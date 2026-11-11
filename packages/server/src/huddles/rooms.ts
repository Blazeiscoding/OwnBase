import type { EphemeralEvent, HuddleRing, ID, ReadySnapshot } from "@ownbase/protocol";
import type { EventTo } from "../events/registry.js";
import type { Client, Gateway, HuddleFrame, Huddles, SessionCheck } from "../gateway.js";
import type { RateLimiter } from "../limits.js";
import type { Store } from "../store.js";
import { CallLog } from "./callLog.js";

type HuddleJoinResult = Extract<EphemeralEvent, { type: "huddle.join.result" }>;
type Frame<T extends HuddleFrame["type"]> = Extract<HuddleFrame, { type: T }>;

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

export interface HuddleRoomsOptions {
  /** Shared with the gateway and the HTTP side, so one caller has one allowance overall. */
  limiter: RateLimiter | null;
  /** Leaves the note of a ring nobody answered in its conversation (E10). */
  missedCall: (channelId: ID, callerId: ID) => void;
  graceMs?: number;
  ringMs?: number;
}

/**
 * Who is in which huddle on which device, the rings of direct messages'
 * huddles (E10), and the call log. Purely live state: a huddle exists only
 * while people are in it, so none of it is written to the event log or
 * survives a restart. The gateway hands it each signed-in socket's huddle
 * frames and tells it when a socket is gone.
 */
export class HuddleRooms implements Huddles {
  /** channelId -> who is in that channel's huddle, and on which device. */
  private rooms = new Map<ID, Map<ID, Seat>>();
  /** channelId -> the ring of a direct message's huddle just started. */
  private rings = new Map<ID, Ring>();
  /** What happened in huddles lately, for the host (see `CallLog`). */
  readonly calls = new CallLog();
  private graceMs: number;
  private ringMs: number;

  constructor(
    private gateway: Gateway,
    private store: Store,
    private options: HuddleRoomsOptions,
  ) {
    this.graceMs = options.graceMs ?? HUDDLE_GRACE_MS;
    this.ringMs = options.ringMs ?? HUDDLE_RING_MS;
  }

  handle(frame: HuddleFrame, client: Client): void {
    switch (frame.type) {
      case "huddle.join":
        return this.join(frame.channelId, client, frame.requestId);
      case "huddle.leave":
        return this.leaveFrom(frame.channelId, client);
      case "huddle.decline":
        if (this.afford(client.userId)) this.decline(frame.channelId, client.userId);
        return;
      case "huddle.signal":
        if (this.afford(client.userId)) this.relaySignal(frame, client);
        return;
      case "huddle.report":
        if (this.afford(client.userId)) this.report(frame, client);
        return;
    }
  }

  /** Silent when refused, as a dropped typing notice is. */
  private afford(userId: ID): boolean {
    return !this.options.limiter || this.options.limiter.take("ephemeral", userId).ok;
  }

  snapshot(userId: ID): Pick<ReadySnapshot, "huddles" | "huddleRings"> {
    const huddles: Record<ID, ID[]> = {};
    for (const [channelId, members] of this.rooms) {
      if (this.store.canAccess(channelId, userId)) huddles[channelId] = [...members.keys()];
    }
    const huddleRings = [...this.rings.values()]
      .filter((ring) => ring.state.callerId === userId || ring.rang.includes(userId))
      .map((ring) => ({ ...ring.state }));
    return { huddles, huddleRings };
  }

  /** Participants of one channel's huddle, for tests and diagnostics. */
  participants(channelId: ID): ID[] {
    return [...(this.rooms.get(channelId)?.keys() ?? [])];
  }

  /** A channel's ring as it stands, for tests and diagnostics. */
  ring(channelId: ID): HuddleRing | null {
    const ring = this.rings.get(channelId);
    return ring ? { ...ring.state } : null;
  }

