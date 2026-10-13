import { useEffect, useId, useRef, useState } from "react";
import { ApiError } from "@slackoss/client-core";
import type { ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { Avatar } from "./Avatar.js";
import { Modal } from "./Modal.js";
import { Icon } from "./Icon.js";
import { avatarColor } from "../lib/format.js";
import { Dialog, inputCls } from "./Dialog.js";
import { FriendActions } from "./FriendsDialog.js";
import { buttonClass } from "./Button.js";
import { STATUS_PRESETS } from "../lib/status.js";

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
  const selfId = useWorkspace((s) => s.self?.id);
  const [opening, setOpening] = useState(false);
  const [dmError, setDmError] = useState<string | null>(null);
  // The press on Message this card is waiting on. Once the card is closed, or
  // shows someone else, an earlier press has nothing left to finish: opening
  // its conversation then would pull the reader out of wherever they went (Q11).
  const press = useRef(0);
  useEffect(() => {
    setOpening(false);
    setDmError(null);
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

  const online = presence === "online";
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
              aria-label={online ? "Active now" : "Offline"}
              className={`absolute bottom-2 right-2 size-5 rounded-full ring-4 ring-raised ${
                online ? "bg-online" : "bg-ink-faint"
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
              className={`size-2 rounded-full ${online ? "bg-online" : "bg-ink-faint"}`}
            />
            {online ? "Active now" : "Offline"}
          </div>
          {(user.statusEmoji || user.statusText) && (
            <p className="mt-3 border-t border-edge pt-3 text-sm">
              {user.statusEmoji && <span className="mr-1.5">{user.statusEmoji}</span>}
              {user.statusText}
            </p>
          )}
          {user.id !== selfId && !user.isBot && (
            <div className="mt-3 border-t border-edge pt-3">
              <FriendActions userId={user.id} />
            </div>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const id = useId();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await client.api.updateMe({
        displayName: displayName.trim() || self?.handle || "",
        statusEmoji: statusEmoji.trim(),
        statusText: statusText.trim(),
      });
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
                setSaved(false);
              }}
              className="rounded-full border border-edge px-2.5 py-1 text-xs text-ink-faint transition-colors hover:border-alert hover:text-alert"
            >
              Clear
            </button>
          )}
        </div>
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
      <button type="submit" disabled={busy} className={buttonClass("primary", "w-full")}>
        {busy ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}
