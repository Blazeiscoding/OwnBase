import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SessionInfo, StorageUsage } from "@ownbase/protocol";
import { ApiError, failureOf, snoozedUntil } from "@ownbase/client-core";
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
import { ACCOUNT_SECTIONS, type AccountSection } from "../lib/accountSections.js";
import { SavedContext, useSaved, useSavedNote } from "../lib/savedNote.js";
import { NOTIFY_LEVELS } from "../lib/notifyLevels.js";
import {
  SECTION_LABELS,
  findSettings,
  settingMark,
  settingOnPage,
  type Setting,
} from "../lib/settingsSearch.js";
import { resumeTime, snoozeOptions } from "../lib/snooze.js";
import { DENSITIES, THEMES, useAppearance, type Theme } from "../lib/appearance.js";
import { inputCls } from "./TextField.js";
import { Select } from "./Select.js";
import { ListStatus } from "./ListStatus.js";
import { ProfileForm } from "./ProfileDialog.js";
import { SettingsWindow } from "./SettingsWindow.js";
import { VoiceVideoSettings } from "./VoiceVideoSettings.js";
import { TwoStepSettings } from "./TwoStepSettings.js";
import { LinkedSignIns } from "./LinkedSignIns.js";
import { BlockedPeople } from "./Blocking.js";
import { buttonClass } from "./Button.js";
import { useToast } from "./Toast.js";
import { failureText } from "../lib/failure.js";
import { isImeKey } from "../lib/textInput.js";
import { When } from "./When.js";
import { runAction, useActionContext } from "../lib/actions.js";
import { UpdateSettings } from "./Updates.js";

type Confirmation = { kind: "device"; session: SessionInfo } | { kind: "others" };

export type { AccountSection };

const SECTIONS = ACCOUNT_SECTIONS.map((id) => ({ id, label: SECTION_LABELS[id] }));

const CONTROLS =
  "input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)";
const HEADINGS = "h3, h4, legend, label";

/**
 * Everything about your own account in one place, a section at a time:
 * profile, notifications, composing, security, devices and storage. A window
 * over the workspace (UX-60): its own list of sections and a search on one
 * side, the section on the other. Choices save as they are made, and say so
 * quietly.
 */
