import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@slackoss/client-core";
import type { Invite, InviteStatus } from "@slackoss/protocol";
import { useCopy } from "../lib/useCopy.js";
import { browserLink, desktopLink, serverAddress } from "../lib/deeplink.js";
import {
  DEFAULT_INVITE,
  INVITE_EXPIRY_CHOICES,
  INVITE_USE_CHOICES,
  describeExpiry,
  describeUses,
  reusableInvite,
} from "../lib/invites.js";
import { useClient, useWorkspace } from "../context.js";
import { Swap } from "./Motion.js";
import { Dialog } from "./Dialog.js";
import { useConfirm } from "./Confirm.js";
import { useShareableServer } from "./ShareableServer.js";
import { buttonClass } from "./Button.js";
import { QrCode } from "./QrCode.js";
import { useOptionalToast } from "./Toast.js";

/** What an invite's status means to the person looking at the list. */
const INVITE_STATUS: Record<InviteStatus, string> = {
  active: "Active",
  expired: "Expired",
  used_up: "Used up",
  revoked: "Revoked",
  creator_deactivated: "Creator deactivated",
  creator_not_permitted: "Creator can no longer invite",
};

const quietButton =
  "h-8 shrink-0 rounded-lg px-2.5 text-[13px] font-medium text-ink-dim transition-colors hover:bg-ink/[0.06] hover:text-ink";
const selectCls =
  "mt-1 h-8 w-full rounded-lg border border-edge bg-raised px-2 text-[13px] font-normal text-ink";

/**
 * Invite people. It opens with a link ready to copy (UX-43): one this person
 * already made that still works like a new one, or a new one for a week and
 * any number of people. Other lengths and limits are a "Change" away, and a QR
 * code carries the link to a phone.
 */
