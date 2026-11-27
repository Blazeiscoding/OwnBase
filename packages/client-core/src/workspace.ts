import { createStore, type StoreApi } from "zustand/vanilla";
import {
  PROTOCOL_VERSION,
  SOCKET_CLOSE,
  SOCKET_REFUSALS,
  type AccessPolicy,
  type Channel,
  type ChannelPrefs,
  type CustomEmoji,
  type CreateUserGroupBody,
  type UpdateUserGroupBody,
  type UserGroup,
  type NotifyLevel,
  type NotifySchedule,
  type EphemeralEvent,
  type EventEnvelope,
  type ID,
  type Message,
  type ReadySnapshot,
  type ForwardReference,
  type ReplyReference,
  type CreateChannelBody,
  type ReportReason,
  type SearchSort,
  type ServerToClient,
  type UpdateChannelBody,
  type UpdateMeBody,
  type ThreadFollow,
  type SidebarSection,
  type User,
  type ViewSubmitted,
} from "@ownbase/protocol";
import { Api, ApiError } from "./api.js";
import { AccountActions } from "./account.js";
import { AdminActions } from "./admin.js";
import { AppActions } from "./apps.js";
import { Calls } from "./calls.js";
import { Commands } from "./commands.js";
import { Lists } from "./lists.js";
import { MessageActions, withSaved } from "./messageActions.js";
import { Modals } from "./modals.js";
import { LocalLedger } from "./localWork.js";
import { FileCache, previewImageKey } from "./fileCache.js";
import { HistoryLoader } from "./historyLoader.js";
import { AvatarCache } from "./avatars.js";
import { ClientEmitter, type ClientEvents, type ClientListener } from "./events.js";
import { isSignedOut } from "./selectors.js";
import { initialState, type WorkspaceState } from "./workspaceState.js";
import { WorkspaceSettings } from "./workspaceSettings.js";
import {
  forgetAllUnlisted,
  isMessageEvent,
  reduceMessages,
  unhandled,
  windowTimeline,
  type MessageCache,
  type MessageEvent,
} from "./messageCache.js";
import { answerOf, doneOf, failureOf } from "./answers.js";
import { type StoredPending } from "./outbox.js";
import { OptimisticWrites } from "./optimisticWrites.js";
import { Preferences } from "./preferences.js";
import { ReadMarks } from "./readMarks.js";
import { Sender, type SendAnswer } from "./sender.js";
import { pollChoicesKey, serverPollChoices, type PollDraft } from "./polls.js";
import type { CallLogLine, CallView, ScreenShareQuality } from "./huddle.js";
import type { MicrophoneSettings, NoiseFilter, OpenSystemMicrophone } from "./devices.js";

/** How `LocalWork` reaches the outbox and drafts, which nothing else should change. */
export const LOCAL_WORK = Symbol("localWork");

export interface LocalWorkHost {
  outboxSnapshot(): StoredPending[];
  restoreOutbox(entries: StoredPending[]): void;
  adoptRefusal(nonce: string, reason: string): void;
  hydrateDrafts(drafts: Record<string, string>, stored?: Record<string, number>): void;
}

/**
 * Someone typing is shown for this long after they last said so, and says so
 * again sooner while they type, so the dots do not blink out between keys.
 */
const TYPING_SHOWN_FOR_MS = 5000;
const TYPING_SAY_EVERY_MS = 3000;

/**
 * A live connection to one workspace server: typed REST + resilient WebSocket
 * + a Zustand store holding the local replica the UI renders from.
 */
export class WorkspaceClient {
  readonly store: StoreApi<WorkspaceState>;
  /**
   * The server's REST API, for this client's own use and for tests that stand
   * in for the server. Everything else asks the client, so the store hears.
   */
  readonly api: Api;
  readonly files: FileCache;
  /** Profile pictures, fetched with this session and kept as object URLs (E9). */
  readonly avatars: AvatarCache;
  /** Custom emoji pictures, by emoji id, which names one picture for good (J12). */
  readonly emojiPictures: AvatarCache;
  readonly account: AccountActions;
  readonly admin: AdminActions;
  readonly apps: AppActions;
  readonly lists: Lists;
  private readonly commands: Commands;
  private readonly modals: Modals;
  private readonly calls: Calls;
  private readonly settings: WorkspaceSettings;
  private readonly preferences: Preferences;
  private readonly messageActions: MessageActions;
  private readonly readMarks: ReadMarks;
  private readonly sender: Sender;
  private readonly history: HistoryLoader;
  /** The sends waiting to hear whether this device keeps their words (GL-02). */
  readonly kept = new LocalLedger();
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private typingSweep: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /**
   * The next connection asks for a whole snapshot rather than what it missed,
   * because applying what was missed failed once and would fail again.
   */
  private wantsSnapshot = false;
  private readonly events = new ClientEmitter();

  /** Listens for one kind of news from this workspace; the function returned stops listening. */
  on<K extends keyof ClientEvents>(event: K, listener: ClientListener<K>): () => void {
    return this.events.on(event, listener);
  }

  /**
   * The server's seq when this connection opened. Everything at or below it
   * already happened; everything above it is arriving as it is sent.
   */
  private connectedAtSeq = 0;
  private acknowledgedMessages = new Set<ID>();
  /** Pins, saves, votes, reactions, snoozes, notification choices and thread follows not yet answered. */
  private writes = new OptimisticWrites();

  constructor(
    public readonly baseUrl: string,
    private token: string,
  ) {
    this.api = new Api(baseUrl, token);
    this.files = new FileCache(this.api, undefined, (fileId) => this.fileOwner(fileId));
    this.avatars = new AvatarCache((userId, version) => this.api.fetchAvatar(userId, version));
    this.emojiPictures = new AvatarCache((id) => this.api.fetchCustomEmoji(id));
    this.store = createStore<WorkspaceState>(() => ({ ...initialState }));
    this.account = new AccountActions(this.api);
    this.admin = new AdminActions(this.api, (users) =>
      users.forEach((user) => this.keepUser(user)),
    );
    this.apps = new AppActions(this.api, () => void this.commands.loadCommands());
    this.lists = new Lists(this.api, this.store);
    this.commands = new Commands(this.api, this.store, () => this.stopped);
    this.modals = new Modals(this.api, this.store);
    this.settings = new WorkspaceSettings(this.api, this.store, () => this.stopped);
    this.preferences = new Preferences(this.api, this.store, this.writes, () => this.stopped);
    this.messageActions = new MessageActions(this.api, this.store, this.writes);
    this.readMarks = new ReadMarks(this.api, this.store, this.writes, () => this.stopped);
    this.history = new HistoryLoader(this.api, this.store, this.writes, () => this.stopped);
    this.sender = new Sender(
      this.api,
      this.store,
      this.kept,
      this.commands,
      (message) => this.settleSent(message),
      () => this.stopped,
    );
    this.calls = new Calls(this.api, this.store, (msg) => this.sendSocket(msg));
    // A session that has ended keeps nothing it downloaded (F07).
    this.store.subscribe((now, before) => {
      if (now.status !== before.status && isSignedOut(now.status)) this.files.invalidateAll();
    });
  }

  get state(): WorkspaceState {
    return this.store.getState();
  }

  /**
   * The loaded message a file is attached to, asked when the file is first
   * fetched, so the cache can let it go with that message or conversation
   * after the history listing it is gone (F07).
   */
  private fileOwner(fileId: ID): { channelId: ID; messageId: ID; threadRootId: ID | null } | null {
    for (const m of Object.values(this.state.messages)) {
      if (
        m.files.some((f) => f.id === fileId) ||
        m.previews.some((p) => previewImageKey(p.id) === fileId)
      )
        return { channelId: m.channelId, messageId: m.id, threadRootId: m.threadRootId };
    }
    return null;
  }

  /** Where the next connection picks up: after what was heard, or afresh. */
  private resumeSeq(): number | null {
    return this.wantsSnapshot || this.state.lastSeq === 0 ? null : this.state.lastSeq;
  }

  connect(): void {
    if (this.ws) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopped = false;
    this.openSocket(this.resumeSeq());
    this.typingSweep ??= setInterval(() => this.sweepTyping(), 2000);
    this.readMarks.start();
    if (typeof window !== "undefined" && !this.listeningOnline) {
      window.addEventListener("online", this.onNetworkBack);
      this.listeningOnline = true;
    }
  }

