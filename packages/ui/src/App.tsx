import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { normalizeServerUrl, WorkspaceClient } from "@ownbase/client-core";
import { TITLE_BAR_HEIGHT } from "@ownbase/protocol/desktop";
import { PlatformContext } from "./context.js";
import type { Platform, SavedServer } from "./platform.js";
import { parseDeepLink } from "./lib/deeplink.js";
import { normalizeServerUrlSafe } from "./lib/deeplinkHelpers.js";
import { WorkspaceScreen } from "./screens/WorkspaceScreen.js";
import { Dialog } from "./components/Dialog.js";
import { Icon } from "./components/Icon.js";
import { LazyDialog } from "./components/LazyView.js";
import { useHostingStatus, useLastHosted } from "./lib/hosting.js";
import { useApplyAppearance } from "./lib/appearance.js";
import { buttonClass } from "./components/Button.js";
import { Banner, BannerAction } from "./components/Banner.js";
import type { HostingEntry, HostingLine } from "./components/Sidebar.js";

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
import { changeSavedServers, parseSavedServers, type SignInChange } from "./lib/savedServers.js";
import { hostedButStopped } from "./lib/resume.js";
import { forgetCachedIcon, useCachedWorkspaceIcons } from "./lib/workspaceIcon.js";
import type { SignedOutFrom, SignedOutHow } from "./lib/signOut.js";
import { railOrder } from "./lib/workspaceRail.js";
import { useOtherWorkspacesUnread } from "./lib/otherUnread.js";
import { navigationOf } from "./lib/navigation.js";

type Session =
  | { view: "loading" }
  | { view: "restore_failed" }
  | {
      view: "join";
      autoProbe?: string;
      inviteCode?: string;
      claimCode?: string;
      /** Back from the workspace's single sign-on, with the code that signs in (P9). */
      ssoCode?: string;
      /** The workspace ended this sign-in: say so, and offer to sign in there again. */
      signedOut?: SignedOutFrom;
    }
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

