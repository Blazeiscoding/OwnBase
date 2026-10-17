import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { normalizeServerUrl, WorkspaceClient } from "@slackoss/client-core";
import { PlatformContext } from "./context.js";
import type { Platform, SavedServer } from "./platform.js";
import { parseDeepLink } from "./lib/deeplink.js";
import { WorkspaceScreen } from "./screens/WorkspaceScreen.js";
import { Dialog } from "./components/Dialog.js";
import { Icon } from "./components/Icon.js";
import { LazyDialog } from "./components/LazyView.js";
import { useHostingStatus, useLastHosted } from "./lib/hosting.js";
import { useApplyAppearance } from "./lib/appearance.js";
import { buttonClass } from "./components/Button.js";
import { Banner, BannerAction } from "./components/Banner.js";
import type { HostingLine } from "./components/Sidebar.js";

// Joining is the first screen once per device; someone returning opens straight
// into their workspace, so it loads on first use and stays out of every start.
const JoinScreen = lazy(() =>
  import("./screens/JoinScreen.js").then((module) => ({ default: module.JoinScreen })),
);

// Only the desktop app hosts, and only now and then, so its dialog loads on first use.
const HostDialog = lazy(() =>
  import("./components/HostDialog.js").then((module) => ({ default: module.HostDialog })),
);
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ConfirmProvider } from "./components/Confirm.js";
import { ToastProvider } from "./components/Toast.js";
import { parseSavedServers } from "./lib/savedServers.js";
import { hostedButStopped } from "./lib/resume.js";

type Session =
  | { view: "loading" }
  | { view: "restore_failed" }
  | { view: "join"; autoProbe?: string; inviteCode?: string }
  | {
      view: "workspace";
      id: number;
      client: WorkspaceClient;
      server: SavedServer;
      /** Set when a link to a message opened this workspace. */
      target?: { channelId: string; messageId: string } | null;
      /** This account just founded the workspace: open on inviting people. */
      welcome?: boolean;
    };

/** What shows while the app starts, or while a screen it needs arrives. */
function Starting() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <span
        className="flex size-9 animate-spin rounded-full border-2 border-edge border-t-copper"
        aria-hidden="true"
      />
      <span className="text-shimmer font-mono text-sm text-ink-faint" data-text="starting…">
        starting…
      </span>
    </div>
  );
}

/** The chosen theme and density, on the document, for every screen. */
function Appearance() {
  useApplyAppearance();
  return null;
}

function AppBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}

