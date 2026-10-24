import { useId, type ReactNode } from "react";
import type { ID } from "@slackoss/protocol";
import { blockedPartner } from "../lib/blocking.js";
import { dueReminderCount, unreadThreadCount } from "@slackoss/client-core";
import { useWorkspace } from "../context.js";
import { useMediaQuery } from "../lib/useMediaQuery.js";
import { useOnScreenKeyboard } from "../lib/onScreenKeyboard.js";
import { useEdgeSwipe } from "../lib/edgeSwipe.js";
import { AvatarWithPresence } from "./Avatar.js";
import { Badge } from "./Badge.js";
import { Icon, type IconName } from "./Icon.js";
import { hasOpenModal } from "./Modal.js";
import { AccountMenu } from "./Sidebar.js";

/**
 * Where the bottom bar shows: the width half of theme.css's drawer query, so a
 * phone held upright. On its side a phone keeps the drawer alone, since height
 * is what it lacks there.
 */
export const PHONE_QUERY = "(max-width: 760px)";
/** theme.css's drawer query, where a swipe from the edge opens the sidebar. */
const DRAWER_QUERY = "(max-width: 760px), (max-height: 480px)";

/** What the account menu does, as the sidebar's own menu is given it. */
export interface AccountActions {
  onCreateAccount?: () => void;
  onEditProfile: () => void;
  onAccountSettings: () => void;
  onScheduled?: () => void;
  onShortcuts?: () => void;
  onDiagnostics?: () => void;
}

/**
 * What a phone adds to the workspace (UX-70, UX-71): a bar along the bottom
 * with Home, DMs, Activity and You, so the places people look for most are in
 * sight rather than behind the drawer; a swipe in from the left edge that
 * opens the drawer, which still has every channel; and a layout that keeps
 * clear of the on-screen keyboard. The web client only: the desktop app's
 * window is never a phone.
 */
export function PhoneNavigation(props: {
  activeChannelId: ID | null;
  /** The side panel open now; Activity's and the DMs' mark their place in the bar. */
  openPanel: string;
  drawerOpen: boolean;
  onOpenDrawer: () => void;
  onCloseDrawer: () => void;
  /** Closes whatever covers the conversation, back to it. */
  onConversation: () => void;
  onDirectMessages: () => void;
  onActivity: () => void;
  account: AccountActions;
}) {
  useOnScreenKeyboard();
  useEdgeSwipe({
    open: props.drawerOpen,
    enabled: () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(DRAWER_QUERY).matches &&
      !hasOpenModal(),
    onOpen: props.onOpenDrawer,
    onClose: props.onCloseDrawer,
  });
  const phone = useMediaQuery(PHONE_QUERY);
  const drawerLayout = useMediaQuery(DRAWER_QUERY);
  const workspaceName = useWorkspace((s) => s.workspaceName);
  return (
    <>
      {/* The sidebar's heading, the workspace's name, is hidden with the
          closed drawer; it stays the page's heading, in its banner, for a
          screen reader. */}
      {drawerLayout && !props.drawerOpen && workspaceName && (
        <header className="sr-only">
          <h1>{workspaceName}</h1>
        </header>
      )}
      {phone && <BottomBar {...props} />}
    </>
  );
}

/** One of the bar's buttons: as tall as the bar, and a quarter of its width. */
const ITEM =
  "group/item flex h-full w-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-medium leading-4";