  close(): void {
    for (const room of this.rooms.values())
      for (const seat of room.values()) if (seat.released) clearTimeout(seat.released);
    // Stopping misses nobody's call: the rings end with the huddles, unannounced.
    for (const ring of this.rings.values()) if (ring.timer) clearTimeout(ring.timer);
    this.rings.clear();
  }

  private join(channelId: ID, client: Client, requestId: string): void {
    const userId = client.userId;
    // One bounded reply only to this socket, like pong. Room fanout stays
    // admission-rationed.
    const reply = (event: HuddleJoinResult) => this.gateway.tellDevice(client, event);
    const refuse = (message: string, retryAfterMs?: number) =>
      reply({
        type: "huddle.join.result",
        channelId,
        requestId,
        accepted: false,
        message,
        retryAfterMs,
      });
    if (!this.store.canAccess(channelId, userId)) {
      this.calls.add({ channelId, userId, kind: "refused", reason: "no access" });
      refuse("You no longer have access to this conversation.");
      return;
    }
    let room = this.rooms.get(channelId);
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
        if (before) this.gateway.tellDevice(before, { type: "huddle.moved", channelId });
      }
      reply({ type: "huddle.join.result", channelId, requestId, accepted: true });
      return;
    }
    // Each admitted join can cause at most one later departure broadcast. Leave,
    // disconnect and access revocation must still release the seat when exhausted.
    const admission = this.options.limiter?.take("ephemeral", userId);
    if (admission && !admission.ok) {
      this.calls.add({ channelId, userId, kind: "refused", reason: "joining too often" });
      refuse(
        `Huddle joins are temporarily limited. Wait ${Math.max(1, Math.ceil(admission.retryAfterMs / 1000))} seconds, then try again.`,
        admission.retryAfterMs,
      );
      return;
    }
    const started = !room;
    if (!room) this.rooms.set(channelId, (room = new Map()));
    room.set(userId, { client, released: null });
    this.calls.add({ channelId, userId, kind: "joined" });
    if (started) this.gateway.contained("huddle ring", () => this.startRing(channelId, userId));
    this.publish(channelId);
    reply({ type: "huddle.join.result", channelId, requestId, accepted: true });
  }

  /**
   * Leaving, as a device asks to. Only the device in the call can, or any of
   * the person's while the place waits for its device: a device whose place
   * moved to another may still say it left, and the call goes on there.
   */
  private leaveFrom(channelId: ID, client: Client): void {
    const seat = this.rooms.get(channelId)?.get(client.userId);
    if (!seat || (seat.client && seat.client !== client)) return;
    this.leave(channelId, client.userId, "left");
  }

  leave(channelId: ID, userId: ID, reason: string): void {
    if (this.drop(channelId, userId, reason)) this.publish(channelId);
  }

  /**
   * A socket is gone. A place it held waits for its device to come back
   * (`holdSeat`), whatever other devices the person has online: the place
   * belongs to the device in the call. A socket `revoked` for a reason gives
   * its places up at once, since it is not coming back; those rooms are
   * returned, for the gateway to tell.
   */
  deviceGone(client: Client, revoked: string | null): ID[] {
    const left: ID[] = [];
    for (const [channelId, room] of this.rooms) {
      const seat = room.get(client.userId);
      if (!seat || seat.client !== client) continue;
      if (revoked === null) this.holdSeat(channelId, client.userId, seat);
      else if (this.drop(channelId, client.userId, revoked)) left.push(channelId);
    }
    return left;
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
      this.gateway.contained("huddle place", () => {
        // Still this place, and still waiting: nobody came back for it.
        if (this.rooms.get(channelId)?.get(userId) !== seat || seat.client) return;
        this.leave(channelId, userId, "disconnected");
      });
    }, this.graceMs);
    seat.released.unref?.();
  }

  /** Takes someone out of a room in memory only; whether they were in it. */
  private drop(channelId: ID, userId: ID, reason: string): boolean {
    const room = this.rooms.get(channelId);
    const seat = room?.get(userId);
    if (!room || !seat) return false;
    if (seat.released) clearTimeout(seat.released);
    room.delete(userId);
    this.calls.add({ channelId, userId, kind: "left", reason });
    if (room.size === 0) this.rooms.delete(channelId);
    return true;
  }

  publish(channelId: ID, authorized?: SessionCheck): void {
    this.gateway.tellChannel(
      channelId,
      { type: "huddle.participants", channelId, userIds: this.participants(channelId) },
      authorized,
    );
    this.gateway.contained("huddle ring", () => this.settleRing(channelId));
  }

  private relaySignal(frame: Frame<"huddle.signal">, client: Client): void {
    const { channelId, to, signal } = frame;
    const userId = client.userId;
    // Only relay between the two devices in the same huddle: not to the
    // person's other devices, and not while theirs is reconnecting.
    const room = this.rooms.get(channelId);
    const target = room?.get(to);
    const refused =
      room?.get(userId)?.client !== client
        ? "the sender is not in the huddle on this device"
        : !target
          ? "the other person is not in the huddle"
          : !target.client
            ? "the other person's connection is down"
            : !this.store.canAccess(channelId, userId) || !this.store.canAccess(channelId, to)
              ? "no access to the conversation"
              : null;
    // Routes and media notices come by the dozen; the setup is what tells.
    if (refused)
      this.calls.add({
        channelId,
        userId,
        peerId: to,
        kind: "dropped",
        reason: `${signal.kind}: ${refused}`,
      });
    else if (signal.kind === "offer" || signal.kind === "answer")
      this.calls.add({ channelId, userId, peerId: to, kind: signal.kind });
    if (!refused && target?.client && this.gateway.authorized(target.client)) {
      this.gateway.tellDevice(target.client, {
        type: "huddle.signal",
        channelId,
        from: userId,
        signal,
      });
    }
  }

  private report(frame: Frame<"huddle.report">, client: Client): void {
    // A report can come just after either side left, so only the
    // conversation's access is asked, not the room's.
    if (this.store.canAccess(frame.channelId, client.userId))
      this.calls.add({
        channelId: frame.channelId,
        userId: client.userId,
        peerId: frame.peer,
        kind: "report",
        report: frame.report,
      });
  }

  // ---------- rings (E10) ----------

  /**
   * Rings everyone else in a direct message whose huddle this person has
   * just started: not bots, who cannot answer, nor deactivated accounts.
   * Joining a huddle already going rings nobody, and a channel never rings.
   */
  private startRing(channelId: ID, callerId: ID): void {
    const channel = this.store.channels.get(channelId);
    if (!channel || (channel.type !== "dm" && channel.type !== "group_dm")) return;
    const rang = this.store.channels.memberIds(channelId).filter((id) => {
      if (id === callerId) return false;
      const user = this.store.people.get(id);
      return !!user && !user.isBot && !user.deactivated;
    });
    if (rang.length === 0) return;
    const before = this.rings.get(channelId);
    if (before) this.endRing(channelId, before);
    const startedAt = Date.now();
    const ring: Ring = {
      state: {
        channelId,
        callerId,
        startedAt,
        endsAt: startedAt + this.ringMs,
        ringing: rang,
        answered: [],
        declined: [],
      },
      rang,
      timer: null,
    };
    ring.timer = setTimeout(() => {
      ring.timer = null;
      this.gateway.contained("huddle ring", () => this.endRing(channelId, ring));
    }, this.ringMs);
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
    const room = this.rooms.get(channelId);
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

  private decline(channelId: ID, userId: ID): void {
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
      this.gateway.contained("missed call", () =>
        this.options.missedCall(channelId, ring.state.callerId),
      );
  }

  private tellRing(ring: Ring): void {
    const event: EventTo<"person"> = { type: "huddle.ring", ring: { ...ring.state } };
    for (const userId of [ring.state.callerId, ...ring.rang])
      this.gateway.contained("huddle ring", () => this.gateway.tellPerson(userId, event));
  }
}