export function App({ platform }: { platform: Platform }) {
  const [savedServers, setSavedServers] = useState<SavedServer[]>([]);
  const savedServersRef = useRef<SavedServer[]>([]);
  const [session, setSession] = useState<Session>({ view: "loading" });
  const [hostDialogOpen, setHostDialogOpen] = useState(false);
  const [inviteAsk, setInviteAsk] = useState(0);
  const hosting = useHostingStatus(platform.hosting);
  const lastHosted = useLastHosted(platform.hosting, hosting.status);
  const clientRef = useRef<WorkspaceClient | null>(null);
  const connectionId = useRef(0);
  const navigation = useRef(0);
  const renderedNavigation = navigation.current;
  const restoredServers = useRef(false);
  const saveVersion = useRef(0);
  const serverTurns = useRef<Promise<void>>(Promise.resolve());
  /** The change that could not be saved, for Retry. */
  const unsaved = useRef<((stored: SavedServer[]) => SavedServer[]) | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [forgetConfirm, setForgetConfirm] = useState(false);
  const [forgetBusy, setForgetBusy] = useState(false);
  const forgetting = useRef(false);
  const deferredDeepLink = useRef<string | null>(null);
  const [forgetError, setForgetError] = useState(false);
  /** Which workspace is open, so a deep link to it can skip reconnecting. */
  const openServerUrl = useRef<string | null>(null);
  /** A message a link asked for, kept while its workspace is signed in to. */
  const pendingTarget = useRef<{ serverUrl: string; channelId: string; messageId: string } | null>(
    null,
  );

  /**
   * One turn at the stored sign-ins: this window's turns one after another,
   * and other windows of this browser kept waiting where the browser can.
   */
  const serversTurn = useCallback(<T,>(turn: () => Promise<T>): Promise<T> => {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    const taken = serverTurns.current.then(() =>
      locks ? (locks.request("tandem:saved-sign-ins", turn) as Promise<T>) : turn(),
    );
    serverTurns.current = taken.then(
      () => {},
      () => {},
    );
    return taken;
  }, []);

  /**
   * Makes one change to the saved sign-ins, to the list as it is stored now.
   * A window used to write the whole list as it last knew it, so one left open
   * brought back a sign-in another window had forgotten since, or wiped one
   * another window had added (Q05). The list is read, changed and written in
   * one turn; what is stored then is what this window goes on to show.
   */
  const changeServers = useCallback(
    async (change: (stored: SavedServer[]) => SavedServer[]) => {
      const version = ++saveVersion.current;
      // Shown at once. What was stored takes its place when the turn is done.
      savedServersRef.current = change(savedServersRef.current);
      setSavedServers(savedServersRef.current);
      try {
        const next = await serversTurn(async () => {
          // Strict: a list that cannot be read is never written over.
          const stored = parseSavedServers(
            await platform.storage.get<unknown>("servers", { strict: true }),
          );
          const changed = change(stored);
          await platform.storage.set("servers", changed);
          return changed;
        });
        if (version !== saveVersion.current) return;
        unsaved.current = null;
        savedServersRef.current = next;
        setSavedServers(next);
        setSaveError(false);
      } catch {
        if (version !== saveVersion.current) return;
        unsaved.current = change;
        setSaveError(true);
      }
    },
    [platform, serversTurn],
  );

  const openWorkspace = useCallback(
    (
      server: SavedServer,
      list: SavedServer[],
      target?: { channelId: string; messageId: string } | null,
      welcome = false,
    ) => {
      navigation.current++;
      clientRef.current?.destroy();
      const client = new WorkspaceClient(server.url, server.token);
      clientRef.current = client;
      client.connect();
      const same = (s: SavedServer) => s.url === server.url && s.token === server.token;
      // A sign-in this window already held, as against one just made.
      const held = list.some(same);
      const used = { ...server, lastUsedAt: Date.now() };
      void changeServers((stored) =>
        // Held here but gone from what is stored: another window forgot it, or
        // signed in again, since. Opening it here does not put it back.
        held && !stored.some(same) ? stored : [used, ...stored.filter((s) => s.url !== server.url)],
      );
      openServerUrl.current = server.url;
      setSession({
        view: "workspace",
        id: ++connectionId.current,
        client,
        server,
        target: target ?? null,
        welcome,
      });
    },
    [changeServers],
  );

  const restoreServers = useCallback(async () => {
    const ticket = ++navigation.current;
    setSession({ view: "loading" });
    try {
      const list = parseSavedServers(
        await platform.storage.get<unknown>("servers", { strict: true }),
      );
      if (ticket !== navigation.current) return;
      restoredServers.current = true;
      savedServersRef.current = list;
      setSavedServers(list);
      if (list.length > 0) {
        // Reconnecting to a workspace this computer hosted but stopped only
        // ever spins. Offer to host it again instead.
        const parked = await hostedButStopped(list[0]!, platform.hosting).catch(() => false);
        if (ticket !== navigation.current) return;
        if (parked) setSession({ view: "join" });
        else openWorkspace(list[0]!, list);
      } else {
        setSession({ view: "join" });
      }
    } catch {
      if (ticket === navigation.current) setSession({ view: "restore_failed" });
    }
  }, [openWorkspace, platform]);

  // A locked key store or unreadable settings must not silently erase sign-ins.
  useEffect(() => {
    void restoreServers();
    return () => {
      navigation.current++;
      clientRef.current?.destroy();
    };
  }, [restoreServers]);

  /** Nothing of the workspace that was open stays connected behind another screen. */
  const closeWorkspace = useCallback(() => {
    clientRef.current?.destroy();
    clientRef.current = null;
    openServerUrl.current = null;
  }, []);

  // Links, from the desktop app or a browser's address: join a workspace, or
  // jump to a specific message.
  const handleDeepLink = useCallback(
    async (raw: string) => {
      const link = parseDeepLink(raw);
      if (!link) return;
      if (forgetting.current) {
        deferredDeepLink.current = raw;
        return;
      }
      setForgetConfirm(false);
      pendingTarget.current = null;
      const ticket = ++navigation.current;
      try {
        const list = restoredServers.current
          ? savedServersRef.current
          : parseSavedServers(await platform.storage.get<unknown>("servers", { strict: true }));
        if (ticket !== navigation.current) return;
        restoredServers.current = true;
        savedServersRef.current = list;
        setSavedServers(list);
        const known = list.find((s) => s.url === link.serverUrl);
        if (link.kind === "message") {
          // Already looking at this workspace: just move, don't reconnect.
          if (openServerUrl.current === link.serverUrl) {
            setSession((prev) =>
              prev.view === "workspace"
                ? { ...prev, target: { channelId: link.channelId, messageId: link.messageId } }
                : prev,
            );
            return;
          }
          // Otherwise it needs credentials we already hold, or a sign-in first,
          // after which the message still opens.
          if (known) {
            openWorkspace(known, list, {
              channelId: link.channelId,
              messageId: link.messageId,
            });
          } else {
            closeWorkspace();
            pendingTarget.current = link;
            setSession({ view: "join", autoProbe: link.serverUrl });
          }
          return;
        }
        if (known) openWorkspace(known, list);
        else {
          closeWorkspace();
          setSession({
            view: "join",
            autoProbe: link.serverUrl,
            inviteCode: link.code ?? undefined,
          });
        }
      } catch {
        if (ticket === navigation.current) setSession({ view: "restore_failed" });
      }
    },
    [closeWorkspace, openWorkspace, platform],
  );

  useEffect(() => {
    if (!platform.deepLinks) return;
    void platform.deepLinks.consumePending().then((url) => {
      if (url) handleDeepLink(url);
    });
    return platform.deepLinks.subscribe(handleDeepLink);
  }, [platform, handleDeepLink]);

  const leaveWorkspace = useCallback(() => {
    navigation.current++;
    pendingTarget.current = null;
    closeWorkspace();
    setSession({ view: "join" });
  }, [closeWorkspace]);

  const forgetServer = useCallback(
    (url: string) => {
      void changeServers((stored) => stored.filter((s) => s.url !== url));
    },
    [changeServers],
  );

  const endSession = useCallback(
    (server: SavedServer, client: WorkspaceClient) => {
      // A late logout response must not remove a newer sign-in to the same workspace.
      void changeServers((stored) =>
        stored.filter((saved) => saved.url !== server.url || saved.token !== server.token),
      );
      if (clientRef.current === client) leaveWorkspace();
    },
    [changeServers, leaveWorkspace],
  );

  async function forgetSavedSignIns() {
    if (forgetting.current) return;
    forgetting.current = true;
    setForgetBusy(true);
    setForgetError(false);
    const ticket = ++navigation.current;
    try {
      // Deliberate reset of credentials only; drafts and other settings remain.
      // In its turn, so no change still on its way writes a sign-in back after it.
      await serversTurn(() => platform.storage.set("servers", []));
      if (ticket !== navigation.current) return;
      savedServersRef.current = [];
      restoredServers.current = true;
      setSavedServers([]);
      setSaveError(false);
      setForgetConfirm(false);
      setSession({ view: "join" });
    } catch {
      if (ticket === navigation.current) setForgetError(true);
    } finally {
      forgetting.current = false;
      setForgetBusy(false);
      const link = deferredDeepLink.current;
      deferredDeepLink.current = null;
      if (link) {
        setForgetConfirm(false);
        void handleDeepLink(link);
      }
    }
  }

  const saveErrorText = `Could not save changes to sign-ins on this device. This session can continue.${
    platform.kind === "desktop"
      ? " Unlock your system key store and retry; new sign-ins are never saved as plain text."
      : " Check browser storage and retry before closing."
  }`;
  const retrySaving = () => void changeServers(unsaved.current ?? ((stored) => stored));
  // In a workspace it waits its turn in the one banner place there (UX-25).
  const saveErrorAbove = saveError && session.view !== "workspace";
  const hostingStatus = hosting.status;
  const viewingHosted =
    session.view === "workspace" &&
    hostingStatus?.port !== undefined &&
    session.server.url === normalizeServerUrl(`localhost:${hostingStatus.port}`);
  const hostingLine: HostingLine | undefined =
    platform.hosting &&
    (hostingStatus?.running ||
      hostingStatus?.phase === "starting" ||
      hostingStatus?.phase === "stopping" ||
      hosting.error)
      ? {
          text: hosting.error
            ? "Hosting status unavailable"
            : hostingStatus?.openToAllError
              ? hostingStatus.openToAllError
              : hostingStatus?.warning
                ? hostingStatus.warning
                : hostingStatus?.phase === "starting"
                  ? "Starting your hosted workspace…"
                  : hostingStatus?.phase === "stopping"
                    ? "Stopping your hosted workspace…"
                    : // The sidebar names the workspace on screen already.
                      `Hosting ${viewingHosted ? "" : `${hostingStatus?.workspaceName ?? "a workspace"} `}on this computer${hostingStatus?.openToAll?.phase === "open" ? " · open to all" : ""}`,
          state:
            hosting.error || hostingStatus?.warning || hostingStatus?.openToAllError
              ? "trouble"
              : hostingStatus?.running
                ? "live"
                : "busy",
          alert: !!(hostingStatus?.warning || hostingStatus?.openToAllError),
          onManage: () => setHostDialogOpen(true),
        }
      : undefined;

  return (
    <PlatformContext.Provider value={platform}>
      <Appearance />
      <AppBoundary>
        <div className="flex h-full flex-col">
          {platform.kind === "desktop" &&
            (saveErrorAbove || session.view === "loading" || session.view === "restore_failed") && (
              <div className="titlebar-drag h-10 shrink-0 border-b border-edge" />
            )}
          {saveErrorAbove && (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-3 border-b border-alert/30 bg-raised px-4 py-3 text-sm text-ink"
            >
              <span className="flex-1">{saveErrorText}</span>
              <button
                type="button"
                className="shrink-0 font-medium text-ink underline decoration-ink-faint/60 hover:decoration-ink"
                onClick={retrySaving}
              >
                Retry saving
              </button>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {session.view === "loading" && <Starting />}
            {session.view === "restore_failed" && (
              <div className="flex h-full items-center justify-center bg-ground p-6">
                <div className="w-full max-w-md rounded-3xl border border-edge bg-raised p-8 text-center text-ink shadow-sm">
                  <span
                    className="mx-auto mb-5 flex size-12 items-center justify-center rounded-2xl bg-alert/10 text-alert"
                    aria-hidden="true"
                  >
                    <Icon name="alert" size={22} />
                  </span>
                  <h1 className="text-xl font-semibold tracking-tight">
                    Saved sign-ins could not be opened
                  </h1>
                  <p role="alert" className="mt-3 text-sm leading-relaxed text-ink-dim">
                    {platform.kind === "desktop"
                      ? "Unlock your system key store, or use the OS account that saved these sign-ins, and try again. The saved data is still on this device."
                      : "Browser storage could not be read. The saved data is kept; try again after resolving the storage problem."}
                  </p>
                  <div className="mt-7 flex flex-wrap justify-center gap-2">
                    <button
                      type="button"
                      className={buttonClass("primary")}
                      onClick={() => void restoreServers()}
                    >
                      Try again
                    </button>
                    <button
                      type="button"
                      className={buttonClass("secondary")}
                      onClick={() => {
                        setForgetError(false);
                        setForgetConfirm(true);
                      }}
                    >
                      Forget saved sign-ins
                    </button>
                  </div>
                </div>
              </div>
            )}
            {session.view === "join" && (
              <ErrorBoundary
                fallback={
                  <div
                    role="alert"
                    className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm"
                  >
                    <p>The screen for joining a workspace could not load.</p>
                    <button
                      type="button"
                      className={buttonClass("primary")}
                      onClick={() => window.location.reload()}
                    >
                      Reload
                    </button>
                  </div>
                }
              >
                <Suspense fallback={<Starting />}>
                  <JoinScreen
                    platform={platform}
                    savedServers={savedServers}
                    autoProbe={session.autoProbe}
                    inviteCode={session.inviteCode}
                    onConnected={(server, how) => {
                      const pending = pendingTarget.current;
                      pendingTarget.current = null;
                      openWorkspace(
                        server,
                        savedServers,
                        pending?.serverUrl === server.url
                          ? { channelId: pending.channelId, messageId: pending.messageId }
                          : null,
                        how?.founded,
                      );
                    }}
                    onForget={forgetServer}
                    onHostClick={platform.hosting ? () => setHostDialogOpen(true) : undefined}
                    hostingStatus={hosting.status}
                    hostingStatusError={hosting.error}
                    hostingStatusLoading={hosting.loading}
                    lastHosted={lastHosted}
                  />
                </Suspense>
              </ErrorBoundary>
            )}
            {session.view === "workspace" && (
              <WorkspaceScreen
                key={session.id}
                client={session.client}
                platform={platform}
                initialTarget={session.target ?? null}
                welcome={session.welcome}
                inviteAsk={inviteAsk}
                onLeaveWorkspace={leaveWorkspace}
                onSignedOut={() => endSession(session.server, session.client)}
                onAccountCreated={(token, handle) =>
                  // The same person, now with an account: open it again with
                  // the new session, which the guest one has given way to.
                  openWorkspace({ ...session.server, token, handle }, savedServersRef.current)
                }
                otherWorkspaces={savedServers
                  .filter((saved) => saved.url !== session.server.url)
                  .map((saved) => ({
                    url: saved.url,
                    name: saved.workspaceName,
                    handle: saved.handle,
                  }))}
                onOpenWorkspace={(url) => {
                  const saved = savedServersRef.current.find((s) => s.url === url);
                  if (saved) openWorkspace(saved, savedServersRef.current);
                }}
                banner={
                  saveError ? (
                    <Banner
                      tone="alert"
                      actions={<BannerAction onClick={retrySaving}>Retry saving</BannerAction>}
                    >
                      {saveErrorText}
                    </Banner>
                  ) : undefined
                }
                hosting={hostingLine}
                hostedHere={viewingHosted && !!hostingStatus?.running}
              />
            )}
            {hostDialogOpen && platform.hosting && (
              <LazyDialog loading="Loading hosting" onClose={() => setHostDialogOpen(false)}>
                <HostDialog
                  hosting={platform.hosting}
                  state={hosting}
                  viewingHosted={viewingHosted}
                  onClose={() => setHostDialogOpen(false)}
                  onInvite={() => {
                    setHostDialogOpen(false);
                    setInviteAsk((n) => n + 1);
                  }}
                  onStarted={(status) => {
                    setHostDialogOpen(false);
                    // A host that finishes starting must not replace a newer deep-link navigation.
                    if (navigation.current !== renderedNavigation) return;
                    const url = normalizeServerUrl(`localhost:${status.port}`);
                    // Already on screen, from Manage hosting: there is nothing to open.
                    if (openServerUrl.current === url) return;
                    leaveWorkspace();
                    setSession({ view: "join", autoProbe: url });
                  }}
                />
              </LazyDialog>
            )}
            {forgetConfirm && (
              <Dialog
                title="Forget saved sign-ins?"
                onClose={() => {
                  if (!forgetBusy) setForgetConfirm(false);
                }}
                dismissible={!forgetBusy}
              >
                <p className="text-sm text-ink-dim">
                  Remove saved sign-ins on this device and sign in again. Drafts, queued messages
                  and hosted workspaces stay on this device.
                </p>
                {forgetError && (
                  <p role="alert" className="mt-3 text-sm text-alert">
                    Could not update saved sign-ins. Check access to the settings file and retry.
                  </p>
                )}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    className={buttonClass("quiet")}
                    disabled={forgetBusy}
                    onClick={() => setForgetConfirm(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={buttonClass("primary")}
                    disabled={forgetBusy}
                    onClick={() => void forgetSavedSignIns()}
                  >
                    {forgetBusy ? "Forgetting…" : "Forget and sign in again"}
                  </button>
                </div>
              </Dialog>
            )}
          </div>
        </div>
      </AppBoundary>
    </PlatformContext.Provider>
  );
}
