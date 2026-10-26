import type {
  AccessPolicy,
  Channel,
  ChannelPrefs,
  Friendship,
  ID,
  Message,
  ModalView,
  User,
  ThreadFollow,
  Reminder,
  SidebarSection,
} from "./entities.js";
import type { CallReport, HuddleRing, HuddleSignal } from "./huddle.js";
import type { MemberNotice } from "./plan.js";

/**
 * Durable workspace events. Every mutation appends one to the event log and
 * gets a monotonically increasing `seq`. Clients track `lastSeq` and replay
 * missed events on reconnect.
 *
 * A `message.updated` that says `previewsOnly` changes only the message's link
 * previews, found or removed (E2). It is not an edit, so apps are not told and
 * nothing quoting the message changes. An edit leaves it out. One that says
 * `pollOnly` changes only its poll: votes, or its closing (E6), in the same way.
 */
export type WorkspaceEvent =
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message; previewsOnly?: true; pollOnly?: true }
  | { type: "message.deleted"; channelId: ID; messageId: ID; threadRootId: ID | null }
  | { type: "reaction.added"; channelId: ID; messageId: ID; emoji: string; userId: ID }
  | { type: "reaction.removed"; channelId: ID; messageId: ID; emoji: string; userId: ID }
  | { type: "pin.added"; channelId: ID; messageId: ID; userId: ID }
  | { type: "pin.removed"; channelId: ID; messageId: ID }
  | { type: "history.removed"; channelId: ID; rootIds: ID[] } // Whole threads retention took; see applyRetention.
  | { type: "channel.created"; channel: Channel }
  | { type: "channel.updated"; channel: Channel }
  | { type: "member.joined"; channelId: ID; userId: ID }
  | { type: "member.left"; channelId: ID; userId: ID }
  | { type: "user.joined"; user: User }
  | { type: "user.updated"; user: User };

export interface EventEnvelope {
  seq: number;
  event: WorkspaceEvent;
}

/** Ephemeral events — never logged, never replayed. */
export type EphemeralEvent =
  | { type: "channel.read"; channelId: ID; seq: number }
  /**
   * A read cursor deliberately moved backwards. Separate from `channel.read`
   * because that one only ever advances, and this one must not be treated as
   * a stale echo of a higher cursor.
   */
  | { type: "channel.unread"; channelId: ID; seq: number }
  | {
      type: "channel.access";
      channelId: ID;
      channel: Channel | null;
      membership: {
        lastReadSeq: number;
        /** See `ReadySnapshot.memberships`. Absent from older servers. */
        repliesReadSeq?: number;
        prefs: ChannelPrefs;
      } | null;
    }
  | { type: "friends"; friends: Friendship[] }
  /**
   * The people this account has blocked, after any change (E12). Private to
   * its own sockets: whoever is blocked is told nothing.
   */
  | { type: "blocks"; blocked: ID[] }
  /**
   * How many reported messages wait for an admin now (E12). Told to the owner
   * and admins only, at each report and each one resolved.
   */
  | { type: "reports"; open: number }
  | { type: "typing"; channelId: ID; userId: ID }
  | { type: "presence"; userId: ID; presence: Presence }
  /**
   * The workspace has a new name, replacing the one the ready snapshot gave.
   * A client that misses it gets the new name from its next snapshot. Clients
   * older than this event ignore it.
   */
  | { type: "workspace.renamed"; workspaceName: string }
  /**
   * Who may join changed, replacing what the ready snapshot gave. Told to
   * everyone signed in, since the Join screen tells anyone who asks. Clients
   * older than this event ignore it.
   */
  | { type: "workspace.accessPolicy"; accessPolicy: AccessPolicy }
  /**
   * The workspace's icon changed, replacing the version the ready snapshot
   * gave: a new one, or null when it was removed. Told to everyone signed in,
   * since the Join screen shows it to anyone who asks. Clients older than this
   * event ignore it.
   */
  | { type: "workspace.icon"; iconVersion: string | null }
  /**
   * Link previews were turned on or off for the workspace, replacing what the
   * ready snapshot gave. Told to everyone signed in. Clients older than this
   * event ignore it.
   */
  | { type: "workspace.linkPreviews"; enabled: boolean }
  /** Private to one user's own sockets, so their devices stay in step. */
  | { type: "saved"; messageId: ID; saved: boolean }
  /** This user's follow state for one thread, so their devices stay in step. */
  | { type: "thread.follow"; state: ThreadFollow }
  /**
   * One of this user's reminders was set, changed or came due. Coming due
   * carries the message, for the notification. Private to their own sockets.
   */
  | { type: "reminder"; reminder: Reminder; message?: Message }
  /**
   * One of this user's reminders is gone: done, cancelled, or its message
   * deleted or out of their reach. Private to their own sockets.
   */
  | { type: "reminder.removed"; messageId: ID }
  /**
   * What this user chose in an anonymous poll, which no message says (E6):
   * option places, empty once they take their vote back. Private to their own
   * sockets.
   */
  | { type: "poll.choices"; messageId: ID; choices: number[] }
  /**
   * This account's sidebar sections, in their order, after any change to
   * them (E8). Private to their own sockets.
   */
  | { type: "sidebar.sections"; sections: SidebarSection[] }
  /**
   * This user's queue of messages to send later changed: one was queued,
   * edited, moved, cancelled, sent, held for a new reason or given up on. Read
   * `GET /api/scheduled` for what it holds now. Private to their own sockets.
   */
  | { type: "scheduled" }
  | { type: "prefs"; channelId: ID; prefs: ChannelPrefs }
  /** This user's unread mention count per conversation, replacing what it had. */
  | { type: "mentions"; counts: Record<ID, number> }
  /** Who is in a channel's huddle right now. */
  | { type: "huddle.participants"; channelId: ID; userIds: ID[] }
  /** Sender-only admission result, correlated to this device's join attempt. */
  | { type: "huddle.join.result"; channelId: ID; requestId: string; accepted: true }
  | {
      type: "huddle.join.result";
      channelId: ID;
      requestId: string;
      accepted: false;
      message: string;
      retryAfterMs?: number;
    }
  /**
   * Told only to the device that held this person's place in a huddle, when
   * they joined it from another device: that one is in the call now.
   */
  | { type: "huddle.moved"; channelId: ID }
  /** A relayed WebRTC handshake payload from one peer. */
  | { type: "huddle.signal"; channelId: ID; from: ID; signal: HuddleSignal }
  /**
   * A direct message's huddle ringing, as it is now (E10), to its caller and
   * everyone it rang, at each change. `ring.ringing` empty means it is over.
   */
  | { type: "huddle.ring"; ring: HuddleRing }
  /**
   * A reply only the recipient sees — how a slash command answers privately.
   * It is never stored, so it disappears on reload, exactly like Slack's.
   */
  | {
      type: "ephemeral.message";
      channelId: ID;
      /** Local id, so the client can key and dismiss it. */
      id: ID;
      /** The bot (or user) it is shown as coming from. */
      userId: ID;
      text: string;
      createdAt: number;
    }
  /**
   * An app is asking this one person to fill in a form. Like an ephemeral
   * message it is not stored: closing the app loses it, which is what a modal
   * that has not been submitted should do.
   */
  | { type: "view.open"; view: ModalView };

