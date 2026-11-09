import type { ID, Poll } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import type { Store } from "../store.js";

/** Polls (E6): a message's question, its options, and who chose what. */
export class PollStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

  /** The polls among these messages, with their votes counted, by message id. */
  ofMessages(messageIds: ID[]): Map<ID, Poll> {
    const polls = new Map<ID, Poll>();
    if (messageIds.length === 0) return polls;
    const ph = messageIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT message_id, options, multiple, anonymous, closed_at FROM polls
         WHERE message_id IN (${ph})`,
      )
      .all(...messageIds) as {
      message_id: string;
      options: string;
      multiple: number;
      anonymous: number;
      closed_at: number | null;
    }[];
    if (rows.length === 0) return polls;
    const votes = this.db
      .prepare(
        `SELECT message_id, user_id, option FROM poll_votes
         WHERE message_id IN (${rows.map(() => "?").join(",")})
         ORDER BY created_at, rowid`,
      )
      .all(...rows.map((r) => r.message_id)) as {
      message_id: string;
      user_id: string;
      option: number;
    }[];
    for (const row of rows) {
      const anonymous = row.anonymous === 1;
      const options = (JSON.parse(row.options) as string[]).map((text) => ({
        text,
        votes: 0,
        ...(anonymous ? {} : { voterIds: [] as ID[] }),
      }));
      const voters = new Set<ID>();
      for (const vote of votes) {
        if (vote.message_id !== row.message_id) continue;
        const option = options[vote.option];
        if (!option) continue;
        option.votes++;
        option.voterIds?.push(vote.user_id);
        voters.add(vote.user_id);
      }
      polls.set(row.message_id, {
        options,
        multiple: row.multiple === 1,
        anonymous,
        voters: voters.size,
        closedAt: row.closed_at,
      });
    }
    return polls;
  }

  /** Makes a message a poll; its words are the question. */
  create(messageId: ID, poll: { options: string[]; multiple: boolean; anonymous: boolean }): void {
    this.db
      .prepare("INSERT INTO polls (message_id, options, multiple, anonymous) VALUES (?, ?, ?, ?)")
      .run(messageId, JSON.stringify(poll.options), poll.multiple ? 1 : 0, poll.anonymous ? 1 : 0);
  }

  /** What a poll offers and whether it is open, to check a vote against; null for no poll. */
  rules(
    messageId: ID,
  ): { options: number; multiple: boolean; anonymous: boolean; closedAt: number | null } | null {
    const row = this.db
      .prepare("SELECT options, multiple, anonymous, closed_at FROM polls WHERE message_id = ?")
      .get(messageId) as
      | { options: string; multiple: number; anonymous: number; closed_at: number | null }
      | undefined;
    if (!row) return null;
    return {
      options: (JSON.parse(row.options) as string[]).length,
      multiple: row.multiple === 1,
      anonymous: row.anonymous === 1,
      closedAt: row.closed_at,
    };
  }

  /** One account's choices in a poll, by option place. */
  choices(messageId: ID, userId: ID): number[] {
    const rows = this.db
      .prepare("SELECT option FROM poll_votes WHERE message_id = ? AND user_id = ? ORDER BY option")
      .all(messageId, userId) as { option: number }[];
    return rows.map((row) => row.option);
  }

  /**
   * Replaces one account's choices in a poll; none takes the vote back. Says
   * whether anything changed, so choosing again what is chosen tells nobody.
   */
  setChoices(messageId: ID, userId: ID, choices: number[]): boolean {
    const before = this.choices(messageId, userId);
    const after = [...new Set(choices)].sort((a, b) => a - b);
    if (before.length === after.length && before.every((c, i) => c === after[i])) return false;
    this.db
      .prepare("DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?")
      .run(messageId, userId);
    const insert = this.db.prepare(
      "INSERT INTO poll_votes (message_id, user_id, option, created_at) VALUES (?, ?, ?, ?)",
    );
    const now = Date.now();
    for (const option of after) insert.run(messageId, userId, option, now);
    // Ahead of the new count, so a device of theirs never counts its own vote twice.
    this.store.outbox.person(
      userId,
      { type: "poll.choices", messageId, choices: this.choices(messageId, userId) },
      { ahead: true },
    );
    return true;
  }

  /** Closes a poll for good; false when it was already closed. */
  close(messageId: ID): boolean {
    const res = this.db
      .prepare("UPDATE polls SET closed_at = ? WHERE message_id = ? AND closed_at IS NULL")
      .run(Date.now(), messageId);
    return res.changes > 0;
  }

  /**
   * What one account chose in each anonymous poll it voted in and can still
   * read, for the handshake snapshot: no message says so. A poll that is not
   * anonymous says on each option who chose it.
   */
  anonymousChoices(userId: ID): Record<ID, number[]> {
    const rows = this.db
      .prepare(
        `SELECT v.message_id, v.option FROM poll_votes v
         JOIN polls p ON p.message_id = v.message_id
         JOIN messages m ON m.id = v.message_id
         JOIN channels c ON c.id = m.channel_id
         WHERE v.user_id = ? AND p.anonymous = 1 AND m.deleted_at IS NULL
           AND (c.type = 'public'
             OR EXISTS (SELECT 1 FROM channel_members cm
                        WHERE cm.channel_id = c.id AND cm.user_id = v.user_id))
         ORDER BY v.message_id, v.option`,
      )
      .all(userId) as { message_id: string; option: number }[];
    const choices: Record<ID, number[]> = {};
    for (const row of rows) (choices[row.message_id] ??= []).push(row.option);
    return choices;
  }
}