function BottomBar(props: Parameters<typeof PhoneNavigation>[0]) {
  const { activeChannelId } = props;
  const guest = useWorkspace((s) => s.self?.role === "guest");
  const self = useWorkspace((s) => s.self);
  const dndUntil = useWorkspace((s) => s.self?.dndUntil ?? null);
  const snoozed = dndUntil !== null && dndUntil > Date.now();
  // What waits elsewhere, as the drawer's button counts it: the conversation
  // on screen is being read, and a muted one does not call for attention.
  const unreadRooms = useWorkspace((s) =>
    Object.keys(s.memberships).some((id) => {
      const channel = s.channels[id];
      return (
        id !== activeChannelId &&
        (channel?.type === "public" || channel?.type === "private") &&
        !channel.archived &&
        !s.prefs[id]?.muted &&
        (s.channelLastSeq[id] ?? 0) > (s.memberships[id] ?? 0)
      );
    }),
  );
  const unreadDms = useWorkspace(
    (s) =>
      Object.keys(s.memberships).filter((id) => {
        const channel = s.channels[id];
        return (
          id !== activeChannelId &&
          (channel?.type === "dm" || channel?.type === "group_dm") &&
          !channel.archived &&
          !s.prefs[id]?.muted &&
          // Waiting unseen with someone blocked (E12).
          !blockedPartner(channel, s.self?.id, s.blocked) &&
          (s.channelLastSeq[id] ?? 0) > (s.memberships[id] ?? 0)
        );
      }).length,
  );
  const mentions = useWorkspace((s) =>
    Object.entries(s.mentionCounts).reduce(
      (sum, [id, count]) => (id === activeChannelId ? sum : sum + count),
      0,
    ),
  );
  const unreadReplies = useWorkspace((s) => unreadThreadCount(s.threadFollows) > 0);
  const dueReminders = useWorkspace(dueReminderCount);
  const waitingInActivity = [
    mentions > 0 && `${mentions} ${mentions === 1 ? "mention" : "mentions"}`,
    dueReminders > 0 && `${dueReminders} ${dueReminders === 1 ? "reminder" : "reminders"} due`,
  ]
    .filter(Boolean)
    .join(", ");
  const here =
    props.openPanel === "activity" ? "activity" : props.openPanel === "dms" ? "dms" : "home";

  return (
    <nav
      aria-label="Main navigation"
      // Under the open drawer, which covers it, and dims it.
      inert={props.drawerOpen}
      className="bottom-bar"
    >
      <ul className="flex h-14 items-stretch gap-1 px-1">
        <BarItem
          icon="home"
          label="Home"
          current={here === "home"}
          // Back to the conversation; from there, the list of every conversation.
          onClick={here === "home" ? props.onOpenDrawer : props.onConversation}
          dot={unreadRooms}
          waiting={unreadRooms ? "Unread messages in channels" : undefined}
        />
        {!guest && (
          <BarItem
            icon="messages"
            label="DMs"
            current={here === "dms"}
            onClick={props.onDirectMessages}
            count={unreadDms}
            waiting={
              unreadDms > 0
                ? `${unreadDms} unread ${unreadDms === 1 ? "conversation" : "conversations"}`
                : undefined
            }
          />
        )}
        <BarItem
          icon="activity"
          label="Activity"
          current={here === "activity"}
          onClick={props.onActivity}
          count={mentions + dueReminders}
          dot={mentions + dueReminders === 0 && unreadReplies}
          waiting={
            waitingInActivity ||
            (unreadReplies ? "Unread replies in threads you follow" : undefined)
          }
        />
        <li className="flex min-w-0 flex-1">
          <AccountMenu
            guest={guest}
            snoozed={snoozed}
            {...props.account}
            onScheduled={guest ? undefined : props.account.onScheduled}
            trigger={{
              label: "You",
              className: `${ITEM} text-ink-faint aria-expanded:text-ink`,
              content: (
                <>
                  <Pill>
                    <AvatarWithPresence
                      user={self ?? undefined}
                      online={!snoozed}
                      size={22}
                      ring="var(--color-deep)"
                    />
                  </Pill>
                  You
                </>
              ),
            }}
          />
        </li>
      </ul>
    </nav>
  );
}

/** Where an item's icon sits, lit behind it when that is where you are. */
function Pill(props: { current?: boolean; children: ReactNode }) {
  return (
    <span
      className={`relative flex h-8 w-14 items-center justify-center rounded-full transition-colors duration-150 ${
        props.current ? "bg-copper/15 text-copper" : "group-active/item:bg-ink/[0.06]"
      }`}
    >
      {props.children}
    </span>
  );
}

function BarItem(props: {
  icon: IconName;
  label: string;
  current: boolean;
  onClick: () => void;
  /** A red count of what names you. */
  count?: number;
  /** A quiet dot: something is unread, nothing names you. */
  dot?: boolean;
  /** What the count or the dot says, in words. */
  waiting?: string;
}) {
  const described = useId();
  return (
    <li className="flex min-w-0 flex-1">
      <button
        type="button"
        onClick={props.onClick}
        // Named by its label alone; what waits there is its description.
        aria-label={props.label}
        aria-current={props.current ? "page" : undefined}
        aria-describedby={props.waiting ? described : undefined}
        className={`${ITEM} ${props.current ? "text-ink" : "text-ink-faint"}`}
      >
        <Pill current={props.current}>
          <Icon name={props.icon} size={22} />
          <Badge
            size="small"
            max={99}
            count={props.count ?? 0}
            className="absolute -top-1 right-1.5 ring-2 ring-deep"
          />
          <Badge
            dot
            tone="quiet"
            count={!!props.dot && !props.count}
            className="absolute right-3 top-0.5 ring-2 ring-deep"
          />
        </Pill>
        {props.label}
        {props.waiting && (
          <span id={described} className="sr-only">
            {props.waiting}
          </span>
        )}
      </button>
    </li>
  );
}