export function AccountDialog({
  onClose,
  section: initialSection = "profile",
  onSectionChange,
}: {
  onClose: () => void;
  /** The section to open on, and to move to when it changes, as Back and Forward do. */
  section?: AccountSection;
  /** Told when someone chooses another section, so the address can follow. */
  onSectionChange?: (section: AccountSection) => void;
}) {
  const client = useClient();
  const platform = usePlatform();
  // Updates are the desktop app's own; the browser has none.
  const shown = (id: AccountSection) => id !== "updates" || !!platform.updates;
  const sections = SECTIONS.filter((s) => shown(s.id));
  const tabsId = useId();
  const [section, setSection] = useState<AccountSection>(
    shown(initialSection) ? initialSection : "profile",
  );
  const [query, setQuery] = useState("");
  /** A setting a search went to, to bring into view once its section shows. */
  const [goingTo, setGoingTo] = useState<Setting | null>(null);
  const [saved, markSaved, clearSaved] = useSavedNote();
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
    const result = await client.account.sessions();
    if (!alive.current || version !== loadVersion.current) return;
    setLoading(false);
    if (result instanceof ApiError) {
      setLoadError(
        result.code === "unauthorized"
          ? accountError(result)
          : failureText("Could not load signed-in devices.", result, "Try again."),
      );
      return;
    }
    setSessions(result);
    setLoaded(true);
    setLoadError(null);
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
    const failed = await client.account.changePassword(currentPassword, newPassword);
    if (!alive.current) return;
    if (failed) {
      setError(accountError(failed));
      setBusy(false);
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setRepeatPassword("");
    setNotice("Password changed. Your other devices are signed out. This device stays signed in.");
    setSessions((current) => current.filter((session) => session.current));
    await load();
    if (alive.current) setBusy(false);
  }

  async function confirm() {
    if (!confirmation || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const failed =
        confirmation.kind === "device"
          ? await client.account.signOutDevice(confirmation.session.id)
          : await client.account.signOutOtherDevices();
      if (!alive.current) return;
      if (failed) {
        setError(accountError(failed));
        return;
      }
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
      if (alive.current) setError(accountError(failureOf(err)));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  function choose(wanted: AccountSection) {
    const next = shown(wanted) ? wanted : "profile";
    if (next === section) return;
    setSection(next);
    onSectionChange?.(next);
    // What was said, or about to be confirmed, belongs to the section it came from.
    setError(null);
    setNotice(null);
    setConfirmation(null);
    clearSaved();
  }

  /** Opens the section a setting is in and brings the setting into view. */
  function goTo(setting: Setting) {
    setQuery("");
    choose(setting.section);
    setGoingTo(setting);
  }

  useEffect(() => {
    if (!goingTo || !panel.current) return;
    setGoingTo(null);
    const group = settingOnPage(panel.current, goingTo.id);
    if (!group) {
      document.getElementById(`${tabsId}-tab-${goingTo.section}`)?.focus();
      return;
    }
    group.scrollIntoView?.({ block: "center" });
    const control = group.querySelector<HTMLElement>(CONTROLS);
    if (control) control.focus({ preventScroll: true });
    else {
      const heading = group.matches(HEADINGS)
        ? group
        : (group.querySelector<HTMLElement>(HEADINGS) ?? group);
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    // Marked for a moment, for whoever chose it with a pointer and sees no focus ring.
    for (const marked of panel.current.querySelectorAll(".setting-found"))
      marked.classList.remove("setting-found");
    void group.offsetWidth;
    group.classList.add("setting-found");
    group.addEventListener("animationend", () => group.classList.remove("setting-found"), {
      once: true,
    });
  }, [goingTo, section, tabsId]);

  // Back and Forward can name another section while the dialog stays open.
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  useEffect(() => chooseRef.current(initialSection), [initialSection]);

  const otherSessions = sessions.filter((session) => !session.current);
  const askToConfirm = (value: Confirmation) => {
    setConfirmation(value);
    setError(null);
  };
  const results = query.trim() ? findSettings(query).filter((s) => shown(s.section)) : null;
  return (
    <SavedContext.Provider value={markSaved}>
      <SettingsWindow
        title="Account settings"
        about={`${self?.displayName} · @${self?.handle}`}
        sections={sections}
        section={section}
        onChoose={choose}
        tabsId={tabsId}
        saved={saved}
        scroller={panel}
        onClose={onClose}
        search={
          <input
            type="search"
            aria-label="Search settings"
            aria-controls={`${tabsId}-found`}
            placeholder="Search settings"
            value={query}
            maxLength={80}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // An input method's Enter picks a candidate and its Escape lets go
              // of one: neither is a jump to a result or clearing the field.
              if (isImeKey(event.nativeEvent)) return;
              if (event.key === "Escape" && query) {
                // Clears the search first; the next Escape closes the window.
                event.preventDefault();
                setQuery("");
              } else if (event.key === "Enter" && results?.[0]) {
                event.preventDefault();
                goTo(results[0]);
              }
            }}
            className={inputCls}
          />
        }
        searching={results !== null}
        found={
          <div id={`${tabsId}-found`} hidden={results === null}>
            {results && results.length > 0 ? (
              <ul aria-label="Settings found" className="flex flex-col gap-0.5">
                {results.map((setting) => (
                  <li key={`${setting.section}:${setting.label}`}>
                    <button
                      type="button"
                      onClick={() => goTo(setting)}
                      className="w-full rounded-md px-3 py-1.5 text-left text-sm text-ink-dim transition-colors hover:bg-ink/[0.04] hover:text-ink"
                    >
                      <span className="block font-medium text-ink">{setting.label}</span>
                      <span className="block text-xs text-ink-faint">
                        {SECTION_LABELS[setting.section]}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p role="status" className="px-3 py-1.5 text-sm text-ink-faint">
                No settings match &ldquo;{query.trim()}&rdquo;.
              </p>
            )}
          </div>
        }
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
            <div {...settingMark("enter-key")} className="mt-3">
              <Select
                label="When I press Enter"
                value={composer.enterSends ? "send" : "newline"}
                disabled={!composer.loaded || composer.saving}
                onChange={(event) =>
                  void composer
                    .setEnterSends(event.target.value === "send")
                    .then((kept) => kept && markSaved())
                }
              >
                <option value="send">Send the message</option>
                <option value="newline">Start a new line</option>
              </Select>
            </div>
            <p className="mt-2 text-sm text-ink-dim">
              Applies to messages and thread replies in every workspace on this device. Ctrl+Enter
              or Cmd+Enter always sends. Shift+Enter always starts a new line.
            </p>
            {composer.error && (
              <p role="alert" className="mt-2 text-sm text-alert">
                {composer.error}
                {composer.unreadable && (
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
            <section {...settingMark("password")} aria-labelledby="account-password-title">
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
            <TwoStepSettings />
            <LinkedSignIns />
            <BlockedPeople />
            <section
              {...settingMark("sign-out")}
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
              <SignOutButton disabled={busy || confirmation !== null} />
            </section>
          </>
        )}
        {section === "devices" && (
          <section {...settingMark("devices")} aria-labelledby="account-devices-title">
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
              Each sign-in shows as its own row. Sign out of any you no longer use.
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
                  ? "No signed-in devices found. Press Refresh to check again."
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
                          Last active <When at={session.lastSeenAt} />
                        </span>
                      )}
                      {" · "}
                      <span title={formatFull(session.createdAt)}>
                        signed in <When at={session.createdAt} />
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
        {section === "updates" && <UpdateSettings />}
        {confirmation && (
          <section
            ref={confirmationPanel}
            tabIndex={-1}
            aria-label="Confirm sign out"
            className="mt-4 rounded-xl border border-alert/40 bg-ground p-4"
          >
            <h3 className="font-semibold">
              {confirmation.kind === "others"
                ? "Sign out your other devices?"
                : `Sign out ${deviceLabel(confirmation.session.userAgent)}?`}
            </h3>
            <p className="mt-2 text-sm text-ink-dim">
              {confirmation.kind === "others"
                ? "They will need to sign in again. This device stays signed in."
                : "It will need to sign in again. This device stays signed in."}
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
      </SettingsWindow>
    </SavedContext.Provider>
  );
}

/** The account menu's Sign out, which asks first, here in Security. */
function SignOutButton({ disabled }: { disabled: boolean }) {
  const actions = useActionContext();
  return (
    <button
      className={buttonClass("secondary")}
      disabled={disabled}
      onClick={() => runAction(actions, "sign-out")}
    >
      Sign out of this workspace
    </button>
  );
}

/** What this device does with notifications, and a pause that follows the account. */
function NotificationSettings() {
  const platform = usePlatform();
  const client = useClient();
  const toast = useToast();
  const dndUntil = useWorkspace((s) => s.self?.dndUntil ?? null);
  const [permission, setPermission] = useState(browserPermission);
  const [asking, setAsking] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const pausedUntil = snoozedUntil(dndUntil, now.getTime());

  // A pause ends by itself; say so without waiting for another render.
  useEffect(() => {
    if (pausedUntil === null) return;
    const timer = setTimeout(() => setNow(new Date()), Math.max(0, pausedUntil - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [pausedUntil]);

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
      <section
        {...settingMark("device-notifications")}
        aria-labelledby="account-device-notifications-title"
      >
        <h3 id="account-device-notifications-title" className="font-semibold">
          On this device
        </h3>
        <p className="mt-1 text-sm text-ink-dim">
          {platform.kind === "desktop"
            ? "The desktop app shows its own notifications for mentions and direct messages."
            : permission === "granted"
              ? "Notifications are on in this browser."
              : permission === "denied"
                ? "This browser blocks notifications from OwnBase. Allow them in the browser's site settings, then reload the page."
                : permission === "unsupported"
                  ? "This browser cannot show notifications."
                  : "Notifications are off in this browser. Turn them on to hear about mentions while another window or tab is in front."}
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
      <section
        {...settingMark("pause-notifications")}
        aria-labelledby="account-pause-title"
        className="mt-6 border-t border-edge pt-5"
      >
        <h3 id="account-pause-title" className="font-semibold">
          Pause notifications
        </h3>
        <p role="status" className="mt-1 text-sm text-ink-dim">
          {pausedUntil !== null
            ? `Paused until ${resumeTime(pausedUntil, now)}, on every device you use.`
            : "A pause stops notifications on every device you use."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {pausedUntil !== null ? (
            <button
              className={buttonClass("secondary")}
              onClick={() =>
                void client.snoozeNotificationsUntil(null).then((error) => {
                  if (error)
                    toast({ message: failureText("Could not resume notifications.", error) });
                })
              }
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
                  void client.snoozeNotificationsUntil(option.until()).then((error) => {
                    if (error)
                      toast({ message: failureText("Could not pause notifications.", error) });
                  });
                  setNow(new Date());
                }}
              >
                {option.label}
              </button>
            ))
          )}
        </div>
      </section>
      <DefaultLevelSettings />
      <PreviewSettings />
    </>
  );
}

/**
 * What every conversation notifies about unless it was set on its own (v53).
 * Saved at once, as the other choices on this page are.
 */
function DefaultLevelSettings() {
  const client = useClient();
  const level = useWorkspace((s) => s.notifyDefault);
  const saved = useSaved();
  const [failed, setFailed] = useState(false);
  return (
    <fieldset className="mt-6 border-t border-edge pt-5">
      <legend className="float-left w-full font-semibold">Notify me about</legend>
      <p className="clear-both pt-1 text-sm text-ink-dim">
        For every conversation in this workspace, on all your devices. To set one channel on its
        own, open its details and go to Notifications.
      </p>
      <div className="mt-3 space-y-2">
        {NOTIFY_LEVELS.map((option) => (
          <label key={option.value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="notify-default"
              className="mt-1"
              checked={level === option.value}
              onChange={() => {
                setFailed(false);
                void client.setNotifyDefault(option.value).then((error) => {
                  if (!error) saved();
                  else setFailed(true);
                });
              }}
            />
            <span>
              {option.label}
              <span className="block text-xs text-ink-faint">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {failed && (
        <p role="alert" className="mt-2 text-sm text-alert">
          Your choice was not saved. Check your connection and try again.
        </p>
      )}
    </fieldset>
  );
}

/** How much a notification shows, for this account on this device (IMP-03). */
function PreviewSettings() {
  const client = useClient();
  const selfId = useWorkspace((s) => s.self?.id ?? null);
  const previews = useNotificationPreviews();
  const saved = useSaved();
  const account = selfId ? previewAccount(client.baseUrl, selfId) : null;
  const chosen = previewFor(previews, account);
  return (
    <fieldset
      {...settingMark("notification-previews")}
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
              onChange={() =>
                account &&
                void previews.setPreview(account, option.id).then((kept) => kept && saved())
              }
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
  system: {
    label: "Match this device",
    hint: "Onyx or White, following your device's dark or light setting",
  },
  dark: { label: "Onyx", hint: "A dark, near-black theme" },
  light: { label: "White", hint: "A light theme, for bright rooms" },
};

/** How OwnBase looks on this device: its theme, and how much it fits in. */
function AppearanceSettings() {
  const appearance = useAppearance();
  const saved = useSaved();
  return (
    <>
      <fieldset {...settingMark("theme")} disabled={!appearance.loaded}>
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
                    onChange={() => void appearance.set({ theme }).then((kept) => kept && saved())}
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
      </fieldset>
      <fieldset
        {...settingMark("density")}
        disabled={!appearance.loaded}
        className="mt-6 border-t border-edge pt-5"
      >
        <legend className="float-left w-full font-semibold">Density</legend>
        <div className="clear-both mt-3 space-y-2 pt-1">
          {DENSITIES.map((density) => (
            <label key={density} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="density"
                className="mt-1"
                checked={appearance.density === density}
                onChange={() => void appearance.set({ density }).then((kept) => kept && saved())}
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
    void client.account.storageUsage(controller.signal).then((usage) => {
      if (controller.signal.aborted) return;
      setLoading(false);
      if (usage instanceof ApiError)
        setError(failureText("Could not load storage use.", usage, "Try again."));
      else setUsage(usage);
    });
    return () => controller.abort();
  }, [client, attempt]);
  return (
    <section {...settingMark("storage")} aria-labelledby="account-storage-title">
      <h3 id="account-storage-title" className="font-semibold">
        Workspace attachment storage
      </h3>
      <p className="mt-1 text-sm text-ink-dim">
        Files everyone in this workspace has uploaded, including uploads still in progress. The
        person who hosts the workspace sets the limit.
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
              Storage is full. Nobody can upload files until someone deletes some or the host raises
              the limit.
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