/** Where the open workspace sits on the rail, among this device's saved ones. */
function railPlace(saved: SavedServer[], open: SavedServer): number {
  const order = railOrder(saved.some((s) => s.url === open.url) ? saved : [...saved, open]);
  return Math.max(
    0,
    order.findIndex((s) => s.url === open.url),
  );
}

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
  /** The tab Manage hosting opens on, when something asked for one. */
  const [hostSection, setHostSection] = useState<"internet" | undefined>(undefined);
  const hosting = useHostingStatus(platform.hosting);
  const savedIcons = useCachedWorkspaceIcons(
    platform,
    savedServers.map((s) => s.url),
  );
  const lastHosted = useLastHosted(platform.hosting, hosting.status);
  // What waits in the workspaces not open, for their places on the rail.
  const openUrl = session.view === "workspace" ? session.server.url : null;
  const otherUnread = useOtherWorkspacesUnread(
    openUrl === null
      ? []
      : savedServers.filter((s) => s.url !== openUrl).map((s) => ({ url: s.url, token: s.token })),
  );
  const clientRef = useRef<WorkspaceClient | null>(null);
  const connectionId = useRef(0);
  const navigation = useRef(0);
  const renderedNavigation = navigation.current;
  const restoredServers = useRef(false);
  const saveVersion = useRef(0);
  const serverTurns = useRef<Promise<void>>(Promise.resolve());
  /** The change that could not be saved, for Retry. */
  const unsaved = useRef<SignInChange | null>(null);
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
   * and other windows of this browser kept waiting where the browser can. It
   * cannot over plain http, where there is no `navigator.locks`; there the
   * store makes each change in one step instead (`changeSignIns`).
   */
  const serversTurn = useCallback(<T,>(turn: () => Promise<T>): Promise<T> => {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    const taken = serverTurns.current.then(() =>
      locks ? (locks.request("ownbase:saved-sign-ins", turn) as Promise<T>) : turn(),
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
   * one turn, or by the store in one step; what is stored then is what this
   * window goes on to show.
   */
  const changeServers = useCallback(
    async (change: SignInChange) => {
      const version = ++saveVersion.current;
      // Shown at once. What was stored takes its place when the turn is done.
      savedServersRef.current = changeSavedServers(savedServersRef.current, change);
      setSavedServers(savedServersRef.current);
      try {
        const next = await serversTurn(async () => {
          if (platform.storage.changeSignIns) {
            const stored = await platform.storage.changeSignIns("servers", change);
            if (!stored) throw new Error("Could not read saved sign-ins.");
            return stored;
          }
          // Strict: a list that cannot be read is never written over.
          const stored = parseSavedServers(
            await platform.storage.get<unknown>("servers", { strict: true }),
          );
          const changed = changeSavedServers(stored, change);
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
      // A sign-in this window already held, as against one just made.
      const held = list.some((s) => s.url === server.url && s.token === server.token);
      void changeServers({ kind: "use", server: { ...server, lastUsedAt: Date.now() }, held });
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
        // A sign-in just made elsewhere, whatever this device held before.
        if (link.kind === "sso") {
          closeWorkspace();
          setSession({ view: "join", autoProbe: link.serverUrl, ssoCode: link.code });
          return;
        }
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
            ...(link.kind === "claim"
              ? { claimCode: link.code }
              : { inviteCode: link.code ?? undefined }),
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

  const leaveWorkspace = useCallback(
    (signedOut?: SignedOutFrom) => {
      navigation.current++;
      pendingTarget.current = null;
      closeWorkspace();
      setSession({ view: "join", signedOut });
    },
    [closeWorkspace],
  );

  const forgetServer = useCallback(
    (url: string) => {
      void changeServers({ kind: "forget", url });
      void forgetCachedIcon(platform, url);
    },
    [changeServers, platform],
  );

  const endSession = useCallback(
    (server: SavedServer, client: WorkspaceClient, how?: SignedOutHow) => {
      // A late logout response must not remove a newer sign-in to the same workspace.
      void changeServers({ kind: "signOut", url: server.url, token: server.token });
      if (clientRef.current !== client) return;
      leaveWorkspace(
        how === "ended"
          ? { url: server.url, handle: server.handle, workspaceName: server.workspaceName }
          : undefined,
      );
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
      const forgotten = savedServersRef.current.map((s) => s.url);
      await serversTurn(() => platform.storage.set("servers", []));
      for (const url of forgotten) void forgetCachedIcon(platform, url);
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

  const saveErrorText = `Could not save your sign-ins on this device. You can keep working.${
    platform.kind === "desktop"
      ? " Unlock your computer's password store, then press Retry saving. OwnBase never saves a sign-in without protecting it."
      : " Check that your browser lets this site store data, then press Retry saving before you close the tab."
  }`;
  // Shown only while a change is unsaved, which it makes again.
  const retrySaving = () => {
    if (unsaved.current) void changeServers(unsaved.current);
  };
  // In a workspace it waits its turn in the one banner place there (UX-25).
  const saveErrorAbove = saveError && session.view !== "workspace";
  const hostingStatus = hosting.status;
  // The workspace this computer hosts, however it was reached: by this
  // computer's own name for it, an address on the network (as "On your
  // network" offers it), or the address it is open to all on.
  const viewedUrl = session.view === "workspace" ? session.server.url : null;
  const hostedUrls =
    hostingStatus?.port === undefined
      ? []
      : [
          `localhost:${hostingStatus.port}`,
          `127.0.0.1:${hostingStatus.port}`,
          ...(hostingStatus.lanUrls ?? []),
          ...(hostingStatus.openToAll?.phase === "open" ? [hostingStatus.openToAll.url] : []),
          ...(hostingStatus.publicAddress ? [hostingStatus.publicAddress] : []),
        ];
  const viewingHosted =
    viewedUrl !== null && hostedUrls.some((url) => normalizeServerUrlSafe(url) === viewedUrl);
  const openHosting = (section?: "internet") => {
    setHostSection(section);
    setHostDialogOpen(true);
  };
  const hostingEntry: HostingEntry | undefined = platform.hosting
    ? { running: !!hostingStatus?.running, open: openHosting }
    : undefined;
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
                    : viewingHosted
                      ? // The sidebar names the workspace just above, and the
                        // line has room for about 22 characters beside Manage.
                        hostingStatus?.openToAll?.phase === "open"
                        ? "Hosting · public link"
                        : "Hosting here"
                      : `Hosting ${hostingStatus?.workspaceName ?? "a workspace"} on this computer${hostingStatus?.openToAll?.phase === "open" ? " · public link" : ""}`,
          state:
            hosting.error || hostingStatus?.warning || hostingStatus?.openToAllError
              ? "trouble"
              : hostingStatus?.running
                ? "live"
                : "busy",
          alert: !!(hostingStatus?.warning || hostingStatus?.openToAllError),
          onManage: openHosting,
        }
      : undefined;

  return (
    <PlatformContext.Provider value={platform}>
      <Appearance />
      <AppBoundary>
        <div className="flex h-full flex-col">
          {platform.kind === "desktop" &&
            (saveErrorAbove || session.view === "loading" || session.view === "restore_failed") && (
              <div
                className="titlebar-drag shrink-0 border-b border-edge"
                style={{ height: TITLE_BAR_HEIGHT }}
              />
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
                    OwnBase could not open your saved sign-ins
                  </h1>
                  <p role="alert" className="mt-3 text-sm leading-relaxed text-ink-dim">
                    {platform.kind === "desktop"
                      ? "Unlock your computer's password store, or sign in to the computer account that saved them. Then press Try again. Your sign-ins are still on this device."
                      : "Your browser would not let OwnBase read what it saved. Nothing was deleted. Check that your browser lets this site store data, then press Try again."}
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
                    savedIcons={savedIcons}
                    autoProbe={session.autoProbe}
                    inviteCode={session.inviteCode}
                    claimCode={session.claimCode}
                    ssoCode={session.ssoCode}
                    signedOut={session.signedOut}
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
                    onHostClick={platform.hosting ? () => openHosting() : undefined}
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
                onLeaveWorkspace={() => leaveWorkspace()}
                onSignedOut={(how) => endSession(session.server, session.client, how)}
                onAccountCreated={(token, handle) =>
                  // The same person, now with an account: open it again with
                  // the new session, which the guest one has given way to.
                  openWorkspace({ ...session.server, token, handle }, savedServersRef.current)
                }
                otherWorkspaces={railOrder(savedServers)
                  .filter((saved) => saved.url !== session.server.url)
                  .map((saved) => ({
                    url: saved.url,
                    name: saved.workspaceName,
                    handle: saved.handle,
                    icon: savedIcons[saved.url],
                    waiting: otherUnread[saved.url],
                  }))}
                railPlace={railPlace(savedServers, session.server)}
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
                hostingEntry={hostingEntry}
                hostedHere={viewingHosted && !!hostingStatus?.running}
              />
            )}
            {hostDialogOpen && platform.hosting && (
              <LazyDialog loading="Loading hosting" onClose={() => setHostDialogOpen(false)}>
                <HostDialog
                  hosting={platform.hosting}
                  state={hosting}
                  viewingHosted={viewingHosted}
                  initialSection={hostSection}
                  onClose={() => setHostDialogOpen(false)}
                  onInvite={() => {
                    setHostDialogOpen(false);
                    if (session.view === "workspace")
                      navigationOf(session.client)?.navigate({
                        to: "dialog",
                        dialog: { kind: "invite" },
                      });
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
                  This removes the sign-ins saved on this device. Then you sign in again. Drafts,
                  messages waiting to send and workspaces you host stay on this device.
                </p>
                {forgetError && (
                  <p role="alert" className="mt-3 text-sm text-alert">
                    Could not remove the saved sign-ins. Check that OwnBase can save to this device,
                    then try again.
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
