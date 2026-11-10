import type { ID } from "@ownbase/protocol";
import type { EventTo } from "./registry.js";
import { contain } from "../core/contain.js";

type PersonEvent = EventTo<"person">;
type AdminEvent = EventTo<"admins">;

/** Where committed notices go: the gateway. */
export interface OutboxSink {
  isOnline(userId: ID): boolean;
  anyoneOnline(): boolean;
  tellPerson(userId: ID, event: PersonEvent): void;
  tellAdmins(event: AdminEvent): void;
  /** Tells someone their access to a conversation as it now is, ending what it no longer allows. */
  updateChannelAccess(channelId: ID, userId: ID): void;
}

/** What the outbox reads when it sends, from the committed rows. */
interface OutboxReads {
  memberIds(channelId: ID): ID[];
  unreadMentionCounts(userId: ID): Record<ID, number>;
}

type Notice =
  | {
      kind: "person";
      userId: ID;
      key: string | null;
      ahead: boolean;
      event: PersonEvent | (() => PersonEvent | null);
    }
  | { kind: "admins"; key: string; read: () => AdminEvent }
  | { kind: "access"; channelId: ID; userId: ID }
  | { kind: "mentions"; userIds: ID[] }
  | { kind: "mentionsIn"; channelId: ID };

/** Channel audiences one committed change has read already (F10); see `Gateway.publish`. */
export type Audiences = Map<ID, Set<ID> | null>;

/**
 * What a write has to tell people, kept until the write is committed: each
 * account's own devices of what changed for it, the admins of what waits for
 * them, and whoever's access changed. A write calls this as it changes the
 * rows; a rolled-back transaction takes its notices with it.
 *
 * A notice given as a function is read when it is sent, so it says how things
 * ended however many writes in one change touched them, and is read only for
 * someone connected: anyone else reads it all from their next handshake
 * (REV-06). Mention counts are recounted once per person per change, last.
 *
 * Notices `ahead` of a change go before its durable events, the rest after.
 */
export class Outbox {
  private pending: Notice[] = [];
  private depth = 0;
  private held = 0;
  private sink: OutboxSink | null = null;
  private failed: (err: unknown, what: string) => void = () => {};

  constructor(private reads: OutboxReads) {}

  connect(sink: OutboxSink, failed: (err: unknown, what: string) => void): void {
    this.sink = sink;
    this.failed = failed;
  }

  /** Tells one account's devices. A `key` sends it once per change. */
  person(
    userId: ID,
    event: PersonEvent | (() => PersonEvent | null),
    options: { key?: string; ahead?: boolean } = {},
  ): void {
    const key = options.key ?? null;
    if (
      key !== null &&
      this.pending.some((n) => n.kind === "person" && n.userId === userId && n.key === key)
    )
      return;
    this.add({ kind: "person", userId, key, ahead: options.ahead ?? false, event });
  }

  admins(key: string, read: () => AdminEvent): void {
    if (this.pending.some((n) => n.kind === "admins" && n.key === key)) return;
    this.add({ kind: "admins", key, read });
  }

  /** Someone's access to a conversation changed; told ahead of the change's events. */
  access(channelId: ID, userId: ID): void {
    this.add({ kind: "access", channelId, userId });
  }

  /** These people's unread mention counts may have changed. */
  mentions(userIds: Iterable<ID>): void {
    const ids = [...userIds];
    if (ids.length > 0) this.add({ kind: "mentions", userIds: ids });
  }

  /** The mention counts of everyone in a conversation may have changed. */
  mentionsIn(channelId: ID): void {
    if (!this.pending.some((n) => n.kind === "mentionsIn" && n.channelId === channelId))
      this.add({ kind: "mentionsIn", channelId });
  }

  begin(): number {
    this.depth++;
    return this.pending.length;
  }

  commit(): void {
    this.depth--;
    if (this.depth === 0 && this.held === 0) this.flush();
  }

  rollback(mark: number): void {
    this.depth--;
    this.pending.length = Math.min(mark, this.pending.length);
  }

  /**
   * Keeps every notice until `work` is done, so a change's durable events can
   * go out between those ahead of them (`flushAhead`) and the rest.
   */
  hold<T>(work: () => T, audiences?: Audiences): T {
    this.held++;
    try {
      return work();
    } finally {
      this.held--;
      if (this.held === 0 && this.depth === 0) this.flush(audiences);
    }
  }

  /** Sends the notices that go ahead of a change's events. */
  flushAhead(): void {
    const ahead = this.pending.filter(isAhead);
    if (ahead.length === 0) return;
    this.pending = this.pending.filter((n) => !isAhead(n));
    this.send(ahead);
  }

  private add(notice: Notice): void {
    this.pending.push(notice);
    if (this.depth === 0 && this.held === 0) this.flush();
  }

  private flush(audiences?: Audiences): void {
    const notices = this.pending;
    this.pending = [];
    this.send([...notices.filter(isAhead), ...notices.filter((n) => !isAhead(n))], audiences);
  }

  private send(notices: Notice[], audiences?: Audiences): void {
    const sink = this.sink;
    if (!sink || notices.length === 0) return;
    const recount = new Set<ID>();
    const rooms: ID[] = [];
    for (const notice of notices) {
      this.contained(notice.kind, () => {
        switch (notice.kind) {
          case "access":
            // Even offline: a huddle place kept for a dropped device is given up.
            return sink.updateChannelAccess(notice.channelId, notice.userId);
          case "person": {
            if (!sink.isOnline(notice.userId)) return;
            const event = typeof notice.event === "function" ? notice.event() : notice.event;
            if (event) sink.tellPerson(notice.userId, event);
            return;
          }
          case "admins":
            if (sink.anyoneOnline()) sink.tellAdmins(notice.read());
            return;
          case "mentions":
            for (const id of notice.userIds) recount.add(id);
            return;
          case "mentionsIn":
            rooms.push(notice.channelId);
            return;
        }
      });
    }
    // With nobody connected there is nobody to recount, nor members to read.
    if (rooms.length > 0 && sink.anyoneOnline())
      for (const channelId of rooms)
        this.contained("mentions", () => {
          // A private conversation's audience is its members, read already
          // to send the change's events (F10).
          for (const id of audiences?.get(channelId) ?? this.reads.memberIds(channelId))
            recount.add(id);
        });
    for (const userId of recount) {
      if (!sink.isOnline(userId)) continue;
      this.contained("mentions", () =>
        sink.tellPerson(userId, {
          type: "mentions",
          counts: this.reads.unreadMentionCounts(userId),
        }),
      );
    }
  }

  /** Each notice fails alone: the change it follows has happened. */
  private contained(what: string, work: () => void): void {
    contain(work, (err) => this.failed(err, what));
  }
}

function isAhead(notice: Notice): boolean {
  return notice.kind === "access" || (notice.kind === "person" && notice.ahead);
}
