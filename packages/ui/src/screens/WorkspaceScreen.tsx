import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ID } from "@ownbase/protocol";
import { TITLE_BAR_HEIGHT } from "@ownbase/protocol/desktop";
import { BlockedComposer, DeactivatedComposer } from "../components/Blocking.js";
import {
  WorkspaceClient,
  blockedPartner,
  deactivatedPartner,
  mentionsElsewhere,
  waitsForAttention,
} from "@ownbase/client-core";
import { ClientContext, OpenMessageContext, useClient, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";
import { channelTitle } from "../lib/format.js";
import {
  HostingStatus,
  Sidebar,
  type HostingEntry,
  type HostingLine,
  type OtherWorkspace,
} from "../components/Sidebar.js";
import { JumpToLatestBar, MessageTimeline } from "../components/MessageTimeline.js";
import { Composer } from "../components/Composer.js";
// In the first frame with the sidebar it sits above: loaded later, it pushed
// the channels down under the pointer. Shown only to an owner, and small.
import { GettingStarted } from "../components/GettingStarted.js";
import { useHuddleView } from "../lib/huddleView.js";
import { useHuddleEndedNotice } from "../lib/huddleEnded.js";
import { useCallPreferences, useDeviceCheckEndsWithScreen } from "../lib/callPreferences.js";
import { previewAccount, previewFor, useNotificationPreviews } from "../lib/notificationPreview.js";
import { focusOrigin } from "../lib/opener.js";
import { useFocusedView } from "../lib/focusedView.js";
import { HuddleButton } from "../components/HuddleButton.js";
import { Banner, BannerAction, BannerQueue } from "../components/Banner.js";
import { MemberNoticeBanner } from "../components/MemberNotice.js";
import { ServerNoticeBanner } from "../components/ServerNotice.js";
import { UpdateBanner, useReportCall } from "../components/Updates.js";
import {
  ConversationMenu,
  ConversationSearch,
  MemberStack,
  PinnedBar,
} from "../components/ConversationHeader.js";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import { Icon } from "../components/Icon.js";
import { Badge } from "../components/Badge.js";
import { DraftPersistence } from "../components/DraftPersistence.js";
import { useMessageAnnouncer } from "../components/MessageAnnouncer.js";
import { WorkspaceStorageGate } from "../components/WorkspaceStorageGate.js";
import { ShareableServerProvider } from "../components/ShareableServer.js";
import { hasOpenModal } from "../components/Modal.js";
import { useLastConversation } from "../lib/lastConversation.js";
import { useRecentConversations } from "../lib/recentConversations.js";
import { useRememberWorkspaceIcon } from "../lib/workspaceIcon.js";
import { useMediaQuery } from "../lib/useMediaQuery.js";
import { NARROW_QUERY, WIDE_QUERY } from "../lib/layout.js";
import { useHistoryKeys } from "../lib/historyKeys.js";
import { useIdleReport } from "../lib/idle.js";
import { PartnerTime } from "../components/PartnerTime.js";
import { draftPlace } from "@ownbase/client-core";
import { PhoneNavigation } from "../components/PhoneNavigation.js";
import { EmptyState } from "../components/EmptyState.js";
import { signedOutHow, type SignedOutHow } from "../lib/signOut.js";
import {
  Navigation,
  NavigationContext,
  inView,
  reading,
  registerNavigation,
  useNavigation,
  useNavigationState,
} from "../lib/navigation.js";
import {
  WorkspaceShellContext,
  useWorkspaceShell,
  type WorkspaceShell,
} from "../lib/workspaceShell.js";
import { action, runAction, useActionContext, useGlobalKeys } from "../lib/actions.js";
import { startNotifications } from "../lib/notifications.js";
import { OpenDialog, SidePanel } from "./workspaceViews.js";
import { preloadAll } from "../lib/preloadable.js";

// Asked once per device, and only by a browser that has not answered yet.
const NotificationBanner = lazy(() =>
  import("../components/NotificationBanner.js").then((module) => ({
    default: module.NotificationBanner,
  })),
);
/** Which microphone and camera to use, asked once before a first huddle. */
const DeviceCheckDialog = lazy(() =>
  import("../components/DeviceCheckDialog.js").then((module) => ({
    default: module.DeviceCheckDialog,
  })),
);
/** The bar for a call in progress, fetched when one starts. */
const HuddleBar = lazy(() =>
  import("../components/HuddleBar.js").then((module) => ({ default: module.HuddleBar })),
);
/** A direct message's huddle ringing this account (E10), fetched when one rings. */
const IncomingCall = lazy(() =>
  import("../components/IncomingCall.js").then((module) => ({ default: module.IncomingCall })),
);
/** A form an app opens, which most sessions never see. */
const ViewModal = lazy(() =>
  import("../components/ViewModal.js").then((module) => ({ default: module.ViewModal })),
);
/** The video stage, shown only during a call with video. */
const HuddleStage = lazy(() =>
  import("../components/HuddleStage.js").then((module) => ({ default: module.HuddleStage })),
);

interface Props {
  client: WorkspaceClient;
  platform: Platform;
  /** A message to open on arrival, from a link to it. */
  initialTarget?: { channelId: ID; messageId: ID } | null;
  /** This account just founded the workspace: open on inviting people (UX-42). */
  welcome?: boolean;
  onLeaveWorkspace: () => void;
  /** "ended": the server ended this sign-in, nobody here chose to. */
  onSignedOut: (how?: SignedOutHow) => void;
  /** A guest kept its identity as an account; carry on with this token. */
  onAccountCreated?: (token: string, handle: string) => void;
  /** This device's other saved workspaces, for the sidebar's switcher. */
  otherWorkspaces?: OtherWorkspace[];
  /** Where this workspace sits among `otherWorkspaces` on the rail; first when absent. */
  railPlace?: number;
  onOpenWorkspace?: (url: string) => void;
  /**
   * A banner from outside this workspace, such as sign-ins this device could
   * not save. It takes the banner place unless a message could not be opened.
   */
  banner?: ReactNode;
  /** This computer's hosting, shown in the sidebar's header. */
  hosting?: HostingLine;
  /** This computer hosts the workspace on screen, so Manage hosting can change it too. */
  hostedHere?: boolean;
  /** Manage hosting, for the workspace menu and Ctrl+K, in the desktop app. */
  hostingEntry?: HostingEntry;
}

export function WorkspaceScreen({ client, initialTarget, welcome, banner, ...rest }: Props) {
  const others = rest.otherWorkspaces ?? [];
  const shell: WorkspaceShell = {
    platform: rest.platform,
    otherWorkspaces: others,
    railPlace: Math.min(rest.railPlace ?? 0, others.length),
    onOpenWorkspace: rest.onOpenWorkspace,
    onLeaveWorkspace: rest.onLeaveWorkspace,
    onSignedOut: rest.onSignedOut,
    onAccountCreated: rest.onAccountCreated,
    hosting: rest.hosting,
    hostedHere: rest.hostedHere,
    hostingEntry: rest.hostingEntry,
  };
  return (
    <ClientContext.Provider value={client}>
      <WorkspaceShellContext.Provider value={shell}>
        <div className="flex h-full min-h-0 flex-col">
          {/* Room for the window's own controls, drawn over the window's surface. */}
          {rest.platform.kind === "desktop" && <TitleBar />}
          <div className="min-h-0 flex-1">
            <WorkspaceStorageGate
              client={client}
              platform={rest.platform}
              onLeaveWorkspace={rest.onLeaveWorkspace}
              onSignedOut={rest.onSignedOut}
              // Until the workspace opens: a hosted one that will not start must
              // still offer Manage hosting.
              banner={banner}
              footer={
                rest.hosting && (
                  <HostingStatus hosting={rest.hosting} className="mx-auto mt-6 w-72 text-left" />
                )
              }
            >
              <ShareableServerProvider platform={rest.platform}>
                <WorkspaceNavigation
                  initialTarget={initialTarget ?? null}
                  welcome={welcome}
                  banner={banner}
                />
              </ShareableServerProvider>
            </WorkspaceStorageGate>
          </div>
        </div>
      </WorkspaceShellContext.Provider>
    </ClientContext.Provider>
  );
}

/** Where the workspace screen is, kept for its life and followed by the address. */
function WorkspaceNavigation(props: {
  initialTarget: { channelId: ID; messageId: ID } | null;
  welcome?: boolean;
  banner?: ReactNode;
}) {
  const client = useClient();
  const { initialTarget } = props;
  const [{ navigation, fromRoute }] = useState(() =>
    Navigation.open(client, { target: initialTarget, welcome: props.welcome }),
  );
  useEffect(() => registerNavigation(client, navigation), [client, navigation]);
  useEffect(() => navigation.attach(), [navigation]);
  // A link to a message, on arrival or later: the screen keeps its key across
  // deep links, so it goes there without remounting.
  useEffect(() => {
    if (initialTarget) navigation.navigate({ to: "message", ...initialTarget });
  }, [navigation, initialTarget]);
  const openMessage = useMemo(
    () => (channelId: ID, messageId: ID) =>
      navigation.navigate({ to: "message", channelId, messageId }),
    [navigation],
  );
  return (
    <NavigationContext.Provider value={navigation}>
      <OpenMessageContext.Provider value={openMessage}>
        <WorkspaceLayout restore={!initialTarget && !fromRoute} banner={props.banner} />
      </OpenMessageContext.Provider>
    </NavigationContext.Provider>
  );
}

/**
 * Picks where to be when nothing says: the conversation this account last
 * had open here, once it has been read, or #general (or the first channel).
 * Moves away from a conversation this account cannot see or that has gone,
 * saying so, and pointing to Drafts for what it was writing there.
 */
function useConversationFallback(restore: boolean) {
  const nav = useNavigation();
  const client = useClient();
  const status = useWorkspace((s) => s.status);
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const selfId = useWorkspace((s) => s.self?.id);
  const channelId = useNavigationState((s) => s.channelId);
  const lastConversation = useLastConversation();
  const restoring = useRef(restore);
  /**
   * What each conversation seen here was called, kept after it goes: the
   * note on moving away from one this account just lost can then name it.
   */
  const seenTitles = useRef(new Map<ID, string>());
  for (const channel of Object.values(channels))
    seenTitles.current.set(
      channel.id,
      channel.type === "public" || channel.type === "private"
        ? `#${channel.name}`
        : channelTitle(channel, users, selfId),
    );

  useEffect(() => {
    if (channelId && !(status === "online" && !channels[channelId])) return;
    const list = Object.values(channels).filter((c) => !c.archived);
    const general = list.find((c) => c.name === "general") ?? list[0];
    if (!general) return;
    if (!channelId && restoring.current) {
      if (lastConversation.remembered === undefined) return;
      restoring.current = false;
      const last = lastConversation.remembered && channels[lastConversation.remembered];
      if (last && !last.archived) return nav.settle(last.id);
    }
    if (!channelId) return nav.settle(general.id);
    // One this screen had: the account was removed from it, or it went,
    // while it was open. Its unsent words stay in Drafts (listDrafts).
    const lost = seenTitles.current.get(channelId);
    const unsent = Object.keys(client.state.drafts).some(
      (key) => draftPlace(key)?.channelId === channelId,
    );
    const note = lost
      ? `You no longer have access to ${lost}.${unsent ? " What you were writing there is in Drafts." : ""}`
      : "That conversation is not available. Someone may have deleted it, or you may not have access to it.";
    nav.settle(general.id, { note, drafts: unsent });
  }, [channels, channelId, status, lastConversation.remembered, nav, client]);

  const { remember } = lastConversation;
  const rememberRecent = useRecentConversations().remember;
  useEffect(() => {
    if (channelId && status === "online" && channels[channelId]) {
      remember(channelId);
      rememberRecent(channelId);
    }
  }, [channelId, channels, status, remember, rememberRecent]);

  // A closed conversation opened again, from Ctrl+K or a link, is back in the
  // sidebar. Only on arriving: closing the open one leaves it closed.
  useEffect(() => {
    if (!channelId) return;
    const hidden = client.state.prefs[channelId]?.hiddenSeq;
    if (hidden !== null && hidden !== undefined)
      client.setChannelPrefs(channelId, { hiddenSeq: null });
  }, [channelId, client]);

  useEffect(() => {
    client.focusConversation(channelId);
    return () => client.focusConversation(null);
  }, [client, channelId]);
}

/**
 * The phone drawer: focus moves into it and Tab stays inside, and it closes
 * when the window grows wide enough for the sidebar to sit beside the rest.
 */
function useDrawer() {
  const nav = useNavigation();
  const open = useNavigationState((s) => s.drawer);
  useEffect(() => {
    if (!open) return;
    const sidebar = document.querySelector<HTMLElement>('[aria-label="Workspace navigation"]');
    const previous = focusOrigin();
    // Jump to…, not the first button: the rail's buttons show a tooltip on
    // focus, which would take the Escape meant to close the drawer.
    (
      sidebar?.querySelector<HTMLElement>("[data-drawer-focus]") ??
      sidebar?.querySelector<HTMLElement>("button")
    )?.focus();
    const onTab = (event: KeyboardEvent) => {
      if (event.defaultPrevented || hasOpenModal() || event.key !== "Tab") return;
      const buttons = [
        ...(sidebar?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
      ].filter((button) => button.getClientRects().length > 0);
      const first = buttons[0];
      const last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onTab);
    return () => {
      window.removeEventListener("keydown", onTab);
      // A newly opened dialog owns focus now; do not pull it back out.
      if (previous?.isConnected && !document.activeElement?.closest('[role="dialog"]'))
        previous.focus();
    };
  }, [open]);

  useEffect(() => {
    const wide = window.matchMedia(WIDE_QUERY);
    const onResize = () => {
      if (wide.matches && nav.state.drawer) nav.closeDrawer();
    };
    wide.addEventListener("change", onResize);
    return () => wide.removeEventListener("change", onResize);
  }, [nav]);
}

function WorkspaceLayout(props: { restore: boolean; banner?: ReactNode }) {
  const client = useClient();
  const nav = useNavigation();
  const shell = useWorkspaceShell();
  const { platform } = shell;
  const actions = useActionContext();
  const status = useWorkspace((s) => s.status);
  // So the saved workspaces show this one's icon while its server is off.
  useRememberWorkspaceIcon(platform);
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const self = useWorkspace((s) => s.self);
  // Every device of an account idle makes it away (E9).
  useIdleReport(client);
  const calls = useCallPreferences();
  useDeviceCheckEndsWithScreen();
  const channelId = useNavigationState((s) => s.channelId);
  const panel = useNavigationState((s) => s.panel);
  const drawer = useNavigationState((s) => s.drawer);
  const error = useNavigationState((s) => s.error);
  const lostDraftsNote = useNavigationState((s) => s.lostDraftsNote);
  const navigating = useNavigationState((s) => s.navigating);
  const highlightId = useNavigationState((s) => s.highlightId);
  const channelRead = useNavigationState((s) => reading(s).channel);
  const channelInView = useNavigationState((s) => inView(s).channel);
  const threadInView = useNavigationState((s) => inView(s).thread);
  const huddleRoom = useRef(channelId);
  huddleRoom.current = channelId;
  useConversationFallback(props.restore);
  useDrawer();
  useGlobalKeys();
  useHistoryKeys(platform.kind === "desktop");

  // Below a laptop's width a side panel covers the conversation, as theme.css
  // lays it out, so what it covers leaves the Tab order and the screen
  // reader's reading as the page does behind a dialog. The main landmark
  // around it stays, so the page still has one.
  const narrow = useMediaQuery(NARROW_QUERY);
  const panelCovers = narrow && panel.kind !== "none";
  const [huddleView, setHuddleView] = useHuddleView();
  const inHuddle = useWorkspace((s) => !!s.huddle);
  // An update never restarts the app during a call.
  useReportCall(inHuddle);
  useHuddleEndedNotice();
  const rungHere = useWorkspace((s) =>
    Object.values(s.rings).some((ring) => !!s.self && ring.ringing.includes(s.self.id)),
  );
  // Wide enough for the chat beside the call with room left for a share, as
  // Discord shows a voice channel's. The choice to hide it lasts the session.
  const roomForChat = useMediaQuery("(min-width: 1280px)");
  const [callChat, setCallChat] = useState(true);
  const callShown = inHuddle && huddleView === "call";
  const chatBeside = callShown && roomForChat && callChat;
  /** The call covers the chat, which stays mounted underneath so it keeps its place. */
  const chatCovered = callShown && !chatBeside;
  useLayoutEffect(() => {
    nav.setCover({ panel: panelCovers, call: chatCovered });
  }, [nav, panelCovers, chatCovered]);
  // Another conversation, opened while the call covers the chat, is there to be read.
  const lastChannel = useRef(channelId);
  useEffect(() => {
    if (lastChannel.current === channelId) return;
    lastChannel.current = channelId;
    if (nav.state.cover.call) setHuddleView("chat");
  }, [channelId, nav, setHuddleView]);

  useEffect(preloadAll, []);

  const activeChannel = channelId ? channels[channelId] : undefined;
  const title = activeChannel ? channelTitle(activeChannel, users, self?.id) : "";
  const isRoom = activeChannel?.type === "public" || activeChannel?.type === "private";
  /** A public channel can be looked into without joining, and then has no settings of one's own. */
  const isMember = useWorkspace((s) => !!channelId && channelId in s.memberships);
  /** Whom this conversation is with, when it is a DM with someone blocked (E12). */
  const blockedHere = useWorkspace((s) =>
    channelId ? blockedPartner(s.channels[channelId], s.self?.id, s.blocked) : null,
  );
  /** Whom this conversation is with, when it is a DM with a deactivated account. */
  const deactivatedHere = useWorkspace((s) =>
    channelId ? deactivatedPartner(s.channels[channelId], s.self?.id, s.users) : null,
  );

  const announcer = useMessageAnnouncer();
  const { hear, forget } = announcer;
  // Read when a message arrives, so a change of choice applies to the next
  // notification without starting the notifications again.
  const previews = useNotificationPreviews();
  const account = self ? previewAccount(client.baseUrl, self.id) : null;
  const preview = previewFor(previews, account);
  const current = useRef({ preview, account });
  current.current = { preview, account };
  // A browser that turned on notifications while closed tells this session
  // the server's way to reach it, and how much it may say. Loaded only in a
  // browser: the desktop app notifies on its own.
  useEffect(() => {
    if (platform.kind === "desktop" || !account || !previews.loaded) return;
    void import("../lib/webPush.js")
      .then(({ keepPushCurrent }) =>
        keepPushCurrent({
          platform,
          account,
          preview,
          send: (body) => client.account.keepPushSubscription(body),
        }),
      )
      .catch(() => {});
  }, [platform, account, preview, previews.loaded, client]);
  // Other windows of this account, in this browser, stay quiet about what
  // this one shows while it has focus.
  useFocusedView(account, {
    channelId,
    threadRootId: panel.kind === "thread" ? panel.rootId : null,
    channelVisible: channelInView,
    threadVisible: threadInView,
  });
  // What the last conversation received is not news in the next one.
  useEffect(() => forget(), [channelId, forget]);
  // Started as the screen commits, not after: a message arriving between a
  // conversation appearing and a passive effect running would otherwise be
  // missed.
  useLayoutEffect(
    () =>
      startNotifications({
        client,
        navigation: nav,
        platform,
        preview: () => current.current.preview,
        account: () => current.current.account,
        hear,
      }),
    [client, nav, platform, hear],
  );

  useEffect(() => {
    // Signing out is what leads back to the screen that can replace a password:
    // signing in again lands on it, holding the password it needs to replace.
    if (status === "auth_failed" || status === "password_change_required")
      shell.onSignedOut(signedOutHow(client, status));
  }, [status, shell, client]);

  const callLog = () =>
    nav.navigate({ to: "dialog", dialog: { kind: "diagnostics", callLog: true } });
  const callSettings = () =>
    nav.navigate({ to: "dialog", dialog: { kind: "account", section: "calls" } });
  const details = useCallback(
    () => nav.navigate({ to: "dialog", dialog: { kind: "channel-details" } }),
    [nav],
  );
  const invite = action("invite");
  // What the timeline is handed stays the same from one render to the next.
  // This layout renders for many things that are not the conversation's (a
  // call starting, a dialog, a channel or a person changing), and a handler
  // made anew each time had every message on screen rendered again with it,
  // and React keeping a second copy of each: about 14 MiB for a full history.
  const openThread = useCallback((rootId: ID) => nav.navigate({ to: "thread", rootId }), [nav]);
  const openConversation = useCallback(
    (id: ID) => nav.navigate({ to: "conversation", channelId: id }),
    [nav],
  );
  const openProfile = useCallback(
    (userId: ID) => nav.navigate({ to: "dialog", dialog: { kind: "profile", userId } }),
    [nav],
  );
  const canInvite = invite.available(actions);
  const latestActions = useRef(actions);
  latestActions.current = actions;
  const runInvite = useCallback(() => invite.run(latestActions.current), [invite]);

  return (
    <div className={`workspace-shell relative flex h-full ${drawer ? "sidebar-open" : ""}`}>
      <DraftPersistence platform={platform} />
      {/* Outside main, whose content goes inert while the phone drawer is open. */}
      {announcer.region}
      {drawer && (
        <button
          className="sidebar-dismiss fixed inset-0 z-30"
          aria-label="Close navigation"
          onClick={() => nav.closeDrawer()}
        />
      )}
      <Sidebar
        gettingStarted={
          self?.role === "owner" && (
            <ErrorBoundary fallback={<span hidden />}>
              <GettingStarted
                onNewChannel={() => runAction(actions, "new-channel")}
                onInvite={() => runAction(actions, "invite")}
                onNotifications={() =>
                  nav.navigate({
                    to: "dialog",
                    dialog: { kind: "account", section: "notifications" },
                  })
                }
                onNameWorkspace={() => runAction(actions, "workspace-settings")}
                activeChannelName={activeChannel && isRoom ? `#${activeChannel.name}` : null}
                onTryHuddle={() => {
                  if (!channelId) return;
                  const ticket = nav.moves;
                  if (nav.state.drawer) nav.closeDrawer();
                  calls
                    .joinHuddle(
                      client,
                      channelId,
                      () => nav.current(ticket) && huddleRoom.current === channelId,
                    )
                    .catch((err: unknown) => {
                      nav.showError(
                        err instanceof Error
                          ? `Could not start a huddle: ${err.message}`
                          : "Could not start a huddle. Check your connection and try again.",
                      );
                    });
                }}
              />
            </ErrorBoundary>
          )
        }
      />

      <main className="workspace-main flex min-w-0 flex-1 flex-col">
        {/* What the drawer or a side panel covers goes inert, but the landmark
            itself stays, so the page always has its one main. */}
        <div inert={drawer || panelCovers} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="channel-header titlebar-drag flex h-12 shrink-0 items-center gap-1 pl-2 pr-2 shadow-[0_1px_0_var(--color-edge)]">
            <NavigationToggle activeChannelId={channelId} open={drawer} />
            <button
              onClick={() => channelId && details()}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-ink/[0.04]"
            >
              <h2 className="shrink-0 truncate text-[16px] font-semibold leading-tight">
                {isRoom ? (
                  <>
                    <span className="mr-1 font-normal text-ink-faint">#</span>
                    {title}
                  </>
                ) : (
                  title || "…"
                )}
              </h2>
              {activeChannel?.topic && (
                <>
                  <span aria-hidden="true" className="channel-topic h-5 w-px shrink-0 bg-edge" />
                  <p className="channel-topic min-w-0 truncate text-[13px] text-ink-faint">
                    {activeChannel.topic}
                  </p>
                </>
              )}
              {activeChannel?.type === "dm" && <PartnerTime channelId={activeChannel.id} />}
            </button>
            {channelId && (
              <ConversationSearch
                title={isRoom ? `#${title}` : title}
                onSearch={() =>
                  nav.navigate({ to: "dialog", dialog: { kind: "search", inConversation: true } })
                }
              />
            )}
            {channelId && (
              <div className="flex shrink-0 items-center gap-1">
                {activeChannel?.type !== "dm" && (
                  <MemberStack
                    channelId={channelId}
                    pressed={panel.kind === "members"}
                    onToggle={() => nav.navigate({ to: "toggle-panel", kind: "members" })}
                  />
                )}
                {!deactivatedHere && <HuddleButton channelId={channelId} />}
                <ConversationMenu
                  channelId={channelId}
                  isRoom={isRoom}
                  onPins={() => nav.navigate({ to: "panel", panel: { kind: "pins" } })}
                  onFiles={() => nav.navigate({ to: "panel", panel: { kind: "files", channelId } })}
                  onNotifications={
                    isMember
                      ? () =>
                          nav.navigate({
                            to: "dialog",
                            dialog: { kind: "channel-details", tab: "notifications" },
                          })
                      : undefined
                  }
                  onDetails={details}
                />
              </div>
            )}
          </header>
          {channelId && (
            <PinnedBar
              channelId={channelId}
              open={panel.kind === "pins"}
              onToggle={() => nav.navigate({ to: "toggle-panel", kind: "pins" })}
            />
          )}
          {/* One banner at a time, the most pressing (UX-25): a message that could
              not be opened, then what the app could not save, then the ask to
              turn on notifications, then a message on its way, then what
              the server's extensions say (P6), then a new version of the
              desktop app, then a workspace with more members than its plan
              includes (P5). */}
          <BannerQueue
            banners={[
              error && (
                <Banner
                  tone="alert"
                  actions={
                    <>
                      {error === lostDraftsNote && (
                        <BannerAction
                          onClick={() => {
                            nav.dismissError();
                            nav.navigate({ to: "panel", panel: { kind: "drafts" } });
                          }}
                        >
                          Show drafts
                        </BannerAction>
                      )}
                      <BannerAction onClick={() => nav.dismissError()}>Dismiss</BannerAction>
                    </>
                  }
                >
                  {error}
                </Banner>
              ),
              props.banner,
              platform.kind !== "desktop" &&
                typeof Notification !== "undefined" &&
                ((onShowing) => (
                  // The ask is a courtesy: if it cannot load, the workspace carries on without it.
                  <ErrorBoundary fallback={<span hidden />}>
                    <Suspense fallback={null}>
                      <NotificationBanner storage={platform.storage} onShowing={onShowing} />
                    </Suspense>
                  </ErrorBoundary>
                )),
              navigating && <Banner tone="status">Opening message…</Banner>,
              (onShowing) => <ServerNoticeBanner onShowing={onShowing} />,
              (onShowing) => <UpdateBanner onShowing={onShowing} />,
              (onShowing) => <MemberNoticeBanner onShowing={onShowing} />,
            ]}
          />

          {channelId ? (
            // The call beside the chat on a wide window, over it otherwise.
            <div className="relative flex min-h-0 flex-1">
              {callShown && (
                <ErrorBoundary
                  fallback={
                    <div
                      role="alert"
                      className="flex w-64 shrink-0 flex-col justify-center gap-3 border-r border-edge p-5 text-sm text-ink-dim"
                    >
                      <p>
                        The call could not load here, but you are still in it. Reload the app to see
                        it.
                      </p>
                      <button
                        type="button"
                        onClick={() => setHuddleView("chat")}
                        className="self-start rounded-xl border border-edge px-3 py-2 text-ink hover:border-ink-faint"
                      >
                        Back to the chat
                      </button>
                    </div>
                  }
                >
                  <Suspense fallback={null}>
                    <HuddleStage
                      chat={
                        roomForChat
                          ? { shown: callChat, onToggle: () => setCallChat((on) => !on) }
                          : undefined
                      }
                      onHide={() => setHuddleView("chat")}
                      onShowCallLog={callLog}
                      onOpenSettings={callSettings}
                    />
                  </Suspense>
                </ErrorBoundary>
              )}
              {/* One column whatever the view, so the timeline keeps its place. */}
              <div
                inert={chatCovered}
                className={`flex min-h-0 flex-col ${
                  chatBeside
                    ? "w-[clamp(20rem,28%,26rem)] shrink-0 border-l border-edge"
                    : "min-w-0 flex-1"
                }`}
              >
                <MessageTimeline
                  // A panel beside the conversation leaves it in view, and so read,
                  // as Slack's does; only one covering it stops that.
                  readActive={channelRead}
                  channelId={channelId}
                  highlightMessageId={highlightId}
                  onOpenThread={openThread}
                  onChannelClick={openConversation}
                  onOpenProfile={openProfile}
                  onInvite={canInvite ? runInvite : undefined}
                  onDetails={details}
                />
                {calls.checkingDevices && (
                  <Suspense fallback={null}>
                    <DeviceCheckDialog />
                  </Suspense>
                )}
                {inHuddle && (
                  <Suspense fallback={null}>
                    <HuddleBar
                      view={huddleView}
                      onViewChange={setHuddleView}
                      onShowCallLog={callLog}
                      onOpenSettings={callSettings}
                    />
                  </Suspense>
                )}
                <div hidden={chatCovered} className="contents">
                  <JumpToLatestBar channelId={channelId} onJump={() => nav.clearHighlight()} />
                  {blockedHere ? (
                    <BlockedComposer userId={blockedHere} />
                  ) : deactivatedHere ? (
                    <DeactivatedComposer userId={deactivatedHere} />
                  ) : (
                    <Composer
                      channelId={channelId}
                      placeholder={isRoom ? `Message #${title}` : `Message ${title}`}
                      autoFocus
                      onLeft={() => nav.navigate({ to: "left" })}
                    />
                  )}
                </div>
              </div>
            </div>
          ) : (
            // Nothing open: no channel left, or the last one was left. Not a dead end.
            <EmptyState
              icon="hash"
              className="flex flex-1 flex-col items-center justify-center"
              action={{ label: "Browse channels", run: () => runAction(actions, "browse") }}
            >
              Pick a conversation in the sidebar, or find a channel to join.
            </EmptyState>
          )}
        </div>
      </main>

      <SidePanel />
      {/* On a phone: the bottom bar, the swipe that opens the drawer, and room for the keyboard. */}
      {platform.kind === "web" && <PhoneNavigation />}
      <OpenDialog />
      {/* Not one of the workspace's own dialogs: an app asked for this one, so
          it shows itself whenever one arrives. */}
      <Suspense fallback={null}>
        <ViewModal />
      </Suspense>
      {rungHere && (
        <ErrorBoundary fallback={<span hidden />}>
          <Suspense fallback={null}>
            <IncomingCall
              onOpen={(id) => nav.navigate({ to: "conversation", channelId: id })}
              preview={preview}
              tag={account}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}

/**
 * The desktop window's title bar, as Discord's: where you are, in the middle,
 * on the app's own background, with the window's controls over its right end.
 */
function TitleBar() {
  const name = useWorkspace((s) => s.workspaceName);
  return (
    <div
      className="titlebar-drag flex shrink-0 items-center justify-center bg-deep"
      style={{ height: TITLE_BAR_HEIGHT }}
    >
      <span aria-hidden="true" className="truncate px-36 text-[13px] font-semibold text-ink-dim">
        {name}
      </span>
    </div>
  );
}

/**
 * The phone's button that opens the sidebar. The sidebar is out of sight
 * there, so the button carries what it would show: a red count for mentions
 * waiting in other conversations, or a dot when only unread messages are.
 * The conversation on screen and muted ones do not count, as on the rail.
 */
function NavigationToggle(props: { activeChannelId: ID | null; open: boolean }) {
  const nav = useNavigation();
  const { activeChannelId } = props;
  const mentions = useWorkspace((s) => mentionsElsewhere(s, activeChannelId));
  const unread = useWorkspace((s) =>
    Object.keys(s.memberships).some((id) => waitsForAttention(s, id, activeChannelId)),
  );
  const described = mentions > 0 || unread;
  return (
    <button
      id="open-navigation"
      className="mobile-nav-toggle relative rounded-lg p-2 text-ink-dim hover:bg-ink/[0.06]"
      aria-label="Open navigation"
      aria-describedby={described ? "open-navigation-waiting" : undefined}
      aria-expanded={props.open}
      onClick={() => nav.navigate({ to: "drawer" })}
    >
      <Icon name="menu" />
      <Badge
        size="small"
        max={99}
        count={mentions}
        className="absolute right-0 top-0 ring-2 ring-ground"
      />
      <Badge
        dot
        tone="quiet"
        count={mentions === 0 && unread}
        className="absolute right-1 top-1 ring-2 ring-ground"
      />
      {described && (
        <span id="open-navigation-waiting" className="sr-only">
          {mentions > 0
            ? `${mentions} ${mentions === 1 ? "mention" : "mentions"} elsewhere`
            : "Unread messages elsewhere"}
        </span>
      )}
    </button>
  );
}
