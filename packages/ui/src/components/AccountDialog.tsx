import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SessionInfo, StorageUsage } from "@slackoss/protocol";
import { ApiError } from "@slackoss/client-core";
import { formatBytes, formatFull, formatWhen } from "../lib/format.js";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import { accountError, deviceLabel } from "../lib/account.js";
import { useComposerPreferences } from "../lib/composerPreferences.js";
import {
  NOTIFICATION_PREVIEWS,
  previewAccount,
  previewFor,
  useNotificationPreviews,
} from "../lib/notificationPreview.js";
import type { AccountSection } from "../lib/accountSections.js";
import { resumeTime, snoozeOptions } from "../lib/snooze.js";
import { DENSITIES, THEMES, useAppearance, type Theme } from "../lib/appearance.js";
import { Dialog, DialogScroll, inputCls } from "./Dialog.js";
import { ListStatus } from "./ListStatus.js";
import { stepIn } from "./Motion.js";
import { ProfileForm } from "./ProfileDialog.js";
import { VoiceVideoSettings } from "./VoiceVideoSettings.js";
import { buttonClass } from "./Button.js";

type Confirmation =
  { kind: "device"; session: SessionInfo } | { kind: "others" } | { kind: "signout" };

export type { AccountSection };

const SECTIONS: readonly { id: AccountSection; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "notifications", label: "Notifications" },
  { id: "appearance", label: "Appearance" },
  { id: "composing", label: "Composing" },
  { id: "calls", label: "Voice & video" },
  { id: "security", label: "Security" },
  { id: "devices", label: "Devices" },
  { id: "storage", label: "Storage" },
];

/** Where an arrow key, Home or End moves from one section, wrapping at either end. */
function sectionAfter(key: string, current: AccountSection): AccountSection | null {
  const at = SECTIONS.findIndex((s) => s.id === current);
  const last = SECTIONS.length - 1;
  if (key === "ArrowDown" || key === "ArrowRight") return SECTIONS[at === last ? 0 : at + 1]!.id;
  if (key === "ArrowUp" || key === "ArrowLeft") return SECTIONS[at === 0 ? last : at - 1]!.id;
  if (key === "Home") return SECTIONS[0]!.id;
  if (key === "End") return SECTIONS[last]!.id;
  return null;
}

/**
 * Everything about your own account in one place, a section at a time:
 * profile, notifications, composing, security, devices and storage.
 */
