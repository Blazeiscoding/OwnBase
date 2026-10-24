import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  type AccessPolicy,
  type ClientToServer,
  type EphemeralEvent,
  type EventEnvelope,
  type HuddleRing,
  type ID,
  type Presence,
  type ReadySnapshot,
  type ServerToClient,
} from "@slackoss/protocol";
import type { Store } from "./store.js";
import { hashToken } from "./auth.js";
import { socketMessage } from "./socketSchema.js";
import { CallLog } from "./callLog.js";
import type { RateLimiter } from "./limits.js";
import { resolveClientAddress } from "./netTrust.js";

type HuddleJoinResult = Extract<EphemeralEvent, { type: "huddle.join.result" }>;

interface Client {
  ws: WebSocket;
  userId: ID;
  tokenHash: string;
  alive: boolean;
  /** Its device has gone idle, as it says (E9); every one idle makes the account away. */
  idle?: boolean;
}

/**
 * How long a place in a huddle waits for its device to come back after that
 * device's connection drops, before it is given up and the others are told.
 * A blip, or the server restarting its socket, then costs the call nothing.
 */
export const HUDDLE_GRACE_MS = 30_000;

/**
 * How long a direct message's huddle rings the people in it before whoever
 * has not answered has missed it (E10).
 */
export const HUDDLE_RING_MS = 30_000;

/** A ring as the gateway keeps it: its state as told, everyone it rang, and its end. */
interface Ring {
  state: HuddleRing;
  /** Everyone it rang, who hear each change, whether or not it still rings them. */
  rang: ID[];
  timer: NodeJS.Timeout | null;
}

/**
 * Someone's place in a huddle: the socket of the device in the call, or none
 * while that device's connection is down, until it comes back or `released`
 * gives the place up.
 */
interface Seat {
  client: Client | null;
  released: NodeJS.Timeout | null;
}

/**
 * Holds every live socket, answers "who may see this event", and fans out
 * durable + ephemeral events. Event visibility: global events go to everyone;
 * events on a public channel go to everyone; events on private/dm channels go
 * to current members only.
 */