export type Presence = "online" | "away" | "offline";

/** Sent by the server immediately after a successful WS hello. */
export interface ReadySnapshot {
  type: "ready";
  seq: number;
  /** Present for syncVersion 1: null replaces history; otherwise replay follows from this cursor. */
  replayFrom?: number | null;
  self: User;
  users: User[];
  channels: Channel[];
  memberships: {
    channelId: ID;
    /** Reads what the channel shows: its messages, and replies also sent to it. */
    lastReadSeq: number;
    /**
     * Replies in a thread this account has no read cursor for count as read up
     * to here: where the channel cursor stood when the server began reading
     * replies through their threads, or where the workspace was on joining.
     * Absent from older servers, whose channel cursor reads every reply too.
     */
    repliesReadSeq?: number;
    prefs: ChannelPrefs;
  }[];
  /** Latest message seq per channel the user belongs to, for unread badges. */
  channelLastSeq: Record<ID, number>;
  /**
   * Who is online. Anyone missing is offline. Servers before 1 October 2026
   * also listed every other account as offline.
   */
  presence: Record<ID, Presence>;
  /** Message ids this user has saved for later. */
  savedMessageIds: ID[];
  /** Unread mentions per conversation. Absent from servers before v16. */
  mentionCounts?: Record<ID, number>;
  /** Follow state and thread read cursors. Absent from servers before v15. */
  threadFollows?: ThreadFollow[];
  /** Live huddles the user can see: channelId -> participant ids. */
  huddles: Record<ID, ID[]>;
  /** This server answers correlated join attempts before clients start their peer mesh. */
  huddleJoinReplies?: true;
  /** This server keeps a call log and takes `huddle.report`; older ones close on it. */
  huddleReports?: true;
  /**
   * The rings this account is part of, calling or called (E10). Present only
   * where the server rings direct calls and takes `huddle.decline`; an older
   * one closes the socket on it.
   */
  huddleRings?: HuddleRing[];
  /** This server keeps inline replies; older ones post one as an ordinary message. */
  inlineReplies?: true;
  /** This server forwards a message (`forwardFrom`); an older one would drop the original. */
  forwards?: true;
  /** This server sends `scheduled` when the queue changes; an older one has to be asked. */
  scheduledEvents?: true;
  /** This server answers Activity's `threads` mode; an older one refuses it. */
  activityThreads?: true;
  /** This server mutes a thread (`PUT /api/messages/:id/mute`); an older one refuses it. */
  threadMutes?: true;
  /**
   * This account's reminders it can still reach, waiting and due (E4). Absent
   * from a server that keeps none, so no reminder is offered there.
   */
  reminders?: Reminder[];
  /**
   * What this account chose in each anonymous poll it voted in and can still
   * read, by message id (E6). Absent from a server without polls, so none is
   * offered there.
   */
  pollChoices?: Record<ID, number[]>;
  /**
   * This server lists the files shared in conversations (`GET /api/files`,
   * E7). An older one does not, so the file browser is not offered there.
   */
  sharedFiles?: true;
  /**
   * This account's sidebar sections, in their order (E8). Absent from a
   * server that keeps none, so none is offered there.
   */
  sidebarSections?: SidebarSection[];
  /**
   * This server keeps profile pictures, time zones and away by hand, and
   * reads a socket's `idle` (E9). An older one offers none of them.
   */
  profiles?: true;
  /**
   * This server keeps a star per conversation, `ChannelPrefs.starred`. An
   * older one drops a star sent to it without saying so, so it is not offered.
   */
  stars?: true;
  /**
   * This server lets its owner and admins rename the workspace and change who
   * may join (`PUT /api/admin/workspace/name` and `/access-policy`). An older
   * one refuses both, so Workspace settings offers neither there.
   */
  workspaceSettings?: true;
  /** Who may join now. Absent from servers before `workspaceSettings`. */
  accessPolicy?: AccessPolicy;
  /**
   * This server keeps an icon for the workspace, which its owner and admins
   * set and remove (`PUT` and `DELETE /api/admin/workspace/icon`) and anyone
   * reads (`GET /api/workspace/icon`). An older one has neither, so no upload
   * is offered there and the workspace shows its coloured square.
   */
  workspaceIcon?: true;
  /** The icon's version, which changes with its image, or null when there is none. */
  iconVersion?: string | null;
  /**
   * Whether this server adds link previews to new messages now, which its
   * owner and admins change (`PUT /api/admin/workspace/link-previews`). Absent
   * from servers before link previews, so the setting is not offered there.
   */
  linkPreviews?: boolean;
  workspaceName: string;
  /** Stable across address/name changes and backup restores. Older servers omit it. */
  workspaceId?: ID;
  friends?: Friendship[];
  /**
   * The people this account has blocked (E12), which also says this server
   * blocks and takes reports of messages. An older one does neither, so
   * neither is offered there.
   */
  blocked?: ID[];
  /** How many reported messages wait for an admin (E12). Given to the owner and admins only. */
  openReports?: number;
  /**
   * How many members the plan includes, when the host set it (P5). Given to
   * the owner and admins only, who are offered a bigger plan past it.
   */
  memberNotice?: MemberNotice;
}

