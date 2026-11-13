import type { AuditEntry, ID, SettingsPanel, User } from "@ownbase/protocol";
import type { EarlierWords, ExtensionContext, Keep } from "@ownbase/server/extensions";
import { HttpError } from "@ownbase/server/httpError";
import {
  parseSyslog,
  sendSyslog,
  signatureHeaders,
  syslogHost,
  syslogMessage,
  type SentEntry,
} from "./auditStream.js";
import { makeExport, type EarlierVersion, type ExportChoice } from "./complianceExport.js";
import { complianceEndpoints } from "./endpoints.js";

/**
 * Compliance (P12), part of the Enterprise edition, with a license that has
 * `compliance`. Three panels under Workspace settings, Compliance:
 *
 * - Legal hold. Messages written by the people held, and every message in
 *   the channels held, are kept: retention skips them and nobody can delete
 *   them (the core refuses). An edit of one keeps the words it replaces here.
 *   Held people are not told, though a deletion refused says the message is
 *   kept for the workspace's records.
 * - Export. Messages, edits and deletions for a range of days, for chosen
 *   people, channels or both, as JSON lines with the files (complianceExport.ts).
 * - Sending the record. Each entry of the administrative record to a webhook,
 *   signed and through the server's outbound guard, or to syslog, in order,
 *   none skipped: a failed delivery is tried again until it goes.
 *
 * When the license ends, holds stay in force and can still be lifted, but
 * none can be added; no new export is made; nothing more is sent until it is
 * renewed, and then what was recorded meanwhile goes.
 */

const HOLD = "compliance:hold";
const VERSION = "compliance:version:";
const CHOICE = "compliance:export";
const STREAM = "compliance:stream";
const SENT = "compliance:stream:state";

/** Entries sent at once. */
const BATCH = 100;
/** How long after a failed delivery it is tried again. */
export const RETRY_MS = 60_000;
/** A webhook's signing secret is at least this long. */
const SECRET_MIN = 16;
const DAY = 24 * 60 * 60 * 1000;
const LICENSE_TEXT = "an Enterprise license with compliance";

interface Hold {
  userIds: ID[];
  channelIds: ID[];
  /** When the first thing still held was held. */
  since: number;
}

interface Stream {
  webhook?: string;
  secret?: string;
  syslog?: string;
}

interface Sent {
  /** The last entry every destination has. */
  cursor: ID | null;
  sentAt: number | null;
  error: string | null;
  failedAt: number | null;
}

interface Choice {
  from: string;
  to: string;
  userIds: ID[];
  channelIds: ID[];
}

export interface Compliance {
  register(context: ExtensionContext): void;
  settingsPanels(): SettingsPanel[];
  keeps(): Keep;
  editing(earlier: EarlierWords): void;
  stop(): void;
}

const day = (at: number) =>
  new Date(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
const moment = (at: number) => `${day(at)} at ${new Date(at).toISOString().slice(11, 16)} UTC`;
const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "maya, @sam #legal" as names, lower-case, each once. */
const names = (text: string, mark: string) => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map((name) => name.replace(new RegExp(`^\\${mark}`), "").toLowerCase())
      .filter(Boolean),
  ),
];

/** A day as 2026-01-31, in UTC: its first moment, or null. */
function dayStart(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(at).toISOString().slice(0, 10) === text.trim() ? at : null;
}