export function InviteDialog(props: { onClose: () => void }) {
  const client = useClient();
  const confirm = useConfirm();
  const toast = useOptionalToast();
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const selfRole = useWorkspace((s) => s.self?.role);
  // Older servers do not send the flag; every member could invite there.
  const canInvite = useWorkspace((s) => s.self?.canInvite ?? true);
  const [invite, setInvite] = useState<Invite | null>(null);
  /** Undefined until the first answer; null when the list could not be read. */
  const [invites, setInvites] = useState<Invite[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  const [hours, setHours] = useState<number | null>(DEFAULT_INVITE.hours);
  const [maxUses, setMaxUses] = useState<number | null>(DEFAULT_INVITE.maxUses);
  const opened = useRef(false);
  const listRequest = useRef(0);
  const permissions = useMemo(
    () =>
      Object.values(users)
        .map((user) => `${user.id}:${user.role}:${user.canInvite}:${user.deactivated}`)
        .sort()
        .join("|"),
    [users],
  );
  const { copy, label } = useCopy();
  const shareable = useShareableServer();
  const addresses = [shareable.serverUrl, ...shareable.alternatives];
  const [chosenAddress, setChosenAddress] = useState<string | null>(null);
  const serverUrl =
    chosenAddress && addresses.includes(chosenAddress) ? chosenAddress : shareable.serverUrl;
  const host = serverAddress(serverUrl);
  const links = invite
    ? {
        browser: browserLink(serverUrl, { kind: "join", code: invite.code }),
        desktop: desktopLink(serverUrl, { kind: "join", code: invite.code }),
      }
    : null;
  // The list is fresher about uses than the answer that made the link.
  const shown = (invite && invites?.find((i) => i.code === invite.code)) || invite;

  const loadInvites = useCallback(async () => {
    const request = ++listRequest.current;
    try {
      const result = await client.api.listInvites();
      if (request === listRequest.current) setInvites(result.invites);
    } catch {
      // The list is a convenience beside creating one; failing to load it
      // should not stop anyone inviting a colleague.
      if (request === listRequest.current) setInvites(null);
    }
  }, [client]);

  useEffect(() => {
    void loadInvites();
    return () => {
      listRequest.current++;
    };
  }, [loadInvites, permissions]);

  useEffect(() => {
    if (!canInvite) setInvite(null);
  }, [canInvite]);

  async function make(expiresInHours: number | null, uses: number | null) {
    setBusy(true);
    setError(null);
    try {
      const { invite } = await client.api.createInvite({
        ...(expiresInHours !== null ? { expiresInHours } : {}),
        ...(uses !== null ? { maxUses: uses } : {}),
      });
      setInvite(invite);
      setChanging(false);
      void loadInvites();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invite_permission_required"
          ? "An administrator must allow you to create invite codes."
          : "Could not make an invite link. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  // Once the list has answered, or failed to: show a link without being asked.
  useEffect(() => {
    if (!canInvite || opened.current || invites === undefined) return;
    opened.current = true;
    const kept = invites ? reusableInvite(invites, selfId) : null;
    if (kept) setInvite(kept);
    else void make(DEFAULT_INVITE.hours, DEFAULT_INVITE.maxUses);
    // `make` is this render's; it only needs the client, which does not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canInvite, invites, selfId]);

  async function copyLink(link: string) {
    if (await copy(link, "browser"))
      toast?.({ message: "Invite link copied.", kind: "success" });
  }

  async function revoke(code: string) {
    const go = await confirm({
      title: "Revoke this invite?",
      body: "Anyone who has not used it yet will not be able to join with it.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!go) return;
    setError(null);
    try {
      await client.api.revokeInvite(code);
      if (code === invite?.code) setInvite(null);
      void loadInvites();
    } catch {
      setError(
        "Could not confirm whether that invite was revoked. Check your connection before trying again.",
      );
      void loadInvites();
    }
  }

  return (
    <Dialog title="Invite people" onClose={props.onClose}>
      <p className="mb-4 text-sm text-ink-dim">
        {canInvite
          ? "Send someone this link. It opens the workspace in their browser with the invite already filled in."
          : "Anyone joining needs this workspace's address, and an invite code as well if the workspace is invite-only."}
      </p>
      {canInvite ? (
        shown && links ? (
          <div className="card-warm animate-pop-in mb-4 overflow-hidden rounded-xl">
            <div className="px-4 pt-3">
              <div className="mb-1.5 text-[13px] font-medium text-ink-dim">Invite link</div>
              <div className="flex items-center justify-between gap-3">
                <code className="min-w-0 break-all font-mono text-xs leading-5 text-ink">
                  {links.browser}
                </code>
                <button
                  onClick={() => void copyLink(links.browser)}
                  className={buttonClass("primary", "h-8 shrink-0 px-3 text-[13px]")}
                >
                  <Swap text>{label("Copy link", "Copied", "Copy failed", "browser")}</Swap>
                </button>
              </div>
              <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-faint">
                <span>
                  {describeExpiry(shown.expiresAt)} · {describeUses(shown.maxUses, shown.uses)}
                </span>
                <button
                  type="button"
                  aria-expanded={changing}
                  onClick={() => setChanging((open) => !open)}
                  className="rounded font-medium text-ink-dim underline decoration-ink-faint/60 underline-offset-2 transition-colors hover:text-ink hover:decoration-ink"
                >
                  {changing ? "Keep this link" : "Change"}
                </button>
              </p>
            </div>
            {changing && (
              <form
                aria-label="New invite link"
                className="mx-4 mt-3 grid gap-3 rounded-lg border border-edge p-3 sm:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy) void make(hours, maxUses);
                }}
              >
                <label className="text-[12px] font-medium text-ink-dim">
                  Expires after
                  <select
                    value={String(hours)}
                    onChange={(event) =>
                      setHours(event.target.value === "null" ? null : Number(event.target.value))
                    }
                    className={selectCls}
                  >
                    {INVITE_EXPIRY_CHOICES.map((choice) => (
                      <option key={choice.label} value={String(choice.hours)}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-[12px] font-medium text-ink-dim">
                  Number of uses
                  <select
                    value={String(maxUses)}
                    onChange={(event) =>
                      setMaxUses(event.target.value === "null" ? null : Number(event.target.value))
                    }
                    className={selectCls}
                  >
                    {INVITE_USE_CHOICES.map((uses) => (
                      <option key={String(uses)} value={String(uses)}>
                        {uses === null ? "No limit" : uses === 1 ? "1 use" : `${uses} uses`}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  aria-disabled={busy || undefined}
                  className={buttonClass("secondary", "h-8 text-[13px] sm:col-span-2")}
                >
                  {busy ? "Making a link…" : "Make a new link"}
                </button>
              </form>
            )}
            <div className="mt-3 flex gap-4 border-t border-edge px-4 py-3">
              {!shareable.localOnly && (
                <QrCode value={links.browser} label="QR code for the invite link" size={104} />
              )}
              <div className="min-w-0 flex-1 space-y-2">
                {!shareable.localOnly && (
                  <p className="text-[12px] leading-5 text-ink-dim">
                    Scan it with a phone's camera to open the invite there.
                  </p>
                )}
                <div>
                  <div className="text-[12px] text-ink-faint">Invite code</div>
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-[15px] font-semibold tracking-[0.2em] text-ink">
                      {shown.code}
                    </code>
                    <button onClick={() => void copy(shown.code, "code")} className={quietButton}>
                      <Swap text>{label("Copy code", "Copied", "Copy failed", "code")}</Swap>
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="border-t border-edge px-4 py-3">
              <div className="mb-1.5 text-[12px] text-ink-faint">Desktop app link</div>
              <div className="flex items-center justify-between gap-3">
                <code className="min-w-0 break-all font-mono text-xs leading-5 text-ink">
                  {links.desktop}
                </code>
                <button onClick={() => void copy(links.desktop, "desktop")} className={quietButton}>
                  <Swap text>{label("Copy desktop link", "Copied", "Copy failed", "desktop")}</Swap>
                </button>
              </div>
            </div>
          </div>
        ) : busy || invites === undefined ? (
          <p role="status" className="card-warm mb-4 rounded-xl p-4 text-sm text-ink-dim">
            Making an invite link…
          </p>
        ) : (
          <button
            onClick={() => void make(DEFAULT_INVITE.hours, DEFAULT_INVITE.maxUses)}
            className={buttonClass("primary", "mb-4 w-full")}
          >
            Make an invite link
          </button>
        )
      ) : (
        <p className="card-warm mb-4 rounded-xl p-3 text-sm text-ink-dim">
          Creating invite codes needs permission from an administrator. Ask one to allow it, or to
          invite the person for you.
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 text-sm text-alert">
          {error}
        </p>
      )}
      <div className="card-warm rounded-xl px-4 py-3">
        <div className="mb-1.5 text-[13px] font-medium text-ink-dim">Server address</div>
        <div className="flex items-center justify-between gap-2">
          {addresses.length > 1 ? (
            <select
              aria-label="Address used in links"
              value={serverUrl}
              onChange={(e) => setChosenAddress(e.target.value)}
              className="h-8 min-w-0 rounded-lg border border-edge bg-raised px-2 font-mono text-[13px] text-ink"
            >
              {addresses.map((address) => (
                <option key={address} value={address}>
                  {serverAddress(address)}
                </option>
              ))}
            </select>
          ) : (
            <code className="min-w-0 break-all font-mono text-[13px] text-ink">{host}</code>
          )}
          <button onClick={() => void copy(host, "host")} className={quietButton}>
            <Swap text>{label("Copy address", "Copied", "Copy failed", "host")}</Swap>
          </button>
        </div>
        {shareable.localOnly && (
          <p className="mt-2 text-xs text-ink-dim">
            This address reaches only this computer, so links made here will not work for anyone
            else. Open this workspace at its network or public address to invite people.
          </p>
        )}
      </div>
      {invites && invites.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-[13px] font-medium text-ink-dim">Invite codes</div>
          <ul className="max-h-60 space-y-1.5 overflow-y-auto" aria-label="Invite codes">
            {invites.map((inv) => {
              // A role change takes effect before a refreshed list returns.
              if (selfRole !== "owner" && selfRole !== "admin" && inv.createdBy !== selfId)
                return null;
              const author = users[inv.createdBy];
              const status =
                inv.status !== "revoked" && author?.deactivated
                  ? "creator_deactivated"
                  : inv.status !== "revoked" && author?.canInvite === false
                    ? "creator_not_permitted"
                    : (inv.status ?? "active");
              const creator =
                inv.createdBy === selfId ? "you" : (users[inv.createdBy]?.displayName ?? "someone");
              return (
                <li
                  key={inv.code}
                  className="flex items-center gap-3 rounded-xl border border-edge px-3 py-2 text-sm"
                >
                  <code className="font-mono text-[13px] tracking-[0.15em] text-ink">
                    {inv.code}
                  </code>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                    by {creator} · {inv.uses}
                    {inv.maxUses !== null ? ` of ${inv.maxUses}` : ""} used
                    {inv.expiresAt !== null && status === "active"
                      ? ` · ${describeExpiry(inv.expiresAt).toLowerCase()}`
                      : ""}
                  </span>
                  <span
                    className={`flex items-center gap-1.5 text-xs ${status === "active" ? "text-online" : "text-ink-faint"}`}
                  >
                    {status === "active" && (
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-online" />
                    )}
                    {INVITE_STATUS[status]}
                  </span>
                  {status !== "revoked" && (
                    <button
                      onClick={() => void revoke(inv.code)}
                      className="rounded-lg px-2 py-1 text-xs text-ink-dim transition-colors hover:bg-alert/10 hover:text-alert"
                      aria-label={`Revoke invite ${inv.code}`}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
