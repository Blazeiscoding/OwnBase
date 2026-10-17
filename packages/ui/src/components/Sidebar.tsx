import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { channelPermissions, type Channel, type ID } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { unreadThreadCount } from "@slackoss/client-core";
import { channelTitle, initials, workspaceGradient } from "../lib/format.js";
import { resumeTime, snoozeOptions } from "../lib/snooze.js";
import { shortcutLabel } from "../lib/shortcuts.js";
import { AvatarWithPresence, PresenceDot } from "./Avatar.js";
import { Icon, type IconName } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";
import { Menu, type MenuItem } from "./Menu.js";
import { CountBadge, Swap, useChanges } from "./Motion.js";
import { KeepAccountOffer } from "./KeepAccountOffer.js";
import { useOptionalToast } from "./Toast.js";
import { CLEAR_AFTER, STATUS_PRESETS, statusEnd, statusUntil } from "../lib/status.js";
import { huddleNames } from "../lib/huddleView.js";
import { namesList } from "../lib/catchUp.js";
import { muteItem, starItem, type Conversation } from "../lib/conversationChoices.js";

interface Props {
  activeChannelId: ID | null;
  onSelect: (id: ID) => void;
  onBrowseChannels: () => void;
  onNewChannel: () => void;
  onNewDm: () => void;
  onFriends: () => void;
  onSearch: () => void;
  onSaved: () => void;
  /** The side panel open beside the conversation, which its row shows. */
  openPanel?: string;
  /** Messages queued to send later; offered in the account menu. */
  onScheduled?: () => void;
  onActivity: () => void;
  onThreads: () => void;
  onInvite: () => void;
  /**
   * A channel's details, from the gear on its row; with "members", where
   * people are added to a private one. Opens that channel first.
   */
  onChannelDetails?: (channelId: ID, tab?: "members") => void;
  onSwitchWorkspace: () => void;
  onEditProfile: () => void;
  onAccountSettings: () => void;
  /** Guests only: keeping this identity as an account. */
  onCreateAccount?: () => void;
  onShortcuts?: () => void;
  onDiagnostics?: () => void;
  /** Shown under the Jump button, such as the owner's first steps. */
  gettingStarted?: ReactNode;
  /** Admins only; absent for members. */
  onManageApps?: () => void;
  onManagePeople?: () => void;
  onWorkspaceSettings?: () => void;
  connectionLabel: string | null;
  /** This computer's hosting, while it hosts or something is wrong with it. */
  hosting?: HostingLine;
  /** This device's other saved sign-ins, most recently used first. */
  otherWorkspaces?: OtherWorkspace[];
  onOpenWorkspace?: (url: string) => void;
}

/**
 * What this computer's hosting is doing, for the line under the workspace's
 * name (UX-25), where it replaced a bar along the bottom of the window.
 */
export interface HostingLine {
  /** Hosting, starting, stopping, or what is wrong. */
  text: string;
  state: "live" | "busy" | "trouble";
  /** Something wrong that a screen reader says at once. */
  alert?: boolean;
  onManage: () => void;
}

