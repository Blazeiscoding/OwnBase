import {
  PROTOCOL_VERSION,
  SOCKET_CLOSE,
  clientMessage,
  isAdministrator,
  type ClientToServer,
  type EventEnvelope,
  type ID,
  type Presence,
  type ReadySnapshot,
  type ServerToClient,
  type SocketRefusal,
  type User,
} from "@ownbase/protocol";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { hashToken } from "./auth.js";
import { contain } from "./core/contain.js";
import type { Audiences, OutboxSink } from "./events/outbox.js";
import { eventChannel, type EventTo } from "./events/registry.js";
import { PASSWORD_CHANGE_REQUIRED } from "./httpError.js";
import type { RateLimiter } from "./limits.js";
import type { Store } from "./store.js";

export type SessionCheck = (client: Client) => boolean;

/** One signed-in socket: a device. */
export interface Client {
  ws: WebSocket;
  userId: ID;
  tokenHash: string;
  alive: boolean;
  /** Its device has gone idle, as it says (E9); every one idle makes the account away. */
  idle?: boolean;
}

/** The startup snapshot without what the gateway itself knows: the features' slices. */
export type FeatureSnapshot = Omit<
  ReadySnapshot,
  "type" | "seq" | "replayFrom" | "self" | "presence" | "huddles" | "huddleRings" | "serverTime"
>;

export type HuddleFrame = Extract<ClientToServer, { type: `huddle.${string}` }>;

const isHuddleFrame = (msg: ClientToServer): msg is HuddleFrame => msg.type.startsWith("huddle.");

/**
 * What the gateway needs of the live huddles (huddles/rooms.ts): it hands
 * them a signed-in socket's huddle frames and tells them when a socket is
 * gone, and they give the handshake who is in which huddle.
 */
export interface Huddles {
  handle(frame: HuddleFrame, client: Client): void;
  snapshot(userId: ID): Pick<ReadySnapshot, "huddles" | "huddleRings">;
  /** Holds or gives up the places `client` had; the rooms it left now. */
  deviceGone(client: Client, revoked: string | null): ID[];
  /** Tells a room's audience who is in it now. */
  publish(channelId: ID, authorized?: SessionCheck): void;
  leave(channelId: ID, userId: ID, reason: string): void;
  close(): void;
}

/**
 * Holds every live socket and fans events out to each one's audience, as the
 * event registry declares it (`events/registry.ts`): a conversation's events
 * to whoever can read it, which for a public channel is everyone signed in
 * and otherwise its current members; workspace events to everyone.
 */
export class Gateway implements OutboxSink {
  private clients = new Set<Client>();
  private byUser = new Map<ID, Set<Client>>();
  private heartbeat: NodeJS.Timeout;
  private sockets = new Set<WebSocket>();
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private featureSnapshot: (user: User) => FeatureSnapshot = () => {
    throw new Error("the gateway was attached before the features gave their snapshot");
  };
  private liveHuddles: Huddles | null = null;

