import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { ID, Message } from "@slackoss/protocol";
import {
  WorkspaceClient,
  decideNotification,
  isMessageOnScreen,
  isMessageRead,
  notificationBody,
} from "@slackoss/client-core";
import { ClientContext, OpenMessageContext, useClient, useWorkspace } from "../context.js";
import type { Platform } from "../platform.js";
import { channelTitle } from "../lib/format.js";
import {
  HostingStatus,
  Sidebar,
  type HostingLine,
  type OtherWorkspace,
} from "../components/Sidebar.js";
import { JumpToLatestBar, MessageTimeline } from "../components/MessageTimeline.js";
import { Composer } from "../components/Composer.js";
import { huddleHasVideo, type HuddleView } from "../lib/huddleView.js";
import { useCallPreferences } from "../lib/callPreferences.js";
import { CatchUpSummary, namesList } from "../lib/catchUp.js";
import {
  catchUpContent,
  notificationContent,
  previewAccount,
  previewFor,
  useNotificationPreviews,
  type NotificationPreview,
} from "../lib/notificationPreview.js";
import type { PaletteCommand } from "../components/QuickSwitcher.js";
import { useAppearance } from "../lib/appearance.js";
import { shortcutLabel } from "../lib/shortcuts.js";
import type { AccountSection } from "../components/AccountDialog.js";
import { HuddleButton } from "../components/HuddleButton.js";
import { Banner, BannerAction } from "../components/Banner.js";
import { ConversationMenu, MemberStack, PinnedBar } from "../components/ConversationHeader.js";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import { LazyDialog, LazyPanel } from "../components/LazyView.js";
import { Icon } from "../components/Icon.js";
import { DraftPersistence } from "../components/DraftPersistence.js";
import { useMessageAnnouncer } from "../components/MessageAnnouncer.js";
import { WorkspaceStorageGate } from "../components/WorkspaceStorageGate.js";
import { ShareableServerProvider } from "../components/ShareableServer.js";
import { hasOpenModal } from "../components/Modal.js";
import { loadTooltipBubble } from "../components/Tooltip.js";
import { isImeKey } from "../lib/textInput.js";
import { useLastConversation } from "../lib/lastConversation.js";
import { useMediaQuery } from "../lib/useMediaQuery.js";
import {
  ROUTE_VIEWS,
  currentRoute,
  writeRoute,
  type RouteDialog,
  type RouteView,
} from "../lib/route.js";
import { loadEmoji } from "../lib/emoji.js";
import { useHistoryKeys } from "../lib/historyKeys.js";
import { PhoneNavigation } from "../components/PhoneNavigation.js";