export class Gateway {
  private clients = new Set<Client>();
  private byUser = new Map<ID, Set<Client>>();
  /**
   * channelId -> who is in that channel's huddle, and on which device. Purely
   * live state: a huddle exists only while people are in it, so it is never
   * written to the event log and does not survive a restart.
   */
  private huddles = new Map<ID, Map<ID, Seat>>();
  /** channelId -> the ring of a direct message's huddle just started (E10), live as huddles are. */
  private rings = new Map<ID, Ring>();
  /** What happened in huddles lately, for the host (see `CallLog`). */
  readonly calls = new CallLog();
  private heartbeat: NodeJS.Timeout;
  private sockets = new Set<WebSocket>();
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private store: Store,
    /** The workspace's name, who may join it and its icon's version, as they are now. */
    private workspace: {
      name: () => string;
      accessPolicy: () => AccessPolicy;
      iconVersion: () => string | null;
      /** Whether new messages get link previews now (E2). */
      linkPreviews: () => boolean;
    },
    /** Shared with the HTTP side, so one caller has one allowance overall. */
    private limiter: RateLimiter | null = null,
    private clientAddress: (request: IncomingMessage) => string = (request) =>
      resolveClientAddress(request.socket.remoteAddress, request.headers),
    /**
     * Told of a failure in a socket callback, which Fastify's error handler
     * never sees: an exception there would otherwise end the process (F03).
     */
    private reportFailure: (err: unknown, where: string) => void = () => {},
    private options: {
      huddleGraceMs?: number;
      /** How long a ring lasts (`HUDDLE_RING_MS` by default). */
      huddleRingMs?: number;
      /** Leaves the note of a ring nobody answered in its conversation (E10). */
      missedCall?: (channelId: ID, callerId: ID) => void;
    } = {},
  ) {
    this.heartbeat = setInterval(() => {
      this.contained("heartbeat", () => {
        const authorized = this.sessionCheck();
        for (const c of [...this.clients]) {
          if (!authorized(c)) continue;
          if (!c.alive) {
            c.ws.terminate();
            continue;
          }
          c.alive = false;
          c.ws.ping();
        }
      });
    }, 30_000);
  }

  /**
   * Runs one socket callback so a throw is reported rather than ending the
   * process. What it was doing may be half done, so callers decide what to
   * close; this only keeps the server up.
   */
  private contained(where: string, work: () => void): boolean {
    try {
      work();
      return true;
    } catch (err) {
      this.report(err, where);
      return false;
    }
  }

  private report(err: unknown, where: string): void {
    try {
      this.reportFailure(err, where);
    } catch {
      // Reporting cannot be what ends the process either.
    }
  }

  /**
   * Closes a socket whose state could not be read, so its client reconnects
   * and is checked afresh. 1011 is a server fault, not a refusal: the client
   * keeps its sign-in and tries again, where 4003 would sign it out. Taken out
   * of fan-out first, so nothing more reaches it while it closes.
   */
  private fail(client: Client | null, ws: WebSocket): void {
    // Told about afterwards, not here: telling others reads their sessions,
    // which are failing too, and each failure would tell everyone again.
    if (client) this.contained("unregister", () => this.unregister(client, true));
    try {
      ws.close(1011, "server error");
    } catch {
      ws.terminate();
    }
  }

  attach(server: HttpServer, path = "/ws"): void {
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 128 * 1024,
      perMessageDeflate: false,
    });
    server.on("upgrade", (req, socket, head) => {
      if (this.closing) {
        socket.destroy();
        return;
      }
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        // Upgrade events bypass Fastify's request error handler. A malformed
        // absolute target must end this connection rather than the process.
        socket.destroy();
        return;
      }
      if (url.pathname !== path) {
        socket.destroy();
        return;
      }
      const upgraded = this.contained("upgrade", () => {
        // Opening sockets is cheap for the caller and not for the server, so it
        // is rationed before the handshake rather than after it. Keyed on the
        // address because there is no account yet to key on.
        const address = this.clientAddress(req);
        if (this.limiter && !this.limiter.take("socket", address).ok) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
      });
      if (!upgraded) socket.destroy();
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    clearInterval(this.heartbeat);
    for (const room of this.huddles.values())
      for (const seat of room.values()) if (seat.released) clearTimeout(seat.released);
    // Stopping misses nobody's call: the rings end with the huddles, unannounced.
    for (const ring of this.rings.values()) if (ring.timer) clearTimeout(ring.timer);
    this.rings.clear();
    this.closePromise = Promise.all(
      [...this.sockets].map(
        (ws) =>
          new Promise<void>((resolve) => {
            ws.once("close", () => resolve());
            ws.terminate();
          }),
      ),
    ).then(
      () => {},
      (error: unknown) => {
        // Not kept: closing again ends whatever sockets are left.
        this.closePromise = null;
        throw error;
      },
    );
    return this.closePromise;
  }

  /** Silent when refused: a dropped typing notice is not worth an error frame. */
  private affordEphemeral(userId: ID): boolean {
    return !this.limiter || this.limiter.take("ephemeral", userId).ok;
  }

  /** Whether this account has a socket here now, so is told about changes as they happen. */
  isOnline(userId: ID): boolean {
    return this.byUser.has(userId);
  }

  onlineUserIds(): ID[] {
    return [...this.byUser.keys()];
  }

  /** Sockets open now, signed in or not yet. */
  socketCount(): number {
    return this.sockets.size;
  }

  private presenceListeners = new Set<() => void>();

  /** Called whenever someone's first socket opens or last socket closes. */
  onPresenceChange(listener: () => void): () => void {
    this.presenceListeners.add(listener);
    return () => void this.presenceListeners.delete(listener);
  }

  private presenceChanged(): void {
    for (const listener of this.presenceListeners) {
      try {
        listener();
      } catch {
        // Whoever listens cannot stop a socket from being counted.
      }
    }
  }

  /**
   * Who is online. Everyone else is offline, as clients have always read an
   * account missing from the map; listing every account as offline made each
   * handshake load them all a second time (OPT-13).
   */
  presenceMap(): Record<ID, Presence> {
    const out: Record<ID, Presence> = {};
    for (const id of this.byUser.keys()) out[id] = this.presenceOf(id);
    return out;
  }

  /** Each connected account's presence as everyone was last told it. */
  private told = new Map<ID, Presence>();

  /**
   * Someone's presence (E9): offline with no socket; away when they set
   * themselves away, or when every device of theirs says it is idle; online
   * otherwise.
   */
  private presenceOf(userId: ID): Presence {
    const sockets = this.byUser.get(userId);
    if (!sockets || sockets.size === 0) return "offline";
    if (this.store.isAway(userId)) return "away";
    return [...sockets].every((client) => client.idle) ? "away" : "online";
  }

  /**
   * Tells everyone someone's presence when it is not what they were last
   * told, while they are connected; going offline is told as sockets close.
   */
  refreshPresence(userId: ID): void {
    const now = this.presenceOf(userId);
    if (now === "offline" || this.told.get(userId) === now) return;
    this.told.set(userId, now);
    this.contained("presence", () =>
      this.broadcastEphemeral({ type: "presence", userId, presence: now }, null),
    );
  }

  private onConnection(ws: WebSocket): void {
    this.sockets.add(ws);
    let client: Client | null = null;
    const authTimer = setTimeout(() => {
      if (!client) ws.terminate();
    }, 10_000);

    ws.on("pong", () => {
      if (client) client.alive = true;
    });

    ws.on("message", (data) => {
      if (this.closing || (client && !this.clients.has(client))) return;
      let msg: ClientToServer;
      try {
        const parsed = socketMessage.safeParse(JSON.parse(String(data)));
        if (!parsed.success) {
          ws.close(4000, "invalid message");
          return;
        }
        msg = parsed.data;
      } catch {
        return;
      }
      // Session and snapshot reads run here, outside Fastify's error handler.
      // One that throws closes this socket for its client to try again,
      // having sent nothing that depended on the read (F03).
      if (!this.contained("message", () => handle(msg))) this.fail(client, ws);
    });

    const handle = (msg: ClientToServer): void => {
      if (msg.type === "hello" && !client) {
        clearTimeout(authTimer);
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this.send(ws, {
            type: "error",
            code: "protocol_mismatch",
            message: `server speaks protocol v${PROTOCOL_VERSION}`,
          });
          ws.close(4002);
          return;
        }
        const tokenHash = hashToken(msg.token);
        const user = this.store.getSessionUser(tokenHash);
        if (!user) {
          this.send(ws, { type: "error", code: "auth_failed", message: "invalid token" });
          ws.close(4003);
          return;
        }
        // The REST side refuses a locked account; the socket has to as well, or
        // a temporary password would still hand over the whole workspace.
        if (this.store.mustChangePassword(user.id)) {
          this.send(ws, {
            type: "error",
            code: "password_change_required",
            message: "Choose a new password before using this workspace.",
          });
          ws.close(4004);
          return;
        }
        // Everything the handshake reads is read before this socket joins
        // fan-out, so a read that fails announces nobody online (F03).
        const snapshot: ReadySnapshot = {
          type: "ready",
          seq: this.store.currentSeq(),
          self: user,
          users: this.store.listUsers(),
          channels: this.store.listChannelsVisibleTo(user.id),
          memberships: this.store.memberships(user.id),
          channelLastSeq: this.store.channelLastSeqMap(user.id),
          presence: {},
          savedMessageIds: this.store.savedMessageIds(user.id),
          threadFollows: this.store.threadFollows(user.id),
          mentionCounts: this.store.unreadMentionCounts(user.id),
          huddles: this.huddlesVisibleTo(user.id),
          huddleJoinReplies: true,
          huddleReports: true,
          huddleRings: this.ringsFor(user.id),
          inlineReplies: true,
          forwards: true,
          scheduledEvents: true,
          activityThreads: true,
          threadMutes: true,
          reminders: this.store.reminders(user.id),
          pollChoices: this.store.anonymousPollChoices(user.id),
          sharedFiles: true,
          sidebarSections: this.store.sidebarSections(user.id),
          profiles: true,
          stars: true,
          workspaceSettings: true,
          accessPolicy: this.workspace.accessPolicy(),
          workspaceIcon: true,
          iconVersion: this.workspace.iconVersion(),
          linkPreviews: this.workspace.linkPreviews(),
          workspaceName: this.workspace.name(),
          workspaceId: this.store.getMeta("workspace_id") ?? undefined,
          friends: this.store.listFriends(user.id),
          blocked: this.store.blockedIds(user.id),
          ...(user.role === "owner" || user.role === "admin"
            ? { openReports: this.store.openReportCount() }
            : {}),
        };
        const missed =
          msg.lastSeq !== null && msg.lastSeq <= snapshot.seq
            ? this.store.eventsSince(msg.lastSeq, user.id)
            : null;
        client = { ws, userId: user.id, tokenHash, alive: true };
        this.register(client);
        snapshot.presence = this.presenceMap();
        if (msg.syncVersion === 1) snapshot.replayFrom = missed === null ? null : msg.lastSeq;
        this.send(ws, snapshot);
        if (missed !== null) {
          for (const envelope of missed) this.send(ws, { type: "event", envelope });
        } else if (msg.lastSeq !== null && msg.syncVersion !== 1) {
          this.send(ws, { type: "resync" });
        }
        if (msg.syncVersion === 1) this.send(ws, { type: "synced", seq: snapshot.seq });
        return;
      }

      if (!client) return;
      if (!this.authorized(client)) return;
      if (msg.type === "ping") {
        this.send(ws, { type: "pong" });
      } else if (msg.type === "typing") {
        // Every keystroke can send one of these, and each fans out to a whole
        // channel, so the cost of sending is far below the cost of delivering.
        if (!this.affordEphemeral(client.userId)) return;
        if (this.store.canAccess(msg.channelId, client.userId)) {
          this.broadcastEphemeral(
            { type: "typing", channelId: msg.channelId, userId: client.userId },
            this.audienceForChannel(msg.channelId),
          );
        }
      } else if (msg.type === "huddle.join") {
        this.joinHuddle(msg.channelId, client, msg.requestId);
      } else if (msg.type === "huddle.leave") {
        this.leaveFrom(msg.channelId, client);
      } else if (msg.type === "huddle.decline") {
        if (!this.affordEphemeral(client.userId)) return;
        this.declineRing(msg.channelId, client.userId);
      } else if (msg.type === "huddle.signal") {
        if (!this.affordEphemeral(client.userId)) return;
        // Only relay between the two devices in the same huddle: not to the
        // person's other devices, and not while theirs is reconnecting.
        const room = this.huddles.get(msg.channelId);
        const target = room?.get(msg.to);
        const refused =
          room?.get(client.userId)?.client !== client
            ? "the sender is not in the huddle on this device"
            : !target
              ? "the other person is not in the huddle"
              : !target.client
                ? "the other person's connection is down"
                : !this.store.canAccess(msg.channelId, client.userId) ||
                    !this.store.canAccess(msg.channelId, msg.to)
                  ? "no access to the conversation"
                  : null;
        const setup = msg.signal.kind === "offer" || msg.signal.kind === "answer";
        // Routes and media notices come by the dozen; the setup is what tells.
        if (setup || refused)
          this.calls.add({
            channelId: msg.channelId,
            userId: client.userId,
            peerId: msg.to,
            ...(refused
              ? { kind: "dropped", reason: `${msg.signal.kind}: ${refused}` }
              : { kind: msg.signal.kind as "offer" | "answer" }),
          });
        if (!refused && target?.client && this.authorized(target.client)) {
          this.send(target.client.ws, {
            type: "ephemeral",
            event: {
              type: "huddle.signal",
              channelId: msg.channelId,
              from: client.userId,
              signal: msg.signal,
            },
          });
        }
      } else if (msg.type === "idle") {
        if (!this.affordEphemeral(client.userId)) return;
        client.idle = msg.idle;
        this.refreshPresence(client.userId);
      } else if (msg.type === "huddle.report") {
        if (!this.affordEphemeral(client.userId)) return;
        // A report can come just after either side left, so only the
        // conversation's access is asked, not the room's.
        if (this.store.canAccess(msg.channelId, client.userId))
          this.calls.add({
            channelId: msg.channelId,
            userId: client.userId,
            peerId: msg.peer,
            kind: "report",
            report: msg.report,
          });
      }
    };

    ws.on("close", () => {
      this.sockets.delete(ws);
      clearTimeout(authTimer);
      const leaving = client;
      if (leaving) this.contained("close", () => this.unregister(leaving));
    });
    ws.on("error", () => ws.terminate());
  }

  private register(client: Client): void {
    this.clients.add(client);
    let set = this.byUser.get(client.userId);
    const firstSocket = !set;
    if (!set) this.byUser.set(client.userId, (set = new Set()));
    set.add(client);
    if (firstSocket) {
      this.told.delete(client.userId);
      this.refreshPresence(client.userId);
      this.presenceChanged();
    } else {
      // A device in use again makes someone away by idling online.
      this.refreshPresence(client.userId);
    }
  }

  /**
   * Forgets a socket. Every in-memory change comes first and cannot fail, so a
   * read that throws while telling others still leaves this person out of
   * fan-out, presence and every huddle (F03); each notice then fails alone.
   *
   * A huddle place this socket held waits for its device to come back
   * (`holdSeat`), whatever other devices the person has online: the place
   * belongs to the device in the call. A socket `revoked` for a reason gives
   * its places up at once, since it is not coming back.
   */
  private unregister(client: Client, later = false, revoked: string | null = null): void {
    if (!this.clients.delete(client)) return;
    const left: ID[] = [];
    for (const [channelId, room] of this.huddles) {
      const seat = room.get(client.userId);
      if (!seat || seat.client !== client) continue;
      if (revoked === null) this.holdSeat(channelId, client.userId, seat);
      else if (this.dropFromHuddle(channelId, client.userId, revoked)) left.push(channelId);
    }
    const set = this.byUser.get(client.userId);
    if (!set) return;
    set.delete(client);
    const offline = set.size === 0;
    if (offline) {
      this.byUser.delete(client.userId);
      this.told.delete(client.userId);
    } else {
      // The devices left may all be idle.
      this.contained("presence", () => this.refreshPresence(client.userId));
    }
    if (later) {
      for (const channelId of left) this.departures.huddles.add(channelId);
      if (offline) {
        this.departures.users.add(client.userId);
        this.presenceChanged();
      }
      if ((offline || left.length > 0) && !this.departures.scheduled) {
        this.departures.scheduled = true;
        setImmediate(() => this.contained("departures", () => this.announceDepartures()));
      }
      return;
    }
    for (const channelId of left) {
      this.contained("huddle departure", () => this.publishHuddle(channelId));
    }
    if (!offline) return;
    this.contained("presence", () =>
      this.broadcastEphemeral(
        { type: "presence", userId: client.userId, presence: "offline" },
        null,
      ),
    );
    this.presenceChanged();
  }

  // ---------- huddles ----------

  private huddlesVisibleTo(userId: ID): Record<ID, ID[]> {
    const out: Record<ID, ID[]> = {};
    for (const [channelId, members] of this.huddles) {
      if (this.store.canAccess(channelId, userId)) out[channelId] = [...members.keys()];
    }
    return out;
  }

  private joinHuddle(channelId: ID, client: Client, requestId?: string): void {
    const userId = client.userId;
    const reply = (event: HuddleJoinResult) => {
      if (!requestId) return; // Older clients do not wait for admission replies.
      // One bounded reply only to this socket, like pong. Room fanout stays
      // admission-rationed; send() applies the existing slow-reader limit.
      this.send(client.ws, { type: "ephemeral", event });
    };
    const refuse = (message: string, retryAfterMs?: number) => {
      if (requestId)
        reply({
          type: "huddle.join.result",
          channelId,
          requestId,
          accepted: false,
          message,
          retryAfterMs,
        });
    };
    if (!this.store.canAccess(channelId, userId)) {
      this.calls.add({ channelId, userId, kind: "refused", reason: "no access" });
      refuse("You no longer have access to this conversation.");
      return;
    }
    let room = this.huddles.get(channelId);
    // Repeated joins are already represented by the room and spend no admission.
    // Nor does coming back to a place kept for this person, from the device that
    // lost its connection or from another of theirs; the others see no change.
    const seat = room?.get(userId);
    if (seat) {
      const before = seat.client;
      if (seat.released) clearTimeout(seat.released);
      seat.released = null;
      seat.client = client;
      if (before !== client) {
        this.calls.add({
          channelId,
          userId,
          kind: "joined",
          reason: before ? "moved from another device" : "came back after a lost connection",
        });
        // The device that had the place ends the call there, rather than
        // talk over this one.
        if (before)
          this.send(before.ws, { type: "ephemeral", event: { type: "huddle.moved", channelId } });
      }
      if (requestId) reply({ type: "huddle.join.result", channelId, requestId, accepted: true });
      return;
    }
    // Each admitted join can cause at most one later departure broadcast. Leave,
    // disconnect and access revocation must still release the seat when exhausted.
    const admission = this.limiter?.take("ephemeral", userId);
    if (admission && !admission.ok) {
      this.calls.add({ channelId, userId, kind: "refused", reason: "joining too often" });
      refuse(
        `Huddle joins are temporarily limited. Wait ${Math.max(1, Math.ceil(admission.retryAfterMs / 1000))} seconds, then try again.`,
        admission.retryAfterMs,
      );
      return;
    }
    const started = !room;
    if (!room) this.huddles.set(channelId, (room = new Map()));
    room.set(userId, { client, released: null });
    this.calls.add({ channelId, userId, kind: "joined" });
    // The first one in a direct message's huddle rings the others (E10).
    if (started) this.contained("huddle ring", () => this.startRing(channelId, userId));
    this.publishHuddle(channelId);
    if (requestId) reply({ type: "huddle.join.result", channelId, requestId, accepted: true });
  }

  /**
   * Leaving, as a device asks to. Only the device in the call can, or any of
   * the person's while the place waits for its device: a device whose place
   * moved to another may still say it left, and the call goes on there.
   */
  private leaveFrom(channelId: ID, client: Client): void {
    const seat = this.huddles.get(channelId)?.get(client.userId);
    if (!seat || (seat.client && seat.client !== client)) return;
    this.leaveHuddle(channelId, client.userId, "left");
  }

  private leaveHuddle(channelId: ID, userId: ID, reason: string): void {
    if (this.dropFromHuddle(channelId, userId, reason)) this.publishHuddle(channelId);
  }

  /**
   * Keeps the place of a device whose connection dropped, for it to come
   * back to. If it has not by the end of the grace, the place is given up and
   * the others are told, as a departure always was.
   */
  private holdSeat(channelId: ID, userId: ID, seat: Seat): void {
    seat.client = null;
    if (seat.released) clearTimeout(seat.released);
    seat.released = setTimeout(() => {
      seat.released = null;
      this.contained("huddle place", () => {
        // Still this place, and still waiting: nobody came back for it.
        if (this.huddles.get(channelId)?.get(userId) !== seat || seat.client) return;
        this.leaveHuddle(channelId, userId, "disconnected");
      });
    }, this.options.huddleGraceMs ?? HUDDLE_GRACE_MS);
    seat.released.unref?.();
  }

  /** Takes someone out of a room in memory only; whether they were in it. */
  private dropFromHuddle(channelId: ID, userId: ID, reason: string): boolean {
    const room = this.huddles.get(channelId);
    const seat = room?.get(userId);
    if (!room || !seat) return false;
    if (seat.released) clearTimeout(seat.released);
    room.delete(userId);
    this.calls.add({ channelId, userId, kind: "left", reason });
    // An empty huddle is no huddle at all.
    if (room.size === 0) this.huddles.delete(channelId);
    return true;
  }

  /**
   * Membership changes also invalidate a call and notify the affected user's
   * devices. Someone removed from a private channel is outside its audience,
   * so its durable `member.left` never reaches them: this notice is the only
   * thing that clears it from their screens. If it cannot be read or sent,
   * their devices reconnect, and the handshake reads their access afresh and
   * drops whatever they may no longer see (F06). The change itself stands.
   */
  updateChannelAccess(channelId: ID, userId: ID): void {
    try {
      const membership =
        this.store.memberships(userId).find((m) => m.channelId === channelId) ?? null;
      const channel = this.store.canAccess(channelId, userId)
        ? this.store.getChannel(channelId)
        : null;
      if (!channel) this.leaveHuddle(channelId, userId, "lost access");
      this.sendToUser(userId, { type: "channel.access", channelId, channel, membership });
    } catch (err) {
      this.report(err, "channel access");
      this.resynchronizeUser(userId);
    }
  }

  /** Tells the channel who is in its huddle now, and brings its ring up to date (E10). */
  private publishHuddle(channelId: ID, authorized?: (client: Client) => boolean): void {
    this.broadcastEphemeral(
      {
        type: "huddle.participants",
        channelId,
        userIds: [...(this.huddles.get(channelId)?.keys() ?? [])],
      },
      this.audienceForChannel(channelId),
      authorized,
    );
    this.contained("huddle ring", () => this.settleRing(channelId));
  }

  // ---------- rings (E10) ----------

  /**
   * Rings everyone else in a direct message whose huddle this person has
   * just started: not bots, who cannot answer, nor deactivated accounts.
   * Joining a huddle already going rings nobody, and a channel never rings.
   */
  private startRing(channelId: ID, callerId: ID): void {
    const channel = this.store.getChannel(channelId);
    if (!channel || (channel.type !== "dm" && channel.type !== "group_dm")) return;
    const rang = this.store.memberIds(channelId).filter((id) => {
      if (id === callerId) return false;
      const user = this.store.getUser(id);
      return !!user && !user.isBot && !user.deactivated;
    });
    if (rang.length === 0) return;
    const before = this.rings.get(channelId);
    if (before) this.endRing(channelId, before);
    const ms = this.options.huddleRingMs ?? HUDDLE_RING_MS;
    const startedAt = Date.now();
    const ring: Ring = {
      state: {
        channelId,
        callerId,
        startedAt,
        endsAt: startedAt + ms,
        ringing: rang,
        answered: [],
        declined: [],
      },
      rang,
      timer: null,
    };
    ring.timer = setTimeout(() => {
      ring.timer = null;
      this.contained("huddle ring", () => this.endRing(channelId, ring));
    }, ms);
    ring.timer.unref?.();
    this.rings.set(channelId, ring);
    this.tellRing(ring);
  }

  /**
   * Brings a ring up to date with who is in its huddle: someone it rang who
   * is in the huddle now has answered, and a ring whose caller is no longer
   * in it is over.
   */
  private settleRing(channelId: ID): void {
    const ring = this.rings.get(channelId);
    if (!ring) return;
    const room = this.huddles.get(channelId);
    if (!room?.has(ring.state.callerId)) return this.endRing(channelId, ring);
    const { state } = ring;
    const joined = ring.rang.filter((id) => room.has(id) && !state.answered.includes(id));
    if (joined.length === 0) return;
    state.ringing = state.ringing.filter((id) => !joined.includes(id));
    state.declined = state.declined.filter((id) => !joined.includes(id));
    state.answered = [...state.answered, ...joined];
    if (state.ringing.length === 0) this.endRing(channelId, ring);
    else this.tellRing(ring);
  }

  /** Someone it is ringing says no, which the caller hears. */
  private declineRing(channelId: ID, userId: ID): void {
    const ring = this.rings.get(channelId);
    if (!ring || !ring.state.ringing.includes(userId)) return;
    ring.state.ringing = ring.state.ringing.filter((id) => id !== userId);
    ring.state.declined = [...ring.state.declined, userId];
    if (ring.state.ringing.length === 0) this.endRing(channelId, ring);
    else this.tellRing(ring);
  }

  /**
   * Stops a ring for everyone. Whoever it was still ringing missed it, and if
   * nobody answered, the conversation is left a note saying so, as from the
   * caller.
   */
  private endRing(channelId: ID, ring: Ring): void {
    if (this.rings.get(channelId) !== ring) return;
    this.rings.delete(channelId);
    if (ring.timer) clearTimeout(ring.timer);
    ring.timer = null;
    const missed = ring.state.ringing.length > 0;
    ring.state.ringing = [];
    this.tellRing(ring);
    if (missed && ring.state.answered.length === 0)
      this.contained("missed call", () =>
        this.options.missedCall?.(channelId, ring.state.callerId),
      );
  }

  /** Tells the caller and everyone it rang how a ring stands, on all their devices. */
  private tellRing(ring: Ring): void {
    const event: EphemeralEvent = { type: "huddle.ring", ring: { ...ring.state } };
    for (const userId of [ring.state.callerId, ...ring.rang])
      this.contained("huddle ring", () => this.sendToUser(userId, event));
  }

  /** The rings this account is part of, calling or called, for its snapshot. */
  private ringsFor(userId: ID): HuddleRing[] {
    return [...this.rings.values()]
      .filter((ring) => ring.state.callerId === userId || ring.rang.includes(userId))
      .map((ring) => ({ ...ring.state }));
  }

  /** A channel's ring as it stands, for tests and diagnostics. */
  huddleRing(channelId: ID): HuddleRing | null {
    const ring = this.rings.get(channelId);
    return ring ? { ...ring.state } : null;
  }

  /** Who went offline when their sockets failed, not yet told to anyone. */
  private departures = { users: new Set<ID>(), huddles: new Set<ID>(), scheduled: false };

  /**
   * Tells everyone at once about the people whose sockets failed, with one
   * session check for the whole batch (F03). A socket whose session cannot
   * be read here fails too and is told about in the next batch, so a
   * failing database costs a read per session, not one per notice per
   * session, and no failure nests inside another.
   */
  private announceDepartures(): void {
    const { users, huddles } = this.departures;
    this.departures = { users: new Set(), huddles: new Set(), scheduled: false };
    if (this.closing) return;
    const authorized = this.sessionCheck();
    for (const channelId of huddles)
      this.contained("huddle departure", () => this.publishHuddle(channelId, authorized));
    for (const userId of users) {
      // Back already, on a socket that told everyone so.
      if (this.byUser.has(userId)) continue;
      this.contained("presence", () =>
        this.broadcastEphemeral(
          { type: "presence", userId, presence: "offline" },
          null,
          authorized,
        ),
      );
    }
  }

  /** Participants of one channel's huddle, for tests and diagnostics. */
  huddleParticipants(channelId: ID): ID[] {
    return [...(this.huddles.get(channelId)?.keys() ?? [])];
  }

  /** null audience = all connected users. */
  private audienceForChannel(channelId: ID): Set<ID> | null {
    const ch = this.store.getChannel(channelId);
    if (!ch) return new Set();
    if (ch.type === "public") return null;
    return new Set(this.store.memberIds(channelId));
  }

  /**
   * Fan a durable event out to every connected client allowed to see it.
   * `audiences` carries each channel's audience across the events of one
   * committed change, read once however many of them there are (F10); the
   * caller drops it when that change is out, so it never outlives the
   * committed rows it was read from.
   */
  publish(
    envelope: EventEnvelope,
    channelId: ID | null,
    audiences?: Map<ID, Set<ID> | null>,
  ): void {
    // With nobody signed in there is nobody to read an audience for.
    if (this.clients.size === 0) return;
    const audience = channelId === null ? null : this.channelAudience(channelId, audiences);
    const frame = JSON.stringify({ type: "event", envelope } satisfies ServerToClient);
    const authorized = this.sessionCheck();
    for (const c of this.reach(audience)) if (authorized(c)) this.sendRaw(c.ws, frame);
  }

  /** A channel's audience, from `audiences` when this change has read it already. */
  channelAudience(channelId: ID, audiences?: Map<ID, Set<ID> | null>): Set<ID> | null {
    if (audiences?.has(channelId)) return audiences.get(channelId)!;
    const audience = this.audienceForChannel(channelId);
    audiences?.set(channelId, audience);
    return audience;
  }

  /**
   * The sockets a fan-out to `audience` reaches: everyone's, or only those of
   * the people in it, found by person rather than by checking every socket
   * here (REV-06). A copy, since a revoked socket leaves the set mid-way.
   */
  private reach(audience: Set<ID> | null): Client[] {
    if (audience === null) return [...this.clients];
    return [...audience].flatMap((userId) => [...(this.byUser.get(userId) ?? [])]);
  }

  /**
   * Whether a socket's session is still signed in, asked once per session in
   * one fan-out however many of its devices it reaches (REV-06). An ended
   * session closes each of its sockets as it is met, as `authorized` does, so
   * revocation and expiry act as soon as before; the answer lives only as
   * long as the fan-out that asked.
   */
  private sessionCheck(): (client: Client) => boolean {
    const known = new Map<string, boolean | "unreadable">();
    return (client) => {
      if (!this.clients.has(client)) return false;
      const key = `${client.tokenHash}\n${client.userId}`;
      let active = known.get(key);
      if (active === undefined) {
        try {
          active = this.store.isSessionActive(client.tokenHash, client.userId);
        } catch (err) {
          this.report(err, "session check");
          active = "unreadable";
        }
        known.set(key, active);
      }
      // A session that cannot be read is not known to be signed in: send it
      // nothing, and close for its client to reconnect and be asked again (F03).
      if (active === "unreadable") {
        this.fail(client, client.ws);
        return false;
      }
      if (!active) this.revoke(client, "session expired or revoked");
      return active;
    };
  }

  /**
   * Cuts every live socket a person has. Deactivating an account revokes its
   * sessions, but an already-open WebSocket authenticated once and would
   * otherwise keep streaming the workspace to someone who has just been
   * removed from it.
   */
  disconnectUser(userId: ID): void {
    for (const client of [...(this.byUser.get(userId) ?? [])]) {
      this.revoke(client, "account deactivated");
    }
  }

  /**
   * Closes every socket, so each client reconnects and replays from the last
   * event it received. For a committed event that could not be fanned out: a
   * client that went on receiving later events would take the next one as its
   * checkpoint and never ask for the one it missed. Closing stops further
   * frames at once; the close handler unregisters as usual.
   */
  resynchronize(): void {
    for (const client of this.clients) client.ws.close(1012, "resynchronize");
  }

  /**
   * Closes one person's sockets for the same reason, taking them out of
   * fan-out at once. Needs no read, so it works when the read that failed
   * is the reason for it.
   */
  resynchronizeUser(userId: ID): void {
    for (const client of [...(this.byUser.get(userId) ?? [])]) {
      this.contained("unregister", () => this.unregister(client));
      client.ws.close(1012, "resynchronize");
    }
  }

  disconnectSession(tokenHash: string): void {
    for (const client of [...this.clients]) {
      if (client.tokenHash === tokenHash) this.revoke(client, "signed out");
    }
  }

  private revoke(client: Client, reason: string): void {
    this.send(client.ws, { type: "error", code: "auth_failed", message: reason });
    // Stop fanout and accepting frames immediately, without waiting for the close handshake.
    this.unregister(client, false, reason);
    client.ws.close(4003, reason);
  }

  private authorized(client: Client): boolean {
    return this.sessionCheck()(client);
  }

  /** Sends an ephemeral event to every socket of one user (their other devices). */
  sendToUser(userId: ID, event: EphemeralEvent): void {
    const frame = JSON.stringify({ type: "ephemeral", event } satisfies ServerToClient);
    const authorized = this.sessionCheck();
    for (const c of [...(this.byUser.get(userId) ?? [])])
      if (authorized(c)) this.sendRaw(c.ws, frame);
  }

  broadcastEphemeral(
    event: EphemeralEvent,
    audience: Set<ID> | null,
    authorized: (client: Client) => boolean = this.sessionCheck(),
  ): void {
    const frame = JSON.stringify({ type: "ephemeral", event } satisfies ServerToClient);
    for (const c of this.reach(audience)) if (authorized(c)) this.sendRaw(c.ws, frame);
  }

  private send(ws: WebSocket, msg: ServerToClient): void {
    this.sendRaw(ws, JSON.stringify(msg));
  }

  private sendRaw(ws: WebSocket, frame: string): void {
    // A slow reader must reconnect and replay instead of growing an unbounded
    // queue in the host's RAM.
    if (ws.bufferedAmount > 2 * 1024 * 1024) {
      ws.terminate();
      return;
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  }
}