  constructor(
    private store: Store,
    /** Shared with the HTTP side, so one caller has one allowance overall. */
    private limiter: RateLimiter | null,
    private clientAddress: (request: IncomingMessage) => string,
    /**
     * Told of a failure in a socket callback, which Fastify's error handler
     * never sees: an exception there would otherwise end the process (F03).
     */
    private reportFailure: (err: unknown, where: string) => void,
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
  contained(where: string, work: () => void): boolean {
    return contain(work, (err) => this.reportFailure(err, where));
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

  useSnapshot(snapshot: (user: User) => FeatureSnapshot): void {
    this.featureSnapshot = snapshot;
  }

  /** The huddles this gateway's sockets are in, given once, before `attach`. */
  useHuddles(huddles: Huddles): void {
    this.liveHuddles = huddles;
  }

  private get huddles(): Huddles {
    if (this.liveHuddles) return this.liveHuddles;
    throw new Error("the gateway was used before the huddles were given to it");
  }

  attach(server: HttpServer, path = "/ws"): void {
    if (!this.liveHuddles) throw new Error("the gateway was attached before the huddles were");
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
    this.liveHuddles?.close();
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
    if (this.store.people.isAway(userId)) return "away";
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
      this.tellEveryone({ type: "presence", userId, presence: now }),
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
        const parsed = clientMessage.safeParse(JSON.parse(String(data)));
        if (!parsed.success) {
          ws.close(SOCKET_CLOSE.invalidMessage, "invalid message");
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
            protocolVersion: PROTOCOL_VERSION,
          });
          ws.close(SOCKET_CLOSE.protocol_mismatch);
          return;
        }
        const tokenHash = hashToken(msg.token);
        const user = this.store.accounts.getSessionUser(tokenHash);
        if (!user) {
          this.refuse(ws, "auth_failed", "invalid token");
          return;
        }
        if (this.store.accounts.mustChangePassword(user.id)) {
          this.refuse(ws, "password_change_required", PASSWORD_CHANGE_REQUIRED);
          return;
        }
        // Everything the handshake reads is read before this socket joins
        // fan-out, so a read that fails announces nobody online (F03).
        const snapshot: ReadySnapshot = {
          type: "ready",
          seq: this.store.currentSeq(),
          replayFrom: null,
          self: user,
          presence: {},
          ...this.huddles.snapshot(user.id),
          serverTime: Date.now(),
          ...this.featureSnapshot(user),
        };
        const missed =
          msg.lastSeq !== null && msg.lastSeq <= snapshot.seq
            ? this.store.eventsSince(msg.lastSeq, user.id)
            : null;
        client = { ws, userId: user.id, tokenHash, alive: true };
        this.register(client);
        snapshot.presence = this.presenceMap();
        snapshot.replayFrom = missed === null ? null : msg.lastSeq;
        this.send(ws, snapshot);
        for (const envelope of missed ?? []) this.send(ws, { type: "event", envelope });
        this.send(ws, { type: "synced", seq: snapshot.seq });
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
          this.tellChannel(msg.channelId, {
            type: "typing",
            channelId: msg.channelId,
            userId: client.userId,
          });
        }
      } else if (msg.type === "idle") {
        if (!this.affordEphemeral(client.userId)) return;
        client.idle = msg.idle;
        this.refreshPresence(client.userId);
      } else if (isHuddleFrame(msg)) {
        this.huddles.handle(msg, client);
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
   * A socket `revoked` for a reason is not coming back for its huddle places.
   */
  private unregister(client: Client, later = false, revoked: string | null = null): void {
    if (!this.clients.delete(client)) return;
    const left = this.huddles.deviceGone(client, revoked);
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
      this.contained("huddle departure", () => this.huddles.publish(channelId));
    }
    if (!offline) return;
    this.contained("presence", () =>
      this.tellEveryone({ type: "presence", userId: client.userId, presence: "offline" }),
    );
    this.presenceChanged();
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
    const told = this.contained("channel access", () => {
      const membership =
        this.store.channels.memberships(userId).find((m) => m.channelId === channelId) ?? null;
      const channel = this.store.canAccess(channelId, userId)
        ? this.store.channels.get(channelId)
        : null;
      if (!channel) this.huddles.leave(channelId, userId, "lost access");
      this.tellPerson(userId, { type: "channel.access", channelId, channel, membership });
    });
    if (!told) this.resynchronizeUser(userId);
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
      this.contained("huddle departure", () => this.huddles.publish(channelId, authorized));
    for (const userId of users) {
      // Back already, on a socket that told everyone so.
      if (this.byUser.has(userId)) continue;
      this.contained("presence", () =>
        this.tellEveryone({ type: "presence", userId, presence: "offline" }, authorized),
      );
    }
  }

  /**
   * Who can read a conversation, as `canAccess` says, read once per committed
   * change when `audiences` carries it (F10); null for everyone signed in. A
   * guest is never a member of a conversation that is not public: every way
   * in refuses one.
   */
  private channelAudience(channelId: ID, audiences?: Audiences): Set<ID> | null {
    if (audiences?.has(channelId)) return audiences.get(channelId)!;
    const ch = this.store.channels.get(channelId);
    const audience = !ch
      ? new Set<ID>()
      : ch.type === "public"
        ? null
        : new Set(this.store.channels.memberIds(channelId));
    audiences?.set(channelId, audience);
    return audience;
  }

  /**
   * Fans a durable event out to every connected client allowed to see it.
   * `audiences` carries each channel's audience across the events of one
   * committed change; the caller drops it when that change is out, so it
   * never outlives the committed rows it was read from.
   */
  publish(envelope: EventEnvelope, audiences?: Audiences): void {
    // With nobody signed in there is nobody to read an audience for.
    if (this.clients.size === 0) return;
    const channelId = eventChannel(envelope.event);
    const audience = channelId === null ? null : this.channelAudience(channelId, audiences);
    this.fanOut({ type: "event", envelope }, audience);
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
        let read: boolean | "unreadable" = "unreadable";
        this.contained("session check", () => {
          read = this.store.accounts.isSessionActive(client.tokenHash, client.userId);
        });
        active = read;
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
    client.ws.close(SOCKET_CLOSE.auth_failed, reason);
  }

  private refuse(ws: WebSocket, code: SocketRefusal, message: string): void {
    this.send(ws, { type: "error", code, message });
    ws.close(SOCKET_CLOSE[code]);
  }

  authorized(client: Client): boolean {
    return this.sessionCheck()(client);
  }

  anyoneOnline(): boolean {
    return this.byUser.size > 0;
  }

  tellPerson(userId: ID, event: EventTo<"person">): void {
    this.fanOut({ type: "ephemeral", event }, new Set([userId]));
  }

  tellChannel(channelId: ID, event: EventTo<"channel">, authorized?: SessionCheck): void {
    this.fanOut({ type: "ephemeral", event }, this.channelAudience(channelId), authorized);
  }

  tellEveryone(event: EventTo<"everyone">, authorized?: SessionCheck): void {
    this.fanOut({ type: "ephemeral", event }, null, authorized);
  }

  tellAdmins(event: EventTo<"admins">): void {
    const admins = new Set<ID>();
    for (const userId of this.byUser.keys()) {
      const user = this.store.people.get(userId);
      if (user && isAdministrator(user.role) && !user.deactivated) admins.add(userId);
    }
    if (admins.size > 0) this.fanOut({ type: "ephemeral", event }, admins);
  }

  tellDevice(client: Client, event: EventTo<"device">): void {
    this.send(client.ws, { type: "ephemeral", event });
  }

  private fanOut(
    msg: ServerToClient,
    audience: Set<ID> | null,
    authorized: SessionCheck = this.sessionCheck(),
  ): void {
    const frame = JSON.stringify(msg);
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
