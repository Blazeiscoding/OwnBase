import type { ID, ScheduleMessageBody, ScheduledMessage } from "@ownbase/protocol";
import { failureOf, fileRefusal } from "./answers.js";
import {
  readWorkspaceStorage,
  workspaceStorageKey,
  writeWorkspaceStorage,
  type StorageHost,
  type WorkspaceStorageKey,
} from "./deviceStorage.js";
import { draftKey } from "./drafts.js";
import { newNonce } from "./outbox.js";
import { ApiError } from "./transport.js";
import type { WorkspaceClient } from "./workspace.js";

/** Where a message is scheduled to: a channel, or a thread in it. */
export interface SchedulePlace {
  channelId: ID;
  threadRootId?: ID;
}

/** A message to schedule, as its author wrote it. */
export interface ScheduleDraft {
  text: string;
  files: File[];
  sendAt: number;
  /** A reply that is also to be shown in the channel. */
  alsoToChannel?: boolean;
}

/**
 * What scheduling came to. A failure says why, as a sentence to show, and
 * `saved` is the request kept on this device when it may have reached the
 * server: `check` asks again with it, and cannot schedule it twice.
 */
export type ScheduleAnswer =
  | { ok: true; scheduled: ScheduledMessage; request: ScheduleMessageBody }
  | { ok: false; reason: string; saved: ScheduleMessageBody | null };

/** The request a composer kept from before, or why it could not be read. */
export type SavedSchedule = { request: ScheduleMessageBody | null } | { failed: string };

/**
 * Schedules messages for later (E3), keeping each request on this device
 * before it goes: a request whose answer was lost, even by a restart, is
 * asked again with the same nonce rather than scheduled twice. One composer's
 * request at a time, under its draft key.
 */
export class ScheduledSends {
  /** Files already uploaded for a request, so trying again does not upload them twice. */
  private uploads = new WeakMap<File, { channelId: ID; id: ID }>();

  constructor(
    private readonly client: WorkspaceClient,
    private readonly host: StorageHost,
  ) {}

  /** The request kept for this place from before, waiting to be checked. */
  async saved(place: SchedulePlace): Promise<SavedSchedule> {
    const key = this.keyOf(place);
    if (!key) return { request: null };
    let value: unknown;
    try {
      value = await readWorkspaceStorage<unknown>(this.host, key);
    } catch {
      return {
        failed:
          "Could not load a message you were scheduling. Press Try again before you send this draft.",
      };
    }
    if (value == null) return { request: null };
    // The request schemas bring their validation library with them, which is
    // most of a tenth of the app. A saved request is rare, so they load only
    // when there is one to check.
    const parsed = (await import("@ownbase/protocol/rest")).scheduleMessageBody.safeParse(value);
    if (
      !parsed.success ||
      !parsed.data.nonce ||
      (parsed.data.threadRootId ?? null) !== (place.threadRootId ?? null)
    )
      return {
        failed:
          "Could not read a message you were scheduling. Your draft is still here. Look in Scheduled before you send it again.",
      };
    return { request: parsed.data };
  }