  private listeningOnline = false;
  /**
   * The device's network is back. A socket that never noticed it was gone
   * sends what was lost on the way now; one waiting out its backoff, up to
   * half a minute, tries at once.
   */
  private onNetworkBack = (): void => {
    if (this.stopped) return;
    if (this.state.status === "online") {
      this.sender.retryLostSends();
      return;
    }
    if (this.reconnectTimer && !this.ws) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectDelay = 1000;
      this.openSocket(this.resumeSeq());
    }
  };

  destroy(): void {
    this.stopped = true;
    this.avatars.clear();
    this.emojiPictures.clear();
    // Writes still out answer to nobody now; none may correct the server,
    // and none waiting behind them may go (REV-11).
    this.writes.close();
    this.history.stop();
    this.readMarks.clearReadRequests();
    this.readMarks.stop();
    // Release the microphone before the socket goes, so no call is left open.
    this.leaveHuddle();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sender.stopWaiting();
    if (this.listeningOnline) window.removeEventListener("online", this.onNetworkBack);
    this.listeningOnline = false;
    if (this.typingSweep) clearInterval(this.typingSweep);
    this.typingSweep = null;
    this.ws?.close();
    this.ws = null;
    for (const p of this.state.pending) {
      for (const a of p.attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    this.files.dispose();
    this.sender.dropFiles();
    this.store.setState((s) => ({
      status: "closed",
      threadPages: Object.fromEntries(
        Object.entries(s.threadPages).map(([id, page]) => [id, { ...page, loading: false }]),
      ),
      timelineStatus: Object.fromEntries(
        Object.entries(s.timelineStatus).map(([id, status]) => [id, { ...status, loading: null }]),
      ),
    }));
  }

  private openSocket(lastSeq: number | null): void {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          token: this.token,
          lastSeq,
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
    };

    ws.onmessage = (e) => {
      if (this.ws !== ws || this.stopped) return;
      let msg: ServerToClient;
      try {
        msg = JSON.parse(String(e.data)) as ServerToClient;
      } catch {
        ws.close(SOCKET_CLOSE.invalidMessage, "invalid server message");
        return;
      }
      try {
        this.handleServerMessage(msg);
      } catch (error) {
        this.recoverFrom(ws, msg, error);
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const refusal = SOCKET_REFUSALS.find((r) => SOCKET_CLOSE[r] === event.code);
      if (refusal) this.store.setState({ status: refusal });
      // A refusal lasts until somebody does something, so reconnecting would be
      // a loop that never ends and never says why.
      if (this.stopped || SOCKET_REFUSALS.some((r) => r === this.state.status)) {
        this.leaveHuddle();
        return;
      }
      // A call goes on through a dropped connection: its sound and video do
      // not pass through this socket, and the server keeps this device's
      // place a while. `resumeHuddle` takes it back once the socket returns.
      this.calls.holdHuddle();
      this.store.setState({ status: "reconnecting" });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
        this.openSocket(this.resumeSeq());
      }, this.reconnectDelay);
    };

    ws.onerror = () => ws.close();
  }

  /**
   * Applying a server message failed here: a fault in this client, not in the
   * message. Asking for what was missed would replay the same event and fail
   * again, so an event that failed is dropped with whatever it half changed:
   * the connection starts over from a whole snapshot. Anything else is only
   * reported; the connection goes on.
   */
  private recoverFrom(ws: WebSocket, msg: ServerToClient, error: unknown): void {
    console.error("Could not apply the server's %s message.", msg.type, error);
    if (msg.type !== "event") return;
    this.wantsSnapshot = true;
    ws.close(1000, "resync");
  }

  private handleServerMessage(msg: ServerToClient): void {
    switch (msg.type) {
      case "ready":
        this.wantsSnapshot = false;
        this.applyReady(msg);
        this.afterReady(msg);
        if (this.state.status === "online") this.sender.retryLostSends();
        break;
      case "synced":
        this.store.setState((s) => ({ lastSeq: Math.max(s.lastSeq, msg.seq), status: "online" }));
        this.readMarks.flushReads();
        this.sender.retryLostSends();
        break;
      case "event":
        this.applyEvent(msg.envelope);
        break;
      case "ephemeral":
        this.applyEphemeral(msg.event);
        break;
      case "error":
        if (msg.code === "protocol_mismatch")
          this.store.setState({
            status: "protocol_mismatch",
            serverProtocolVersion: msg.protocolVersion ?? 0,
          });
        else this.store.setState({ status: msg.code });
        break;
      case "pong":
        break;
      default:
        unhandled(msg);
    }
  }

  private applyReady(snap: ReadySnapshot): void {
    // A replaced server must not inherit this connection's private drafts or
    // outbox, even if a copied session token happens to work there. Keep the
    // old identity intact so unmount can flush its work before signing in again.
    if (
      this.state.self &&
      (this.state.self.id !== snap.self.id ||
        (this.state.workspaceId && snap.workspaceId && this.state.workspaceId !== snap.workspaceId))
    ) {
      this.destroy();
      this.store.setState({ status: "auth_failed" });
      return;
    }
    this.reconnectDelay = 1000;
    // Anything the server had already recorded when we connected is history,
    // however soon after it reaches us.
    this.connectedAtSeq = snap.seq;
    const visible = new Set(snap.channels.map((c) => c.id));
    for (const id of Object.keys(this.state.channels)) {
      if (!visible.has(id)) this.removeChannel(id);
    }
    const reset = snap.replayFrom === null || this.state.lastSeq > snap.seq;
    if (reset) this.resetHistory();
    const users: Record<ID, User> = {};
    for (const u of snap.users) users[u.id] = u;
    const channels: Record<ID, Channel> = {};
    for (const c of snap.channels) channels[c.id] = c;
    const memberships: Record<ID, number> = {};
    const prefs: Record<ID, ChannelPrefs> = {};
    const repliesRead: Record<ID, number> = {};
    for (const m of snap.memberships) {
      memberships[m.channelId] = this.readMarks.readyCursor(m, snap);
      repliesRead[m.channelId] = m.repliesReadSeq;
      prefs[m.channelId] = m.prefs;
    }
    const saved: Record<ID, true> = {};
    for (const id of snap.savedMessageIds) saved[id] = true;
    const threadFollows: Record<ID, ThreadFollow> = {};
    for (const follow of snap.threadFollows) threadFollows[follow.rootId] = follow;
    const leftWhileAway = Object.keys(this.state.prefs).filter((id) => !(id in prefs));

    this.store.setState((prev) => ({
      status: "connecting",
      workspaceName: snap.workspaceName,
      workspaceId: snap.workspaceId,
      clockSkewMs: snap.serverTime - Date.now(),
      sidebarSections: snap.sidebarSections,
      notifyDefault: snap.notifyDefault,
      notifySchedule: snap.notifySchedule,
      reminders: Object.fromEntries(
        snap.reminders.map((reminder) => [reminder.messageId, reminder]),
      ),
      // But for those this device is reading, which the server may not have yet.
      channelRemovals: Object.fromEntries(
        snap.channelRemovals
          .filter((removal) => !this.readMarks.isReading(removal.id))
          .map((removal) => [removal.id, removal]),
      ),
      // Whatever changed while this client was away was not heard.
      reactionActivity: {
        seenAt: snap.reactionsSeenAt,
        unseen: snap.unseenReactions,
        revision: prev.reactionActivity.revision + 1,
      },
      pollChoices: snap.pollChoices,
      // What the server now says stands, but for votes still on their way.
      pollPicks: Object.fromEntries(
        Object.entries(prev.pollPicks).filter(([messageId]) =>
          this.writes.isPending({ kind: "poll", messageId }),
        ),
      ),
      accessPolicy: snap.accessPolicy,
      linkPreviews: snap.linkPreviews,
      iconVersion: snap.iconVersion,
      customEmoji: Object.fromEntries(snap.customEmoji.map((emoji) => [emoji.name, emoji])),
      emojiAddingAdminsOnly: snap.emojiAddingAdminsOnly,
      userGroups: Object.fromEntries(snap.userGroups.map((group) => [group.id, group])),
      // Whatever was said while this client was away was not heard.
      scheduledChanges: prev.scheduledChanges + 1,
      self: snap.self,
      users,
      channels,
      memberships,
      repliesRead,
      prefs,
      channelLastSeq: snap.channelLastSeq,
      presence: snap.presence,
      threadFollows,
      mentionCounts: snap.mentionCounts,
      saved,
      huddles: snap.huddles,
      rings: Object.fromEntries(snap.huddleRings.map((ring) => [ring.channelId, ring])),
      friends: snap.friends,
      blocked: snap.blocked,
      keywords: snap.keywords,
      openReports: snap.openReports ?? null,
      memberNotice: snap.memberNotice ?? null,
      serverNotices: snap.notices ?? [],
      lastSeq: reset || prev.lastSeq === 0 ? snap.seq : (snap.replayFrom ?? prev.lastSeq),
      typing: {},
    }));
    // The snapshot is the server's word; writes still out go on top of it.
    for (const channelId of leftWhileAway) this.writes.forget({ kind: "prefs", channelId });
    for (const [channelId, channelPrefs] of Object.entries(prefs))
      this.writes.heard({ kind: "prefs", channelId }, channelPrefs);
    this.writes.heard({ kind: "sectionOrder" }, snap.sidebarSections);
    this.writes.reshow();
    this.history.reloadAfterReady(channels);
    this.calls.resumeHuddle(snap);
  }

  private resetHistory(): void {
    this.history.reset();
    this.readMarks.clearReadRequests();
    this.acknowledgedMessages.clear();
    this.store.setState({
      messages: {},
      messageSeqs: {},
      timelines: {},
      threads: {},
      threadPages: {},
      timelineStatus: {},
      typing: {},
      ephemerals: {},
      ephemeralsDropped: {},
      modal: null,
      modalsBelow: [],
    });
  }

  private removeChannel(channelId: ID): void {
    this.history.forgetTimeline(channelId);
    this.readMarks.forgetChannel(channelId);
    this.calls.leaveIfIn(channelId);
    const state = this.state;
    const inChannel = Object.values(state.messages).filter((m) => m.channelId === channelId);
    const roots = new Set(state.timelines[channelId]?.ids ?? []);
    for (const [id, page] of Object.entries(state.threadPages))
      if (page.channelId === channelId) roots.add(id);
    for (const m of inChannel) if (m.threadRootId) roots.add(m.threadRootId);
    // A choice for a channel this account can no longer see has nowhere to go.
    this.writes.forget({ kind: "prefs", channelId });
    this.history.forgetThreads(roots);
    for (const m of inChannel) for (const f of m.files) this.files.invalidate(f.id);
    // And those it fetched earlier, from history that has since been let go (F07).
    this.files.invalidateChannel(channelId);
    const without = <T>(values: Record<ID, T>) =>
      Object.fromEntries(Object.entries(values).filter(([id]) => id !== channelId));
    const notRoot = <T>(values: Record<ID, T>) =>
      Object.fromEntries(Object.entries(values).filter(([id]) => !roots.has(id)));
    this.store.setState(
      forgetAllUnlisted({
        messages: state.messages,
        messageSeqs: state.messageSeqs,
        timelines: without(state.timelines),
        threads: notRoot(state.threads),
        threadPages: notRoot(state.threadPages),
      }),
    );
    this.store.setState((s) => ({
      timelineStatus: without(s.timelineStatus),
      channels: without(s.channels),
      memberships: without(s.memberships),
      repliesRead: without(s.repliesRead),
      prefs: without(s.prefs),
      prefsWrites: without(s.prefsWrites),
      channelLastSeq: without(s.channelLastSeq),
      typing: without(s.typing),
      huddles: without(s.huddles),
      rings: without(s.rings),
      ephemerals: without(s.ephemerals),
      ephemeralsDropped: without(s.ephemeralsDropped),
      saved: notRoot(s.saved),
      modal: null,
      modalsBelow: [],
    }));
  }

  /** What a message arriving changes besides the messages held: badges, typing, the outbox. */
  private arrived(s: WorkspaceState, patch: Partial<WorkspaceState>, message: Message): void {
    // A reply belongs to its thread; only what the channel shows moves its badge.
    if (!message.threadRootId || message.broadcast)
      patch.channelLastSeq = {
        ...s.channelLastSeq,
        [message.channelId]: Math.max(s.channelLastSeq[message.channelId] ?? 0, message.seq),
      };
    const settled = s.pending.find((p) => p.userId === message.userId && p.nonce === message.nonce);
    if (settled) {
      for (const a of settled.attachments) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      this.sender.forgetFiles(settled);
      patch.pending = s.pending.filter((p) => p.nonce !== message.nonce);
    }
    const typing = s.typing[message.channelId];
    if (typing?.[message.userId]) {
      const { [message.userId]: _gone, ...rest } = typing;
      patch.typing = { ...s.typing, [message.channelId]: rest };
    }
  }

  /**
   * The server's answer to a send, which can arrive before its event. The
   * message takes its pending copy's place at once; its event, when it
   * comes, changes nothing more.
   */
  private settleSent(message: Message): void {
    const s = this.state;
    if (!s.channels[message.channelId]) return;
    if (!s.pending.some((p) => p.userId === message.userId && p.nonce === message.nonce)) return;
    if (message.seq > s.lastSeq) this.acknowledgedMessages.add(message.id);
    const envelope = { seq: message.seq, event: { type: "message.created" as const, message } };
    const patch: Partial<WorkspaceState> = liveMessages(s, envelope, false);
    this.arrived(s, patch, message);
    this.history.holdForLoads(envelope);
    this.store.setState(patch);
    this.writes.reshow();
  }

  private applyEvent(envelope: EventEnvelope): void {
    const { event, seq } = envelope;
    const s = this.state;
    if (seq <= s.lastSeq && s.lastSeq !== 0) return;
    const patch: Partial<WorkspaceState> = { lastSeq: seq };
    if (event.type === "message.created" && this.acknowledgedMessages.delete(event.message.id)) {
      this.store.setState(patch);
      return;
    }
    // The snapshot already says how channels, members and people are now.
    const inSnapshot = seq <= this.connectedAtSeq;
    const changed = (channelId: ID) => {
      patch.changedContent = { ...s.changedContent, [channelId]: seq };
    };
    /** The server's word on writes of this device's, told once the event is applied. */
    const heard: (() => void)[] = [];
    switch (event.type) {
      case "message.created": {
        const message = { ...event.message, seq };
        if (!s.channels[message.channelId]) break;
        this.arrived(s, patch, message);
        if (message.userId !== s.self?.id)
          this.events.emit("message", message, { live: seq > this.connectedAtSeq });
        break;
      }
      case "message.updated": {
        // Previews found or removed are not an edit: nothing quoting the
        // message changes, and Activity has nothing new to show (E2). Nor are
        // a poll's votes (E6).
        if (!event.previewsOnly && !event.pollOnly) changed(event.message.channelId);
        if (event.pollOnly && !event.message.poll?.anonymous) {
          const messageId = event.message.id;
          const mine = serverPollChoices(event.message, s.self?.id, null);
          this.messageActions.settlePollPick(s, patch, messageId, mine);
          heard.push(() => this.writes.heard({ kind: "poll", messageId }, pollChoicesKey(mine)));
        }
        break;
      }
      case "history.removed": {
        this.files.invalidateRoots(event.channelId, event.rootIds);
        const gone = new Set(event.rootIds);
        const threadFollows = { ...s.threadFollows };
        const saved = { ...s.saved };
        for (const rootId of gone) {
          delete threadFollows[rootId];
          delete saved[rootId];
          this.history.forgetThread(rootId);
        }
        patch.threadFollows = threadFollows;
        patch.saved = saved;
        // Their reminders went with them on the server.
        patch.reminders = Object.fromEntries(
          Object.entries(s.reminders).filter(
            ([messageId, reminder]) =>
              !gone.has(messageId) && !(reminder.threadRootId && gone.has(reminder.threadRootId)),
          ),
        );
        patch.removedHistory = { ...s.removedHistory, [event.channelId]: seq };
        changed(event.channelId);
        break;
      }
      case "message.deleted": {
        changed(event.channelId);
        this.events.emit("messageDeleted", event.messageId);
        if (s.pollChoices[event.messageId]) {
          const { [event.messageId]: _gone, ...pollChoices } = s.pollChoices;
          patch.pollChoices = pollChoices;
        }
        if (s.pollPicks[event.messageId]) {
          const { [event.messageId]: _gone, ...pollPicks } = s.pollPicks;
          patch.pollPicks = pollPicks;
        }
        // Its files go with it, whether or not its history is still loaded (F07).
        this.files.invalidateMessage(event.messageId);
        break;
      }
      case "reaction.added":
      case "reaction.removed": {
        if (event.userId !== s.self?.id) break;
        const key = { kind: "reaction", messageId: event.messageId, emoji: event.emoji } as const;
        heard.push(() => this.writes.heard(key, event.type === "reaction.added"));
        break;
      }
      case "pin.added":
      case "pin.removed": {
        changed(event.channelId);
        const pinned = event.type === "pin.added";
        heard.push(() => this.writes.heard({ kind: "pin", messageId: event.messageId }, pinned));
        break;
      }
      case "channel.created":
      case "channel.updated": {
        if (inSnapshot) break;
        patch.channels = { ...s.channels, [event.channel.id]: event.channel };
        if (
          event.type === "channel.created" &&
          event.channel.memberIds?.includes(s.self?.id ?? "")
        ) {
          patch.memberships = { ...s.memberships, [event.channel.id]: 0 };
          patch.repliesRead = joined(s.repliesRead, event.channel.id, seq);
        }
        break;
      }
      case "member.joined": {
        if (inSnapshot) break;
        patch.memberChanges = { ...s.memberChanges, [event.channelId]: seq };
        if (event.userId === s.self?.id) {
          // Joined with what was there read, as the server keeps it.
          patch.memberships = {
            ...s.memberships,
            [event.channelId]: s.memberships[event.channelId] ?? seq,
          };
          if (!(event.channelId in s.memberships))
            patch.repliesRead = joined(s.repliesRead, event.channelId, seq);
        }
        const ch = s.channels[event.channelId];
        if (ch?.memberIds && !ch.memberIds.includes(event.userId)) {
          patch.channels = {
            ...s.channels,
            [ch.id]: { ...ch, memberIds: [...ch.memberIds, event.userId] },
          };
        }
        break;
      }
      case "member.left": {
        if (inSnapshot) break;
        patch.memberChanges = { ...s.memberChanges, [event.channelId]: seq };
        if (event.userId === s.self?.id) {
          changed(event.channelId);
          const { [event.channelId]: _gone, ...rest } = s.memberships;
          patch.memberships = rest;
          const { [event.channelId]: _floor, ...repliesRead } = s.repliesRead;
          patch.repliesRead = repliesRead;
          // Notification settings belong to the membership, which a rejoin
          // starts afresh, and a choice still being saved has nowhere to go.
          const { [event.channelId]: _prefs, ...prefs } = s.prefs;
          const { [event.channelId]: _write, ...prefsWrites } = s.prefsWrites;
          patch.prefs = prefs;
          patch.prefsWrites = prefsWrites;
          this.writes.forget({ kind: "prefs", channelId: event.channelId });
        }
        const ch = s.channels[event.channelId];
        if (ch?.memberIds) {
          patch.channels = {
            ...s.channels,
            [ch.id]: { ...ch, memberIds: ch.memberIds.filter((id) => id !== event.userId) },
          };
        }
        break;
      }
      case "user.joined":
      case "user.updated": {
        if (inSnapshot) break;
        const user = event.user;
        patch.users = { ...s.users, [user.id]: user };
        if (user.id === s.self?.id) {
          patch.self = user;
          heard.push(() => this.writes.heard({ kind: "dnd" }, user.dndUntil));
        }
        break;
      }
      default:
        unhandled(event);
    }
    if (isMessageEvent(event)) {
      const message = { ...envelope, event };
      Object.assign(patch, liveMessages({ ...s, ...patch }, message, true));
      this.history.holdForLoads(message);
    }
    this.store.setState(patch);
    for (const tell of heard) tell();
  }

  private applyEphemeral(event: EphemeralEvent): void {
    const s = this.store.getState();
    switch (event.type) {
      case "friends":
        this.store.setState({ friends: event.friends });
        break;
      case "blocks":
        this.store.setState({ blocked: event.blocked });
        break;
      case "keywords":
        this.store.setState({ keywords: event.keywords });
        break;
      case "reports":
        this.store.setState({ openReports: event.open });
        break;
      case "workspace.renamed":
        this.store.setState({ workspaceName: event.workspaceName, workspaceRenamedBy: event.by });
        break;
      case "workspace.accessPolicy":
        this.store.setState({ accessPolicy: event.accessPolicy });
        break;
      case "workspace.linkPreviews":
        this.store.setState({ linkPreviews: event.enabled });
        break;
      case "workspace.icon":
        this.store.setState({ iconVersion: event.iconVersion });
        break;
      case "emoji.added":
        this.settings.keepEmoji(event.emoji);
        break;
      case "emoji.removed":
        this.settings.forgetEmoji(event.id, event.name);
        break;
      case "workspace.emojiAdding":
        this.store.setState({ emojiAddingAdminsOnly: event.adminsOnly });
        break;
      case "userGroup.saved":
        this.settings.keepGroup(event.group);
        break;
      case "userGroup.deleted":
        this.settings.forgetGroup(event.id);
        break;
      case "channel.access": {
        if (!event.channel) {
          this.removeChannel(event.channelId);
          break;
        }
        const memberships = { ...s.memberships };
        const repliesRead = { ...s.repliesRead };
        const prefs = { ...s.prefs };
        const prefsWrites = { ...s.prefsWrites };
        if (event.membership) {
          memberships[event.channelId] = event.membership.lastReadSeq;
          repliesRead[event.channelId] = event.membership.repliesReadSeq;
          prefs[event.channelId] = event.membership.prefs;
        } else {
          delete memberships[event.channelId];
          delete repliesRead[event.channelId];
          delete prefs[event.channelId];
          delete prefsWrites[event.channelId];
          this.writes.forget({ kind: "prefs", channelId: event.channelId });
        }
        this.store.setState({
          channels: { ...s.channels, [event.channelId]: event.channel },
          memberships,
          repliesRead,
          prefs,
          prefsWrites,
        });
        if (event.membership)
          this.writes.heard({ kind: "prefs", channelId: event.channelId }, event.membership.prefs);
        break;
      }
      case "presence":
        this.store.setState({ presence: { ...s.presence, [event.userId]: event.presence } });
        break;
      case "huddle.participants": {
        const huddles = { ...s.huddles };
        if (event.userIds.length > 0) huddles[event.channelId] = event.userIds;
        else delete huddles[event.channelId];
        this.store.setState({ huddles });
        this.calls.participantsChanged(event);
        break;
      }
      case "huddle.ring": {
        // Over once it rings nobody; the server forgets it then too.
        const rings = { ...s.rings };
        const before = rings[event.ring.channelId];
        if (event.ring.ringing.length > 0) rings[event.ring.channelId] = event.ring;
        else delete rings[event.ring.channelId];
        const message = this.calls.ringNoticeFor(before, event.ring);
        this.store.setState({
          rings,
          ...(message
            ? { ringNotice: { channelId: event.ring.channelId, message, at: Date.now() } }
            : {}),
        });
        break;
      }
      case "huddle.moved":
        this.calls.moved(event);
        break;
      case "huddle.join.result": {
        this.calls.joinResult(event);
        break;
      }
      case "huddle.signal":
        this.calls.signal(event);
        break;
      case "channel.read":
        this.readMarks.channelRead(event);
        break;
      case "prefs":
        // What this or another device saved; a choice still being saved from
        // here stays on top until its own answer comes back.
        if (!this.writes.heard({ kind: "prefs", channelId: event.channelId }, event.prefs))
          this.store.setState({ prefs: { ...s.prefs, [event.channelId]: event.prefs } });
        break;
      case "saved":
        if (!this.writes.heard({ kind: "save", messageId: event.messageId }, event.saved))
          this.store.setState({ saved: withSaved(s.saved, event.messageId, event.saved) });
        break;
      case "mentions":
        this.store.setState({ mentionCounts: event.counts });
        break;
      case "channel.unread":
        this.readMarks.channelUnread(event);
        break;
      case "thread.follow":
        this.readMarks.applyThreadFollow(event.state);
        break;
      case "reminder": {
        const known = s.reminders[event.reminder.messageId];
        this.store.setState({
          reminders: { ...s.reminders, [event.reminder.messageId]: event.reminder },
        });
        // Told once as it comes due; the same reminder told again is not news.
        if (event.message && event.reminder.dueAt !== null && known?.dueAt !== event.reminder.dueAt)
          this.events.emit("reminderDue", event.reminder, event.message);
        break;
      }
      case "reminder.removed": {
        if (!s.reminders[event.messageId]) break;
        const { [event.messageId]: _gone, ...reminders } = s.reminders;
        this.store.setState({ reminders });
        break;
      }
      case "channel.removal":
        this.store.setState({
          channelRemovals: { ...s.channelRemovals, [event.removal.id]: event.removal },
        });
        break;
      case "channel.removals.read":
        this.readMarks.forgetRemovals(event.ids);
        break;
      case "reactions.changed":
        this.store.setState({
          reactionActivity: {
            ...s.reactionActivity,
            unseen: event.unseen,
            revision: s.reactionActivity.revision + 1,
          },
        });
        break;
      case "reactions.seen":
        this.reactionsSeen(event);
        break;
      case "notify.default":
        if (!this.writes.heard({ kind: "notifyDefault" }, event.level))
          this.store.setState({ notifyDefault: event.level });
        break;
      case "notify.schedule":
        if (!this.writes.heard({ kind: "notifySchedule" }, event.schedule))
          this.store.setState({ notifySchedule: event.schedule });
        break;
      case "sidebar.sections":
        // A reorder of this device's still on its way is not undone by an older word.
        if (!this.writes.heard({ kind: "sectionOrder" }, event.sections))
          this.store.setState({ sidebarSections: event.sections });
        break;
      case "poll.choices": {
        const pollChoices = { ...s.pollChoices };
        if (event.choices.length > 0) pollChoices[event.messageId] = event.choices;
        else delete pollChoices[event.messageId];
        const patch: Partial<WorkspaceState> = { pollChoices };
        this.messageActions.settlePollPick(s, patch, event.messageId, event.choices);
        this.store.setState(patch);
        this.writes.heard(
          { kind: "poll", messageId: event.messageId },
          pollChoicesKey(event.choices),
        );
        break;
      }
      case "scheduled":
        this.store.setState({ scheduledChanges: s.scheduledChanges + 1 });
        break;
      case "ephemeral.message":
        this.commands.addEphemeral({
          id: event.id,
          channelId: event.channelId,
          userId: event.userId,
          text: event.text,
          createdAt: event.createdAt,
        });
        break;
      case "view.open": {
        // The server says what is open now, bottom first.
        const { stack } = event;
        this.store.setState({ modal: stack.at(-1)!, modalsBelow: stack.slice(0, -1) });
        break;
      }
      case "view.close":
        this.modals.forgetModals(event.viewIds);
        break;
      case "typing":
        if (event.userId === s.self?.id) break;
        this.store.setState({
          typing: {
            ...s.typing,
            [event.channelId]: {
              ...s.typing[event.channelId],
              [event.userId]: Date.now() + TYPING_SHOWN_FOR_MS,
            },
          },
        });
        break;
      default:
        unhandled(event);
    }
  }

  private sweepTyping(): void {
    const s = this.store.getState();
    const now = Date.now();
    let changed = false;
    const typing: WorkspaceState["typing"] = {};
    for (const [chId, byUser] of Object.entries(s.typing)) {
      const kept = Object.fromEntries(Object.entries(byUser).filter(([, exp]) => exp > now));
      if (Object.keys(kept).length !== Object.keys(byUser).length) changed = true;
      if (Object.keys(kept).length > 0) typing[chId] = kept;
    }
    if (changed) this.store.setState({ typing });
  }

  // ---------- actions ----------

  /**
   * Closes the form without answering it, going back to the one under it if
   * there is one. The server is told so the person's other devices follow;
   * the app is told nothing, as in Slack.
   */
  dismissModal(viewId = this.state.modal?.id): void {
    this.modals.dismissModal(viewId);
  }

  dismissAllModals(): void {
    this.modals.dismissAllModals();
  }

  /**
   * Sends the filled-in form. Field errors come back keyed by block so the UI
   * can put each one under the field it belongs to; the form stays open then.
   */
  submitModal(
    values: Record<string, Record<string, string | string[]>>,
    viewId = this.state.modal?.id,
  ): Promise<ViewSubmitted | ApiError> {
    return this.modals.submitModal(values, viewId);
  }

  /** Visible history is protected while inactive caches are evicted by recency. */
  focusConversation(channelId: ID | null): void {
    this.readMarks.focusConversation(channelId);
    this.history.focusConversation(channelId);
  }

  focusThread(rootId: ID | null): void {
    this.readMarks.focusThread(rootId);
    this.history.focusThread(rootId);
  }

  /**
   * Loads the newest page, or the page before what is loaded with `older`.
   * `unreadAfter` is the seq the reader had read up to: when every message in
   * the newest page is after it and there are older ones, the conversation
   * opens instead on a window around the first unread, so it starts at its
   * New line rather than with the rest of what was missed out of sight above.
   * Settles once done; how it went is in `timelineStatus`.
   */
  loadTimeline(
    channelId: ID,
    opts: { older?: boolean; latest?: boolean; unreadAfter?: number } = {},
  ): Promise<void> {
    return this.history.loadTimeline(channelId, opts);
  }

  /**
   * Marks a channel read through the newest of its history loaded here; not
   * while its timeline is anchored away from the newest, which is not on screen.
   */
  readLoadedTail(channelId: ID): void {
    this.readMarks.readLoadedTail(channelId);
  }

  /**
   * Replaces the timeline with a window centred on `messageId`, for jumping to
   * a search hit or a pinned message. Answers the thread the message is in
   * (null when none), or undefined when another jump or window overtook it.
   */
  async jumpToMessage(channelId: ID, messageId: ID): Promise<ID | null | undefined | ApiError> {
    return this.history.jumpToMessage(channelId, messageId);
  }

  cancelMessageJump(): void {
    this.history.cancelMessageJump();
  }

  /**
   * Pages forward from an anchored view back toward the newest messages.
   * Settles once done; how it went is in `timelineStatus`.
   */
  loadNewer(channelId: ID): Promise<void> {
    return this.history.loadNewer(channelId);
  }

  /**
   * Keeps the current window visible until the live tail has loaded
   * successfully; how it went is in `timelineStatus`.
   */
  jumpToLatest(channelId: ID): Promise<void> {
    return this.history.jumpToLatest(channelId);
  }

  async loadThread(
    threadRootId: ID,
    channelId: ID,
    direction: "latest" | "older" | "newer" = "latest",
    around?: ID,
  ): Promise<void> {
    return this.history.loadThread(threadRootId, channelId, direction, around);
  }

  /**
   * Optimistic send: the message (and local image previews) appear instantly,
   * then attachments upload and the server event reconciles it by nonce.
   * A refused send took nothing; the caller keeps the draft.
   */
  send(
    channelId: ID,
    text: string,
    opts: {
      threadRootId?: ID;
      files?: File[];
      alsoSendToChannel?: boolean;
      /** The message this one answers in place; see `quoteOf`. */
      replyTo?: ReplyReference;
      /** The message this one passes on, words of its own or none; see `forwardOf`. */
      forward?: ForwardReference;
      /** Makes it a poll, `text` its question (E6); alone, without files or a forward. */
      poll?: PollDraft;
    } = {},
  ): SendAnswer {
    return this.sender.send(channelId, text, opts);
  }

  retrySend(nonce: string): void {
    this.sender.retrySend(nonce);
  }

  get [LOCAL_WORK](): LocalWorkHost {
    return {
      outboxSnapshot: () => this.sender.outboxSnapshot(),
      restoreOutbox: (entries) => this.sender.restoreOutbox(entries),
      adoptRefusal: (nonce, reason) => this.sender.adoptRefusal(nonce, reason),
      hydrateDrafts: (drafts, stored) => this.hydrateDrafts(drafts, stored),
    };
  }

  discardSend(nonce: string): void {
    this.sender.discardSend(nonce);
  }

  /**
   * Adds this account's reaction, or takes it back, shown at once (see
   * `OptimisticWrites`). Resolves with the server's refusal, or null.
   */
  toggleReaction(message: Message, emoji: string): Promise<ApiError | null> {
    return this.messageActions.toggleReaction(message, emoji);
  }

  /**
   * Votes in a poll, replacing this account's choices; none takes the vote
   * back. Shown at once; the latest choice is the one that stands. Resolves
   * with the server's refusal, such as for a poll closed meanwhile, or null.
   */
  vote(message: Message, choices: number[]): Promise<ApiError | null> {
    return this.messageActions.vote(message, choices);
  }

  /** Its author closes a poll for good. Resolves with the server's refusal, or null. */
  closePoll(message: Message): Promise<ApiError | null> {
    return this.messageActions.closePoll(message);
  }

  /** Pins a message or takes its pin off, shown at once; the channel-wide event confirms it. */
  togglePin(message: Message): Promise<ApiError | null> {
    return this.messageActions.togglePin(message);
  }

  /**
   * Saves a message for later or lets it go, shown at once; this account's
   * devices get the echo. Pass `save` to repeat an earlier intent, so trying a
   * refused save again saves even if the state has changed elsewhere since,
   * rather than flipping.
   */
  toggleSaved(messageId: ID, save = !this.state.saved[messageId]): Promise<ApiError | null> {
    return this.messageActions.toggleSaved(messageId, save);
  }

  /** Follows a thread or stops, shown at once; other devices get the echo. */
  setThreadFollow(rootId: ID, following: boolean): Promise<ApiError | null> {
    return this.readMarks.setThreadFollow(rootId, following);
  }

  /**
   * Mutes a thread or lifts its mute, shown at once. Muting unfollows it, and
   * lifting a mute leaves it unfollowed; neither reads it.
   */
  setThreadMute(rootId: ID, muted: boolean): Promise<ApiError | null> {
    return this.readMarks.setThreadMute(rootId, muted);
  }

  /**
   * Sets a reminder about a message, or moves the one there, once the server
   * has it. Resolves with its refusal, such as for a time already past, or null.
   */
  setReminder(messageId: ID, at: number): Promise<ApiError | null> {
    return this.messageActions.setReminder(messageId, at);
  }

  /** Removes a reminder, done or cancelled. One already gone counts as removed. */
  async cancelReminder(messageId: ID): Promise<ApiError | null> {
    return this.messageActions.cancelReminder(messageId);
  }

  /**
   * Reads notes that someone removed this account from channels, which clears
   * them from Activity at once and from this account's other devices once the
   * server has it. If it could not be told, the notes are back, and this
   * resolves with why.
   */
  async readChannelRemovals(ids: ID[]): Promise<ApiError | null> {
    return this.readMarks.readChannelRemovals(ids);
  }

  /**
   * Marks the reactions to this account's messages seen up to `upTo`, or up
   * to now, on every device of theirs (K13). Resolves with why it could not.
   */
  async seeReactions(upTo?: number): Promise<ApiError | null> {
    try {
      this.reactionsSeen(await this.api.seeReactions(upTo));
      return null;
    } catch (error) {
      return failureOf(error);
    }
  }

  /** Takes what the server says about seen reactions; a mark never moves back. */
  reactionsSeen({ seenAt, unseen }: { seenAt: number; unseen: number }): void {
    this.store.setState((s) =>
      seenAt < s.reactionActivity.seenAt
        ? {}
        : { reactionActivity: { ...s.reactionActivity, seenAt, unseen } },
    );
  }

  /**
   * Marks a thread read up to its loaded tail. This is the only cursor that
   * reading a thread moves: the channel's stays put, so unseen channel
   * messages and mentions stay unread. A thread you do not follow keeps its
   * cursor too, without following it. `through`, a reply named from outside
   * the thread such as in Activity, reads it up to that reply instead, loaded
   * or not. A read waits for no follow or mute: it moves only the cursor.
   */
  markThreadRead(
    rootId: ID,
    opts: { explicit?: boolean; through?: Pick<Message, "channelId" | "seq"> } = {},
  ): void {
    this.readMarks.markThreadRead(rootId, opts);
  }

  /**
   * Renames the workspace, for its owner and admins, and shows the name the
   * server kept as soon as it answers, rather than when its event arrives.
   */
  renameWorkspace(name: string): Promise<string | ApiError> {
    return this.settings.renameWorkspace(name);
  }

  /**
   * Changes who may join, for its owner and admins, and shows what the server
   * kept as soon as it answers. Leaving guests allowed signs every guest out.
   */
  setAccessPolicy(policy: AccessPolicy): Promise<ApiError | null> {
    return this.settings.setAccessPolicy(policy);
  }

  /** Turns link previews on or off, for its owner and admins, and shows the answer at once. */
  setLinkPreviews(enabled: boolean): Promise<ApiError | null> {
    return this.settings.setLinkPreviews(enabled);
  }

  /**
   * Takes a preview off one of this account's messages. It goes from view at
   * once; the server's `message.updated` says the same, and a refusal puts it
   * back and resolves with why.
   */
  removeLinkPreview(message: Message, previewId: ID): Promise<ApiError | null> {
    return this.messageActions.removeLinkPreview(message, previewId);
  }

  /**
   * Sets the workspace's icon, for its owner and admins, and shows the new
   * one as soon as the server keeps it, rather than when its event arrives.
   */
  setWorkspaceIcon(image: Blob): Promise<ApiError | null> {
    return this.settings.setWorkspaceIcon(image);
  }

  /**
   * Adds a section to this account's sidebar, last, and gives it once the
   * server has it; the refusal instead, such as at the limit (E8).
   */
  createSidebarSection(name: string): Promise<SidebarSection | ApiError> {
    return this.preferences.createSidebarSection(name);
  }

  renameSidebarSection(id: ID, name: string): Promise<ApiError | null> {
    return this.preferences.renameSidebarSection(id, name);
  }

  /** Deletes one of this account's sections; its conversations go back where they would be. */
  deleteSidebarSection(id: ID): Promise<ApiError | null> {
    return this.preferences.deleteSidebarSection(id);
  }

  /**
   * Puts this account's sections in a new order, shown at once. A refusal,
   * such as a section added on another device meanwhile, shows the list the
   * server last told this one.
   */
  orderSidebarSections(ids: ID[]): Promise<ApiError | null> {
    return this.preferences.orderSidebarSections(ids);
  }

  /**
   * Adds a custom emoji under `name` (J12): a PNG, GIF or WebP picture,
   * shown here as soon as the server keeps it. Gives the emoji, or the
   * refusal, such as a name already taken.
   */
  addCustomEmoji(name: string, image: Blob): Promise<CustomEmoji | ApiError> {
    return this.settings.addCustomEmoji(name, image);
  }

  /** Removes a custom emoji, for whoever added it and for admins, at once here too. */
  removeCustomEmoji(emoji: CustomEmoji): Promise<ApiError | null> {
    return this.settings.removeCustomEmoji(emoji);
  }

  /** Keeps adding custom emoji to the owner and admins, or opens it to every member. */
  setEmojiAdding(adminsOnly: boolean): Promise<ApiError | null> {
    return this.settings.setEmojiAdding(adminsOnly);
  }

  /**
   * Makes a user group (J13), for admins: a handle no person or group has, a
   * name and its people. Gives the group, or the refusal.
   */
  createUserGroup(body: CreateUserGroupBody): Promise<UserGroup | ApiError> {
    return this.settings.createUserGroup(body);
  }

  /** Renames a user group, or replaces who is in it, at once here too. */
  updateUserGroup(id: ID, body: UpdateUserGroupBody): Promise<UserGroup | ApiError> {
    return this.settings.updateUserGroup(id, body);
  }

  deleteUserGroup(id: ID): Promise<ApiError | null> {
    return this.settings.deleteUserGroup(id);
  }

  /** Removes the workspace's icon, for its owner and admins, at once here too. */
  removeWorkspaceIcon(): Promise<ApiError | null> {
    return this.settings.removeWorkspaceIcon();
  }

  /**
   * Shows a notification choice for one channel at once, then saves it. If
   * the server refuses, the channel shows what the server has, and the
   * choice is kept in `prefsWrites` to try again, unless a later choice has
   * already replaced it: an earlier request failing never undoes a later one.
   */
  setChannelPrefs(channelId: ID, patch: Partial<ChannelPrefs>): Promise<ApiError | null> {
    return this.preferences.setChannelPrefs(channelId, patch);
  }

  /** Tries again to save the notification choice for a channel that failed. */
  retryChannelPrefs(channelId: ID): void {
    this.preferences.retryChannelPrefs(channelId);
  }

  /** Snooze notifications for `minutes`, or pass null to clear Do Not Disturb. */
  snoozeNotifications(minutes: number | null): Promise<ApiError | null> {
    return this.preferences.snoozeNotifications(minutes);
  }

  /**
   * Pause notifications until an epoch ms time; null resumes them now. The
   * server ends with the latest snooze chosen here, whatever order the
   * requests reach it in; if that one is refused, only the snooze goes back,
   * to what the server last said, and the rest of the profile is left as it
   * now is.
   */
  snoozeNotificationsUntil(dndUntil: number | null): Promise<ApiError | null> {
    return this.preferences.snoozeNotificationsUntil(dndUntil);
  }

  // ---------- huddles ----------

  /**
   * Every step of the current huddle, or of the last one after leaving it:
   * for Diagnostics, so someone who cannot connect can show why.
   */
  callLog(): CallLogLine[] {
    return this.calls.callLog();
  }

  /**
   * Joins the channel's huddle, starting one if nobody is in it, with the
   * microphone off when `muted`, and the devices chosen in Voice & video
   * settings. Throws if the microphone is unavailable or admission fails,
   * releasing local media and leaving no half-joined room.
   */
  async joinHuddle(
    channelId: ID,
    options: {
      muted?: boolean;
      microphone?: MicrophoneSettings;
      cameraId?: string;
      noiseFilter?: NoiseFilter;
      systemMicrophone?: OpenSystemMicrophone;
    } = {},
  ): Promise<void> {
    return this.calls.joinHuddle(channelId, options);
  }

  leaveHuddle(): void {
    this.calls.leaveHuddle();
  }

  /**
   * Says no to the ring of this direct message's huddle (E10). It stops here
   * at once and on this account's other devices when the server says so; the
   * caller is told.
   */
  declineRing(channelId: ID): void {
    this.calls.declineRing(channelId);
  }

  toggleMic(): void {
    this.calls.toggleMic();
  }

  /** Asks for a microphone again after the huddle's stopped. */
  retryMicrophone(): void {
    this.calls.retryMicrophone();
  }

  /**
   * Starts sharing the screen, at `quality` where given, with its sound unless
   * `sound` is false, or stops sharing it.
   */
  async toggleScreenShare(quality?: ScreenShareQuality, sound?: boolean): Promise<void> {
    await this.calls.toggleScreenShare(quality, sound);
  }

  /**
   * Changes the share's resolution and frame rate while it goes; false where
   * nothing is shared or the browser would not change it.
   */
  async setScreenShareQuality(quality: ScreenShareQuality): Promise<boolean> {
    return this.calls.setScreenShareQuality(quality);
  }

  async toggleCamera(): Promise<void> {
    await this.calls.toggleCamera();
  }

  /**
   * How tall the call draws each other person's camera and share, in device
   * pixels; anyone left out is not drawn. Kept for a session started later,
   * since the call's view can be up before it (`HuddleSession.setViews`).
   */
  setCallViews(views: ReadonlyMap<ID, CallView>): void {
    this.calls.setCallViews(views);
  }

  /** Changes the huddle's microphone, or its processing, while in one. */
  async setMicrophone(settings: MicrophoneSettings): Promise<void> {
    await this.calls.setMicrophone(settings);
  }

  /** Changes the huddle's camera; while it is off, the next one it turns on. */
  async setCamera(deviceId: string | undefined): Promise<void> {
    await this.calls.setCamera(deviceId);
  }

  private sendSocket(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** `changedAt` is when the words were written: now, or earlier for a draft put back. */
  setDraft(key: string, text: string, changedAt = Date.now()): void {
    this.store.setState((s) => {
      const drafts = { ...s.drafts };
      const draftTimes = { ...s.draftTimes };
      if (text.trim()) {
        // The same words again change nothing, and say nothing new about when.
        if (drafts[key] === text) return s;
        drafts[key] = text;
        draftTimes[key] = changedAt;
      } else {
        delete drafts[key];
        delete draftTimes[key];
      }
      return { drafts, draftTimes };
    });
  }

  /**
   * Replaces the drafts with what is stored: at startup, with the times
   * stored beside them (`stored`), or as another window changed them. A draft
   * whose text is unchanged keeps its time; one restored takes its stored
   * time, if any; one another window changed is as new as hearing of it.
   */
  private hydrateDrafts(drafts: Record<string, string>, stored?: Record<string, number>): void {
    this.store.setState((s) => {
      const draftTimes: Record<string, number> = {};
      const now = Date.now();
      for (const [key, text] of Object.entries(drafts)) {
        const time = s.drafts[key] === text ? s.draftTimes[key] : stored ? stored[key] : now;
        if (time !== undefined) draftTimes[key] = time;
      }
      return { drafts, draftTimes };
    });
  }

  /**
   * `explicit` marks someone actually asking for this, rather than the visible
   * timeline acknowledging itself. Only the former overrides a deliberate
   * unread, so looking at a conversation cannot undo one but choosing to read
   * it can.
   */
  markRead(
    channelId: ID,
    seq = this.state.channelLastSeq[channelId] ?? 0,
    opts: { explicit?: boolean } = {},
  ): void {
    this.readMarks.markRead(channelId, seq, opts);
  }

  /**
   * Leaves a message and everything after it unread. Any acknowledgement
   * already on its way is abandoned first, so it cannot land afterwards and
   * undo this.
   */
  markUnread(channelId: ID, seq: number): void {
    this.readMarks.markUnread(channelId, seq);
  }

  /** The same for one thread, which also follows it. */
  markThreadUnread(rootId: ID, seq: number): void {
    this.readMarks.markThreadUnread(rootId, seq);
  }

  /** Forgets that private replies were let go here, once the notice is dismissed. */
  dismissDroppedEphemerals(channelId: ID): void {
    this.commands.dismissDroppedEphemerals(channelId);
  }

  dismissEphemeral(channelId: ID, id: ID): void {
    this.commands.dismissEphemeral(channelId, id);
  }

  /** Whether this device has gone idle, as it last told the server (E9). */
  private idle = false;

  /**
   * Says this device has gone idle, nobody touching it for a while, or is in
   * use again (E9). Every device of an account idle makes it away. Said again
   * on each new connection, so a server that restarted still knows.
   */
  setIdle(idle: boolean): void {
    if (this.idle === idle) return;
    this.idle = idle;
    this.sendSocket({ type: "idle", idle });
  }

  /**
   * Blocks or unblocks someone for this account (E12); resolves with the
   * server's refusal, or null. The list is kept from the answer, before the
   * socket says it.
   */
  setBlocked(userId: ID, blocked: boolean): Promise<ApiError | null> {
    return doneOf(async () => {
      const result = blocked
        ? await this.api.blockUser(userId)
        : await this.api.unblockUser(userId);
      if (!this.stopped) this.store.setState({ blocked: result.blocked });
    });
  }

  /**
   * Replaces this account's keywords (K11); resolves with the server's
   * refusal, or null. The list is kept from the answer, tidied as the server
   * kept it, before the socket says it.
   */
  setKeywords(keywords: string[]): Promise<ApiError | null> {
    return doneOf(async () => {
      const result = await this.api.setKeywords(keywords);
      if (!this.stopped) this.store.setState({ keywords: result.keywords });
    });
  }

  /**
   * What conversations notify about unless one was set on its own (v53),
   * shown at once; put back when the server refused, resolving with why.
   */
  setNotifyDefault(level: NotifyLevel): Promise<ApiError | null> {
    return this.preferences.setNotifyDefault(level);
  }

  /**
   * The hours this account allows notifications (K12), or null for always,
   * shown at once; put back when the server refused, resolving with why.
   */
  setNotifySchedule(schedule: NotifySchedule | null): Promise<ApiError | null> {
    return this.preferences.setNotifySchedule(schedule);
  }

  private changeSelf(request: () => Promise<{ user: User }>): Promise<ApiError | null> {
    return doneOf(async () => this.keepUser((await request()).user));
  }

  /** Away by hand, until set back (E9). */
  setAway(away: boolean): Promise<ApiError | null> {
    return this.changeSelf(() => this.api.updateMe({ away }));
  }

  /** A time zone for this account, such as one chosen in settings; null forgets it (E9). */
  setTimeZone(timeZone: string | null): Promise<ApiError | null> {
    return this.changeSelf(() => this.api.updateMe({ timeZone }));
  }

  /** Keeps a new profile picture for this account, made small first (E9). */
  setAvatar(image: Blob): Promise<ApiError | null> {
    return this.changeSelf(() => this.api.setAvatar(image));
  }

  removeAvatar(): Promise<ApiError | null> {
    return this.changeSelf(() => this.api.removeAvatar());
  }

  /** An account as the server now has it, shown at once rather than when its event comes. */
  private keepUser(user: User): void {
    if (this.stopped) return;
    this.store.setState((s) => ({
      self: s.self?.id === user.id ? user : s.self,
      users: { ...s.users, [user.id]: user },
    }));
  }

  /**
   * What this device tells the server once it is in (E9):
   * that it is idle, if it is, and its time zone, for an account with none.
   */
  private afterReady(snap: ReadySnapshot): void {
    if (this.idle) this.sendSocket({ type: "idle", idle: true });
    void this.commands.loadCommands();
    if (snap.self.timeZone) return;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) void this.setTimeZone(zone);
  }

  /** Changes this account's name or status; resolves with the server's refusal, or null. */
  updateProfile(body: UpdateMeBody): Promise<ApiError | null> {
    return this.changeSelf(() => this.api.updateMe(body));
  }

  setFriendship(userId: ID, action: "request" | "accept" | "remove"): Promise<ApiError | null> {
    return doneOf(async () => {
      const { friends } = await this.api.updateFriend(userId, action);
      if (!this.stopped) this.store.setState({ friends });
    });
  }

  private signingOut = false;

  /**
   * Signs this session out. Doing so closes the connection, which reads as a
   * sign-in that ended, often before the answer arrives; `signedOutOnPurpose`
   * tells the two apart.
   */
  async signOut(): Promise<ApiError | null> {
    this.signingOut = true;
    const refused = await doneOf(() => this.api.logout());
    if (refused) this.signingOut = false;
    return refused;
  }

  get signedOutOnPurpose(): boolean {
    return this.signingOut;
  }

  serverInfo() {
    return answerOf(() => this.api.serverInfo());
  }

  private fileLimit: Promise<number | null> | null = null;

  /**
   * The largest file this workspace takes, asked once: null where the server
   * does not say, or could not be asked, which is asked again next time.
   */
  maxFileBytes(): Promise<number | null> {
    this.fileLimit ??= this.api.storageUsage().then(
      (usage) => (Number.isFinite(usage.maxFileBytes) ? usage.maxFileBytes : null),
      () => {
        this.fileLimit = null;
        return null;
      },
    );
    return this.fileLimit;
  }

  search(
    q: string,
    limit?: number,
    opts?: { cursor?: string; channelId?: ID; sort?: SearchSort; signal?: AbortSignal },
  ) {
    return answerOf(() => this.api.search(q, limit, opts));
  }

  /** One message, for the card under a link to it; a 404 when it is gone or not readable. */
  getMessage(channelId: ID, messageId: ID, signal?: AbortSignal) {
    return answerOf(async () => (await this.api.getMessage(channelId, messageId, signal)).message);
  }

  /** Refused as `message_changed` if the words are no longer `expectedText`. */
  editMessage(messageId: ID, text: string, expectedText: string) {
    return doneOf(() => this.api.editMessage(messageId, text, expectedText));
  }

  deleteMessage(messageId: ID) {
    return doneOf(() => this.api.deleteMessage(messageId));
  }

  /** Presses a button an app put on a message. */
  runMessageAction(messageId: ID, actionId: string) {
    return answerOf(() => this.api.runMessageAction(messageId, actionId));
  }

  /** Reports a message to the workspace's admins (E12), with why and anything to add. */
  reportMessage(messageId: ID, reason: ReportReason, note?: string) {
    return doneOf(() => this.api.reportMessage(messageId, reason, note));
  }

  /** An address that downloads the file once, within a minute, by a browser's navigation. */
  downloadUrl(fileId: ID) {
    return answerOf(() => this.api.downloadUrl(fileId));
  }

  reminders(signal?: AbortSignal) {
    return answerOf(async () => (await this.api.listReminders(signal)).reminders);
  }

  latestDirectMessages(signal?: AbortSignal) {
    return answerOf(() => this.api.latestDirectMessages(signal));
  }

  /** Every channel this account can see, with how many active people each room holds. */
  browseChannels(signal?: AbortSignal) {
    return answerOf(() => this.api.listChannels(signal));
  }

  updateChannel(channelId: ID, body: UpdateChannelBody) {
    return doneOf(() => this.api.updateChannel(channelId, body));
  }

  joinChannel(channelId: ID) {
    return doneOf(() => this.api.joinChannel(channelId));
  }

  leaveChannel(channelId: ID) {
    return doneOf(() => this.api.leaveChannel(channelId));
  }

  channelMembers(channelId: ID) {
    return answerOf(async () => (await this.api.channelMembers(channelId)).memberIds);
  }

  addToChannel(channelId: ID, userId: ID) {
    return doneOf(() => this.api.inviteMember(channelId, userId));
  }

  removeFromChannel(channelId: ID, userId: ID) {
    return doneOf(() => this.api.removeChannelMember(channelId, userId));
  }

  setChannelManager(channelId: ID, userId: ID, manager: boolean) {
    return doneOf(() => this.api.setChannelManager(channelId, userId, manager));
  }

  private typingSaid = new Map<ID, number>();

  /** Says this person is typing here, at most once every `TYPING_SAY_EVERY_MS`. */
  sendTyping(channelId: ID): void {
    const now = Date.now();
    if (now - (this.typingSaid.get(channelId) ?? 0) < TYPING_SAY_EVERY_MS) return;
    this.typingSaid.set(channelId, now);
    this.sendSocket({ type: "typing", channelId });
  }

  openDm(userIds: ID[]): Promise<Channel | ApiError> {
    return this.createChannel({
      type: userIds.length === 1 ? "dm" : "group_dm",
      memberIds: userIds,
    });
  }

  /** Makes a conversation this account is in, shown at once rather than when its event comes. */
  createChannel(body: CreateChannelBody): Promise<Channel | ApiError> {
    return answerOf(async () => {
      const { channel } = await this.api.createChannel(body);
      if (this.stopped) return channel;
      this.store.setState((s) => ({
        channels: { ...s.channels, [channel.id]: channel },
        memberships: { ...s.memberships, [channel.id]: s.memberships[channel.id] ?? 0 },
        repliesRead:
          channel.id in s.memberships
            ? s.repliesRead
            : joined(s.repliesRead, channel.id, s.lastSeq),
      }));
      return channel;
    });
  }
}

/**
 * `repliesRead` after joining a channel at `seq`: its replies until then are
 * not this account's to catch up on, as the server counts them on joining.
 */
function joined(repliesRead: Record<ID, number>, channelId: ID, seq: number) {
  return { ...repliesRead, [channelId]: seq };
}

/**
 * A message event as it happens, rather than replayed onto a page: a channel
 * at its newest end lets go of its oldest messages past the cap.
 */
function liveMessages(
  cache: MessageCache,
  envelope: EventEnvelope & { event: MessageEvent },
  inOrder: boolean,
): MessageCache {
  const next = reduceMessages(cache, envelope, inOrder);
  return envelope.event.type === "message.created"
    ? windowTimeline(next, envelope.event.message.channelId, "oldest")
    : next;
}