export function AccountDialog({
  onClose,
  onSignedOut,
  section: initialSection = "profile",
  onSectionChange,
}: {
  onClose: () => void;
  onSignedOut: () => void;
  /** The section to open on, and to move to when it changes, as Back and Forward do. */
  section?: AccountSection;
  /** Told when someone chooses another section, so the address can follow. */
  onSectionChange?: (section: AccountSection) => void;
}) {
  const client = useClient();
  const tabsId = useId();
  const [section, setSection] = useState<AccountSection>(initialSection);
  const self = useWorkspace((s) => s.self);
  const composer = useComposerPreferences();
  const alive = useRef(true);
  const loadVersion = useRef(0);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const confirmationPanel = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirmation) {
      confirmationPanel.current?.focus();
      confirmationPanel.current?.scrollIntoView({ block: "nearest" });
    }
  }, [confirmation]);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    try {
      const result = await client.api.listSessions();
      if (alive.current && version === loadVersion.current) {
        setSessions(result.sessions);
        setLoaded(true);
        setLoadError(null);
      }
    } catch (err) {
      if (alive.current && version === loadVersion.current) {
        setLoadError(
          err instanceof ApiError && err.code === "unauthorized"
            ? accountError(err)
            : "Could not load signed-in devices. Check your connection and try again.",
        );
      }
    } finally {
      if (alive.current && version === loadVersion.current) setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    if (newPassword !== repeatPassword) {
      setError("The new passwords do not match.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("Choose a different password from your current one.");
      return;
    }
    setBusy(true);
    try {
      await client.api.changePassword(currentPassword, newPassword);
      if (!alive.current) return;
      setCurrentPassword("");
      setNewPassword("");
      setRepeatPassword("");
      setNotice(
        "Password changed. Your other devices have been signed out; this device stays signed in.",
      );
      setSessions((current) => current.filter((session) => session.current));
      await load();
    } catch (err) {
      if (alive.current) setError(accountError(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function confirm() {
    if (!confirmation || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (confirmation.kind === "signout") {
        await client.api.logout();
        onSignedOut();
        return;
      }
      if (confirmation.kind === "device") await client.api.revokeSession(confirmation.session.id);
      else await client.api.revokeOtherSessions();
      if (!alive.current) return;
      setNotice(
        confirmation.kind === "device"
          ? "That device has been signed out."
          : "Your other devices have been signed out.",
      );
      setSessions((current) =>
        current.filter((session) =>
          confirmation.kind === "device" ? session.id !== confirmation.session.id : session.current,
        ),
      );
      setConfirmation(null);
      await load();
    } catch (err) {
      if (alive.current) setError(accountError(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  function choose(next: AccountSection) {
    if (next === section) return;
    setSection(next);
    // A section is read from its start, wherever the last one was left.
    if (panel.current) panel.current.scrollTop = 0;
    // It steps in from the side of the list it is on: one further down from the right.
    const at = (id: AccountSection) => SECTIONS.findIndex((s) => s.id === id);
    stepIn(panel.current?.firstElementChild, at(next) - at(section));
    onSectionChange?.(next);
    // What was said, or about to be confirmed, belongs to the section it came from.
    setError(null);
    setNotice(null);
    setConfirmation(null);
  }

  // On a phone the sections are a strip that scrolls sideways, and the one
  // opened on may be past its end. Brought to the middle, it shows its neighbours.
  useEffect(() => {
    document
      .getElementById(`${tabsId}-tab-${section}`)
      ?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [tabsId, section]);

  // Back and Forward can name another section while the dialog stays open.
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  useEffect(() => chooseRef.current(initialSection), [initialSection]);

  const otherSessions = sessions.filter((session) => !session.current);
  const askToConfirm = (value: Confirmation) => {
    setConfirmation(value);
    setError(null);
  };
  return (
    <Dialog title="Account settings" onClose={onClose} width={760} ownScroll>
      <p className="mb-4 shrink-0 px-6 text-sm text-ink-dim">
        Signed in as <span className="font-medium text-ink">{self?.displayName}</span> · @
        {self?.handle}
      </p>
      {/* One height for every section, so choosing another does not resize the
          dialog under the pointer. The sections stay put beside the one being
          read, and only that one scrolls. */}
      <div className="flex h-[36rem] min-h-0 flex-col gap-y-3 sm:flex-row">
        <div
          role="tablist"
          aria-label="Account settings"
          aria-orientation="vertical"
          // Padded by the width of a focus ring, which its scrolling would clip.
          className="tab-strip mx-5 flex shrink-0 gap-0.5 overflow-auto p-1 sm:mb-5 sm:mr-0 sm:w-45 sm:flex-col sm:border-r sm:border-edge sm:pr-3"
          onKeyDown={(event) => {
            const next = sectionAfter(event.key, section);
            if (!next) return;
            event.preventDefault();
            choose(next);
            document.getElementById(`${tabsId}-tab-${next}`)?.focus();
          }}
        >
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              id={`${tabsId}-tab-${s.id}`}
              type="button"
              role="tab"
              aria-selected={section === s.id}
              aria-controls={`${tabsId}-panel`}
              tabIndex={section === s.id ? 0 : -1}
              onClick={() => choose(s.id)}
              className={`shrink-0 rounded-md px-3 py-1.5 text-left text-sm font-medium transition-colors ${
                section === s.id
                  ? "channel-row-active text-ink"
                  : "text-ink-faint hover:bg-ink/[0.04] hover:text-ink"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <DialogScroll
          ref={panel}
          id={`${tabsId}-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-tab-${section}`}
        >
          {error && (
            <p
              role="alert"
              className="mb-4 rounded-lg border border-alert/30 bg-alert/10 p-3 text-sm text-alert"
            >
              {error}
            </p>
          )}
          {notice && (
            <p
              role="status"
              className="mb-4 rounded-lg border border-online/30 bg-online/10 p-3 text-sm text-online"
            >
              {notice}
            </p>
          )}
          {section === "profile" && <ProfileForm />}
          {section === "notifications" && <NotificationSettings />}
          {section === "appearance" && <AppearanceSettings />}
          {section === "composing" && (
            <section aria-labelledby="account-composer-title">
              <h3 id="account-composer-title" className="font-semibold">
                Writing messages
              </h3>
              <label className="mt-3 block text-sm">
                When I press Enter
                <select
                  className={`${inputCls} mt-1`}
                  value={composer.enterSends ? "send" : "newline"}
                  disabled={!composer.loaded || composer.saving}
                  onChange={(event) => void composer.setEnterSends(event.target.value === "send")}
                >
                  <option value="send">Send the message</option>
                  <option value="newline">Start a new line</option>
                </select>
              </label>
              <p className="mt-2 text-sm text-ink-dim">
                Applies to channels and threads across workspaces on this device. Ctrl+Enter or
                Cmd+Enter always sends; Shift+Enter adds a new line.
              </p>
              {composer.saving && (
                <p role="status" className="mt-2 text-sm text-ink-dim">
                  Saving preference…
                </p>
              )}
              {composer.error && (
                <p role="alert" className="mt-2 text-sm text-alert">
                  {composer.error}
                  {composer.unread && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={() => void composer.retry()}
                      >
                        Try again
                      </button>
                    </>
                  )}
                </p>
              )}
            </section>
          )}
          {section === "calls" && <VoiceVideoSettings />}
          {section === "security" && (
            <>
              <section aria-labelledby="account-password-title">
                <h3 id="account-password-title" className="font-semibold">
                  Change password
                </h3>
                <p className="mb-3 mt-1 text-sm text-ink-dim">
                  Changing your password signs out your other devices.
                </p>
                <form onSubmit={(event) => void changePassword(event)}>
                  <fieldset disabled={busy || confirmation !== null} className="space-y-3">
                    <label className="block text-sm">
                      Current password
                      <input
                        className={`${inputCls} mt-1`}
                        type={showPassword ? "text" : "password"}
                        autoComplete="current-password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        required
                        maxLength={256}
                      />
                    </label>
                    <label className="block text-sm">
                      New password
                      <input
                        className={`${inputCls} mt-1`}
                        type={showPassword ? "text" : "password"}
                        autoComplete="new-password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        required
                        minLength={8}
                        maxLength={256}
                        aria-describedby="account-password-hint"
                      />
                    </label>
                    <p id="account-password-hint" className="text-xs text-ink-faint">
                      Use at least 8 characters. A long, unique password is best.
                    </p>
                    <label className="block text-sm">
                      Confirm new password
                      <input
                        className={`${inputCls} mt-1`}
                        type={showPassword ? "text" : "password"}
                        autoComplete="new-password"
                        value={repeatPassword}
                        onChange={(e) => setRepeatPassword(e.target.value)}
                        required
                        minLength={8}
                        maxLength={256}
                      />
                    </label>
                    <label className="flex items-center gap-2 text-sm text-ink-dim">
                      <input
                        type="checkbox"
                        checked={showPassword}
                        onChange={(e) => setShowPassword(e.target.checked)}
                      />
                      Show passwords
                    </label>
                    <button className={buttonClass("primary")} type="submit">
                      {busy && !confirmation ? "Saving…" : "Update password"}
                    </button>
                  </fieldset>
                </form>
              </section>
              <section
                aria-labelledby="account-signout-title"
                className="mt-6 border-t border-edge pt-5"
              >
                <h3 id="account-signout-title" className="font-semibold">
                  Sign out
                </h3>
                <p className="mb-3 mt-1 text-sm text-ink-dim">
                  Switching workspaces keeps you signed in. Signing out removes this device's saved
                  sign-in.
                </p>
                <button
                  className={buttonClass("secondary")}
                  disabled={busy || confirmation !== null}
                  onClick={() => askToConfirm({ kind: "signout" })}
                >
                  Sign out of this workspace
                </button>
              </section>
            </>
          )}
          {section === "devices" && (
            <section aria-labelledby="account-devices-title">
              <div className="flex items-center justify-between gap-3">
                <h3 id="account-devices-title" className="font-semibold">
                  Signed-in devices
                </h3>
                <button
                  className={buttonClass("secondary")}
                  disabled={busy || loading}
                  onClick={() => void load()}
                >
                  Refresh
                </button>
              </div>
              <p className="mt-1 text-sm text-ink-dim">
                Each sign-in appears separately. Remove a device you no longer use.
              </p>
              <ListStatus
                className="mt-3"
                loading={loading}
                placeholder={!loaded}
                loadingLabel="Loading devices…"
                error={loadError}
                onRetry={() => void load()}
                empty={
                  loaded && !loadError && sessions.length === 0
                    ? "No active devices were returned. Refresh to check your session."
                    : null
                }
              />
              <ul
                aria-label="Signed-in devices"
                className="mt-3 divide-y divide-edge"
                aria-busy={loading}
              >
                {sessions.map((session) => (
                  <li key={session.id} className="flex flex-wrap items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {deviceLabel(session.userAgent)}{" "}
                        {session.current && (
                          <span className="ml-1 text-xs text-online">This device</span>
                        )}
                      </p>
                      {/* Said as the rest of the app says times, with the exact
                          one on hover, rather than to the second twice over. */}
                      <p className="mt-1 text-xs text-ink-faint">
                        {session.current ? (
                          "Active now"
                        ) : (
                          <span title={formatFull(session.lastSeenAt)}>
                            Last active {formatWhen(session.lastSeenAt)}
                          </span>
                        )}
                        {" · "}
                        <span title={formatFull(session.createdAt)}>
                          signed in {formatWhen(session.createdAt)}
                        </span>
                      </p>
                    </div>
                    {!session.current && (
                      <button
                        className={buttonClass("secondary")}
                        disabled={busy || confirmation !== null}
                        aria-label={`Sign out ${deviceLabel(session.userAgent)}, signed in ${formatWhen(session.createdAt)}`}
                        onClick={() => askToConfirm({ kind: "device", session })}
                      >
                        Sign out
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {otherSessions.length > 0 && (
                <button
                  className={buttonClass("secondary", "mt-3")}
                  disabled={busy || confirmation !== null}
                  onClick={() => askToConfirm({ kind: "others" })}
                >
                  Sign out all other devices
                </button>
              )}
            </section>
          )}
          {section === "storage" && <WorkspaceStorage />}
          {confirmation && (
            <section
              ref={confirmationPanel}
              tabIndex={-1}
              aria-label="Confirm sign out"
              className="mt-4 rounded-xl border border-alert/40 bg-ground p-4"
            >
              <h3 className="font-semibold">
                {confirmation.kind === "signout"
                  ? "Sign out of this workspace?"
                  : confirmation.kind === "others"
                    ? "Sign out your other devices?"
                    : `Sign out ${deviceLabel(confirmation.session.userAgent)}?`}
              </h3>
              <p className="mt-2 text-sm text-ink-dim">
                {confirmation.kind === "signout"
                  ? "You will need your password to sign in again. Your account's saved drafts stay on this device."
                  : "Affected devices will need to sign in again. Your current device stays connected."}
              </p>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  className={buttonClass("secondary")}
                  disabled={busy}
                  onClick={() => setConfirmation(null)}
                >
                  Cancel
                </button>
                <button
                  className={buttonClass("primary")}
                  disabled={busy}
                  onClick={() => void confirm()}
                >
                  {busy ? "Signing out…" : "Confirm sign out"}
                </button>
              </div>
            </section>
          )}
        </DialogScroll>
      </div>
    </Dialog>
  );
}

/** What this device does with notifications, and a pause that follows the account. */
function NotificationSettings() {
  const platform = usePlatform();
  const client = useClient();
  const dndUntil = useWorkspace((s) => s.self?.dndUntil ?? null);
  const [permission, setPermission] = useState(browserPermission);
  const [asking, setAsking] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const paused = dndUntil !== null && dndUntil > now.getTime();

  // A pause ends by itself; say so without waiting for another render.
  useEffect(() => {
    if (!paused) return;
    const timer = setTimeout(() => setNow(new Date()), Math.max(0, dndUntil - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [paused, dndUntil]);

  async function ask() {
    if (asking) return;
    setAsking(true);
    try {
      setPermission(await Notification.requestPermission());
    } finally {
      setAsking(false);
    }
  }

  return (
    <>
      <section aria-labelledby="account-device-notifications-title">
        <h3 id="account-device-notifications-title" className="font-semibold">
          On this device
        </h3>
        <p className="mt-1 text-sm text-ink-dim">
          {platform.kind === "desktop"
            ? "The desktop app shows notifications for mentions and direct messages itself."
            : permission === "granted"
              ? "Notifications are on in this browser."
              : permission === "denied"
                ? "This browser blocks notifications from Tandem. Allow them in the browser's site settings, then reload the page."
                : permission === "unsupported"
                  ? "This browser cannot show notifications."
                  : "Notifications are off in this browser. Turn them on to hear about mentions while Tandem is in the background."}
        </p>
        {platform.kind !== "desktop" && permission === "default" && (
          <button
            className={buttonClass("secondary", "mt-3")}
            disabled={asking}
            onClick={() => void ask()}
          >
            {asking ? "Turning on…" : "Turn on notifications"}
          </button>
        )}
      </section>
      <section aria-labelledby="account-pause-title" className="mt-6 border-t border-edge pt-5">
        <h3 id="account-pause-title" className="font-semibold">
          Pause notifications
        </h3>
        <p role="status" className="mt-1 text-sm text-ink-dim">
          {paused
            ? `Paused until ${resumeTime(dndUntil, now)}, on every device you use.`
            : "Pausing holds notifications on every device you use."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {paused ? (
            <button
              className={buttonClass("secondary")}
              onClick={() => client.snoozeNotificationsUntil(null)}
            >
              Resume notifications
            </button>
          ) : (
            snoozeOptions(now).map((option) => (
              <button
                key={option.label}
                className={buttonClass("secondary")}
                aria-label={
                  option.label.startsWith("Until")
                    ? `Pause ${option.label.toLowerCase()}`
                    : `Pause for ${option.label}`
                }
                onClick={() => {
                  client.snoozeNotificationsUntil(option.until());
                  setNow(new Date());
                }}
              >
                {option.label}
              </button>
            ))
          )}
        </div>
      </section>
      <PreviewSettings />
      <p className="mt-6 border-t border-edge pt-5 text-sm text-ink-dim">
        What each channel notifies you about is in its details, under Notifications.
      </p>
    </>
  );
}

/** How much a notification shows, for this account on this device (IMP-03). */
function PreviewSettings() {
  const client = useClient();
  const selfId = useWorkspace((s) => s.self?.id ?? null);
  const previews = useNotificationPreviews();
  const account = selfId ? previewAccount(client.baseUrl, selfId) : null;
  const chosen = previewFor(previews, account);
  return (
    <fieldset
      className="mt-6 border-t border-edge pt-5"
      disabled={!previews.loaded || previews.saving || !account}
    >
      <legend className="float-left w-full font-semibold">What notifications show</legend>
      <p className="clear-both pt-1 text-sm text-ink-dim">
        For this workspace on this device. Choose less where others can see your screen.
      </p>
      <div className="mt-3 space-y-2">
        {NOTIFICATION_PREVIEWS.map((option) => (
          <label key={option.id} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="notification-preview"
              className="mt-1"
              checked={previews.loaded && chosen === option.id}
              onChange={() => account && void previews.setPreview(account, option.id)}
            />
            <span>
              {option.label}
              <span className="block text-xs text-ink-faint">{option.example}</span>
            </span>
          </label>
        ))}
      </div>
      {previews.error && (
        <p role="alert" className="mt-2 text-sm text-alert">
          {previews.error}
        </p>
      )}
    </fieldset>
  );
}

const THEME_LABELS: Record<Theme, { label: string; hint: string }> = {
  system: { label: "Match this device", hint: "Onyx or White, as the device is set" },
  dark: { label: "Onyx", hint: "Near-black, easy on the eyes" },
  light: { label: "White", hint: "Clean and bright, for well-lit rooms" },
};

/** How Tandem looks on this device: its theme, and how much it fits in. */
function AppearanceSettings() {
  const appearance = useAppearance();
  return (
    <>
      <fieldset disabled={!appearance.loaded}>
        <legend className="font-semibold">Theme</legend>
        <p className="mt-1 text-sm text-ink-dim">Applies to every workspace on this device.</p>
        <div className="mt-3 grid grid-cols-3 gap-3">
          {THEMES.map((theme) => {
            const chosen = appearance.theme === theme;
            return (
              <label
                key={theme}
                className={`cursor-pointer overflow-hidden rounded-xl border-2 text-sm transition-colors ${
                  chosen ? "border-copper" : "border-edge hover:border-ink-faint"
                }`}
              >
                <span aria-hidden="true" className="theme-swatch" data-swatch={theme} />
                <span className="flex items-start gap-2 bg-raised p-2.5">
                  <input
                    type="radio"
                    name="theme"
                    className="mt-1 accent-[var(--color-copper)]"
                    checked={chosen}
                    onChange={() => void appearance.set({ theme })}
                  />
                  <span>
                    <span className="font-semibold">{THEME_LABELS[theme].label}</span>
                    <span className="block text-xs text-ink-faint">{THEME_LABELS[theme].hint}</span>
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-ink-faint">More themes are on the way.</p>
      </fieldset>
      <fieldset disabled={!appearance.loaded} className="mt-6 border-t border-edge pt-5">
        <legend className="float-left w-full font-semibold">Density</legend>
        <div className="clear-both mt-3 space-y-2 pt-1">
          {DENSITIES.map((density) => (
            <label key={density} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="density"
                className="mt-1"
                checked={appearance.density === density}
                onChange={() => void appearance.set({ density })}
              />
              <span>
                {density === "compact" ? "Compact" : "Comfortable"}
                <span className="block text-xs text-ink-faint">
                  {density === "compact"
                    ? "Smaller messages and closer rows, to see more at once"
                    : "The usual size and spacing"}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {appearance.error && (
        <p role="alert" className="mt-3 text-sm text-alert">
          {appearance.error}
        </p>
      )}
    </>
  );
}

/** What the browser currently allows, or that it cannot ask at all. */
function browserPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

function WorkspaceStorage() {
  const client = useClient();
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void client.api
      .storageUsage(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setUsage(value);
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(
            err instanceof ApiError && err.status === 404
              ? "This server does not report storage usage yet."
              : "Could not load workspace storage. Try again.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, attempt]);
  return (
    <section
      className="mt-4 rounded-xl border border-edge p-4"
      aria-label="Workspace attachment storage"
    >
      <h3 className="font-semibold">Workspace attachment storage</h3>
      <p className="mt-2 text-sm text-ink-dim">
        Shared by everyone, including unfinished uploads. The host controls the limit.
      </p>
      {usage && (
        <div className="my-3 text-sm">
          <p>
            {formatBytes(usage.usedBytes)} used ·{" "}
            {usage.limitBytes === null
              ? "No workspace limit"
              : `${formatBytes(usage.limitBytes)} limit`}
          </p>
          {usage.availableBytes !== null && <p>{formatBytes(usage.availableBytes)} available</p>}
          <p>{formatBytes(usage.maxFileBytes)} maximum per file</p>
          {usage.availableBytes === 0 && (
            <p role="status" className="mt-2 text-alert">
              Storage is full. New uploads need space to be freed or a higher limit.
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="my-2 text-sm text-alert">
          {error}
        </p>
      )}
      <button
        className={buttonClass("secondary", "mt-2")}
        disabled={loading}
        onClick={() => setAttempt((n) => n + 1)}
      >
        {loading ? "Loading storage…" : error ? "Retry storage" : "Refresh storage"}
      </button>
    </section>
  );
}
