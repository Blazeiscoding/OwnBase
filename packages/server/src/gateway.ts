import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  type AccessPolicy,
  type ClientToServer,
  type EphemeralEvent,
  type EventEnvelope,
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
   * channelId -> user ids currently in that channel's huddle. Purely live
   * state: a huddle exists only while people are in it, so it is never
   * written to the event log and does not survive a restart.
   */
  private huddles = new Map<ID, Set<ID>>();
  /** What happened in huddles lately, for the host (see `CallLog`). */
  readonly calls = new CallLog();
  private heartbeat: NodeJS.Timeout;
  private sockets = new Set<WebSocket>();
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private store: Store,
    /** The workspace's name and who may join it, as they are now. */
    private workspace: { name: () => string; accessPolicy: () => AccessPolicy },
    /** Shared with the HTTP side, so one caller has one allowance overall. */
    private limiter: RateLimiter | null = null,
    private clientAddress: (request: IncomingMessage) => string = (request) =>
      resolveClientAddress(request.socket.remoteAddress, request.headers),
    /**
     * Told of a failure in a socket callback, which Fastify's error handler
     * never sees: an exception there would otherwise end the process (F03).
     */
    private reportFailure: (err: unknown, where: string) => void = () => {},
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
    for (const id of this.byUser.keys()) out[id] = "online";
    return out;
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
          inlineReplies: true,
          scheduledEvents: true,
          activityThreads: true,
          stars: true,
          workspaceSettings: true,
          accessPolicy: this.workspace.accessPolicy(),
          workspaceName: this.workspace.name(),
          workspaceId: this.store.getMeta("workspace_id") ?? undefined,
          friends: this.store.listFriends(user.id),
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
        this.leaveHuddle(msg.channelId, client.userId, "left");
      } else if (msg.type === "huddle.signal") {
        if (!this.affordEphemeral(client.userId)) return;
        // Only relay between two people actually in the same huddle.
        const room = this.huddles.get(msg.channelId);
        const refused = !room?.has(client.userId)
          ? "the sender is not in the huddle"
          : !room.has(msg.to)
            ? "the other person is not in the huddle"
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
        if (!refused) {
          this.sendToUser(msg.to, {
            type: "huddle.signal",
            channelId: msg.channelId,
            from: client.userId,
            signal: msg.signal,
          });
        }
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
      this.broadcastEphemeral(
        { type: "presence", userId: client.userId, presence: "online" },
        null,
      );
      this.presenceChanged();
    }
  }

  /**
   * Forgets a socket. Every in-memory change comes first and cannot fail, so a
   * read that throws while telling others still leaves this person out of
   * fan-out, presence and every huddle (F03); each notice then fails alone.
   */
  private unregister(client: Client, later = false): void {
    if (!this.clients.delete(client)) return;
    const set = this.byUser.get(client.userId);
    if (!set) return;
    set.delete(client);
    if (set.size > 0) return;
    this.byUser.delete(client.userId);
    // Dropping offline must also drop them from any huddle, or the room
    // keeps a ghost participant nobody can call.
    const left = [...this.huddles.keys()].filter((channelId) =>
      this.dropFromHuddle(channelId, client.userId, "disconnected"),
    );
    if (later) {
      for (const channelId of left) this.departures.huddles.add(channelId);
      this.departures.users.add(client.userId);
      this.presenceChanged();
      if (!this.departures.scheduled) {
        this.departures.scheduled = true;
        setImmediate(() => this.contained("departures", () => this.announceDepartures()));
      }
      return;
    }
    for (const channelId of left) {
      this.contained("huddle departure", () => this.publishHuddle(channelId));
    }
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
      if (this.store.canAccess(channelId, userId)) out[channelId] = [...members];
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
    if (room?.has(userId)) {
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
    if (!room) this.huddles.set(channelId, (room = new Set()));
    room.add(userId);
    this.calls.add({ channelId, userId, kind: "joined" });
    this.publishHuddle(channelId);
    if (requestId) reply({ type: "huddle.join.result", channelId, requestId, accepted: true });
  }

  private leaveHuddle(channelId: ID, userId: ID, reason: string): void {
    if (this.dropFromHuddle(channelId, userId, reason)) this.publishHuddle(channelId);
  }

  /** Takes someone out of a room in memory only; whether they were in it. */
  private dropFromHuddle(channelId: ID, userId: ID, reason: string): boolean {
    const room = this.huddles.get(channelId);
    if (!room?.delete(userId)) return false;
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

  /** Tells the channel who is in its huddle now. */
  private publishHuddle(channelId: ID, authorized?: (client: Client) => boolean): void {
    this.broadcastEphemeral(
      { type: "huddle.participants", channelId, userIds: [...(this.huddles.get(channelId) ?? [])] },
      this.audienceForChannel(channelId),
      authorized,
    );
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
    return [...(this.huddles.get(channelId) ?? [])];
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
    this.unregister(client);
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
