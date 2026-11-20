import type { ID } from "@ownbase/protocol";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { contain } from "../core/contain.js";
import { OUTBOUND_MAX_BYTES, OUTBOUND_TIMEOUT_MS, OutboundError } from "../outbound.js";
import type { Store } from "../store.js";
import { SocketTickets } from "./socketTickets.js";

/** Sockets one app may hold open at once, as on Slack. */
export const SOCKETS_PER_APP = 10;

/**
 * How often each socket is pinged. Slack's Socket Mode client reconnects when
 * the server has not pinged it for 30 seconds, so this stays well under that.
 */
const PING_MS = 10_000;

/**
 * What may wait unsent on one socket. A socket this far behind is not reading;
 * it is closed rather than queued for, and what was on it counts as unanswered.
 */
const SEND_BUFFER_MAX = 1024 * 1024;

/** What is sent over a socket: Slack's three kinds of envelope. */
export type EnvelopeType = "events_api" | "slash_commands" | "interactive";

/** Why the server closes an app's sockets, in Slack's words, which Bolt acts on. */
export type DisconnectReason = "link_disabled" | "refresh_requested";

interface Waiting {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface AppSocket {
  ws: WebSocket;
  appId: ID;
  /** The app-level token it was opened with: replacing or revoking that token closes it. */
  tokenHash: string;
  alive: boolean;
  /** Envelopes sent on it and not yet acknowledged, by envelope id. */
  waiting: Map<string, Waiting>;
}

const notConnected = () =>
  new OutboundError("unreachable", "the app is not connected to the server");

/**
 * Slack's Socket Mode: the sockets apps open to `/apps/socket` with a ticket
 * from apps.connections.open, and the envelopes sent over them. An envelope
 * goes to one of the app's sockets and is done when the app acknowledges it,
 * or has failed after as long as an answer from the app's URL is waited for.
 * Nothing waits in memory for a socket: an app with none connected fails the
 * send, and the caller treats that as it treats a URL that does not answer.
 */
export class AppSockets {
  readonly tickets = new SocketTickets();
  private readonly byApp = new Map<ID, AppSocket[]>();
  /** Which of an app's sockets is sent the next envelope, so they share the work. */
  private readonly turn = new Map<ID, number>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    // An app's acknowledgement carries what its HTTP answer would, which is
    // read up to the same size.
    maxPayload: OUTBOUND_MAX_BYTES,
    perMessageDeflate: false,
  });
  private readonly heartbeat: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly store: Store,
    /** Told of a failure in a socket callback, which nothing else would see. */
    private readonly reportFailure: (err: unknown, where: string) => void,
  ) {
    this.heartbeat = setInterval(() => this.contained("heartbeat", () => this.beat()), PING_MS);
    this.heartbeat.unref();
  }

  private contained(where: string, work: () => void): boolean {
    return contain(work, (err) => this.reportFailure(err, where));
  }

  /** Sockets open now for one app. */
  count(appId: ID): number {
    return this.byApp.get(appId)?.length ?? 0;
  }

  /** Sockets open now, every app's. */
  total(): number {
    let sum = 0;
    for (const sockets of this.byApp.values()) sum += sockets.length;
    return sum;
  }

  /**
   * Takes over an upgrade to `/apps/socket`, from the one upgrade listener
   * the members' gateway holds. Refused with a plain HTTP status, before any
   * socket exists, when its ticket is missing, spent, stale or no longer its
   * app's, or when the app already holds as many sockets as it may.
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
    const holder = this.closed ? null : this.tickets.spend(url.searchParams.get("ticket") ?? "");
    if (!holder || !this.holds(holder.appId, holder.tokenHash)) {
      refuse(socket, 401, "Unauthorized");
      return;
    }
    if (this.count(holder.appId) >= SOCKETS_PER_APP) {
      refuse(socket, 429, "Too Many Requests");
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.contained("app socket", () => this.connected(ws, holder.appId, holder.tokenHash));
    });
  }

  /** Whether a socket opened with this token may still be open: its app, token and mode stand. */
  private holds(appId: ID, tokenHash: string): boolean {
    const app = this.store.apps.forAppLevelToken(tokenHash);
    return !!app && app.id === appId && app.receive === "socket";
  }

  private connected(ws: WebSocket, appId: ID, tokenHash: string): void {
    const sockets = this.byApp.get(appId) ?? [];
    // Two upgrades can pass the count before either has connected.
    if (sockets.length >= SOCKETS_PER_APP || this.closed) {
      ws.close(1008, "too many connections");
      return;
    }
    const entry: AppSocket = { ws, appId, tokenHash, alive: true, waiting: new Map() };
    sockets.push(entry);
    this.byApp.set(appId, sockets);
    ws.on("pong", () => (entry.alive = true));
    ws.on("message", (data, isBinary) =>
      this.contained("app socket message", () => {
        entry.alive = true;
        if (!isBinary) this.received(entry, String(data));
      }),
    );
    ws.on("close", () => this.contained("app socket close", () => this.gone(entry)));
    // ws closes the socket after an error itself, with the reason's code
    // (1009 for a message too large), which ending it here would cut short.
    ws.on("error", () => {});
    this.sendTo(entry, {
      type: "hello",
      num_connections: sockets.length,
      debug_info: { host: "ownbase", approximate_connection_time: 3600 },
      connection_info: { app_id: appId },
    });
  }

  /** An acknowledgement: `{ envelope_id, payload? }`. Anything else from the app is ignored. */
  private received(entry: AppSocket, text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const { envelope_id: id, payload } = message as { envelope_id?: unknown; payload?: unknown };
    if (typeof id !== "string") return;
    const waiting = entry.waiting.get(id);
    if (!waiting) return;
    entry.waiting.delete(id);
    clearTimeout(waiting.timer);
    waiting.resolve(payload);
  }

  private gone(entry: AppSocket): void {
    const sockets = this.byApp.get(entry.appId);
    if (sockets) {
      const left = sockets.filter((s) => s !== entry);
      if (left.length > 0) this.byApp.set(entry.appId, left);
      else this.byApp.delete(entry.appId);
    }
    this.failWaiting(
      entry,
      this.closed
        ? new OutboundError("aborted", "the server is stopping")
        : new OutboundError("unreachable", "the app's connection closed before it answered"),
    );
  }

  private failWaiting(entry: AppSocket, err: Error): void {
    const waiting = [...entry.waiting.values()];
    entry.waiting.clear();
    for (const w of waiting) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  /** Sends a frame, or closes a socket too far behind to take it. False when it was not sent. */
  private sendTo(entry: AppSocket, frame: object): boolean {
    if (entry.ws.readyState !== WebSocket.OPEN) return false;
    if (entry.ws.bufferedAmount > SEND_BUFFER_MAX) {
      entry.ws.terminate();
      return false;
    }
    entry.ws.send(JSON.stringify(frame));
    return true;
  }

  /**
   * Sends an envelope to one of the app's sockets, and resolves with the
   * `payload` of its acknowledgement (undefined for none). Rejects as a call
   * to an app's URL would: not connected, closed before answering, or no
   * answer in the time a URL is given.
   */
  send(
    appId: ID,
    type: EnvelopeType,
    payload: unknown,
    extra: { retryAttempt?: number; retryReason?: string } = {},
  ): Promise<unknown> {
    const sockets = (this.byApp.get(appId) ?? []).filter((s) => s.ws.readyState === WebSocket.OPEN);
    if (sockets.length === 0 || this.closed) return Promise.reject(notConnected());
    const turn = (this.turn.get(appId) ?? 0) % sockets.length;
    this.turn.set(appId, turn + 1);
    const entry = sockets[turn]!;
    const envelopeId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.waiting.delete(envelopeId);
        reject(new OutboundError("timeout", "the app did not answer in time"));
      }, OUTBOUND_TIMEOUT_MS);
      entry.waiting.set(envelopeId, { resolve, reject, timer });
      const sent = this.sendTo(entry, {
        envelope_id: envelopeId,
        type,
        payload,
        accepts_response_payload: type !== "events_api",
        ...(type === "events_api"
          ? { retry_attempt: extra.retryAttempt ?? 0, retry_reason: extra.retryReason ?? "" }
          : {}),
      });
      if (!sent) {
        entry.waiting.delete(envelopeId);
        clearTimeout(timer);
        reject(notConnected());
      }
    });
  }

  /**
   * Closes an app's sockets, telling it why first. `link_disabled` is for a
   * token replaced or revoked, Socket Mode turned off and an app deleted;
   * Slack's client stops reconnecting on it.
   */
  close(appId: ID, reason: DisconnectReason): void {
    this.tickets.forget(appId);
    for (const entry of [...(this.byApp.get(appId) ?? [])]) this.disconnect(entry, reason);
  }

  private disconnect(entry: AppSocket, reason: DisconnectReason): void {
    this.sendTo(entry, { type: "disconnect", reason });
    entry.ws.close(1000, reason);
  }

  /** Pings every socket, and ends any that did not answer the last ping or whose token has gone. */
  private beat(): void {
    for (const sockets of [...this.byApp.values()]) {
      for (const entry of [...sockets]) {
        if (!this.holds(entry.appId, entry.tokenHash)) {
          this.disconnect(entry, "link_disabled");
          continue;
        }
        if (!entry.alive) {
          entry.ws.terminate();
          continue;
        }
        entry.alive = false;
        entry.ws.ping();
      }
    }
  }

  /** The server is stopping: apps are told to come back later, and nothing more is let in. */
  stop(): void {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const sockets of [...this.byApp.values()]) {
      for (const entry of [...sockets]) {
        this.sendTo(entry, { type: "disconnect", reason: "refresh_requested" });
        entry.ws.terminate();
      }
    }
    this.wss.close();
  }
}

/** Ends an upgrade with a plain HTTP refusal. */
function refuse(socket: Duplex, status: number, words: string): void {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${words}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.destroy();
}