  /**
   * Uploads the files, keeps the request on this device, then schedules it.
   * `signal` stops the uploads.
   */
  async schedule(
    place: SchedulePlace,
    draft: ScheduleDraft,
    signal?: AbortSignal,
  ): Promise<ScheduleAnswer> {
    const key = this.keyOf(place);
    if (!key) return { ok: false, reason: "Not connected to the workspace yet.", saved: null };
    const fileIds: ID[] = [];
    try {
      for (const file of draft.files)
        fileIds.push(await this.upload(place.channelId, file, signal));
    } catch (error) {
      return { ok: false, reason: uploadFailure(failureOf(error)), saved: null };
    }
    const { threadRootId } = place;
    const body: ScheduleMessageBody = {
      nonce: newNonce(),
      text: draft.text.trim(),
      sendAt: draft.sendAt,
      ...(threadRootId ? { threadRootId } : {}),
      // The choice travels with the request, so the reply lands where it said.
      ...(threadRootId && draft.alsoToChannel ? { alsoSendToChannel: true } : {}),
      ...(fileIds.length > 0 ? { fileIds } : {}),
    };
    // The exact request, uploaded files and time included, is kept before it
    // can reach the server, so asking again never makes a second one.
    try {
      await writeWorkspaceStorage(this.host, key, body);
    } catch {
      return {
        ok: false,
        reason:
          "Nothing was scheduled because this device could not save a copy first. Your draft is still here.",
        saved: null,
      };
    }
    const answer = await this.confirm(place.channelId, key, body);
    if (answer.ok) {
      for (const file of draft.files) this.uploads.delete(file);
      return answer;
    }
    const error = answer.error;
    if (error.code === "invalid_attachments" || error.code === "attachments_scheduled")
      for (const file of draft.files) this.uploads.delete(file);
    if (error.code === "scheduled_limit") {
      // Refused outright: nothing was queued, so there is nothing to check.
      const cleared = await this.forget(place);
      return {
        ok: false,
        reason: `${error.message} Your draft is still here.`,
        saved: cleared ? null : body,
      };
    }
    return {
      ok: false,
      reason: "Could not finish scheduling. Press Check again to see if the message was scheduled.",
      saved: body,
    };
  }

  /** Asks again with a request kept from before, which cannot schedule it twice. */
  async check(place: SchedulePlace, request: ScheduleMessageBody): Promise<ScheduleAnswer> {
    const key = this.keyOf(place);
    if (!key) return { ok: false, reason: "Not connected to the workspace yet.", saved: request };
    const answer = await this.confirm(place.channelId, key, request);
    if (answer.ok) return answer;
    const { error } = answer;
    return {
      ok: false,
      saved: request,
      reason:
        error.code === "scheduled_removed"
          ? "This message was scheduled, then removed from Scheduled. OwnBase did not schedule it again."
          : error.code === "send_at_in_past"
            ? "The time you picked has passed, so the message was not scheduled. Keep the draft and pick a new time."
            : error.code === "scheduled_limit"
              ? `${error.message} Your message is still saved here.`
              : "Could not check if the message was scheduled. Your message is still saved here. Try again when you're back online.",
    };
  }

  /** Stops keeping this place's request; false when the device could not let it go. */
  async forget(place: SchedulePlace): Promise<boolean> {
    const key = this.keyOf(place);
    if (!key) return false;
    try {
      await writeWorkspaceStorage(this.host, key, null);
      return true;
    } catch {
      return false;
    }
  }

  private async confirm(
    channelId: ID,
    key: WorkspaceStorageKey,
    body: ScheduleMessageBody,
  ): Promise<(ScheduleAnswer & { ok: true }) | { ok: false; error: ApiError }> {
    try {
      const { scheduled } = await this.client.api.scheduleMessage(channelId, body);
      // Kept until here, so a request whose answer is lost can be asked again.
      await writeWorkspaceStorage(this.host, key, null);
      return { ok: true, scheduled, request: body };
    } catch (error) {
      return { ok: false, error: failureOf(error) };
    }
  }

  private async upload(channelId: ID, file: File, signal?: AbortSignal): Promise<ID> {
    const done = this.uploads.get(file);
    if (done?.channelId === channelId) return done.id;
    const { file: uploaded } = await this.client.api.uploadFile(channelId, file, file.name, {
      signal,
    });
    this.uploads.set(file, { channelId, id: uploaded.id });
    return uploaded.id;
  }

  private keyOf(place: SchedulePlace): WorkspaceStorageKey | null {
    const { workspaceId, self } = this.client.state;
    return workspaceStorageKey(
      this.client.baseUrl,
      workspaceId,
      self?.id,
      "schedule-request",
      draftKey(place.channelId, place.threadRootId),
    );
  }
}

function uploadFailure(error: ApiError): string {
  const refused = fileRefusal(error);
  if (!refused)
    return "Could not upload the files. Your draft is still here. Try again when you're back online.";
  return error.code === "storage_quota_exceeded"
    ? `${refused} Your draft is still here. Ask the host to free space or raise the limit, then try again.`
    : `${refused} Remove it and try again.`;
}