/** Everything the server can push over the socket. */
export type ServerToClient =
  | ReadySnapshot
  | { type: "synced"; seq: number }
  | { type: "event"; envelope: EventEnvelope }
  | { type: "ephemeral"; event: EphemeralEvent }
  /** lastSeq was pruned from the log — client must drop caches and re-sync. */
  | { type: "resync" }
  | {
      type: "error";
      code: "auth_failed" | "protocol_mismatch" | "password_change_required";
      message: string;
    }
  | { type: "pong" };

export type ClientToServer =
  | {
      type: "hello";
      token: string;
      lastSeq: number | null;
      protocolVersion: number;
      syncVersion?: 1;
    }
  | { type: "typing"; channelId: ID }
  | { type: "huddle.join"; channelId: ID; requestId?: string }
  | { type: "huddle.leave"; channelId: ID }
  | { type: "huddle.signal"; channelId: ID; to: ID; signal: HuddleSignal }
  /** How one of this side's connections in a huddle went, for the host's call log. */
  | { type: "huddle.report"; channelId: ID; peer: ID; report: CallReport }
  /** Says no to a ring this account is being rung by (E10). */
  | { type: "huddle.decline"; channelId: ID }
  /**
   * Whether this device has gone idle, nobody touching it for a while, or is
   * in use again (E9). Every device idle makes the account away.
   */
  | { type: "idle"; idle: boolean }
  | { type: "ping" };