export function compliance(opts: { licensed: () => boolean; now?: () => number }): Compliance {
  const now = opts.now ?? Date.now;
  let context: ExtensionContext | null = null;
  let hold: Hold = { userIds: [], channelIds: [], since: 0 };
  let exporting = false;
  let pumping = false;
  let again = false;
  let retry: NodeJS.Timeout | null = null;
  let stopListening: (() => void) | null = null;
  let stopped = false;

  const store = () => context!.storage;
  const parse = <T>(raw: string | null, otherwise: T): T => {
    if (!raw) return otherwise;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return otherwise;
    }
  };
  const stream = () => parse<Stream>(store().get(STREAM), {});
  const sent = () =>
    parse<Sent>(store().get(SENT), { cursor: null, sentAt: null, error: null, failedAt: null });
  const choice = () => parse<Choice | null>(store().get(CHOICE), null);
  const held = () => hold.userIds.length > 0 || hold.channelIds.length > 0;
  const streaming = (s: Stream = stream()) => Boolean(s.webhook || s.syslog);

  const licenseRequired = (what: string) =>
    new HttpError(403, "license_required", `${what} needs ${LICENSE_TEXT}.`);

  /** People by username and channels by name, or a 400 naming the first not found. */
  function resolve(people: string, channels: string): { userIds: ID[]; channelIds: ID[] } {
    const userIds: ID[] = [];
    for (const handle of names(people, "@")) {
      const user = context!.users.byHandle(handle);
      if (!user || user.isBot)
        throw new HttpError(400, "invalid_request", `Nobody here has the username ${handle}.`);
      userIds.push(user.id);
    }
    const rooms = context!.channels
      .list()
      .filter((c) => c.type === "public" || c.type === "private");
    const channelIds: ID[] = [];
    for (const name of names(channels, "#")) {
      const room = rooms.find((c) => c.name.toLowerCase() === name);
      if (!room) throw new HttpError(400, "invalid_request", `There is no channel called ${name}.`);
      channelIds.push(room.id);
    }
    return { userIds, channelIds };
  }

  const handles = (ids: ID[]) => ids.map((id) => context!.users.get(id)?.handle ?? id).join(", ");
  const channelNames = (ids: ID[]) => {
    const rooms = new Map(context!.channels.list().map((c) => [c.id, c.name]));
    return ids.map((id) => rooms.get(id) ?? id).join(", ");
  };

  // ---------- legal hold ----------

  function saveHold(values: Record<string, string | boolean>, by: User) {
    const people = typeof values.people === "string" ? values.people : handles(hold.userIds);
    const channels =
      typeof values.channels === "string" ? values.channels : channelNames(hold.channelIds);
    const next = resolve(people, channels);
    const adds =
      next.userIds.some((id) => !hold.userIds.includes(id)) ||
      next.channelIds.some((id) => !hold.channelIds.includes(id));
    // Lifting a hold stays possible once the license ends; adding one does not.
    if (adds && !opts.licensed()) throw licenseRequired("Adding to the legal hold");
    const changed =
      adds ||
      next.userIds.length !== hold.userIds.length ||
      next.channelIds.length !== hold.channelIds.length;
    if (!changed) return;
    const empty = next.userIds.length === 0 && next.channelIds.length === 0;
    hold = { ...next, since: empty ? 0 : held() ? hold.since : now() };
    if (empty) store().delete(HOLD);
    else store().set(HOLD, JSON.stringify(hold));
    context!.audit.record({
      actorId: by.id,
      did: empty ? "lifted the legal hold" : "changed the legal hold",
      details: { people: next.userIds.length, channels: next.channelIds.length },
    });
  }

  function editing(earlier: EarlierWords) {
    if (!context) return;
    if (!hold.userIds.includes(earlier.userId) && !hold.channelIds.includes(earlier.channelId))
      return;
    const version: EarlierVersion = {
      text: earlier.text,
      writtenAt: earlier.writtenAt,
      replacedAt: now(),
    };
    store().set(
      `${VERSION}${earlier.messageId}:${String(earlier.writtenAt).padStart(15, "0")}`,
      JSON.stringify(version),
    );
  }

  const versionsOf = (messageId: ID): EarlierVersion[] =>
    store()
      .list(`${VERSION}${messageId}:`)
      .map(({ value }) => parse<EarlierVersion | null>(value, null))
      .filter((v): v is EarlierVersion => v !== null);

  // ---------- export ----------

  function saveChoice(values: Record<string, string | boolean>) {
    if (!opts.licensed()) throw licenseRequired("An export");
    const text = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : "");
    const from = dayStart(text("from"));
    const to = dayStart(text("to"));
    if (from === null || to === null)
      throw new HttpError(
        400,
        "invalid_request",
        "Give both days as year, month and day, such as 2026-01-31.",
      );
    if (to < from)
      throw new HttpError(400, "invalid_request", "The last day comes before the first.");
    const chosen = resolve(text("people"), text("channels"));
    if (chosen.userIds.length === 0 && chosen.channelIds.length === 0)
      throw new HttpError(400, "invalid_request", "Choose people, channels or both.");
    store().set(
      CHOICE,
      JSON.stringify({ from: text("from").trim(), to: text("to").trim(), ...chosen }),
    );
  }

  /** The saved choice as times, or why there is none to export. */
  function exportChoice(): ExportChoice {
    const saved = choice();
    if (!saved) throw new HttpError(409, "no_export_choice", "Save what the export covers first.");
    return {
      from: dayStart(saved.from)!,
      to: dayStart(saved.to)! + DAY,
      userIds: saved.userIds,
      channelIds: saved.channelIds,
    };
  }

  // ---------- sending the record ----------

  function saveStream(values: Record<string, string | boolean>, by: User) {
    const before = stream();
    const text = (key: keyof Stream) =>
      typeof values[key] === "string" ? (values[key] as string).trim() : (before[key] ?? "");
    const webhook = text("webhook");
    const syslog = text("syslog");
    // A secret left empty keeps the one saved.
    const secret = text("secret") || before.secret || "";
    const next: Stream = {
      ...(webhook ? { webhook } : {}),
      ...(webhook ? { secret } : {}),
      ...(syslog ? { syslog } : {}),
    };
    if (streaming(next) && !opts.licensed()) throw licenseRequired("Sending the record");
    if (webhook) {
      let url: URL;
      try {
        url = new URL(webhook);
      } catch {
        throw new HttpError(400, "invalid_request", "The webhook address is not a web address.");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new HttpError(
          400,
          "invalid_request",
          "The webhook address starts with https:// or http://.",
        );
      if (secret.length < SECRET_MIN)
        throw new HttpError(
          400,
          "invalid_request",
          `Give the webhook a signing secret of at least ${SECRET_MIN} characters.`,
        );
    }
    if (syslog && !parseSyslog(syslog))
      throw new HttpError(
        400,
        "invalid_request",
        "Give the syslog address as udp://, tcp:// or tls://, a host and a port, such as udp://logs.acme.com:514.",
      );
    const moved =
      next.webhook !== before.webhook ||
      next.syslog !== before.syslog ||
      next.secret !== before.secret;
    if (!moved) return;
    if (streaming(next)) store().set(STREAM, JSON.stringify(next));
    else store().delete(STREAM);
    // A new destination gets the whole record, from its first entry.
    if (next.webhook !== before.webhook || next.syslog !== before.syslog) store().delete(SENT);
    const where = [next.webhook ? "a webhook" : "", next.syslog ? "syslog" : ""]
      .filter(Boolean)
      .join(" and ");
    context!.audit.record({
      actorId: by.id,
      did: where
        ? `set the administrative record to be sent to ${where}`
        : "stopped sending the administrative record",
    });
    void pump();
  }

  function toSent(entry: AuditEntry): SentEntry {
    return {
      ...entry,
      time: new Date(entry.at).toISOString(),
      actor: entry.actorId ? (context!.users.get(entry.actorId)?.handle ?? null) : null,
    };
  }

  async function deliver(to: Stream, entries: SentEntry[]) {
    if (to.webhook) {
      const body = JSON.stringify({ entries });
      const answer = await context!.post(to.webhook, body, {
        contentType: "application/json",
        headers: signatureHeaders(to.secret ?? "", body, now()),
      });
      if (answer.status < 200 || answer.status > 299)
        throw new Error(`The webhook answered ${answer.status}.`);
    }
    if (to.syslog) {
      const address = parseSyslog(to.syslog)!;
      const host = syslogHost(context!.publicUrl());
      try {
        await sendSyslog(
          address,
          entries.map((entry) => syslogMessage(entry, host)),
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new Error(
          `The syslog server could not be reached${code ? ` (${code})` : ""}: ${(error as Error).message}.`,
        );
      }
    }
  }

  /**
   * Sends what has not gone yet, a batch at a time, in order. Only one round
   * runs at once; an entry written meanwhile starts another after it.
   */
  async function pump(): Promise<void> {
    if (!context || stopped) return;
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    if (retry) clearTimeout(retry);
    retry = null;
    try {
      do {
        again = false;
        for (;;) {
          const to = stream();
          if (stopped || !streaming(to) || !opts.licensed()) break;
          const state = sent();
          const batch = context.audit.after(state.cursor, BATCH);
          if (batch.length === 0) break;
          await deliver(to, batch.map(toSent));
          // Saved only if the destination is still the one sent to.
          if (JSON.stringify(stream()) !== JSON.stringify(to)) continue;
          store().set(
            SENT,
            JSON.stringify({
              cursor: batch.at(-1)!.id,
              sentAt: now(),
              error: null,
              failedAt: null,
            } satisfies Sent),
          );
        }
      } while (again && !stopped);
    } catch (error) {
      if (!stopped) {
        store().set(
          SENT,
          JSON.stringify({
            ...sent(),
            error: (error as Error).message,
            failedAt: now(),
          } satisfies Sent),
        );
        context.log.warn({ err: error }, "could not send the administrative record; trying again");
        retry = setTimeout(() => void pump(), RETRY_MS);
        retry.unref();
      }
    } finally {
      pumping = false;
    }
  }

  // ---------- the panels ----------

  function holdPanel(): SettingsPanel | null {
    if (!opts.licensed() && !held()) return null;
    return {
      id: "legal-hold",
      section: "compliance",
      title: "Legal hold",
      description:
        "Messages written by the people held, and every message in the channels held, are kept whatever their age: retention skips them, nobody can delete them, and an edit keeps the words it replaces for the export. The people held are not told, though deleting a held message says it is kept for the workspace's records.",
      save: complianceEndpoints.complianceHold.path,
      fields: [
        {
          key: "people",
          label: "People held",
          kind: "text",
          help: "Usernames, separated by commas.",
          value: handles(hold.userIds),
        },
        {
          key: "channels",
          label: "Channels held",
          kind: "text",
          help: "Channel names, separated by commas.",
          value: channelNames(hold.channelIds),
        },
      ],
      status: held()
        ? `Holding ${counted(hold.userIds.length, "person", "people")} and ${counted(hold.channelIds.length, "channel", "channels")} since ${day(hold.since)}.`
        : "Nothing is held.",
      ...(!opts.licensed()
        ? {
            problem: `Adding to the legal hold needs ${LICENSE_TEXT}. What is held stays held, and you can still lift it.`,
          }
        : {}),
    };
  }

  function exportPanel(): SettingsPanel | null {
    if (!opts.licensed()) return null;
    const saved = choice();
    return {
      id: "compliance-export",
      section: "compliance",
      title: "Export",
      description:
        "Messages, edits and deletions for a range of days, as JSON lines in a zip with their files. Choosing a person takes everything they wrote and every message in their direct conversations; choosing a channel takes every message in it. Save what it covers, then download it. A deleted message keeps who wrote it, where and when; its words and files are gone.",
      save: complianceEndpoints.complianceExportChoice.path,
      fields: [
        {
          key: "from",
          label: "First day",
          kind: "text",
          help: "Year, month and day, in UTC.",
          placeholder: "2026-01-01",
          value: saved?.from ?? "",
        },
        {
          key: "to",
          label: "Last day",
          kind: "text",
          help: "Included.",
          placeholder: "2026-12-31",
          value: saved?.to ?? "",
        },
        {
          key: "people",
          label: "People",
          kind: "text",
          help: "Usernames, separated by commas.",
          value: saved ? handles(saved.userIds) : "",
        },
        {
          key: "channels",
          label: "Channels",
          kind: "text",
          help: "Channel names, separated by commas.",
          value: saved ? channelNames(saved.channelIds) : "",
        },
      ],
      ...(saved
        ? {
            status: `Covers ${day(dayStart(saved.from)!)} to ${day(dayStart(saved.to)!)}, ${counted(saved.userIds.length, "person", "people")} and ${counted(saved.channelIds.length, "channel", "channels")}.`,
            actions: [
              {
                id: "download",
                label: "Download the export",
                path: complianceEndpoints.complianceExportLink.path,
              },
            ],
          }
        : {}),
    };
  }

  function streamPanel(): SettingsPanel | null {
    const to = stream();
    if (!opts.licensed() && !streaming(to)) return null;
    const state = sent();
    const status = !streaming(to)
      ? "The record is not sent anywhere."
      : state.error && state.failedAt
        ? `The last try, on ${moment(state.failedAt)}, failed. ${state.error} It is tried again every minute, and nothing is skipped.`
        : state.sentAt
          ? `Sent up to ${moment(state.sentAt)}.`
          : "Nothing sent yet.";
    return {
      id: "audit-stream",
      section: "compliance",
      title: "Sending the administrative record",
      description:
        "Each entry of the administrative record goes, in order and as it is made, to a webhook, to syslog, or both. A new destination gets the whole record first. An entry can arrive twice after a failure, with the same id.",
      save: complianceEndpoints.complianceStream.path,
      fields: [
        {
          key: "webhook",
          label: "Webhook address",
          kind: "url",
          help: 'Entries are POSTed as JSON, {"entries": [...]}, and signed as OwnBase signs requests to apps: HMAC-SHA256 of v0:<timestamp>:<body> in x-ownbase-signature.',
          placeholder: "https://siem.acme.com/ownbase",
          value: to.webhook ?? "",
        },
        {
          key: "secret",
          label: "Signing secret",
          kind: "secret",
          help: `At least ${SECRET_MIN} characters, which the webhook checks the signature with.`,
          value: "",
          isSet: Boolean(to.secret),
        },
        {
          key: "syslog",
          label: "Syslog address",
          kind: "text",
          help: "udp://, tcp:// or tls://, a host and a port. Each entry is one RFC 5424 message.",
          placeholder: "udp://logs.acme.com:514",
          value: to.syslog ?? "",
        },
      ],
      status,
      ...(!opts.licensed()
        ? {
            problem: `Sending the record needs ${LICENSE_TEXT}. Nothing more is sent until it is renewed; then what was recorded meanwhile goes.`,
          }
        : {}),
    };
  }

  return {
    register(given) {
      context = given;
      const { route } = given;
      hold = parse<Hold>(store().get(HOLD), { userIds: [], channelIds: [], since: 0 });

      route(complianceEndpoints.complianceHold, async ({ body, user }) => {
        saveHold(body, user);
        return { ok: true };
      });

      route(complianceEndpoints.complianceExportChoice, async ({ body }) => {
        saveChoice(body);
        return { ok: true };
      });

      route(complianceEndpoints.complianceExportLink, async ({ req, user }) => {
        if (!opts.licensed()) throw licenseRequired("An export");
        exportChoice();
        const ticket = given.ticketFor(req, user, complianceEndpoints.complianceExport, {});
        return {
          download: `${complianceEndpoints.complianceExport.path}?download=${ticket.token}`,
        };
      });

      route(complianceEndpoints.complianceExport, async ({ reply, user }) => {
        reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
        if (!opts.licensed()) throw licenseRequired("An export");
        const chosen = exportChoice();
        if (exporting)
          throw new HttpError(
            409,
            "export_running",
            "An export is downloading already. Wait for it to finish.",
          );
        exporting = true;
        let made;
        try {
          made = await makeExport(given, chosen, {
            madeBy: user,
            madeAt: now(),
            versions: versionsOf,
          });
        } catch (error) {
          exporting = false;
          throw error;
        }
        given.audit.record({
          actorId: user.id,
          did: "downloaded a compliance export",
          details: {
            from: new Date(chosen.from).toISOString().slice(0, 10),
            to: new Date(chosen.to - DAY).toISOString().slice(0, 10),
            people: chosen.userIds.length,
            channels: chosen.channelIds.length,
            messages: made.counts.messages,
          },
        });
        const body = made.open();
        const finished = () => {
          exporting = false;
          made.cleanUp();
        };
        body.once("close", finished);
        body.once("error", finished);
        const name = `compliance-export-${new Date(chosen.from).toISOString().slice(0, 10)}-to-${new Date(chosen.to - DAY).toISOString().slice(0, 10)}.zip`;
        return reply
          .header("content-type", "application/zip")
          .header("x-content-type-options", "nosniff")
          .header("content-length", String(made.length))
          .header("content-disposition", `attachment; filename="${name}"`)
          .send(body);
      });

      route(complianceEndpoints.complianceStream, async ({ body, user }) => {
        saveStream(body, user);
        return { ok: true };
      });

      stopListening = given.audit.onRecord(() => void pump());
      // What was recorded while the server was down, or before the license came back.
      void pump();
    },

    settingsPanels() {
      if (!context) return [];
      return [holdPanel(), exportPanel(), streamPanel()].filter(
        (panel): panel is SettingsPanel => panel !== null,
      );
    },

    keeps: () => hold,

    editing,

    stop() {
      stopped = true;
      stopListening?.();
      if (retry) clearTimeout(retry);
      retry = null;
    },
  };
}
