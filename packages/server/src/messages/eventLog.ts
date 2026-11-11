import type { ID, ReplyReference, WorkspaceEvent } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { shape } from "../core/rows.js";
import { DURABLE_EVENTS, type DurableType } from "../events/registry.js";

/**
 * The copies of a message's words that outlive an edit or a deletion: the
 * event log's, and those in app events still waiting to be delivered. An
 * edit is often someone taking back what they wrote, so both are rewritten.
 *
 * The events themselves stay. A client catching up replays them in order,
 * and a missing sequence number is indistinguishable from a log it has fallen
 * off the end of, which would send it back for a whole new snapshot. What it
 * replays instead is a message with no words in it, followed by the edit or
 * deletion that supersedes it, so it arrives at the same state anyway. An app
 * still waiting for its events is sent the same. What has already been
 * delivered is the app's, and cannot be called back.
 */

const loggedRow = shape({ seq: "number", payload: "text" });
const queuedRow = shape({ id: "text", body: "text" });

type Logged = { seq: number; payload: string };
type Queued = { id: string; body: string };

/** The callback body an app event is queued with; see apps/delivery.ts. */
interface QueuedBody {
  event: Record<string, unknown>;
  ownbase: { type: DurableType };
}

function redactLogged(db: DatabaseSync, rows: Logged[]): void {
  const update = db.prepare("UPDATE events SET payload = ? WHERE seq = ?");
  for (const row of rows) {
    const event = JSON.parse(row.payload) as WorkspaceEvent;
    if (event.type !== "message.created" && event.type !== "message.updated") continue;
    event.message.text = "";
    // A filename is often as telling as the message it was attached to.
    event.message.files = [];
    // Labels, values and URLs can be as revealing as the message's words.
    event.message.actions = [];
    // A preview names the link and says what is there.
    if (event.message.previews) event.message.previews = [];
    delete event.message.poll;
    const after = JSON.stringify(event);
    if (after !== row.payload) update.run(after, row.seq);
  }
}

/** As each event's `app.redact` says. */
function redactQueued(db: DatabaseSync, rows: Queued[]): void {
  const update = db.prepare("UPDATE event_deliveries SET body = ? WHERE id = ?");
  for (const row of rows) {
    const body = JSON.parse(row.body) as QueuedBody;
    const redact = DURABLE_EVENTS[body.ownbase.type].app?.redact;
    if (!redact) continue;
    body.event = redact(body.event);
    const after = JSON.stringify(body);
    if (after !== row.body) update.run(after, row.id);
  }
}

/**
 * Takes the words of the messages `ids` names (a parenthesised list or
 * subquery, filled by `params`) out of the log and apps' queues.
 */
export function redactMessages(db: DatabaseSync, ids: string, ...params: ID[]): void {
  const logged = loggedRow.all(
    db.prepare(
      `SELECT seq, payload FROM events
       WHERE message_id IN ${ids} AND type IN ('message.created', 'message.updated')`,
    ),
    ...params,
  );
  const queued = queuedRow.all(
    db.prepare(`SELECT id, body FROM event_deliveries WHERE message_id IN ${ids}`),
    ...params,
  );
  redactLogged(db, logged);
  redactQueued(db, queued);
}

/**
 * Brings the log's copies of these messages, quoted in replies to them, up
 * to date: an edit's new words, or nothing at all once they are deleted
 * (null). The original's own edit or deletion still follows them on replay.
 */
export function requote(
  db: DatabaseSync,
  quotedIds: ID[],
  now: Pick<ReplyReference, "text" | "fileCount"> | null,
): void {
  if (quotedIds.length === 0) return;
  const quoted = new Set(quotedIds);
  const ph = quotedIds.map(() => "?").join(",");
  const rows = loggedRow.all(
    db.prepare(
      `SELECT seq, payload FROM events WHERE type IN ('message.created', 'message.updated')
       AND message_id IN (SELECT id FROM messages WHERE reply_to_id IN (${ph}))`,
    ),
    ...quotedIds,
  );
  const update = db.prepare("UPDATE events SET payload = ? WHERE seq = ?");
  for (const row of rows) {
    const event = JSON.parse(row.payload) as WorkspaceEvent;
    if (event.type !== "message.created" && event.type !== "message.updated") continue;
    const quote = event.message.replyTo;
    if (!quote || !quoted.has(quote.id)) continue;
    event.message.replyTo = now
      ? { ...quote, ...now }
      : { ...quote, userId: "", text: "", fileCount: 0, deleted: true };
    const after = JSON.stringify(event);
    if (after !== row.payload) update.run(after, row.seq);
  }
}

/**
 * As `requote`, for forwards: the log's copies of messages forwarding these
 * follow an edit's new words, or say the original is gone (null). A hidden
 * one shows no words either way.
 */
export function reforward(db: DatabaseSync, ids: ID[], now: { text: string } | null): void {
  if (ids.length === 0) return;
  const forwarded = new Set(ids);
  const ph = ids.map(() => "?").join(",");
  const rows = loggedRow.all(
    db.prepare(
      `SELECT seq, payload FROM events WHERE type IN ('message.created', 'message.updated')
       AND message_id IN (SELECT id FROM messages WHERE forwarded_from_id IN (${ph}))`,
    ),
    ...ids,
  );
  const update = db.prepare("UPDATE events SET payload = ? WHERE seq = ?");
  for (const row of rows) {
    const event = JSON.parse(row.payload) as WorkspaceEvent;
    if (event.type !== "message.created" && event.type !== "message.updated") continue;
    const ref = event.message.forwardedFrom;
    if (!ref || !forwarded.has(ref.id)) continue;
    event.message.forwardedFrom = now
      ? ref.hidden || ref.deleted
        ? ref
        : { ...ref, text: now.text }
      : { ...ref, userId: "", text: "", files: [], createdAt: 0, deleted: true };
    const after = JSON.stringify(event);
    if (after !== row.payload) update.run(after, row.seq);
  }
}
