import { lazy, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { ID } from "@ownbase/protocol";
import { selfIsAdministrator, type WorkspaceState } from "@ownbase/client-core";
import { useWorkspace } from "../context.js";
import { LazyDialog, LazyPanel } from "../components/LazyView.js";
import { QuickSwitcherLoading, type EarlyTyping } from "../components/QuickSwitcherLoading.js";
import { useToast } from "../components/Toast.js";
import {
  reading,
  useNavigation,
  useNavigationState,
  type Dialog,
  type DialogKind,
  type Navigation,
  type Panel,
  type PanelKind,
} from "../lib/navigation.js";
import { useWorkspaceShell, type WorkspaceShell } from "../lib/workspaceShell.js";
import { mayInvite, paletteCommands, useActionContext } from "../lib/actions.js";
import { useRecentConversations } from "../lib/recentConversations.js";

const ActivityPanel = lazy(() =>
  import("../components/ActivityPanel.js").then((module) => ({ default: module.ActivityPanel })),
);
const DirectMessagesPanel = lazy(() =>
  import("../components/DirectMessagesPanel.js").then((module) => ({
    default: module.DirectMessagesPanel,
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
const DraftsPanel = lazy(() =>
  import("../components/DraftsPanel.js").then((module) => ({ default: module.DraftsPanel })),
);
const FilesPanel = lazy(() =>
  import("../components/FilesPanel.js").then((module) => ({ default: module.FilesPanel })),
);
const AppsDialog = lazy(() =>
  import("../components/AppsDialog.js").then((module) => ({ default: module.AppsDialog })),
);
const PeopleDialog = lazy(() =>
  import("../components/PeopleDialog.js").then((module) => ({ default: module.PeopleDialog })),
);
const ReportsDialog = lazy(() =>
  import("../components/ReportsDialog.js").then((module) => ({ default: module.ReportsDialog })),
);
const AccountDialog = lazy(() =>
  import("../components/AccountDialog.js").then((module) => ({ default: module.AccountDialog })),
);
const WorkspaceSettings = lazy(() =>
  import("../components/WorkspaceSettings.js").then((module) => ({
    default: module.WorkspaceSettings,
  })),
);
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
 * straight after Ctrl+K must not land on a loading state. In the moment before
 * it has arrived, its frame stands in and keeps what is typed, and an Enter.
 */
let LoadedSwitcher: (typeof import("../components/QuickSwitcher.js"))["QuickSwitcher"] | null =
  null;
export const loadQuickSwitcher = () =>
  import("../components/QuickSwitcher.js").then((module) => {
    LoadedSwitcher = module.QuickSwitcher;
    return { default: module.QuickSwitcher };
  });
const LazySwitcher = lazy(loadQuickSwitcher);
function SwitcherDialog(props: ComponentProps<typeof LazySwitcher>) {
  // Chosen once, as for search: a swap would start the palette over.
  const [Loaded] = useState(() => LoadedSwitcher);
  const [typing, setTyping] = useState<EarlyTyping>({ query: "", entered: false });
  return Loaded ? (
    <Loaded {...props} />
  ) : (
    <LazyDialog
      loading="Loading Jump to"
      onClose={props.onClose}
      placeholder={
        <QuickSwitcherLoading
          typing={typing}
          onTyping={setTyping}
          actions={!!props.commands?.length}
          onClose={props.onClose}
        />
      }
    >
      <LazySwitcher {...props} initialQuery={typing.query} openAtOnce={typing.entered} />
    </LazyDialog>
  );
}

/**
 * Search the same way: the header's search is pressed and typed into at once,
 * and words typed while it was still loading were lost.
 */
let LoadedSearch: (typeof import("../components/SearchDialog.js"))["SearchDialog"] | null = null;
export const loadSearchDialog = () =>
  import("../components/SearchDialog.js").then((module) => {
    LoadedSearch = module.SearchDialog;
    return { default: module.SearchDialog };
  });
const LazySearch = lazy(loadSearchDialog);
function SearchDialog(props: ComponentProps<typeof LazySearch>) {
  // Chosen once: a swap would start the search over.
  const [Loaded] = useState(() => LoadedSearch);
  return Loaded ? (
    <Loaded {...props} />
  ) : (
    <LazyDialog loading="Loading search" onClose={props.onClose}>
      <LazySearch {...props} />
    </LazyDialog>
  );
}

/**
 * A thread is out of the first download as well. It is fetched as the
 * workspace opens and drawn directly from then on, so opening one does not
 * stop at a loading state; only one opened in that first moment does.
 */
let LoadedThreadPanel: (typeof import("../components/ThreadPanel.js"))["ThreadPanel"] | null = null;
export const loadThreadPanel = () =>
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

/** What a panel or dialog is drawn with. */
interface ViewContext {
  nav: Navigation;
  /** The conversation open beside it; panels that need one are drawn only with one. */
  channelId: ID | null;
  shell: WorkspaceShell;
  /** Whether this account may queue messages, which Saved and Drafts link to. */
  schedules: boolean;
}

const go = (nav: Navigation) => ({
  close: () => nav.closePanel(),
  conversation: (channelId: ID) => nav.navigate({ to: "conversation", channelId }),
  message: (channelId: ID, messageId: ID) => nav.navigate({ to: "message", channelId, messageId }),
  panel: (panel: Panel) => nav.navigate({ to: "panel", panel }),
  dialog: (dialog: Dialog) => nav.navigate({ to: "dialog", dialog }),
  profile: (userId: ID) => nav.navigate({ to: "dialog", dialog: { kind: "profile", userId } }),
});

interface PanelView<K extends PanelKind> {
  /** Drawn only beside an open conversation. */
  needsChannel?: true;
  render: (panel: Extract<Panel, { kind: K }>, ctx: ViewContext & { channelId: ID }) => ReactNode;
}

/** Every side panel: how it is drawn, from where the screen is. */
const PANELS: { [K in Exclude<PanelKind, "none" | "thread">]: PanelView<K> } = {
  pins: {
    needsChannel: true,
    render: (_, { nav, channelId }) => (
      <LazyPanel name="Pinned" onClose={go(nav).close}>
        <PinsPanel channelId={channelId} onClose={go(nav).close} onJump={go(nav).message} />
      </LazyPanel>
    ),
  },
  saved: {
    render: (_, { nav, schedules }) => (
      <LazyPanel name="Saved" onClose={go(nav).close}>
        <SavedPanel
          onClose={go(nav).close}
          onJump={go(nav).message}
          onScheduled={schedules ? () => go(nav).panel({ kind: "scheduled" }) : undefined}
        />
      </LazyPanel>
    ),
  },
  members: {
    needsChannel: true,
    render: (_, { nav, channelId }) => (
      <LazyPanel name="Members" onClose={go(nav).close}>
        <MembersPanel
          key={channelId}
          channelId={channelId}
          onClose={go(nav).close}
          onOpenProfile={go(nav).profile}
        />
      </LazyPanel>
    ),
  },
  threads: {
    render: (_, { nav }) => (
      <LazyPanel name="Threads" onClose={go(nav).close}>
        <ThreadsPanel
          onClose={go(nav).close}
          onJump={(channelId, rootId) => nav.navigate({ to: "thread", channelId, rootId })}
        />
      </LazyPanel>
    ),
  },
  activity: {
    render: (_, { nav }) => (
      <LazyPanel name="Activity" onClose={go(nav).close}>
        <ActivityPanel
          onClose={go(nav).close}
          onJump={go(nav).message}
          onOpenChannel={go(nav).conversation}
        />
      </LazyPanel>
    ),
  },
  scheduled: {
    render: (panel, { nav }) => (
      <LazyPanel name="Scheduled messages" onClose={go(nav).close}>
        <ScheduledPanel
          onClose={go(nav).close}
          onJump={go(nav).conversation}
          onSaved={() => go(nav).panel({ kind: "saved" })}
          initialEdit={panel.edit}
        />
      </LazyPanel>
    ),
  },
  drafts: {
    render: (_, { nav, schedules }) => (
      <LazyPanel name="Drafts" onClose={go(nav).close}>
        <DraftsPanel
          onClose={go(nav).close}
          onOpen={(place) => nav.navigate({ to: "draft", place })}
          onScheduled={schedules ? () => go(nav).panel({ kind: "scheduled" }) : undefined}
        />
      </LazyPanel>
    ),
  },
  files: {
    render: (panel, { nav }) => (
      <LazyPanel name="Files" onClose={go(nav).close}>
        <FilesPanel
          // Opened again for another conversation, it starts again there.
          key={panel.channelId ?? ""}
          channelId={panel.channelId}
          onClose={go(nav).close}
          onJump={go(nav).message}
        />
      </LazyPanel>
    ),
  },
  dms: {
    render: (_, { nav, channelId }) => (
      <LazyPanel name="Direct messages" onClose={go(nav).close}>
        <DirectMessagesPanel
          activeChannelId={channelId}
          onClose={go(nav).close}
          onOpen={go(nav).conversation}
          onNewMessage={() => go(nav).dialog({ kind: "new-dm" })}
          onFriends={() => go(nav).dialog({ kind: "friends" })}
        />
      </LazyPanel>
    ),
  },
};

function useViewContext(): ViewContext {
  const nav = useNavigation();
  const shell = useWorkspaceShell();
  const channelId = useNavigationState((s) => s.channelId);
  const schedules = useWorkspace((s) => !!s.self && s.self.role !== "guest");
  return { nav, channelId, shell, schedules };
}

/** The side panel open now, beside the conversation. */
export function SidePanel() {
  const ctx = useViewContext();
  const panel = useNavigationState((s) => s.panel);
  const threadRead = useNavigationState((s) => reading(s).thread);
  const { nav, channelId } = ctx;
  if (panel.kind === "none") return null;
  if (panel.kind === "thread")
    return channelId ? (
      <ThreadPanel
        readActive={threadRead}
        channelId={channelId}
        rootId={panel.rootId}
        targetId={panel.targetId}
        onClose={go(nav).close}
        onChannelClick={go(nav).conversation}
        onOpenProfile={go(nav).profile}
      />
    ) : null;
  const view = PANELS[panel.kind] as PanelView<typeof panel.kind>;
  if (view.needsChannel && !channelId) return null;
  return view.render(panel as never, { ...ctx, channelId: channelId ?? "" });
}

interface DialogView<K extends DialogKind> {
  /** Shown while its code loads. */
  loading: string;
  /**
   * Whether this account may open it. One it may not is never drawn, and one
   * an address names closes once the account is known.
   */
  allowed?: (self: WorkspaceState["self"], shell: WorkspaceShell) => boolean;
  /** Named when it closes because the account was no longer an admin. */
  adminName?: string;
  /** Draws its own loading state, so no frame around it. */
  frameless?: true;
  /** Drawn only over an open conversation. */
  needsChannel?: true;
  render: (
    dialog: Extract<Dialog, { kind: K }>,
    ctx: ViewContext & { channelId: ID; close: () => void },
  ) => ReactNode;
}

const admin = (self: WorkspaceState["self"]) => selfIsAdministrator({ self });

/** Every dialog the workspace opens over the conversation. */
const DIALOGS: { [K in Exclude<DialogKind, "none">]: DialogView<K> } = {
  "new-channel": {
    loading: "Loading new channel",
    render: (_, { nav, close }) => (
      <NewChannelDialog onClose={close} onCreated={(ch) => go(nav).conversation(ch.id)} />
    ),
  },
  browse: {
    loading: "Loading channels",
    render: (_, { nav, close }) => (
      <BrowseChannelsDialog onClose={close} onOpen={go(nav).conversation} />
    ),
  },
  "new-dm": {
    loading: "Loading new message",
    render: (dialog, { nav, close }) => (
      <NewDmDialog
        initialMemberIds={dialog.initialMemberIds}
        onClose={close}
        onOpen={go(nav).conversation}
      />
    ),
  },
  invite: {
    loading: "Loading invite",
    allowed: mayInvite,
    render: (dialog, { shell, close }) => {
      const hosting = shell.hosting;
      return (
        <InviteDialog
          welcome={dialog.welcome}
          onClose={close}
          onShareOnline={
            hosting && shell.hostedHere
              ? () => {
                  close();
                  hosting.onManage("internet");
                }
              : undefined
          }
        />
      );
    },
  },
  "guest-account": {
    loading: "Loading account",
    allowed: (_, shell) => !!shell.onAccountCreated,
    render: (_, { shell, close }) => (
      <GuestAccountDialog onClose={close} onCreated={shell.onAccountCreated!} />
    ),
  },
  switcher: {
    loading: "Loading Jump to",
    frameless: true,
    render: (_, { nav, close }) => <Switcher nav={nav} close={close} />,
  },
  search: {
    loading: "Loading search",
    frameless: true,
    render: (dialog, { nav, channelId, close }) => (
      <SearchDialog
        channelId={channelId || null}
        initialQuery={dialog.query}
        inConversation={dialog.inConversation}
        onClose={close}
        onJump={go(nav).message}
      />
    ),
  },
  shortcuts: {
    loading: "Loading keyboard shortcuts",
    render: (_, { close }) => <ShortcutsDialog onClose={close} />,
  },
  diagnostics: {
    loading: "Loading diagnostics",
    render: (dialog, { close }) => (
      <DiagnosticsDialog onClose={close} showCallLog={dialog.callLog} />
    ),
  },
  apps: {
    loading: "Loading settings",
    allowed: admin,
    adminName: "Apps and integrations",
    render: (_, { close }) => <AppsDialog onClose={close} />,
  },
  people: {
    loading: "Loading settings",
    allowed: admin,
    adminName: "People",
    render: (_, { close }) => <PeopleDialog onClose={close} />,
  },
  reports: {
    loading: "Loading settings",
    allowed: admin,
    adminName: "Reported messages",
    render: (_, { close }) => <ReportsDialog onClose={close} />,
  },
  workspace: {
    loading: "Loading settings",
    allowed: admin,
    adminName: "Workspace settings",
    render: (_, { shell, close }) => (
      <WorkspaceSettings onClose={close} hostedHere={shell.hostedHere} />
    ),
  },
  account: {
    loading: "Loading settings",
    render: (dialog, { nav, shell, close }) => (
      <AccountDialog
        onClose={close}
        onSignedOut={shell.onSignedOut}
        section={dialog.section}
        onSectionChange={(section) =>
          nav.navigate({ to: "dialog", dialog: { kind: "account", section }, replace: true })
        }
      />
    ),
  },
  friends: {
    loading: "Loading friends",
    render: (_, { nav, close }) => (
      <FriendsDialog onClose={close} onOpenProfile={go(nav).profile} />
    ),
  },
  profile: {
    loading: "Loading profile",
    render: (dialog, { nav, close }) => (
      <ProfileDialog
        userId={dialog.userId}
        onClose={close}
        onOpenDm={go(nav).conversation}
        onEditProfile={() => go(nav).dialog({ kind: "account", section: "profile" })}
      />
    ),
  },
  "channel-details": {
    loading: "Loading channel details",
    needsChannel: true,
    render: (dialog, { nav, channelId, close }) => (
      <ChannelDetailsDialog
        key={channelId}
        channelId={channelId}
        initialTab={dialog.tab}
        onChangeParticipants={(memberIds) =>
          go(nav).dialog({ kind: "new-dm", initialMemberIds: memberIds })
        }
        onClose={close}
        onLeft={() => nav.navigate({ to: "left" })}
        onOpenProfile={go(nav).profile}
      />
    ),
  },
};

function Switcher({ nav, close }: { nav: Navigation; close: () => void }) {
  const actions = useActionContext();
  const recent = useRecentConversations().recent;
  return (
    <SwitcherDialog
      onClose={close}
      onOpen={go(nav).conversation}
      recent={recent}
      commands={paletteCommands(actions)}
      onSearch={(query) => go(nav).dialog({ kind: "search", query })}
    />
  );
}

/** The dialog open now, over the conversation, if this account may open it. */
export function OpenDialog() {
  const ctx = useViewContext();
  const dialog = useNavigationState((s) => s.dialog);
  const self = useWorkspace((s) => s.self);
  useCloseRefused();
  if (dialog.kind === "none") return null;
  const view = DIALOGS[dialog.kind] as DialogView<typeof dialog.kind>;
  if (view.allowed && !view.allowed(self, ctx.shell)) return null;
  if (view.needsChannel && !ctx.channelId) return null;
  const close = () => ctx.nav.closeDialog();
  const drawn = view.render(dialog as never, { ...ctx, channelId: ctx.channelId ?? "", close });
  if (view.frameless) return drawn;
  return (
    <LazyDialog key={dialog.kind} loading={view.loading} onClose={close}>
      {drawn}
    </LazyDialog>
  );
}

/**
 * Closes a dialog this account may not open, once the account is known: an
 * address can name People or Invite all the same. One taken away while open,
 * by another admin, says why it closed.
 */
function useCloseRefused() {
  const nav = useNavigation();
  const shell = useWorkspaceShell();
  const toast = useToast();
  const kind = useNavigationState((s) => s.dialog.kind);
  const self = useWorkspace((s) => s.self);
  const wasAllowed = useRef(false);
  const view = kind === "none" ? null : DIALOGS[kind];
  const allowed = !view?.allowed || view.allowed(self, shell);
  useEffect(() => {
    if (!self) return;
    if (view && !allowed) {
      nav.refuseDialog();
      if (wasAllowed.current && view.adminName)
        toast({
          message: `You are no longer an admin, so ${view.adminName} closed.`,
          kind: "info",
        });
    }
    wasAllowed.current = allowed;
  }, [self, view, allowed, nav, toast]);
}