const ActivityPanel = lazy(() =>
  import("../components/ActivityPanel.js").then((module) => ({ default: module.ActivityPanel })),
);
const DirectMessagesPanel = lazy(() =>
  import("../components/DirectMessagesPanel.js").then((module) => ({
    default: module.DirectMessagesPanel,
  })),
);
const AppsDialog = lazy(() =>
  import("../components/AppsDialog.js").then((module) => ({ default: module.AppsDialog })),
);
const PeopleDialog = lazy(() =>
  import("../components/PeopleDialog.js").then((module) => ({ default: module.PeopleDialog })),
);
const AccountDialog = lazy(() =>
  import("../components/AccountDialog.js").then((module) => ({ default: module.AccountDialog })),
);
const WorkspaceSettings = lazy(() =>
  import("../components/WorkspaceSettings.js").then((module) => ({
    default: module.WorkspaceSettings,
  })),
);
// Opened now and then rather than on every visit, so they load on first use
// and keep what every visit downloads small.
// Shown to the owner until the first steps are done, then never again.
const GettingStarted = lazy(() =>
  import("../components/GettingStarted.js").then((module) => ({
    default: module.GettingStarted,
  })),
);
// Asked once per device, and only by a browser that has not answered yet.
const NotificationBanner = lazy(() =>
  import("../components/NotificationBanner.js").then((module) => ({
    default: module.NotificationBanner,
  })),
);
const PinsPanel = lazy(() =>
  import("../components/MessageListPanel.js").then((module) => ({ default: module.PinsPanel })),
);
const SavedPanel = lazy(() =>
  import("../components/MessageListPanel.js").then((module) => ({ default: module.SavedPanel })),
);
const ThreadsPanel = lazy(() =>
  import("../components/MessageListPanel.js").then((module) => ({ default: module.ThreadsPanel })),
);
const MembersPanel = lazy(() =>
  import("../components/MembersPanel.js").then((module) => ({ default: module.MembersPanel })),
);
const ScheduledPanel = lazy(() =>
  import("../components/ScheduledPanel.js").then((module) => ({ default: module.ScheduledPanel })),
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
/** A form an app opens, which most sessions never see. */
const ViewModal = lazy(() =>
  import("../components/ViewModal.js").then((module) => ({ default: module.ViewModal })),
);
const SearchDialog = lazy(() =>
  import("../components/SearchDialog.js").then((module) => ({ default: module.SearchDialog })),
);
// Forms opened now and then, and the video stage shown only during a call
// with video, load on first use too.
const NewChannelDialog = lazy(() =>
  import("../components/dialogs.js").then((module) => ({ default: module.NewChannelDialog })),
);
const BrowseChannelsDialog = lazy(() =>
  import("../components/dialogs.js").then((module) => ({
    default: module.BrowseChannelsDialog,
  })),
);
const GuestAccountDialog = lazy(() =>
  import("../components/dialogs.js").then((module) => ({ default: module.GuestAccountDialog })),
);
const NewDmDialog = lazy(() =>
  import("../components/dialogs.js").then((module) => ({ default: module.NewDmDialog })),
);
const InviteDialog = lazy(() =>
  import("../components/InviteDialog.js").then((module) => ({ default: module.InviteDialog })),
);
const HuddleStage = lazy(() =>
  import("../components/HuddleStage.js").then((module) => ({ default: module.HuddleStage })),
);
const FriendsDialog = lazy(() =>
  import("../components/FriendsDialog.js").then((module) => ({ default: module.FriendsDialog })),
);
const ProfileDialog = lazy(() =>
  import("../components/ProfileDialog.js").then((module) => ({ default: module.ProfileDialog })),
);
const ShortcutsDialog = lazy(() =>
  import("../components/ShortcutsDialog.js").then((module) => ({
    default: module.ShortcutsDialog,
  })),
);
const DiagnosticsDialog = lazy(() =>
  import("../components/DiagnosticsDialog.js").then((module) => ({
    default: module.DiagnosticsDialog,
  })),
);
const ChannelDetailsDialog = lazy(() =>
  import("../components/ChannelDetailsDialog.js").then((module) => ({
    default: module.ChannelDetailsDialog,
  })),
);
/**
 * Ctrl+K's palette is out of the first download too, but it is fetched as
 * soon as the workspace opens and drawn directly once here: a switch typed
 * straight after Ctrl+K must not land on a loading state.
 */
let LoadedSwitcher: (typeof import("../components/QuickSwitcher.js"))["QuickSwitcher"] | null =
  null;
const loadQuickSwitcher = () =>
  import("../components/QuickSwitcher.js").then((module) => {
    LoadedSwitcher = module.QuickSwitcher;
    return { default: module.QuickSwitcher };
  });
const LazySwitcher = lazy(loadQuickSwitcher);
function SwitcherDialog(props: ComponentProps<typeof LazySwitcher>) {
  // Chosen once, as for search: a swap would start the palette over.
  const [Loaded] = useState(() => LoadedSwitcher);
  return Loaded ? (
    <Loaded {...props} />
  ) : (
    <LazyDialog loading="Loading Jump to" onClose={props.onClose}>
      <LazySwitcher {...props} />
    </LazyDialog>
  );
}

/**
 * A thread is out of the first download as well. It is fetched as the
 * workspace opens and drawn directly from then on, so opening one does not
 * stop at a loading state; only one opened in that first moment does.
 */
let LoadedThreadPanel: (typeof import("../components/ThreadPanel.js"))["ThreadPanel"] | null = null;
const loadThreadPanel = () =>
  import("../components/ThreadPanel.js").then((module) => {
    LoadedThreadPanel = module.ThreadPanel;
    return { default: module.ThreadPanel };
  });
const LazyThreadPanel = lazy(loadThreadPanel);
function ThreadPanel(props: ComponentProps<typeof LazyThreadPanel>) {
  // Chosen once, as for search: a swap would start the thread over.
  const [Loaded] = useState(() => LoadedThreadPanel);
  return Loaded ? (
    <Loaded {...props} />
  ) : (
    <LazyPanel name="Thread" onClose={props.onClose}>
      <LazyThreadPanel {...props} />
    </LazyPanel>
  );
}

interface Props {
  client: WorkspaceClient;
  platform: Platform;
  /** A message to open on arrival, from a link to it. */
  initialTarget?: { channelId: ID; messageId: ID } | null;
  /** This account just founded the workspace: open on inviting people (UX-42). */
  welcome?: boolean;
  /** Another number each time Invite people is asked for from outside, by Manage hosting. */
  inviteAsk?: number;
  onLeaveWorkspace: () => void;
  onSignedOut: () => void;
  /** A guest kept its identity as an account; carry on with this token. */
  onAccountCreated?: (token: string, handle: string) => void;
  /** This device's other saved workspaces, for the sidebar's switcher. */
  otherWorkspaces?: OtherWorkspace[];
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
}

type DialogKind =
  | { kind: "none" }
  | { kind: "friends" }
  | { kind: "new-channel" }
  | { kind: "browse" }
  | { kind: "new-dm"; initialMemberIds?: ID[] }
  | { kind: "invite"; welcome?: boolean }
  | { kind: "switcher" }
  | { kind: "search"; query?: string; inConversation?: boolean }
  | { kind: "account"; section?: AccountSection }
  | { kind: "profile"; userId: ID }
  | { kind: "channel-details"; tab?: "members" | "notifications" }
  | { kind: "shortcuts" }
  | { kind: "diagnostics"; callLog?: boolean }
  | { kind: "apps" }
  | { kind: "people" }
  | { kind: "workspace" }
  | { kind: "guest-account" };

/** The opposite of the query in theme.css that turns the sidebar into a drawer. */
const WIDE = "(min-width: 761px) and (min-height: 481px)";

/** Whether the sidebar is a drawer now, so a history entry's open drawer can open. */
function drawerLayout(): boolean {
  return typeof window.matchMedia === "function" && !window.matchMedia(WIDE).matches;
}

/** The dialog an address names, as the screen holds it. */
function dialogFromRoute(dialog: RouteDialog | null | undefined): DialogKind {
  if (!dialog) return { kind: "none" };
  if (dialog.name === "account")
    return dialog.section ? { kind: "account", section: dialog.section } : { kind: "account" };
  if (dialog.name === "details") return { kind: "channel-details" };
  return { kind: dialog.name };
}

/** The part of an open dialog the address keeps, if it keeps any. */
function routeDialogOf(dialog: DialogKind): RouteDialog | null {
  switch (dialog.kind) {
    case "account":
      return dialog.section ? { name: "account", section: dialog.section } : { name: "account" };
    case "channel-details":
      return { name: "details" };
    case "people":
    case "apps":
    case "workspace":
    case "invite":
    case "shortcuts":
      return { name: dialog.kind };
    default:
      return null;
  }
}

/** Only one right-hand panel is open at a time. */
type SidePanel =
  | { kind: "none" }
  | { kind: "thread"; rootId: ID; targetId?: ID }
  | { kind: "pins" }
  | { kind: "saved" }
  | { kind: "threads" }
  | { kind: "scheduled" }
  | { kind: "activity" }
  | { kind: "dms" }
  | { kind: "members" };

export function WorkspaceScreen({
  client,
  platform,
  initialTarget,
  welcome,
  inviteAsk,
  onLeaveWorkspace,
  onSignedOut,
  onAccountCreated,
  otherWorkspaces,
  onOpenWorkspace,
  banner,
  hosting,
  hostedHere,
}: Props) {
  return (
    <ClientContext.Provider value={client}>
      <div className="flex h-full min-h-0 flex-col">
        {/* Room for the window's own controls, drawn over the window's surface. */}
        {platform.kind === "desktop" && <TitleBar />}
        <div className="min-h-0 flex-1">
          <WorkspaceStorageGate
            client={client}
            platform={platform}
            onLeaveWorkspace={onLeaveWorkspace}
            onSignedOut={onSignedOut}
            // Until the workspace opens: a hosted one that will not start must
            // still offer Manage hosting.
            banner={banner}
            footer={
              hosting && <HostingStatus hosting={hosting} className="mx-auto mt-6 w-72 text-left" />
            }
          >
            <ShareableServerProvider platform={platform}>
              <WorkspaceInner
                platform={platform}
                initialTarget={initialTarget ?? null}
                welcome={welcome}
                inviteAsk={inviteAsk}
                onLeaveWorkspace={onLeaveWorkspace}
                onSignedOut={onSignedOut}
                onAccountCreated={onAccountCreated}
                otherWorkspaces={otherWorkspaces}
                onOpenWorkspace={onOpenWorkspace}
                banner={banner}
                hosting={hosting}
                hostedHere={hostedHere}
              />
            </ShareableServerProvider>
          </WorkspaceStorageGate>
        </div>
      </div>
    </ClientContext.Provider>
  );
}

function WorkspaceInner({
  platform,
  initialTarget,
  welcome,
  inviteAsk,
  onLeaveWorkspace,
  onSignedOut,
  onAccountCreated,
  otherWorkspaces,
  onOpenWorkspace,
  banner,
  hosting,
  hostedHere,
}: {
  platform: Platform;
  initialTarget: { channelId: ID; messageId: ID } | null;
  welcome?: boolean;
  inviteAsk?: number;
  onLeaveWorkspace: () => void;
  onSignedOut: () => void;
  onAccountCreated?: (token: string, handle: string) => void;
  otherWorkspaces?: OtherWorkspace[];
  onOpenWorkspace?: (url: string) => void;
  banner?: ReactNode;
  hosting?: HostingLine;
  hostedHere?: boolean;
}) {
  const status = useWorkspace((s) => s.status);
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const self = useWorkspace((s) => s.self);
  const clientFromCtx = useClient();
  const calls = useCallPreferences();
  const serverUrl = clientFromCtx.baseUrl;
  // Where the address, or Back and a reload, left this workspace. A link to a
  // message says where to go instead.
  const [initialRoute] = useState(() => (initialTarget ? null : currentRoute(serverUrl)));
  const [activeChannelId, setActiveChannelId] = useState<ID | null>(
    initialTarget?.channelId ?? initialRoute?.channelId ?? null,
  );
  const huddleRoom = useRef(activeChannelId);
  huddleRoom.current = activeChannelId;
  const [highlightMessageId, setHighlightMessageId] = useState<ID | null>(
    initialTarget?.messageId ?? null,
  );
  const [panel, setPanel] = useState<SidePanel>(
    initialRoute?.threadRootId
      ? { kind: "thread", rootId: initialRoute.threadRootId }
      : initialRoute?.view
        ? { kind: initialRoute.view }
        : { kind: "none" },
  );
  const [dialog, setDialog] = useState<DialogKind>(() =>
    welcome ? { kind: "invite", welcome } : dialogFromRoute(initialRoute?.dialog),
  );
  const [sidebarOpen, setSidebarOpen] = useState(
    () => initialRoute?.drawer === true && drawerLayout(),
  );
  const inviteAsked = useRef(inviteAsk);
  useEffect(() => {
    if (inviteAsk === inviteAsked.current) return;
    inviteAsked.current = inviteAsk;
    setDialog({ kind: "invite" });
  }, [inviteAsk]);
  const sidebarOpenRef = useRef(sidebarOpen);
  sidebarOpenRef.current = sidebarOpen;
  /**
   * Whether the history entry on screen is a step this screen added to open
   * the phone drawer. Closing the drawer without going anywhere goes Back
   * through it, so a phone's Back button closes the drawer, and afterwards
   * leaves the conversation as it would have before.
   */
  const drawerStep = useRef(false);
  // Below a laptop's width a side panel covers the conversation, as theme.css
  // lays it out, so what it covers leaves the Tab order and the screen
  // reader's reading as the page does behind a dialog.
  const narrow = useMediaQuery("(max-width: 1023px)");
  const panelCovers = narrow && panel.kind !== "none";
  const closeDrawer = useCallback(() => {
    if (drawerStep.current) {
      drawerStep.current = false;
      window.history.back();
      return;
    }
    setSidebarOpen(false);
  }, []);
  const [huddleView, setHuddleView] = useState<HuddleView>("docked");
  const huddleVideo = useWorkspace((s) => huddleHasVideo(s.huddle));
  const inHuddle = useWorkspace((s) => !!s.huddle);
  // Once the video is gone, the next video starts in view again, above the chat.
  useEffect(() => {
    if (!huddleVideo) setHuddleView("docked");
  }, [huddleVideo]);
  /** The video covers the chat, which stays mounted underneath so it keeps its place. */
  const chatCovered = huddleView === "expanded" && huddleVideo;
  const navigation = useRef(0);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  /** The notifications ask is on show, so a hint waits behind it. */
  const [asking, setAsking] = useState(false);
  const [navigating, setNavigating] = useState(false);
  useEffect(
    () => () => {
      navigation.current++;
      clientFromCtx.cancelMessageJump();
    },
    [clientFromCtx],
  );

  useEffect(() => {
    if (dialog.kind !== "none") setSidebarOpen(false);
  }, [dialog.kind]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const nav = document.querySelector<HTMLElement>('[aria-label="Workspace navigation"]');
    const previous = document.activeElement as HTMLElement | null;
    // Jump to…, not the first button: the rail's buttons show a tooltip on
    // focus, which would take the Escape meant to close the drawer.
    (
      nav?.querySelector<HTMLElement>("[data-drawer-focus]") ??
      nav?.querySelector<HTMLElement>("button")
    )?.focus();
    const onTab = (event: KeyboardEvent) => {
      if (event.defaultPrevented || hasOpenModal() || event.key !== "Tab") return;
      const buttons = [
        ...(nav?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
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
  }, [sidebarOpen]);

  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    const onResize = () => {
      if (wide.matches && sidebarOpenRef.current) closeDrawer();
    };
    wide.addEventListener("change", onResize);
    return () => wide.removeEventListener("change", onResize);
  }, [closeDrawer]);

  // Load the linked message's surrounding history, then navigate to it. This
  // must set state rather than rely on the useState initialisers above: the
  // screen keeps its key across deep links, so it re-renders without remounting.
  useEffect(() => {
    if (!initialTarget) return;
    const { channelId, messageId } = initialTarget;
    jumpToMessage(channelId, messageId);
    return () => {
      navigation.current++;
    };
  }, [clientFromCtx, initialTarget]);

  // The composer's slash-command hints. Re-fetched when an admin adds one.
  useEffect(() => {
    void clientFromCtx.loadCommands();
  }, [clientFromCtx]);

  /**
   * A conversation the app, not the person, moved to. Arriving there replaces
   * the history entry, so Back does not lead to somewhere unavailable.
   */
  const replaceRoute = useRef<ID | null>(null);
  /**
   * Bumped when a link or the address itself names where to be. The place may
   * be the one already on screen, and the address still needs writing back.
   */
  const [routeRequest, setRouteRequest] = useState(0);

  // With nothing in the address or history to say where to be, open the
  // conversation this account last had open here, once it has been read.
  const lastConversation = useLastConversation();
  const restoring = useRef(!initialTarget && !initialRoute);

  // Pick #general (or the first channel) once the snapshot lands, and move
  // there from a conversation this account cannot see or that has gone.
  useEffect(() => {
    if (!activeChannelId || (status === "online" && !channels[activeChannelId])) {
      const list = Object.values(channels).filter((c) => !c.archived);
      const general = list.find((c) => c.name === "general") ?? list[0];
      if (!general) return;
      if (!activeChannelId && restoring.current) {
        if (lastConversation.remembered === undefined) return;
        restoring.current = false;
        const last = lastConversation.remembered && channels[lastConversation.remembered];
        if (last && !last.archived) {
          replaceRoute.current = last.id;
          setActiveChannelId(last.id);
          return;
        }
      }
      if (activeChannelId) {
        setNavigationError(
          "That conversation is not available. It may have been deleted, or you may not have access to it.",
        );
        setPanel((p) => (p.kind === "thread" ? { kind: "none" } : p));
      }
      replaceRoute.current = general.id;
      setActiveChannelId(general.id);
    }
  }, [channels, activeChannelId, status, lastConversation.remembered]);

  const { remember } = lastConversation;
  useEffect(() => {
    if (activeChannelId && status === "online" && channels[activeChannelId])
      remember(activeChannelId);
  }, [activeChannelId, channels, status, remember]);

  // The address follows the conversation and the thread or panel beside it,
  // so Back, Forward and a reload return to them, and Back closes a panel.
  const routeThread = panel.kind === "thread" ? panel.rootId : null;
  const routeView = (ROUTE_VIEWS as readonly string[]).includes(panel.kind)
    ? (panel.kind as RouteView)
    : null;
  // A settings or list dialog is a place too, so Back closes it and a reload
  // reopens it. Moving between Account settings' sections, or closing a
  // dialog the account may not open, rewrites the entry instead of adding one.
  const routeDialog = routeDialogOf(dialog);
  const routeDialogName = routeDialog?.name ?? null;
  const routeDialogSection = routeDialog?.section ?? null;
  const replaceDialogStep = useRef(false);
  /**
   * Whether the history entry on screen is a step this screen added to open
   * the dialog. Closing that dialog goes Back through it, so Back afterwards
   * does not open again what was just dismissed.
   */
  const dialogStep = useRef(false);
  /** The conversation, thread or panel last written, beneath any dialog. */
  const lastPlace = useRef<string | null>(null);
  useEffect(() => {
    if (!activeChannelId) return;
    // Going somewhere from the drawer takes the drawer's step's place, so Back
    // from there returns to where things were before the drawer opened.
    const leavingDrawer = drawerStep.current && !sidebarOpen;
    const replace =
      replaceRoute.current === activeChannelId || replaceDialogStep.current || leavingDrawer;
    if (replaceRoute.current === activeChannelId) replaceRoute.current = null;
    replaceDialogStep.current = false;
    const place = `${activeChannelId}/${routeThread ?? ""}/${routeView ?? ""}`;
    // Only a dialog or the drawer opening over the same place makes a step
    // of its own to go Back through.
    const samePlace = lastPlace.current === place;
    const openingDialog = routeDialogName !== null && !dialogStep.current && samePlace;
    const openingDrawer = sidebarOpen && !drawerStep.current && samePlace && !routeDialogName;
    lastPlace.current = place;
    const step = writeRoute(
      serverUrl,
      {
        channelId: activeChannelId,
        threadRootId: routeThread,
        ...(routeView ? { view: routeView } : {}),
        ...(routeDialogName
          ? {
              dialog: {
                name: routeDialogName,
                ...(routeDialogSection ? { section: routeDialogSection } : {}),
              },
            }
          : {}),
        ...(sidebarOpen ? { drawer: true } : {}),
      },
      replace ? "replace" : "auto",
    );
    if (!routeDialogName) dialogStep.current = false;
    else if (step === "push") dialogStep.current = openingDialog;
    if (!sidebarOpen) drawerStep.current = false;
    else if (step === "push") drawerStep.current = openingDrawer;
  }, [
    serverUrl,
    activeChannelId,
    routeThread,
    routeView,
    routeDialogName,
    routeDialogSection,
    sidebarOpen,
    routeRequest,
  ]);

  // People, Apps and Workspace settings are for administrators. An address
  // can name them all the same, so they close for anyone else once the
  // account is known.
  const isAdmin = self?.role === "owner" || self?.role === "admin";
  useEffect(() => {
    if (
      self &&
      !isAdmin &&
      (dialog.kind === "people" || dialog.kind === "apps" || dialog.kind === "workspace")
    ) {
      replaceDialogStep.current = true;
      setDialog({ kind: "none" });
    }
  }, [self, isAdmin, dialog.kind]);

  useEffect(() => {
    const onPopState = () => {
      const route = currentRoute(serverUrl);
      if (!route) return;
      navigation.current++;
      clientFromCtx.cancelMessageJump();
      setNavigating(false);
      setNavigationError(null);
      setActiveChannelId(route.channelId);
      setHighlightMessageId(null);
      const view = route.view;
      setPanel((p) =>
        route.threadRootId
          ? p.kind === "thread" && p.rootId === route.threadRootId
            ? p
            : { kind: "thread", rootId: route.threadRootId }
          : view
            ? p.kind === view
              ? p
              : { kind: view }
            : p.kind === "none"
              ? p
              : { kind: "none" },
      );
      dialogStep.current = false;
      drawerStep.current = false;
      setDialog(dialogFromRoute(route.dialog));
      setSidebarOpen(route.drawer === true && drawerLayout());
      setRouteRequest((n) => n + 1);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [serverUrl, clientFromCtx]);

  useHistoryKeys(platform.kind === "desktop");

  useEffect(() => {
    // Failing here is not final: opening the palette, a thread, a hint or an emoji picker fetches it again.
    loadQuickSwitcher().catch(() => undefined);
    loadThreadPanel().catch(() => undefined);
    loadTooltipBubble().catch(() => undefined);
    loadEmoji().catch(() => undefined);
    import("../components/EmojiPicker.js").catch(() => undefined);
  }, []);

  useEffect(() => {
    clientFromCtx.focusConversation(activeChannelId);
    return () => clientFromCtx.focusConversation(null);
  }, [clientFromCtx, activeChannelId]);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A foreground form owns its keys. Shortcuts must not replace a busy
      // dialog, or let its Escape dismiss a thread behind it as well.
      if (e.defaultPrevented || hasOpenModal() || isImeKey(e)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog((d) => (d.kind === "switcher" ? { kind: "none" } : { kind: "switcher" }));
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setDialog({ kind: "search" });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        setDialog((d) => (d.kind === "shortcuts" ? { kind: "none" } : { kind: "shortcuts" }));
      }
      // Dialogs close themselves on Escape; this closes the phone drawer, or
      // with none open, the side panel.
      if (e.key === "Escape") {
        if (sidebarOpenRef.current) closeDrawer();
        else setPanel((p) => (p.kind === "none" ? p : { kind: "none" }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDrawer]);

  const activeChannel = activeChannelId ? channels[activeChannelId] : undefined;
  const title = activeChannel ? channelTitle(activeChannel, users, self?.id) : "";
  const isRoom = activeChannel?.type === "public" || activeChannel?.type === "private";
  /** A public channel can be looked into without joining, and then has no settings of one's own. */
  const isMember = useWorkspace((s) => !!activeChannelId && activeChannelId in s.memberships);
  const togglePanel = (kind: "pins" | "members") =>
    setPanel((p) => (p.kind === kind ? { kind: "none" } : { kind }));

  const openChannel = useCallback(
    (id: ID) => {
      navigation.current++;
      clientFromCtx.cancelMessageJump();
      setNavigating(false);
      setNavigationError(null);
      setActiveChannelId(id);
      setHighlightMessageId(null);
      setPanel({ kind: "none" });
      setDialog({ kind: "none" });
      setSidebarOpen(false);
    },
    [clientFromCtx],
  );
  const openThread = useCallback((rootId: ID) => setPanel({ kind: "thread", rootId }), []);
  const openProfile = useCallback((userId: ID) => setDialog({ kind: "profile", userId }), []);
  // What a conversation that has only just begun offers to do first.
  const inviteFromIntro = useCallback(() => setDialog({ kind: "invite" }), []);
  const detailsFromIntro = useCallback(() => setDialog({ kind: "channel-details" }), []);
  /**
   * A channel's details from the gear on its row, as Discord's channel
   * settings. Another channel is opened first, since the details are the open
   * channel's; the one already open stays as it is, thread and all.
   */
  const detailsFromRow = useCallback(
    (id: ID, tab?: "members") => {
      if (id !== activeChannelId) openChannel(id);
      setSidebarOpen(false);
      setDialog(tab ? { kind: "channel-details", tab } : { kind: "channel-details" });
    },
    [activeChannelId, openChannel],
  );

  /**
   * Opens a thread from the Threads list. The row already names its root, so
   * unlike a jump there is nothing to resolve before showing it.
   */
  function openThreadInChannel(channelId: ID, rootId: ID) {
    navigation.current++;
    setNavigationError(null);
    setNavigating(false);
    setDialog({ kind: "none" });
    setActiveChannelId(channelId);
    setHighlightMessageId(rootId);
    setPanel({ kind: "thread", rootId });
  }

  /** Opens a channel scrolled to one message, from search, pins or Saved. */
  function jumpToMessage(channelId: ID, messageId: ID) {
    const ticket = ++navigation.current;
    setDialog({ kind: "none" });
    setNavigationError(null);
    setNavigating(true);
    void clientFromCtx
      .jumpToMessage(channelId, messageId)
      .then((rootId) => {
        if (ticket !== navigation.current || rootId === undefined) return;
        setActiveChannelId(channelId);
        setHighlightMessageId(rootId ?? messageId);
        setPanel(rootId ? { kind: "thread", rootId, targetId: messageId } : { kind: "none" });
        setRouteRequest((n) => n + 1);
      })
      .catch(() => {
        if (ticket === navigation.current)
          setNavigationError(
            "Could not open this message. It may have been deleted, access may have changed, or the workspace may be offline.",
          );
      })
      .finally(() => {
        if (ticket === navigation.current) setNavigating(false);
      });
  }

  // One function for the life of the screen, so links in every message can
  // hold it without each message redrawing whenever this screen does.
  const jumpTo = useRef(jumpToMessage);
  jumpTo.current = jumpToMessage;
  const openMessage = useCallback((channelId: ID, messageId: ID) => {
    jumpTo.current(channelId, messageId);
  }, []);

  const closeDialog = () => {
    if (dialogStep.current) {
      // The entry before this one is the same place without the dialog.
      dialogStep.current = false;
      window.history.back();
      return;
    }
    setDialog({ kind: "none" });
  };

  // The palette's actions: every sidebar destination and the common tasks.
  const appearance = useAppearance();
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const showsDark = appearance.theme === "dark" || (appearance.theme === "system" && prefersDark);
  const isGuest = self?.role === "guest";
  const openPanel = (kind: "activity" | "threads" | "saved" | "scheduled") => {
    setPanel({ kind });
    setSidebarOpen(false);
  };
  const paletteCommands: PaletteCommand[] =
    dialog.kind !== "switcher"
      ? []
      : [
          ...(isGuest
            ? []
            : [
                {
                  id: "new-message",
                  label: "New message",
                  icon: "edit" as const,
                  keywords: "dm direct conversation write",
                  run: () => setDialog({ kind: "new-dm" }),
                },
                {
                  id: "new-channel",
                  label: "Create a channel",
                  icon: "plus" as const,
                  keywords: "new add room",
                  run: () => setDialog({ kind: "new-channel" }),
                },
              ]),
          {
            id: "browse",
            label: "Browse channels",
            icon: "compass",
            keywords: "join find explore",
            run: () => setDialog({ kind: "browse" }),
          },
          {
            id: "activity",
            label: "Activity",
            icon: "activity",
            keywords: "mentions unread notifications",
            run: () => openPanel("activity"),
          },
          {
            id: "threads",
            label: "Threads",
            icon: "thread",
            keywords: "replies following",
            run: () => openPanel("threads"),
          },
          {
            id: "saved",
            label: "Saved",
            icon: "bookmark",
            keywords: "bookmarks later",
            run: () => openPanel("saved"),
          },
          ...(isGuest
            ? []
            : [
                {
                  id: "invite",
                  label: "Invite people",
                  icon: "userPlus" as const,
                  keywords: "link code join add",
                  run: () => setDialog({ kind: "invite" }),
                },
                {
                  id: "scheduled",
                  label: "Scheduled messages",
                  icon: "clock" as const,
                  keywords: "send later",
                  run: () => openPanel("scheduled"),
                },
              ]),
          {
            id: "search",
            label: "Search messages",
            icon: "search",
            keywords: "find",
            shortcut: shortcutLabel("Mod+F"),
            run: () => setDialog({ kind: "search" }),
          },
          {
            id: "status",
            label: "Set a status",
            icon: "user",
            keywords: "profile name away busy",
            run: () => setDialog({ kind: "account", section: "profile" }),
          },
          {
            id: "theme",
            label: showsDark ? "Switch to the White theme" : "Switch to the Onyx theme",
            icon: showsDark ? "sun" : "moon",
            keywords: "theme appearance dark light mode colour color",
            run: () => void appearance.set({ theme: showsDark ? "light" : "dark" }),
          },
          {
            id: "settings",
            label: "Account settings",
            icon: "settings",
            keywords: "preferences notifications password",
            run: () => setDialog({ kind: "account" }),
          },
          ...(isAdmin
            ? [
                {
                  id: "people",
                  label: "Manage people",
                  icon: "members" as const,
                  keywords: "members admin roles deactivate",
                  run: () => setDialog({ kind: "people" }),
                },
                {
                  id: "apps",
                  label: "Apps and integrations",
                  icon: "grid" as const,
                  keywords: "bots webhooks commands",
                  run: () => setDialog({ kind: "apps" }),
                },
                {
                  id: "workspace-settings",
                  label: "Workspace settings",
                  icon: "settings" as const,
                  keywords: "rename name who can join guests invite only access",
                  run: () => setDialog({ kind: "workspace" }),
                },
              ]
            : []),
          ...(isGuest
            ? [
                {
                  id: "create-account",
                  label: "Create an account",
                  icon: "user" as const,
                  keywords: "sign up keep",
                  run: () => setDialog({ kind: "guest-account" }),
                },
              ]
            : []),
          {
            id: "shortcuts",
            label: "Keyboard shortcuts",
            icon: "keyboard",
            keywords: "keys help",
            shortcut: shortcutLabel("Mod+/"),
            run: () => setDialog({ kind: "shortcuts" }),
          },
        ];

  const announcer = useMessageAnnouncer();
  const { hear, forget } = announcer;
  const openThreadId = panel.kind === "thread" ? panel.rootId : null;
  /**
   * What covers the conversation now, read when a message arrives. On a phone
   * the open drawer covers everything, and a side panel covers the timeline;
   * an expanded huddle video covers the timeline too.
   */
  const covered = useRef({ channel: false, thread: false });
  // Read when a message arrives, like what covers the screen, so a change of
  // choice applies to the next notification without reinstalling the handler.
  const previews = useNotificationPreviews();
  const preview = useRef<NotificationPreview>("none");
  const account = self ? previewAccount(clientFromCtx.baseUrl, self.id) : null;
  preview.current = previewFor(previews, account);
  // Each window of this account tags a message's notification the same way,
  // so the browser shows it once however many windows heard it.
  const accountTag = useRef(account);
  accountTag.current = account;
  covered.current = {
    channel: panelCovers || chatCovered || (sidebarOpen && drawerLayout()),
    thread: sidebarOpen && drawerLayout(),
  };
  // What the last conversation received is not news in the next one.
  useEffect(() => forget(), [activeChannelId, forget]);

  // What a reconnect catches up on is told once, as a summary, rather than one
  // interruption per missed message (IMP-03). One for the life of the screen,
  // so what it holds survives changing conversation, and made as the screen
  // commits, before the handler below, so it is there for the first message
  // that handler hears. How it judges and shows messages is set with the handler.
  const catchUpRules = useRef<{
    stillNews: (msg: Message) => boolean;
    show: (messages: Message[]) => void;
  }>({ stillNews: () => false, show: () => {} });
  const catchUp = useRef<CatchUpSummary | null>(null);
  useLayoutEffect(() => {
    const summary = new CatchUpSummary({
      stillNews: (msg) => catchUpRules.current.stillNews(msg),
      show: (messages) => catchUpRules.current.show(messages),
    });
    catchUp.current = summary;
    clientFromCtx.onMessageDeleted = (id) => summary.drop(id);
    return () => {
      summary.dispose();
      catchUp.current = null;
      clientFromCtx.onMessageDeleted = null;
    };
  }, [clientFromCtx]);

  // Desktop notifications for incoming messages, gated by channel preferences,
  // mute and Do Not Disturb (the rules live in client-core so they're testable).
  // Installed as the screen commits, not after: a message arriving between a
  // conversation appearing and a passive effect running would otherwise be
  // judged against the one before, and notify about what is on screen.
  useLayoutEffect(() => {
    const onScreen = (msg: Message) =>
      isMessageOnScreen(msg, {
        focused: document.hasFocus() && document.visibilityState !== "hidden",
        channelId: activeChannelId,
        channelVisible: !covered.current.channel,
        threadRootId: openThreadId,
        threadVisible: !covered.current.thread,
      });
    const tell = (msg: Message) => {
      const state = clientFromCtx.state;
      // Only as much as this account chose to show on this device.
      const { title, body } = notificationContent(preview.current, {
        from: state.users[msg.userId]?.displayName ?? "Someone",
        channelName: state.channels[msg.channelId]?.name,
        body: notificationBody(state, msg),
      });
      // A click opens the message it names, through the same jump that
      // search results, pins and links use.
      platform.notify(title, body, () => openMessage(msg.channelId, msg.id), {
        tag: `${accountTag.current} ${msg.id}`,
      });
    };
    catchUpRules.current = {
      // Read elsewhere, muted, left or now in view since: not news any more.
      stillNews: (msg) => {
        const state = clientFromCtx.state;
        return (
          !onScreen(msg) &&
          !isMessageRead(msg, state) &&
          decideNotification(state, msg, { live: false }).notify
        );
      },
      show: (messages) => {
        const first = messages[0]!;
        if (messages.length === 1) return tell(first);
        const state = clientFromCtx.state;
        const conversations = new Set(messages.map((msg) => msg.channelId));
        const senders = [
          ...new Set(messages.map((msg) => state.users[msg.userId]?.displayName ?? "Someone")),
        ];
        const { title, body } = catchUpContent(preview.current, {
          count: messages.length,
          conversations: conversations.size,
          channelName: state.channels[first.channelId]?.name,
          senders: namesList(senders),
        });
        // A click opens the earliest, where reading them starts. The tag is
        // the same in every window that caught up on the same messages.
        platform.notify(title, body, () => openMessage(first.channelId, first.id), {
          tag: `${accountTag.current} catch-up ${first.id}`,
        });
      },
    };
    clientFromCtx.onIncomingMessage = (msg, { live }) => {
      const state = clientFromCtx.state;
      // Read to a screen reader what reaches the conversation on screen, but
      // not what a reconnect catches up on: that is history, not news.
      const inChannel = msg.channelId === activeChannelId && (!msg.threadRootId || msg.broadcast);
      const inThread = msg.threadRootId !== null && msg.threadRootId === openThreadId;
      if (live && (inChannel || inThread)) {
        hear({
          from: state.users[msg.userId]?.displayName ?? "Someone",
          text: notificationBody(state, msg),
          inThread: !inChannel,
        });
      }
      // A message you're already looking at needs no notification. One in a
      // thread that is not open is not in view just because its channel is.
      if (onScreen(msg)) return;
      if (!decideNotification(state, msg, { live }).notify) return;
      if (live) tell(msg);
      else catchUp.current?.hold(msg);
    };
    return () => {
      clientFromCtx.onIncomingMessage = null;
    };
  }, [clientFromCtx, activeChannelId, openThreadId, hear, openMessage, platform]);

  const connectionLabel =
    status === "online"
      ? null
      : status === "reconnecting" || status === "connecting"
        ? "reconnecting…"
        : status === "auth_failed"
          ? "signed out"
          : status === "protocol_mismatch"
            ? "Server version incompatible — update Tandem"
            : status === "password_change_required"
              ? "Choose a new password to carry on"
              : "offline";

  useEffect(() => {
    // Signing out is what leads back to the screen that can replace a password:
    // signing in again lands on it, holding the password it needs to replace.
    if (status === "auth_failed" || status === "password_change_required") onSignedOut();
  }, [status, onSignedOut]);

  const screen = (
    <div className={`workspace-shell relative flex h-full ${sidebarOpen ? "sidebar-open" : ""}`}>
      <DraftPersistence platform={platform} />
      {/* Outside main, which goes inert while the phone drawer is open. */}
      {announcer.region}
      {sidebarOpen && (
        <button
          className="sidebar-dismiss fixed inset-0 z-30"
          aria-label="Close navigation"
          onClick={closeDrawer}
        />
      )}
      <Sidebar
        openPanel={panel.kind}
        onSearch={() => setDialog({ kind: "switcher" })}
        onSaved={() => {
          setPanel({ kind: "saved" });
          setSidebarOpen(false);
        }}
        onScheduled={() => {
          setPanel({ kind: "scheduled" });
          setSidebarOpen(false);
        }}
        onFriends={() => setDialog({ kind: "friends" })}
        onActivity={() => {
          setPanel({ kind: "activity" });
          setSidebarOpen(false);
        }}
        onThreads={() => {
          setPanel({ kind: "threads" });
          setSidebarOpen(false);
        }}
        activeChannelId={activeChannelId}
        onSelect={openChannel}
        onBrowseChannels={() => setDialog({ kind: "browse" })}
        onNewChannel={() => setDialog({ kind: "new-channel" })}
        onNewDm={() => setDialog({ kind: "new-dm" })}
        onInvite={() => setDialog({ kind: "invite" })}
        onChannelDetails={detailsFromRow}
        onSwitchWorkspace={onLeaveWorkspace}
        otherWorkspaces={otherWorkspaces}
        onOpenWorkspace={onOpenWorkspace}
        onEditProfile={() => setDialog({ kind: "account", section: "profile" })}
        onAccountSettings={() => setDialog({ kind: "account" })}
        onCreateAccount={() => setDialog({ kind: "guest-account" })}
        onShortcuts={() => setDialog({ kind: "shortcuts" })}
        gettingStarted={
          self?.role === "owner" && (
            <ErrorBoundary fallback={<span hidden />}>
              <Suspense fallback={null}>
                <GettingStarted
                  onNewChannel={() => setDialog({ kind: "new-channel" })}
                  onInvite={() => setDialog({ kind: "invite" })}
                  onNotifications={() => setDialog({ kind: "account", section: "notifications" })}
                  activeChannelName={activeChannel && isRoom ? `#${activeChannel.name}` : null}
                  onTryHuddle={() => {
                    if (!activeChannelId) return;
                    const ticket = navigation.current;
                    setSidebarOpen(false);
                    calls
                      .joinHuddle(
                        clientFromCtx,
                        activeChannelId,
                        () =>
                          ticket === navigation.current && huddleRoom.current === activeChannelId,
                      )
                      .catch((err: unknown) => {
                        setNavigationError(
                          err instanceof Error
                            ? `Could not start a huddle: ${err.message}`
                            : "Could not start a huddle. Check your connection and try again.",
                        );
                      });
                  }}
                />
              </Suspense>
            </ErrorBoundary>
          )
        }
        onDiagnostics={() => setDialog({ kind: "diagnostics" })}
        onManageApps={isAdmin ? () => setDialog({ kind: "apps" }) : undefined}
        onManagePeople={isAdmin ? () => setDialog({ kind: "people" }) : undefined}
        onWorkspaceSettings={isAdmin ? () => setDialog({ kind: "workspace" }) : undefined}
        connectionLabel={connectionLabel}
        hosting={hosting}
      />

      <main
        inert={sidebarOpen || panelCovers}
        className="workspace-main flex min-w-0 flex-1 flex-col"
      >
        <header className="channel-header titlebar-drag flex h-12 shrink-0 items-center gap-1 pl-2 pr-2 shadow-[0_1px_0_var(--color-edge)]">
          <NavigationToggle
            activeChannelId={activeChannelId}
            open={sidebarOpen}
            onOpen={() => setSidebarOpen(true)}
          />
          <button
            onClick={() => activeChannelId && setDialog({ kind: "channel-details" })}
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
          </button>
          {activeChannelId && (
            <div className="flex shrink-0 items-center gap-1">
              {activeChannel?.type !== "dm" && (
                <MemberStack
                  channelId={activeChannelId}
                  pressed={panel.kind === "members"}
                  onToggle={() => togglePanel("members")}
                />
              )}
              <HuddleButton channelId={activeChannelId} />
              <ConversationMenu
                channelId={activeChannelId}
                title={isRoom ? `#${title}` : title}
                isRoom={isRoom}
                onPins={() => setPanel({ kind: "pins" })}
                onSearch={() => setDialog({ kind: "search", inConversation: true })}
                onNotifications={
                  isMember
                    ? () => setDialog({ kind: "channel-details", tab: "notifications" })
                    : undefined
                }
                onDetails={() => setDialog({ kind: "channel-details" })}
              />
            </div>
          )}
        </header>
        {activeChannelId && (
          <PinnedBar
            channelId={activeChannelId}
            open={panel.kind === "pins"}
            onToggle={() => togglePanel("pins")}
          />
        )}
        {/* One banner at a time, the most pressing (UX-25): a message that could
            not be opened, then what the app could not save, then the ask to
            turn on notifications, then a message on its way. */}
        {navigationError ? (
          <Banner
            tone="alert"
            actions={<BannerAction onClick={() => setNavigationError(null)}>Dismiss</BannerAction>}
          >
            {navigationError}
          </Banner>
        ) : banner ? (
          banner
        ) : (
          <>
            {platform.kind !== "desktop" && typeof Notification !== "undefined" && (
              // The ask is a courtesy: if it cannot load, the workspace carries on without it.
              <ErrorBoundary fallback={<span hidden />}>
                <Suspense fallback={null}>
                  <NotificationBanner storage={platform.storage} onShowing={setAsking} />
                </Suspense>
              </ErrorBoundary>
            )}
            {navigating && !asking && <Banner tone="status">Opening message…</Banner>}
          </>
        )}

        {activeChannelId ? (
          <>
            {/* The stage sits above the chat, and when expanded, over it. */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              {/* Mounted while there is video at all, even put away: the stage brings
                  itself back when someone starts sharing. */}
              {huddleVideo && (
                <ErrorBoundary
                  fallback={
                    <p role="alert" className="border-b border-edge px-5 py-3 text-sm text-ink-dim">
                      The huddle's video could not load. The call carries on; reload the app to see
                      video.
                    </p>
                  }
                >
                  <Suspense fallback={null}>
                    <HuddleStage view={huddleView} onViewChange={setHuddleView} />
                  </Suspense>
                </ErrorBoundary>
              )}
              <div inert={chatCovered} className="flex min-h-0 flex-1 flex-col">
                <MessageTimeline
                  readActive={
                    dialog.kind === "none" && panel.kind === "none" && !sidebarOpen && !chatCovered
                  }
                  channelId={activeChannelId}
                  highlightMessageId={highlightMessageId}
                  onOpenThread={openThread}
                  onChannelClick={openChannel}
                  onOpenProfile={openProfile}
                  onInvite={self?.role === "guest" ? undefined : inviteFromIntro}
                  onDetails={detailsFromIntro}
                />
              </div>
            </div>
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
                  onShowCallLog={() => setDialog({ kind: "diagnostics", callLog: true })}
                  onOpenSettings={() => setDialog({ kind: "account", section: "calls" })}
                />
              </Suspense>
            )}
            <div hidden={chatCovered} className="contents">
              <JumpToLatestBar
                channelId={activeChannelId}
                onJump={() => setHighlightMessageId(null)}
              />
              <Composer
                channelId={activeChannelId}
                placeholder={isRoom ? `Message #${title}` : `Message ${title}`}
                autoFocus
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-ink-faint">
            Pick a channel to start.
          </div>
        )}
      </main>

      {panel.kind === "thread" && activeChannelId && (
        <ThreadPanel
          readActive={dialog.kind === "none" && !sidebarOpen}
          channelId={activeChannelId}
          rootId={panel.rootId}
          targetId={panel.targetId}
          onClose={() => setPanel({ kind: "none" })}
          onChannelClick={openChannel}
          onOpenProfile={(userId) => setDialog({ kind: "profile", userId })}
        />
      )}
      {panel.kind === "pins" && activeChannelId && (
        <LazyPanel name="Pinned" onClose={() => setPanel({ kind: "none" })}>
          <PinsPanel
            channelId={activeChannelId}
            onClose={() => setPanel({ kind: "none" })}
            onJump={jumpToMessage}
          />
        </LazyPanel>
      )}
      {panel.kind === "saved" && (
        <LazyPanel name="Saved" onClose={() => setPanel({ kind: "none" })}>
          <SavedPanel
            onClose={() => setPanel({ kind: "none" })}
            onJump={jumpToMessage}
            onScheduled={self?.role === "guest" ? undefined : () => setPanel({ kind: "scheduled" })}
          />
        </LazyPanel>
      )}
      {panel.kind === "members" && activeChannelId && (
        <LazyPanel name="Members" onClose={() => setPanel({ kind: "none" })}>
          <MembersPanel
            key={activeChannelId}
            channelId={activeChannelId}
            onClose={() => setPanel({ kind: "none" })}
            onOpenProfile={(userId) => setDialog({ kind: "profile", userId })}
          />
        </LazyPanel>
      )}
      {panel.kind === "threads" && (
        <LazyPanel name="Threads" onClose={() => setPanel({ kind: "none" })}>
          <ThreadsPanel onClose={() => setPanel({ kind: "none" })} onJump={openThreadInChannel} />
        </LazyPanel>
      )}
      {panel.kind === "activity" && (
        <LazyPanel name="Activity" onClose={() => setPanel({ kind: "none" })}>
          <ActivityPanel onClose={() => setPanel({ kind: "none" })} onJump={jumpToMessage} />
        </LazyPanel>
      )}
      {panel.kind === "scheduled" && (
        <LazyPanel name="Scheduled messages" onClose={() => setPanel({ kind: "none" })}>
          <ScheduledPanel
            onClose={() => setPanel({ kind: "none" })}
            onJump={openChannel}
            onSaved={() => setPanel({ kind: "saved" })}
          />
        </LazyPanel>
      )}
      {panel.kind === "dms" && (
        <LazyPanel name="Direct messages" onClose={() => setPanel({ kind: "none" })}>
          <DirectMessagesPanel
            activeChannelId={activeChannelId}
            onClose={() => setPanel({ kind: "none" })}
            onOpen={openChannel}
            onNewMessage={() => setDialog({ kind: "new-dm" })}
            onFriends={() => setDialog({ kind: "friends" })}
          />
        </LazyPanel>
      )}
      {/* On a phone: the bottom bar, the swipe that opens the drawer, and room for the keyboard. */}
      {platform.kind === "web" && (
        <PhoneNavigation
          activeChannelId={activeChannelId}
          openPanel={panel.kind}
          drawerOpen={sidebarOpen}
          onOpenDrawer={() => setSidebarOpen(true)}
          onCloseDrawer={closeDrawer}
          onConversation={() => setPanel({ kind: "none" })}
          onDirectMessages={() => setPanel({ kind: "dms" })}
          onActivity={() => setPanel({ kind: "activity" })}
          account={{
            onCreateAccount: () => setDialog({ kind: "guest-account" }),
            onEditProfile: () => setDialog({ kind: "account", section: "profile" }),
            onAccountSettings: () => setDialog({ kind: "account" }),
            onScheduled: () => setPanel({ kind: "scheduled" }),
            onShortcuts: () => setDialog({ kind: "shortcuts" }),
            onDiagnostics: () => setDialog({ kind: "diagnostics" }),
          }}
        />
      )}

      {(dialog.kind === "new-channel" ||
        dialog.kind === "browse" ||
        dialog.kind === "new-dm" ||
        dialog.kind === "invite") && (
        <LazyDialog
          loading={
            dialog.kind === "new-channel"
              ? "Loading new channel"
              : dialog.kind === "browse"
                ? "Loading channels"
                : dialog.kind === "new-dm"
                  ? "Loading new message"
                  : "Loading invite"
          }
          onClose={closeDialog}
        >
          {dialog.kind === "new-channel" && (
            <NewChannelDialog onClose={closeDialog} onCreated={(ch) => openChannel(ch.id)} />
          )}
          {dialog.kind === "browse" && (
            <BrowseChannelsDialog onClose={closeDialog} onOpen={openChannel} />
          )}
          {dialog.kind === "new-dm" && (
            <NewDmDialog
              initialMemberIds={dialog.initialMemberIds}
              onClose={closeDialog}
              onOpen={openChannel}
            />
          )}
          {dialog.kind === "invite" && (
            <InviteDialog welcome={dialog.welcome} onClose={closeDialog} />
          )}
        </LazyDialog>
      )}
      {dialog.kind === "guest-account" && onAccountCreated && (
        <LazyDialog loading="Loading account" onClose={closeDialog}>
          <GuestAccountDialog onClose={closeDialog} onCreated={onAccountCreated} />
        </LazyDialog>
      )}
      {dialog.kind === "switcher" && (
        <SwitcherDialog
          onClose={closeDialog}
          onOpen={openChannel}
          commands={paletteCommands}
          onSearch={(query) => setDialog({ kind: "search", query })}
        />
      )}
      {dialog.kind === "search" && (
        <LazyDialog loading="Loading search" onClose={closeDialog}>
          <SearchDialog
            channelId={activeChannelId}
            initialQuery={dialog.query}
            inConversation={dialog.inConversation}
            onClose={closeDialog}
            onJump={jumpToMessage}
          />
        </LazyDialog>
      )}
      {dialog.kind === "shortcuts" && (
        <LazyDialog loading="Loading keyboard shortcuts" onClose={closeDialog}>
          <ShortcutsDialog onClose={closeDialog} />
        </LazyDialog>
      )}
      {dialog.kind === "diagnostics" && (
        <LazyDialog loading="Loading diagnostics" onClose={closeDialog}>
          <DiagnosticsDialog onClose={closeDialog} showCallLog={dialog.callLog} />
        </LazyDialog>
      )}
      {(((dialog.kind === "apps" || dialog.kind === "people" || dialog.kind === "workspace") &&
        isAdmin) ||
        dialog.kind === "account") && (
        <LazyDialog key={dialog.kind} loading="Loading settings" onClose={closeDialog}>
          {dialog.kind === "apps" && <AppsDialog onClose={closeDialog} />}
          {dialog.kind === "people" && <PeopleDialog onClose={closeDialog} />}
          {dialog.kind === "workspace" && (
            <WorkspaceSettings onClose={closeDialog} hostedHere={hostedHere} />
          )}
          {dialog.kind === "account" && (
            <AccountDialog
              onClose={closeDialog}
              onSignedOut={onSignedOut}
              section={dialog.section}
              onSectionChange={(section) => {
                replaceDialogStep.current = true;
                setDialog({ kind: "account", section });
              }}
            />
          )}
        </LazyDialog>
      )}
      {/* Not one of the workspace's own dialogs: an app asked for this one, so
          it shows itself whenever one arrives. */}
      <Suspense fallback={null}>
        <ViewModal />
      </Suspense>
      {dialog.kind === "friends" && (
        <LazyDialog loading="Loading friends" onClose={closeDialog}>
          <FriendsDialog
            onClose={closeDialog}
            onOpenProfile={(userId) => setDialog({ kind: "profile", userId })}
          />
        </LazyDialog>
      )}
      {dialog.kind === "profile" && (
        <LazyDialog loading="Loading profile" onClose={closeDialog}>
          <ProfileDialog
            userId={dialog.userId}
            onClose={closeDialog}
            onOpenDm={openChannel}
            onEditProfile={() => setDialog({ kind: "account", section: "profile" })}
          />
        </LazyDialog>
      )}
      {dialog.kind === "channel-details" && activeChannelId && (
        <LazyDialog loading="Loading channel details" onClose={closeDialog}>
          <ChannelDetailsDialog
            key={activeChannelId}
            channelId={activeChannelId}
            initialTab={dialog.tab}
            onChangeParticipants={(memberIds) =>
              setDialog({ kind: "new-dm", initialMemberIds: memberIds })
            }
            onClose={closeDialog}
            onLeft={() => {
              // Going somewhere else at once, so no step Back to wait for.
              dialogStep.current = false;
              setDialog({ kind: "none" });
              setActiveChannelId(null);
            }}
            onOpenProfile={(userId) => setDialog({ kind: "profile", userId })}
          />
        </LazyDialog>
      )}
    </div>
  );
  return <OpenMessageContext.Provider value={openMessage}>{screen}</OpenMessageContext.Provider>;
}

/**
 * The desktop window's title bar, as Discord's: where you are, in the middle,
 * on the app's own background, with the window's controls over its right end.
 */
function TitleBar() {
  const name = useWorkspace((s) => s.workspaceName);
  return (
    <div className="titlebar-drag flex h-10 shrink-0 items-center justify-center bg-deep">
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
function NavigationToggle(props: {
  activeChannelId: ID | null;
  open: boolean;
  onOpen: () => void;
}) {
  const { activeChannelId } = props;
  const mentions = useWorkspace((s) =>
    Object.entries(s.mentionCounts).reduce(
      (sum, [id, count]) => (id === activeChannelId ? sum : sum + count),
      0,
    ),
  );
  const unread = useWorkspace((s) =>
    Object.keys(s.memberships).some(
      (id) =>
        id !== activeChannelId &&
        !s.prefs[id]?.muted &&
        !s.channels[id]?.archived &&
        (s.channelLastSeq[id] ?? 0) > (s.memberships[id] ?? 0),
    ),
  );
  const described = mentions > 0 || unread;
  return (
    <button
      id="open-navigation"
      className="mobile-nav-toggle relative rounded-lg p-2 text-ink-dim hover:bg-ink/[0.06]"
      aria-label="Open navigation"
      aria-describedby={described ? "open-navigation-waiting" : undefined}
      aria-expanded={props.open}
      onClick={props.onOpen}
    >
      <Icon name="menu" />
      {mentions > 0 ? (
        <span
          aria-hidden="true"
          className="badge-mention tabular absolute right-0 top-0 min-w-4 rounded-full px-1 text-center text-[10px] font-bold leading-4 ring-2 ring-ground"
        >
          {mentions > 99 ? "99+" : mentions}
        </span>
      ) : (
        unread && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 size-2 rounded-full bg-ink ring-2 ring-ground"
          />
        )
      )}
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