/** The hosting line: a dot for how it is going, what is happening, and Manage. */
export function HostingStatus(props: { hosting: HostingLine; className?: string }) {
  const { hosting } = props;
  return (
    <div
      className={`flex items-center gap-2 rounded-lg bg-ink/[0.04] px-2.5 py-1.5 text-[12px] ${props.className ?? ""}`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full ${
          hosting.state === "trouble"
            ? "bg-alert"
            : hosting.state === "live"
              ? "bg-online"
              : "animate-pulse bg-ink-faint"
        }`}
      />
      <span
        role={hosting.alert ? "alert" : "status"}
        title={hosting.text}
        className="min-w-0 flex-1 truncate text-ink-faint"
      >
        {hosting.text}
      </span>
      <button
        type="button"
        onClick={hosting.onManage}
        aria-label="Manage hosting"
        className="shrink-0 font-medium text-ink hover:underline"
      >
        Manage
      </button>
    </div>
  );
}

/** A saved sign-in to another workspace, without its credentials. */
export interface OtherWorkspace {
  url: string;
  name: string;
  handle: string;
}

export function Sidebar(props: Props) {
  const unreadThreads = useWorkspace((s) => unreadThreadCount(s.threadFollows));
  const friendRequests = useWorkspace(
    (s) => s.friends.filter((f) => f.status === "incoming").length,
  );
  const workspaceName = useWorkspace((s) => s.workspaceName);
  const channels = useWorkspace((s) => s.channels);
  const memberships = useWorkspace((s) => s.memberships);
  const channelLastSeq = useWorkspace((s) => s.channelLastSeq);
  const users = useWorkspace((s) => s.users);
  const presence = useWorkspace((s) => s.presence);
  const self = useWorkspace((s) => s.self);
  const selfId = self?.id;
  // A guest has public channels only: no DMs, rooms of its own, friends or schedules.
  const guest = self?.role === "guest";
  // Older servers do not send the flag; every member could invite there.
  const canInvite = !guest && (self?.canInvite ?? true);

  /**
   * Discord's two actions at the end of a channel's row: invite and settings,
   * before the row's More menu.
   * Everyone in a public channel is everyone in the workspace, so inviting to
   * one invites to the workspace; a private one is joined by being added.
   */
  function channelActions(ch: Channel): RowAction[] {
    const actions: RowAction[] = [];
    if (ch.type === "private") {
      if (
        channelPermissions(self ?? undefined, ch, ch.id in memberships).invite &&
        props.onChannelDetails
      )
        actions.push({
          label: `Add people to ${ch.name}`,
          icon: "userPlus",
          onClick: () => props.onChannelDetails?.(ch.id, "members"),
        });
    } else if (canInvite) {
      actions.push({ label: "Invite people", icon: "userPlus", onClick: props.onInvite });
    }
    if (props.onChannelDetails)
      actions.push({
        label: `Channel settings for ${ch.name}`,
        icon: "settings",
        onClick: () => props.onChannelDetails?.(ch.id),
      });
    return actions;
  }
  const drafts = useWorkspace((s) => s.drafts);
  const prefs = useWorkspace((s) => s.prefs);
  // An older server keeps no stars, so none is offered there.
  const stars = useWorkspace((s) => s.stars);
  const huddles = useWorkspace((s) => s.huddles);
  const mentionCounts = useWorkspace((s) => s.mentionCounts);
  const dndUntil = useWorkspace((s) => s.self?.dndUntil ?? null);
  const snoozed = dndUntil !== null && dndUntil > Date.now();
  const others = props.otherWorkspaces ?? [];
  const name = workspaceName || "Connecting…";

  const { starred, rooms, dms } = useMemo(() => {
    const starred: Channel[] = [];
    const rooms: Channel[] = [];
    const dms: Channel[] = [];
    for (const ch of Object.values(channels)) {
      // An archived channel keeps its star, and comes back to Starred with it.
      if (ch.archived || !(ch.id in memberships)) continue;
      // Starred moves a conversation out of its usual section, as Slack's does.
      if (prefs[ch.id]?.starred) starred.push(ch);
      else if (isDirect(ch)) dms.push(ch);
      else rooms.push(ch);
    }
    // By name, channels and people together, so a row stays where it was put
    // rather than jumping each time a message arrives.
    const named = (ch: Channel) => (isDirect(ch) ? channelTitle(ch, users, selfId) : ch.name);
    starred.sort((a, b) => named(a).localeCompare(named(b)));
    rooms.sort((a, b) => a.name.localeCompare(b.name));
    dms.sort((a, b) => (channelLastSeq[b.id] ?? 0) - (channelLastSeq[a.id] ?? 0));
    return { starred, rooms, dms };
  }, [channels, memberships, channelLastSeq, prefs, users, selfId]);

  const isUnread = (id: ID) => (channelLastSeq[id] ?? 0) > (memberships[id] ?? 0);
  const hasDraft = (id: ID) => !!drafts[id];
  // Muted channels still show unread state, just quietly.
  const isMuted = (id: ID) => prefs[id]?.muted ?? false;
  const huddleWith = (id: ID) => huddleNames(huddles[id] ?? [], users, self?.id);
  const mentions = (id: ID) => mentionCounts[id] ?? 0;
  const totalMentions = Object.values(mentionCounts).reduce((sum, n) => sum + n, 0);
  const unreadConversations = Object.keys(memberships).filter((id) => isUnread(id)).length;

  const [collapsed, toggleCollapsed] = useCollapsedSections();
  // How often each category has been opened again: its rows come in afresh each time.
  const [reopened, setReopened] = useState<Record<string, number>>({});
  const toggleSection = (section: string) => {
    if (collapsed.has(section))
      setReopened((was) => ({ ...was, [section]: (was[section] ?? 0) + 1 }));
    toggleCollapsed(section);
  };
  const rowsIn = (section: string) => (reopened[section] ? "rows-in" : "");
  // A collapsed category still shows where you are and what is waiting, as Discord's do.
  const shown = (section: string, id: ID) =>
    !collapsed.has(section) ||
    id === props.activeChannelId ||
    (isUnread(id) && !isMuted(id)) ||
    mentions(id) > 0;

  const client = useClient();
  const toast = useOptionalToast();
  const nav = useRef<HTMLElement>(null);
  /**
   * A row starred or unstarred from its own menu moves to another section, and
   * the menu's button goes with it. Focus follows it there, or to the header
   * of a folded section it went into, rather than falling out of the sidebar.
   */
  const moved = useRef<{ id: ID; section: string } | null>(null);
  useEffect(() => {
    const to = moved.current;
    if (!to) return;
    moved.current = null;
    const row = nav.current?.querySelector<HTMLElement>(`[data-conversation="${to.id}"]`);
    if (row) {
      // A row's buttons are hidden until it holds focus (theme.css), and a
      // hidden button cannot take it, so the row's own button takes it first.
      row.querySelector<HTMLElement>(".channel-row")?.focus();
      row.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
    } else {
      nav.current?.querySelector<HTMLElement>(`[data-section-toggle="${to.section}"]`)?.focus();
    }
  });

  /** A row's own menu: Star or Unstar, and Mute or Unmute, named by what they do now. */
  function rowMenu(ch: Channel, label: string): RowMenu {
    const conversation: Conversation = {
      id: ch.id,
      noun: isDirect(ch) ? "conversation" : "channel",
    };
    const items: MenuItem[] = [];
    if (stars) {
      const isStarred = prefs[ch.id]?.starred === true;
      const star = starItem(client, toast, conversation, isStarred);
      const to = !isStarred ? "starred" : isDirect(ch) ? "dms" : "channels";
      items.push({
        ...star,
        onSelect: () => {
          moved.current = { id: ch.id, section: to };
          star.onSelect();
        },
      });
    }
    items.push(muteItem(client, toast, conversation, isMuted(ch.id)));
    return { label, items };
  }

  function roomRow(ch: Channel) {
    return (
      <ChannelRow
        key={ch.id}
        id={ch.id}
        active={ch.id === props.activeChannelId}
        unread={isUnread(ch.id)}
        muted={isMuted(ch.id)}
        draft={hasDraft(ch.id)}
        huddle={huddleWith(ch.id)}
        mentions={mentions(ch.id)}
        onClick={() => props.onSelect(ch.id)}
        actions={channelActions(ch)}
        menu={rowMenu(ch, ch.name)}
        icon={
          ch.type === "private" ? (
            <span role="img" aria-label="Private channel" title="Private channel">
              <Icon name="lock" size={14} />
            </span>
          ) : (
            // Drawn, and still read as "# general" as it was typed.
            <>
              <Icon name="hash" size={15} />
              <span className="sr-only">#</span>
            </>
          )
        }
        label={ch.name}
      />
    );
  }

  function dmRow(ch: Channel) {
    const others = (ch.memberIds ?? []).filter((id) => id !== self?.id);
    const online = others.some((id) => presence[id] === "online");
    const first = users[others[0] ?? ""];
    const title = channelTitle(ch, users, self?.id);
    return (
      <ChannelRow
        key={ch.id}
        id={ch.id}
        active={ch.id === props.activeChannelId}
        unread={isUnread(ch.id)}
        muted={isMuted(ch.id)}
        draft={hasDraft(ch.id)}
        huddle={huddleWith(ch.id)}
        mentions={mentions(ch.id)}
        onClick={() => props.onSelect(ch.id)}
        menu={rowMenu(ch, title)}
        icon={
          first ? (
            <AvatarWithPresence user={first} online={online} size={20} ring="var(--color-deep)" />
          ) : (
            <PresenceDot online={online} />
          )
        }
        label={title}
        roomy
      />
    );
  }

  return (
    <nav
      ref={nav}
      aria-label="Workspace navigation"
      // On a phone this is a drawer, closed by the time a panel opened from it
      // closes; focus then goes to the button that opens the drawer.
      data-focus-fallback="open-navigation"
      className="workspace-sidebar flex h-full shrink-0 flex-col bg-deep"
    >
      <div className="flex min-h-0 flex-1">
        <WorkspaceRail
          name={name}
          unread={totalMentions}
          others={others}
          onOpen={props.onOpenWorkspace}
          onAdd={props.onSwitchWorkspace}
        />
        <div className="sidebar-column flex min-w-0 flex-col">
          <header className="titlebar-drag flex h-12 shrink-0 items-center px-2 shadow-[0_1px_0_var(--color-edge)]">
            <h1 className="min-w-0 flex-1 text-[15px] font-semibold">
              <WorkspaceMenu
                name={name}
                others={others}
                onOpen={props.onOpenWorkspace}
                onAdd={props.onSwitchWorkspace}
                onCreateAccount={guest ? props.onCreateAccount : undefined}
                onInvite={props.onInvite}
                onManagePeople={props.onManagePeople}
                onManageApps={props.onManageApps}
                onWorkspaceSettings={props.onWorkspaceSettings}
              />
            </h1>
          </header>
          {props.connectionLabel && (
            <p
              role="status"
              className="mx-2 mt-2 flex items-center gap-2 rounded-lg bg-copper/10 px-2.5 py-1.5 text-[12px] font-medium text-copper"
            >
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-copper" />
              <Swap on={props.connectionLabel} text className="min-w-0">
                <span className="block truncate first-letter:uppercase">
                  {props.connectionLabel}
                </span>
              </Swap>
            </p>
          )}
          {props.hosting && <HostingStatus hosting={props.hosting} className="mx-2 mt-2" />}

          <div className="px-2 pb-1 pt-2.5">
            {/* Its words and shortcut are on the button already, so it needs no
              hint. A tooltip would also open when the phone drawer puts focus
              here, and take the Escape meant to close the drawer. */}
            <button
              onClick={props.onSearch}
              data-drawer-focus
              aria-keyshortcuts="Control+K Meta+K"
              className="flex h-8 w-full items-center gap-2 rounded-lg bg-ink/[0.06] px-2.5 text-[13px] text-ink-faint transition-colors hover:bg-ink/[0.09] hover:text-ink-dim"
            >
              <Icon name="search" size={14} />
              <span className="flex-1 text-left">Jump to…</span>
              <kbd aria-hidden="true" className="font-sans text-[11px] tracking-wide">
                {shortcutLabel("Mod+K")}
              </kbd>
            </button>
          </div>

          <div className="sidebar-scroll flex-1 overflow-y-auto px-2 pb-3 pt-1.5">
            {props.gettingStarted}
            <ul className="mb-4 space-y-px">
              <li>
                <NavRow
                  icon="activity"
                  label="Activity"
                  onClick={props.onActivity}
                  open={props.openPanel === "activity"}
                >
                  {totalMentions > 0 ? (
                    <Count label="Unread mentions" strong count={totalMentions} />
                  ) : (
                    <Count label="Unread conversations" count={unreadConversations} />
                  )}
                </NavRow>
              </li>
              <li>
                <NavRow
                  icon="thread"
                  label="Threads"
                  onClick={props.onThreads}
                  open={props.openPanel === "threads"}
                >
                  <Count label="Threads with unread replies" count={unreadThreads} />
                </NavRow>
              </li>
              <li>
                <NavRow
                  icon="bookmark"
                  label="Saved"
                  onClick={props.onSaved}
                  open={props.openPanel === "saved"}
                />
              </li>
            </ul>

            {starred.length > 0 && (
              <>
                <SectionHeader
                  label="Starred"
                  section="starred"
                  collapsed={collapsed.has("starred")}
                  onToggle={() => toggleSection("starred")}
                  actions={[]}
                />
                <ul key={reopened.starred} className={`mb-4 space-y-px ${rowsIn("starred")}`}>
                  {starred
                    .filter((ch) => shown("starred", ch.id))
                    .map((ch) => (isDirect(ch) ? dmRow(ch) : roomRow(ch)))}
                </ul>
              </>
            )}

            <SectionHeader
              label="Channels"
              section="channels"
              collapsed={collapsed.has("channels")}
              onToggle={() => toggleSection("channels")}
              actions={[
                { label: "Browse channels", icon: "compass", onClick: props.onBrowseChannels },
                ...(guest
                  ? []
                  : [{ label: "New channel", icon: "plus" as const, onClick: props.onNewChannel }]),
              ]}
            />
            <ul key={reopened.channels} className={`mb-4 space-y-px ${rowsIn("channels")}`}>
              {rooms.filter((ch) => shown("channels", ch.id)).map(roomRow)}
            </ul>

            {!guest && (
              <SectionHeader
                label="Direct messages"
                section="dms"
                collapsed={collapsed.has("dms")}
                onToggle={() => toggleSection("dms")}
                actions={[
                  {
                    label: "Friends",
                    icon: "friends",
                    onClick: props.onFriends,
                    badge: friendRequests,
                  },
                  { label: "New message", icon: "plus", onClick: props.onNewDm },
                ]}
              />
            )}
            <ul key={reopened.dms} className={`space-y-px ${rowsIn("dms")}`}>
              {dms.filter((ch) => shown("dms", ch.id)).map(dmRow)}
            </ul>
            {/* For someone with nobody to talk to yet; starred ones still count. */}
            {dms.length === 0 && !starred.some(isDirect) && !guest && (
              <button
                onClick={props.onNewDm}
                className="group mt-1 flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink"
              >
                <span className="flex size-5 items-center justify-center rounded-full border border-dashed border-ink-faint/60 group-hover:border-ink-dim">
                  <Icon name="plus" size={12} />
                </span>
                Send someone a message
              </button>
            )}
          </div>
        </div>
      </div>
      {guest && props.onCreateAccount && <KeepAccountOffer onKeep={props.onCreateAccount} />}
      {/* Discord's floating panel: you, across the foot of the rail and the list. */}
      <footer className="user-panel m-2 mt-0 shrink-0 rounded-xl border border-edge bg-raised p-1.5 shadow-[0_8px_24px_-12px_rgb(0_0_0/0.5)]">
        {snoozed && <SnoozedNotice until={dndUntil!} />}
        <div className="flex items-center gap-0.5">
          <AccountMenu
            guest={guest}
            snoozed={snoozed}
            onCreateAccount={props.onCreateAccount}
            onEditProfile={props.onEditProfile}
            onAccountSettings={props.onAccountSettings}
            onScheduled={guest ? undefined : props.onScheduled}
            onShortcuts={props.onShortcuts}
            onDiagnostics={props.onDiagnostics}
          />
          {!snoozed && <SnoozeControl />}
          {!guest && (
            <Tooltip label="Settings">
              <button
                onClick={props.onAccountSettings}
                aria-label="Settings"
                className="group/gear flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink"
              >
                <Icon
                  name="settings"
                  size={17}
                  className="transition-transform duration-300 group-hover/gear:rotate-45"
                />
              </button>
            </Tooltip>
          )}
        </div>
      </footer>
    </nav>
  );
}

/**
 * Which sidebar categories are folded away, kept on this device. Storage
 * that is unavailable, as in a private window, only means they reopen.
 */
function useCollapsedSections(): [Set<string>, (section: string) => void] {
  const key = "tandem:collapsed-sections";
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (section: string) =>
    setCollapsed((was) => {
      const next = new Set(was);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        // Kept for this session only.
      }
      return next;
    });
  return [collapsed, toggle];
}

/** A count beside a row: quiet for unread, the accent for what names you. */
function Count(props: { label: string; strong?: boolean; count: number }) {
  return (
    <CountBadge
      count={props.count}
      aria-label={props.label}
      className={`tabular min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold leading-[18px] ${
        props.strong ? "badge-mention" : "bg-ink/[0.08] text-ink-dim"
      }`}
    />
  );
}

/** One of the sidebar's own places, above the channels. */
function NavRow(props: {
  icon: IconName;
  label: string;
  onClick: () => void;
  /** Its panel is open beside the conversation. */
  open?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      onClick={props.onClick}
      aria-current={props.open ? "true" : undefined}
      className={`flex h-[34px] w-full items-center gap-3 rounded-lg px-2 text-[15px] font-medium transition-colors ${
        props.open
          ? "channel-row-active text-ink"
          : "text-ink-faint hover:bg-ink/[0.06] hover:text-ink-dim"
      }`}
    >
      <Icon name={props.icon} size={18} className={props.open ? "text-copper" : "text-ink-faint"} />
      <span className="min-w-0 flex-1 truncate text-left">{props.label}</span>
      {props.children}
    </button>
  );
}

/**
 * Discord's rail of servers, for Tandem's workspaces: this one, marked as on
 * screen, then this device's other saved sign-ins, then a way to add one.
 * The same choices as the menu on the workspace's name, one click away.
 */
function WorkspaceRail(props: {
  name: string;
  unread: number;
  others: OtherWorkspace[];
  onOpen?: (url: string) => void;
  onAdd: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Workspaces"
      className="workspace-rail titlebar-drag flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto pb-3 pt-3"
    >
      <RailItem label={props.name} current badge={props.unread} />
      {props.others.map((w) => (
        <RailItem
          key={w.url}
          label={`${w.name} · @${w.handle}`}
          title={w.name}
          onClick={() => props.onOpen?.(w.url)}
        />
      ))}
      <span aria-hidden="true" className="h-0.5 w-8 shrink-0 rounded-full bg-edge" />
      <div className="group relative flex w-full justify-center">
        <Tooltip label="Add or join a workspace" side="right">
          <button
            onClick={props.onAdd}
            aria-label="Add or join a workspace"
            className="squircle flex size-12 items-center justify-center bg-raised text-online hover:bg-online hover:text-ground"
          >
            <Icon name="plus" size={22} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

function RailItem(props: {
  /** What it is called to a screen reader. */
  label: string;
  /** What its initials and tooltip are made from; the label when absent. */
  title?: string;
  current?: boolean;
  badge?: number;
  onClick?: () => void;
}) {
  const title = props.title ?? props.label;
  return (
    <div className="group relative flex w-full justify-center">
      {/* Discord's pill: a bar for the workspace on screen, a nub when pointed at. */}
      <span
        aria-hidden="true"
        className="rail-pill"
        data-state={props.current ? "current" : undefined}
      />
      <Tooltip label={title} side="right">
        <button
          onClick={props.onClick}
          aria-label={props.label}
          aria-current={props.current ? "page" : undefined}
          className="squircle relative flex size-12 shrink-0 select-none items-center justify-center text-[15px] font-semibold text-white"
          style={{ background: workspaceGradient(title) }}
        >
          {initials(title)}
          <CountBadge
            count={props.badge ?? 0}
            aria-hidden="true"
            className="badge-mention absolute -bottom-1 -right-1 min-w-5 rounded-full px-1 text-center text-[11px] font-bold leading-4 ring-4 ring-deep"
          />
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * The workspace's name, at the top of the sidebar, opens what concerns the
 * workspace: bringing people in, running it, and moving to another one.
 * Two sign-ins to workspaces with the same name are told apart by the
 * account and the address.
 */
function WorkspaceMenu(props: {
  name: string;
  others: OtherWorkspace[];
  onOpen?: (url: string) => void;
  onAdd: () => void;
  /** Given for a guest, who cannot invite. */
  onCreateAccount?: () => void;
  onInvite: () => void;
  onManagePeople?: () => void;
  onManageApps?: () => void;
  onWorkspaceSettings?: () => void;
}) {
  const items: MenuItem[] = props.onCreateAccount
    ? [
        {
          id: "create-account",
          label: "Create an account",
          icon: "userPlus",
          onSelect: props.onCreateAccount,
        },
      ]
    : [{ id: "invite", label: "Invite people", icon: "userPlus", onSelect: props.onInvite }];
  if (props.onManagePeople)
    items.push({ id: "people", label: "People", icon: "members", onSelect: props.onManagePeople });
  if (props.onManageApps)
    items.push({
      id: "apps",
      label: "Apps and integrations",
      icon: "grid",
      onSelect: props.onManageApps,
    });
  if (props.onWorkspaceSettings)
    items.push({
      id: "workspace-settings",
      label: "Workspace settings",
      icon: "settings",
      onSelect: props.onWorkspaceSettings,
    });
  const names = props.others.map((w) => w.name);
  props.others.forEach((w, i) => {
    const shared = names.filter((n) => n === w.name).length > 1 || w.name === props.name;
    items.push({
      id: w.url,
      label: `${w.name} · @${w.handle}${shared ? ` · ${w.url.replace(/^https?:\/\//, "")}` : ""}`,
      section: i === 0 ? "Switch to" : undefined,
      onSelect: () => props.onOpen?.(w.url),
    });
  });
  items.push({
    id: "add",
    label: "Add or join a workspace…",
    icon: "plus",
    section: props.others.length === 0 ? true : undefined,
    onSelect: props.onAdd,
  });
  return (
    <Menu
      label="Workspace"
      triggerLabel={`${props.name}, workspace menu`}
      items={items}
      align="start"
      triggerClassName="group/ws flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-ink/[0.06]"
      triggerContent={
        <>
          <span className="min-w-0 flex-1 truncate">{props.name}</span>
          <Icon
            name="chevronDown"
            size={16}
            className="shrink-0 text-ink-faint transition-colors group-hover/ws:text-ink"
          />
        </>
      }
    />
  );
}

/**
 * You, at the foot of the sidebar: your name and status, and what concerns
 * only you — your profile, your settings, your queued messages, and help.
 * The phone's bottom bar opens the same menu from a button of its own.
 */
export function AccountMenu(props: {
  guest: boolean;
  snoozed: boolean;
  onCreateAccount?: () => void;
  onEditProfile: () => void;
  onAccountSettings: () => void;
  onScheduled?: () => void;
  onShortcuts?: () => void;
  onDiagnostics?: () => void;
  /** Another button to open it, drawn by its owner; on a phone it opens as a sheet. */
  trigger?: { label: string; className: string; content: ReactNode };
}) {
  const self = useWorkspace((s) => s.self);
  const client = useClient();
  const toast = useOptionalToast();
  const items: MenuItem[] = [];
  /** Sets a status straight from the menu: two clicks for the common ones, each ending when it usually does. */
  const setStatus = (statusEmoji: string, statusText: string, statusExpiresAt: number | null) => {
    client.api.updateMe({ statusEmoji, statusText, statusExpiresAt }).catch(() => {
      toast?.({
        message: "Your status was not changed. Check your connection and try again.",
        kind: "error",
      });
    });
  };
  if (!props.guest && self) {
    const ends = self.statusExpiresAt;
    const current =
      `${self.statusEmoji} ${self.statusText}`.trim() + (ends ? ` · ${statusUntil(ends)}` : "");
    if (current)
      items.push({
        id: "clear-status",
        label: "Clear status",
        icon: "close",
        section: current,
        ariaLabel: `Clear status, ${current}`,
        onSelect: () => setStatus("", "", null),
      });
    STATUS_PRESETS.slice(0, 3)
      .filter((p) => p.text !== self.statusText)
      .forEach((p, i) => {
        const lasts =
          p.clearAfter === "never"
            ? undefined
            : CLEAR_AFTER.find((c) => c.id === p.clearAfter)!.label;
        items.push({
          id: `status-${p.text}`,
          label: p.text,
          emoji: p.emoji,
          hint: lasts,
          section: !current && i === 0 ? "Set a status" : undefined,
          ariaLabel: `Set status: ${p.text}${lasts ? `, for ${lasts.toLowerCase()}` : ""}`,
          onSelect: () => setStatus(p.emoji, p.text, statusEnd(p.clearAfter)),
        });
      });
  }
  if (props.guest && props.onCreateAccount)
    items.push({
      id: "create-account",
      label: "Create an account",
      icon: "userPlus",
      onSelect: props.onCreateAccount,
    });
  if (!props.guest) {
    items.push({
      id: "profile",
      label: "Profile and status",
      icon: "user",
      section: true,
      onSelect: props.onEditProfile,
    });
    items.push({
      id: "account",
      label: "Account settings",
      icon: "settings",
      onSelect: props.onAccountSettings,
    });
  }
  if (props.onScheduled)
    items.push({
      id: "scheduled",
      label: "Scheduled messages",
      icon: "clock",
      onSelect: props.onScheduled,
    });
  // Help: the shortcut sheet opened only with Ctrl+/, and nothing said so.
  if (props.onShortcuts)
    items.push({
      id: "shortcuts",
      label: "Keyboard shortcuts",
      icon: "keyboard",
      section: true,
      onSelect: props.onShortcuts,
    });
  if (props.onDiagnostics)
    items.push({
      id: "diagnostics",
      label: "Diagnostics",
      icon: "help",
      section: props.onShortcuts ? undefined : true,
      onSelect: props.onDiagnostics,
    });
  if (props.trigger)
    return (
      <Menu
        label="Your account"
        triggerLabel={props.trigger.label}
        items={items}
        align="start"
        sheet
        triggerClassName={props.trigger.className}
        triggerContent={props.trigger.content}
      />
    );
  const status = props.guest
    ? "Guest"
    : self?.statusText || self?.statusEmoji
      ? `${self.statusEmoji} ${self.statusText}`.trim()
      : "Set a status";
  return (
    <div className="min-w-0 flex-1">
      <Menu
        label="Your account"
        triggerLabel={`${self?.displayName ?? "…"}, ${status}, your account`}
        items={items}
        align="start"
        triggerClassName="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-ink/[0.05]"
        triggerContent={
          <>
            <AvatarWithPresence
              user={self ?? undefined}
              online={!props.snoozed}
              size={32}
              ring="var(--color-raised)"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold">
                {self?.displayName ?? "…"}
              </span>
              <span className="block truncate text-[12px] text-ink-faint">{status}</span>
            </span>
          </>
        }
      />
    </div>
  );
}

/** While notifications are paused: until when, and a way to resume now. */
function SnoozedNotice({ until }: { until: number }) {
  const client = useClient();
  const resumesAt = resumeTime(until, new Date());
  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg bg-ink/[0.05] px-2.5 py-1.5">
      <span className="text-ink-dim">
        <Icon name="bellOff" size={14} />
      </span>
      <span className="min-w-0 flex-1 text-[12px] text-ink-dim">Paused until {resumesAt}</span>
      <button
        onClick={() => client.snoozeNotifications(null)}
        className="rounded px-1 text-[12px] font-medium text-ink hover:underline"
      >
        Resume
      </button>
    </div>
  );
}

/** Do Not Disturb: pause notifications for a while. */
function SnoozeControl() {
  const client = useClient();
  return (
    <Menu
      label="Pause notifications"
      tooltip="Pause notifications"
      // Headed, so "30 minutes" reads as how long to pause, not a reminder.
      items={snoozeOptions(new Date()).map((o, index) => ({
        id: o.label,
        label: o.label,
        section: index === 0 ? "Pause notifications" : undefined,
        onSelect: () => client.snoozeNotificationsUntil(o.until()),
      }))}
      triggerClassName="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink"
      triggerContent={
        <>
          <Icon name="bell" size={17} />
          <span className="sr-only">Pause notifications</span>
        </>
      }
    />
  );
}

function SectionHeader(props: {
  label: string;
  /** Which section this heads, for focus to find its toggle by. */
  section: string;
  /** Folded away, as Discord's categories fold; a click opens it again. */
  collapsed?: boolean;
  onToggle?: () => void;
  /** Each action shows only its icon, and its label names it. */
  actions: { label: string; icon: IconName; onClick: () => void; badge?: number }[];
}) {
  return (
    <div className="group/section mb-0.5 flex h-7 items-center justify-between pr-0.5">
      <button
        type="button"
        onClick={props.onToggle}
        data-section-toggle={props.section}
        aria-expanded={props.onToggle ? !props.collapsed : undefined}
        className="flex min-w-0 flex-1 items-center gap-0.5 rounded-md py-1 pl-0.5 text-left text-[12px] font-semibold uppercase tracking-[0.04em] text-ink-faint transition-colors hover:text-ink-dim"
      >
        <Icon
          name="chevronDown"
          size={12}
          className={`shrink-0 transition-transform duration-150 ${props.collapsed ? "-rotate-90" : ""}`}
        />
        <span className="truncate">{props.label}</span>
      </button>
      <span className="flex items-center gap-0.5">
        {props.actions.map((a) => (
          <Tooltip key={a.label} label={a.label}>
            <button
              onClick={a.onClick}
              aria-label={a.badge ? `${a.label}, ${a.badge} new` : a.label}
              className="relative flex size-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.07] hover:text-ink"
            >
              <Icon name={a.icon} size={15} />
              <CountBadge
                count={a.badge ?? 0}
                dot
                aria-hidden="true"
                className="badge-mention absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-deep"
              />
            </button>
          </Tooltip>
        ))}
      </span>
    </div>
  );
}

/** One of the small buttons at the end of a channel's row. */
interface RowAction {
  label: string;
  icon: IconName;
  onClick: () => void;
}

/** The More menu at the very end of a conversation's row, named for the conversation. */
interface RowMenu {
  label: string;
  items: MenuItem[];
}

/** A direct message or a group one, rather than a channel. */
function isDirect(ch: Channel): boolean {
  return ch.type === "dm" || ch.type === "group_dm";
}

const ROW_ACTION =
  "flex size-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.08] hover:text-ink";

function ChannelRow(props: {
  id: ID;
  active: boolean;
  unread: boolean;
  muted: boolean;
  draft: boolean;
  /** Who is in this channel’s huddle, by name; empty for none. */
  huddle: string[];
  /** Unread messages here that name this user; 0 for none. */
  mentions: number;
  icon: React.ReactNode;
  label: string;
  /** A row with an avatar in place of the channel mark. */
  roomy?: boolean;
  onClick: () => void;
  /**
   * Shown at the row's end while it is pointed at, holds the keyboard, or is
   * the one open, as Discord shows its invite and settings (theme.css).
   */
  actions?: RowAction[];
  /** More, after the actions; a right-click on the row opens it too. */
  menu?: RowMenu;
}) {
  const showUnread = props.unread && !props.active && !props.muted;
  // One that comes while the sidebar is open pops in, as the counts do.
  const unreadCame = useChanges(showUnread);
  const [menuOpen, setMenuOpen] = useState(false);
  const actions = props.actions ?? [];
  const count = actions.length + (props.menu ? 1 : 0);
  return (
    <li
      className="channel-item relative"
      data-conversation={props.id}
      data-active={props.active || undefined}
      data-actions={count || undefined}
      data-menu-open={menuOpen || undefined}
    >
      {/* Discord's unread nub, at the very edge of the sidebar. */}
      {showUnread && (
        <span
          aria-hidden="true"
          className={`absolute -left-2 top-1/2 h-2 w-1 -translate-y-1/2 rounded-r-full bg-ink ${
            unreadCame ? "animate-badge-in" : ""
          }`}
        />
      )}
      <button
        onClick={props.onClick}
        onContextMenu={
          props.menu &&
          ((event) => {
            event.preventDefault();
            setMenuOpen(true);
          })
        }
        aria-current={props.active ? "page" : undefined}
        className={`channel-row flex h-[34px] w-full items-center gap-2 rounded-lg px-2 text-left text-[15px] font-medium transition-colors ${
          props.active
            ? "channel-row-active text-ink"
            : props.muted
              ? "text-ink-faint hover:bg-ink/[0.06]"
              : props.unread
                ? "font-semibold text-ink hover:bg-ink/[0.06]"
                : "text-ink-faint hover:bg-ink/[0.06] hover:text-ink-dim"
        }`}
      >
        <span
          className={`flex shrink-0 items-center justify-center ${
            props.roomy ? "w-5" : "w-4"
          } ${props.active ? "text-copper" : showUnread ? "text-ink-dim" : "text-ink-faint"}`}
        >
          {props.icon}
        </span>{" "}
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {props.huddle.length > 0 && (
          <span
            role="img"
            aria-label={`Huddle with ${namesList(props.huddle)}`}
            title={`Huddle with ${namesList(props.huddle)}`}
            className="flex shrink-0 items-center gap-0.5 text-online"
          >
            <Icon name="headphones" size={14} />
            <span className="tabular text-[11px] font-semibold">{props.huddle.length}</span>
          </span>
        )}
        {props.draft && !props.active && (
          <span role="img" aria-label="Draft" title="Draft" className="shrink-0 text-ink-faint">
            <Icon name="edit" size={13} />
          </span>
        )}
        {props.muted && (
          <span role="img" aria-label="Muted" title="Muted" className="shrink-0 text-ink-faint">
            <Icon name="bellOff" size={13} />
          </span>
        )}
        <CountBadge
          count={props.mentions}
          aria-label={`${props.mentions} unread ${
            props.mentions === 1 ? "mention" : "mentions"
          } in ${props.label}`}
          className="badge-mention tabular min-w-5 shrink-0 rounded-full px-1.5 text-center text-[11px] font-bold leading-[18px]"
        />
      </button>
      {count > 0 && (
        // Beside the row's button, not in it: a button may not hold another.
        <span className="channel-actions absolute right-1 top-1/2 -translate-y-1/2 items-center gap-0.5">
          {actions.map((action) => (
            <Tooltip key={action.label} label={action.label}>
              <button
                type="button"
                aria-label={action.label}
                onClick={action.onClick}
                className={ROW_ACTION}
              >
                <Icon name={action.icon} size={15} />
              </button>
            </Tooltip>
          ))}
          {props.menu && (
            <Menu
              label={`Options for ${props.menu.label}`}
              items={props.menu.items}
              sheet
              open={menuOpen}
              onOpenChange={setMenuOpen}
              tooltip="More"
              triggerLabel={`More options for ${props.menu.label}`}
              triggerContent={<Icon name="dots" size={15} strokeWidth={2} />}
              triggerClassName={`icon-live ${ROW_ACTION}`}
            />
          )}
        </span>
      )}
    </li>
  );
}
