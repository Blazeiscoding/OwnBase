import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError } from "@ownbase/client-core";
import { currentZoneName, type ID } from "@ownbase/protocol";
import { IconProblem, prepareIcon } from "../lib/iconImage.js";
import { readerTimeZone, theirTime, useMinute, zoneLabel } from "../lib/localTime.js";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { Modal } from "./Modal.js";
import { Icon } from "./Icon.js";
import { avatarColor } from "../lib/format.js";
import { Dialog } from "./Dialog.js";
import { inputCls } from "./TextField.js";
import { FriendActions } from "./FriendsDialog.js";
import { buttonClass } from "./Button.js";
import { useOptionalConfirm } from "./Confirm.js";
import {
  CLEAR_AFTER,
  STATUS_PRESETS,
  statusEnd,
  statusUntil,
  type ClearAfter,
} from "../lib/status.js";

/**
 * Someone's profile card, with a shortcut to open a DM with them; or your own,
 * with the way to change it, so it is not a dead end.
 */
export function ProfileDialog(props: {
  userId: ID;
  onClose: () => void;
  onOpenDm: (channelId: ID) => void;
  /** Opens Account settings at your profile. */
  onEditProfile?: () => void;
}) {
  const client = useClient();
  const user = useWorkspace((s) => s.users[props.userId]);
  const presence = useWorkspace((s) => s.presence[props.userId] ?? "offline");
  const self = useWorkspace((s) => s.self);
  const selfId = self?.id;
  const now = useMinute();
  const [opening, setOpening] = useState(false);
  const [dmError, setDmError] = useState<string | null>(null);
  // Blocking is offered where the server blocks (E12).
  const canBlock = useWorkspace((s) => s.blocked !== null);
  const blockedThem = useWorkspace((s) => s.blocked?.includes(props.userId) === true);
  const [blockError, setBlockError] = useState<string | null>(null);
  // Asked over the workspace; a card drawn alone, as in a test, has nothing to ask with.
  const confirm = useOptionalConfirm();
  // The press on Message this card is waiting on. Once the card is closed, or
  // shows someone else, an earlier press has nothing left to finish: opening
  // its conversation then would pull the reader out of wherever they went (Q11).
  const press = useRef(0);
  useEffect(() => {
    setOpening(false);
    setDmError(null);
    setBlockError(null);
    return () => {
      press.current += 1;
    };
  }, [props.userId]);
  if (!user) return null;

  async function message(userId: ID, name: string) {
    if (opening) return;
    const mine = ++press.current;
    setOpening(true);
    setDmError(null);
    try {
      const channel = await client.openDm([userId]);
      if (press.current === mine) props.onOpenDm(channel.id);
    } catch {
      if (press.current === mine)
        setDmError(
          `Could not open a conversation with ${name}. Check your connection and try again.`,
        );
    } finally {
      if (press.current === mine) setOpening(false);
    }
  }

  /** Blocks them, after saying what that does, or unblocks them (E12). */
  async function toggleBlock(userId: ID, name: string) {
    if (!blockedThem && confirm) {
      const go = await confirm({
        title: `Block ${name}?`,
        body: `Nothing ${name} writes will notify you, their messages fold away for you, and your direct messages with them close. They are not told. You can unblock them here or in Account settings.`,
        confirmLabel: "Block",
        destructive: true,
      });
      if (!go) return;
    }
    setBlockError(null);
    if (!(await client.setBlocked(userId, !blockedThem)))
      setBlockError(
        `Could not ${blockedThem ? "unblock" : "block"} ${name}. Check your connection and try again.`,
      );
  }

  const online = presence === "online";
  const away = presence === "away";
  const presenceWords = online ? "Active now" : away ? "Away" : "Offline";
  // Their clock, where their zone is known (E9).
  const local = theirTime(user, self, now);
  return (
    // Discord's profile card: a band of the person's colour, their picture
    // set into it, and who they are on a card of its own beneath.
    <Modal
      title="Profile"
      onClose={props.onClose}
      backdropClassName="flex animate-fade-in items-center justify-center dialog-backdrop p-4"
      // In a window shorter than the card, the card scrolls rather than losing its ends.
      className="max-h-full w-[340px] max-w-full animate-pop-in dialog-surface overflow-y-auto overscroll-contain rounded-2xl border border-[var(--card-edge)] outline-none"
    >
      <div
        className="relative h-[92px]"
        style={{
          background: `linear-gradient(135deg, ${avatarColor(user.id)}, ${avatarColor(user.id, 0.45)})`,
        }}
      >
        <button
          onClick={props.onClose}
          aria-label="Close"
          className="absolute right-2.5 top-2.5 flex size-8 items-center justify-center rounded-full bg-black/35 text-white transition-colors hover:bg-black/55"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="px-4 pb-4">
        <div className="-mt-11 mb-3 flex items-end justify-between">
          <span className="relative rounded-full bg-raised p-1.5">
            <Avatar user={user} size={80} />
            <span
              role="img"
              aria-label={presenceWords}
              className={`absolute bottom-2 right-2 size-5 rounded-full ring-4 ring-raised ${
                online ? "bg-online" : away ? "border-4 border-online bg-raised" : "bg-ink-faint"
              }`}
            />
          </span>
          {user.role !== "member" && (
            <span className="mb-1 rounded-full bg-ink/[0.07] px-2.5 py-0.5 text-[12px] font-medium capitalize text-ink-dim">
              {user.role}
            </span>
          )}
        </div>
        <div className="rounded-xl bg-deep/70 p-3.5">
          <h2 className="truncate text-xl font-bold leading-tight">{user.displayName}</h2>
          <div className="text-sm text-ink-dim">@{user.handle}</div>
          <div className="mt-2 flex items-center gap-1.5 text-[13px] text-ink-dim">
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${
                online ? "bg-online" : away ? "border-2 border-online" : "bg-ink-faint"
              }`}
            />
            {presenceWords}
          </div>
          {local && (
            <div className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-dim">
              <Icon name="clock" size={13} className="text-ink-faint" />
              {local.time} local time
              {local.differs && user.id !== selfId && (
                <span className="text-ink-faint">
                  · {user.timeZone && zoneLabel(user.timeZone)}
                </span>
              )}
            </div>
          )}
          {(user.statusEmoji || user.statusText) && (
            <p className="mt-3 border-t border-edge pt-3 text-sm">
              {user.statusEmoji && <span className="mr-1.5">{user.statusEmoji}</span>}
              {user.statusText}
              {/* A status that clears itself says when, in this reader's time. */}
              {user.statusExpiresAt && (
                <span className="text-ink-faint"> · {statusUntil(user.statusExpiresAt)}</span>
              )}
            </p>
          )}
          {user.id !== selfId && !user.isBot && !blockedThem && (
            <div className="mt-3 border-t border-edge pt-3">
              <FriendActions userId={user.id} />
            </div>
          )}
          {blockedThem && (
            <p className="mt-3 flex items-center gap-1.5 border-t border-edge pt-3 text-[13px] text-ink-dim">
              <Icon name="ban" size={13} className="text-ink-faint" />
              You blocked {user.displayName}. They are not told.
            </p>
          )}
        </div>
        {user.id !== selfId && dmError && (
          <p role="alert" className="mt-3 text-sm text-alert">
            {dmError}
          </p>
        )}
        {user.id === selfId && props.onEditProfile && (
          <button onClick={props.onEditProfile} className={buttonClass("primary", "mt-3 w-full")}>
            Edit profile and status
          </button>
        )}
        {user.id !== selfId && (
          <button
            // Not `disabled`, so focus stays on the button while it works and it can try again.
            aria-disabled={opening || undefined}
            onClick={() => void message(user.id, user.displayName)}
            className={buttonClass("primary", "mt-3 w-full aria-disabled:opacity-60")}
          >
            {opening ? "Opening…" : `Message ${user.displayName}`}
          </button>
        )}
        {user.id !== selfId && !user.isBot && canBlock && (
          <button
            type="button"
            onClick={() => void toggleBlock(user.id, user.displayName)}
            className={`mt-2 w-full rounded-lg py-1.5 text-[13px] transition-colors hover:bg-ink/[0.04] ${
              blockedThem ? "text-ink-dim hover:text-ink" : "text-ink-faint hover:text-alert"
            }`}
          >
            {blockedThem ? `Unblock ${user.displayName}` : `Block ${user.displayName}`}
          </button>
        )}
        {blockError && (
          <p role="alert" className="mt-2 text-sm text-alert">
            {blockError}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Edit your own name and status, in Account settings. */
export function ProfileForm() {
  const client = useClient();
  const self = useWorkspace((s) => s.self);
  const [displayName, setDisplayName] = useState(self?.displayName ?? "");
  const [statusEmoji, setStatusEmoji] = useState(self?.statusEmoji ?? "");
  const [statusText, setStatusText] = useState(self?.statusText ?? "");
  /** How long the status lasts; "kept" leaves the end it was set with. */
  const [clearAfter, setClearAfter] = useState<ClearAfter | "kept">(
    self?.statusExpiresAt ? "kept" : "never",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const id = useId();
  // The server keeps pictures and time zones (E9); an older one offers neither.
  const profiles = useWorkspace((s) => s.profiles);
  const picker = useRef<HTMLInputElement>(null);
  const [picture, setPicture] = useState<{ busy: boolean; problem: string | null }>({
    busy: false,
    problem: null,
  });
  const [zoneNote, setZoneNote] = useState<string | null>(null);
  const zones = useMemo(() => {
    let all: string[] = [];
    try {
      // Chromium lists some zones by names the IANA database has since
      // changed, India's as "Asia/Calcutta"; each is offered by its current one.
      all = [...new Set(Intl.supportedValuesOf("timeZone").map(currentZoneName))].sort();
    } catch {
      all = [];
    }
    const mine = self?.timeZone;
    return mine && !all.includes(mine) ? [mine, ...all] : all;
  }, [self?.timeZone]);
  const detected = readerTimeZone(undefined);
  // Both by current names: the server keeps them so, and so is `detected`.
  const onThisDevice = self?.timeZone === detected;

  async function choosePicture(file: File) {
    setPicture({ busy: true, problem: null });
    try {
      const ok = await client.setAvatar(await prepareIcon(file, "a profile picture"));
      setPicture({
        busy: false,
        problem: ok ? null : "Your picture was not changed. Check your connection and try again.",
      });
    } catch (err) {
      setPicture({
        busy: false,
        problem:
          err instanceof IconProblem
            ? err.message
            : "Your picture was not changed. Check your connection and try again.",
      });
    }
  }

  async function removePicture() {
    setPicture({ busy: true, problem: null });
    const ok = await client.removeAvatar();
    setPicture({
      busy: false,
      problem: ok ? null : "Your picture was not removed. Check your connection and try again.",
    });
  }

  async function chooseZone(zone: string) {
    setZoneNote(null);
    const ok = await client.setTimeZone(zone);
    setZoneNote(ok ? "Time zone saved." : "Your time zone was not saved. Try again.");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const hasStatus = !!(statusEmoji.trim() || statusText.trim());
    const statusExpiresAt = !hasStatus
      ? null
      : clearAfter === "kept"
        ? (self?.statusExpiresAt ?? null)
        : statusEnd(clearAfter);
    try {
      await client.api.updateMe({
        displayName: displayName.trim() || self?.handle || "",
        statusEmoji: statusEmoji.trim(),
        statusText: statusText.trim(),
        statusExpiresAt,
      });
      // Saved again, it keeps this end rather than starting the time over.
      setClearAfter(statusExpiresAt ? "kept" : "never");
      setSaved(true);
    } catch (err) {
      // What was typed stays in the form, so saving again is one press.
      setError(
        err instanceof ApiError && err.code === "invalid_request"
          ? "Your profile was not saved. A display name can be up to 80 characters and a status up to 120."
          : err instanceof ApiError && err.code === "unauthorized"
            ? "Your session has ended. Sign in again to change your profile."
            : "Your profile was not saved. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={save}
      // A change after saving is not saved yet, so the confirmation goes.
      onChange={() => setSaved(false)}
      aria-label="Your profile"
      className="space-y-4"
    >
      <div className="flex items-center gap-3">
        <Avatar user={self ?? undefined} size={48} />
        <div className="min-w-0 flex-1">
          <label
            htmlFor={`${id}-display-name`}
            className="mb-1.5 block text-[13px] font-medium text-ink-dim"
          >
            Display name
          </label>
          <input
            id={`${id}-display-name`}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={80}
            className={inputCls}
          />
        </div>
      </div>

      {profiles && (
        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-ink-dim">Profile picture</span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => picker.current?.click()}
              aria-disabled={picture.busy || undefined}
              className={buttonClass("secondary", "aria-disabled:opacity-60")}
            >
              {picture.busy
                ? "Saving…"
                : self?.avatarVersion
                  ? "Change picture"
                  : "Upload a picture"}
            </button>
            {self?.avatarVersion && (
              <button
                type="button"
                onClick={() => void removePicture()}
                aria-disabled={picture.busy || undefined}
                className={buttonClass("quiet", "aria-disabled:opacity-60")}
              >
                Remove
              </button>
            )}
            <input
              ref={picker}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file && !picture.busy) void choosePicture(file);
              }}
            />
          </div>
          {picture.problem && (
            <p role="alert" className="mt-1.5 text-sm text-alert">
              {picture.problem}
            </p>
          )}
        </div>
      )}

      {profiles && (
        <div>
          <label
            htmlFor={`${id}-time-zone`}
            className="mb-1.5 block text-[13px] font-medium text-ink-dim"
          >
            Time zone
          </label>
          <select
            id={`${id}-time-zone`}
            value={self?.timeZone ?? ""}
            onChange={(e) => void chooseZone(e.target.value)}
            className={inputCls}
          >
            {!self?.timeZone && <option value="">Not set</option>}
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zoneLabel(zone)}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[13px] text-ink-faint">
            Others see your local time from it.
            {!onThisDevice && (
              <>
                {" "}
                This device is in {zoneLabel(detected)}.{" "}
                <button
                  type="button"
                  onClick={() => void chooseZone(detected)}
                  className="font-medium text-ink-dim underline hover:text-ink"
                >
                  Use it
                </button>
              </>
            )}
          </p>
          <p role="status" className="mt-1 text-[13px] text-ink-dim empty:hidden">
            {zoneNote ?? ""}
          </p>
        </div>
      )}

      <fieldset>
        <legend className="mb-1.5 block text-[13px] font-medium text-ink-dim">Status</legend>
        <div className="flex gap-2">
          <input
            aria-label="Status emoji"
            value={statusEmoji}
            onChange={(e) => setStatusEmoji(e.target.value)}
            maxLength={32}
            placeholder="🙂"
            // One emoji's width: the shared class is full width, which split the
            // row in half with the status text.
            className={`${inputCls.replace("w-full", "")} w-14 shrink-0 text-center text-base`}
          />
          <input
            aria-label="Status text"
            value={statusText}
            onChange={(e) => setStatusText(e.target.value)}
            maxLength={120}
            placeholder="What's happening?"
            className={inputCls}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {STATUS_PRESETS.map((p) => (
            <button
              key={p.text}
              type="button"
              onClick={() => {
                setStatusEmoji(p.emoji);
                setStatusText(p.text);
                setClearAfter(p.clearAfter);
                setSaved(false);
              }}
              className="rounded-full border border-edge px-2.5 py-1 text-xs text-ink-dim transition-colors hover:border-ink-faint/50 hover:text-ink"
            >
              {p.emoji} {p.text}
            </button>
          ))}
          {(statusEmoji || statusText) && (
            <button
              type="button"
              onClick={() => {
                setStatusEmoji("");
                setStatusText("");
                setClearAfter("never");
                setSaved(false);
              }}
              className="rounded-full border border-edge px-2.5 py-1 text-xs text-ink-faint transition-colors hover:border-alert hover:text-alert"
            >
              Clear
            </button>
          )}
        </div>
        {(statusEmoji.trim() || statusText.trim()) && (
          <label className="mt-3 flex items-center gap-2 text-[13px] text-ink-dim">
            Clear after
            <select
              value={clearAfter}
              onChange={(e) => setClearAfter(e.target.value as ClearAfter | "kept")}
              className="rounded-lg border border-edge bg-ground px-2 py-1 text-ink"
            >
              {clearAfter === "kept" && self?.statusExpiresAt && (
                <option value="kept">As set, {statusUntil(self.statusExpiresAt)}</option>
              )}
              {CLEAR_AFTER.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </fieldset>

      {error && (
        <p role="alert" className="text-sm text-alert">
          {error}
        </p>
      )}
      {/* Always present, so the confirmation is announced when it appears. */}
      <p role="status" className="text-sm text-online empty:hidden">
        {saved ? "Profile saved." : ""}
      </p>
      <button type="submit" disabled={busy} className={buttonClass("primary")}>
        {busy ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}
