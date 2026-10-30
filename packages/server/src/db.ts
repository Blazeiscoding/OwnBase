import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    status_text TEXT NOT NULL DEFAULT '',
    status_emoji TEXT NOT NULL DEFAULT '',
    is_bot INTEGER NOT NULL DEFAULT 0,
    deactivated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    creator_id TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    dm_key TEXT UNIQUE,
    last_msg_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE channel_members (
    channel_id TEXT NOT NULL REFERENCES channels(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX idx_members_user ON channel_members(user_id);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    thread_root_id TEXT,
    nonce TEXT,
    seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER
  );
  CREATE INDEX idx_messages_channel ON messages(channel_id, id);
  CREATE INDEX idx_messages_thread ON messages(thread_root_id);

  CREATE TABLE reactions (
    message_id TEXT NOT NULL REFERENCES messages(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE TABLE invites (
    code TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rowid');

  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  `,

  // v2 — file attachments
  `
  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    message_id TEXT REFERENCES messages(id),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_files_message ON files(message_id);
  CREATE INDEX idx_files_channel ON files(channel_id);
  `,

  // v3 — pins (shared per channel) and saved items (private per user)
  `
  CREATE TABLE pins (
    channel_id TEXT NOT NULL REFERENCES channels(id),
    message_id TEXT NOT NULL REFERENCES messages(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, message_id)
  );

  CREATE TABLE saved_items (
    user_id TEXT NOT NULL REFERENCES users(id),
    message_id TEXT NOT NULL REFERENCES messages(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, message_id)
  );
  `,

  // v4 — per-channel notification preferences and Do Not Disturb
  `
  ALTER TABLE channel_members ADD COLUMN notify_level TEXT NOT NULL DEFAULT 'mentions';
  ALTER TABLE channel_members ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN dnd_until INTEGER;
  `,

  // v5 — messages queued to send later
  `
  CREATE TABLE scheduled_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    thread_root_id TEXT,
    file_ids TEXT NOT NULL DEFAULT '[]',
    send_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_scheduled_due ON scheduled_messages(send_at);
  CREATE INDEX idx_scheduled_user ON scheduled_messages(user_id);
  `,

  // v6 — apps: bot users, API tokens and incoming webhooks
  `
  CREATE TABLE apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bot_user_id TEXT NOT NULL REFERENCES users(id),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE app_tokens (
    token_hash TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    channel_id TEXT NOT NULL REFERENCES channels(id),
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_webhooks_app ON webhooks(app_id);
  `,

  // v7 — slash commands and outgoing event subscriptions
  `
  -- Signs outbound requests so a receiver can prove they came from us. Unlike
  -- bot tokens this is stored in the clear: HMAC needs the key itself.
  ALTER TABLE apps ADD COLUMN signing_secret TEXT NOT NULL DEFAULT '';
  UPDATE apps SET signing_secret = lower(hex(randomblob(32)));

  CREATE TABLE slash_commands (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    command TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    usage_hint TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_commands_app ON slash_commands(app_id);

  CREATE TABLE event_subscriptions (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id),
    url TEXT NOT NULL,
    event_types TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_subscriptions_app ON event_subscriptions(app_id);
  `,
  // v8 — workspace-local friend requests, one row per unordered pair.
  `
  CREATE TABLE friendships (
    user_low TEXT NOT NULL REFERENCES users(id),
    user_high TEXT NOT NULL REFERENCES users(id),
    requested_by TEXT NOT NULL REFERENCES users(id),
    accepted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_low, user_high),
    CHECK (user_low < user_high),
    CHECK (requested_by = user_low OR requested_by = user_high)
  );
  CREATE INDEX idx_friends_high ON friendships(user_high);
  `,

  // v9 — interactive buttons: what an app attached to a message, and where a
  // click on one is delivered.
  `
  ALTER TABLE messages ADD COLUMN actions TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE apps ADD COLUMN interactivity_url TEXT NOT NULL DEFAULT '';
  `,
  // v10 — stable send keys. Preserve old duplicate messages, reserving their first key.
  `
  CREATE TABLE message_requests (
    user_id TEXT NOT NULL REFERENCES users(id),
    nonce TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(id),
    request_hash TEXT,
    PRIMARY KEY (user_id, nonce)
  );
  INSERT INTO message_requests (user_id, nonce, message_id)
    SELECT user_id, nonce, MIN(id) FROM messages WHERE nonce IS NOT NULL GROUP BY user_id, nonce;
  `,
  // v11 — scheduled delivery records an outcome instead of vanishing.
  `
  ALTER TABLE scheduled_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'queued';
  ALTER TABLE scheduled_messages ADD COLUMN failure_reason TEXT;
  ALTER TABLE scheduled_messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE scheduled_messages ADD COLUMN message_id TEXT;
  DROP INDEX idx_scheduled_due;
  CREATE INDEX idx_scheduled_due ON scheduled_messages(status, send_at);
  `,
  // v12 — sessions become listable, revocable one at a time, and expiring.
  `
  ALTER TABLE sessions ADD COLUMN id TEXT;
  ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';
  ALTER TABLE sessions ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
  UPDATE sessions SET id = lower(hex(randomblob(16))) WHERE id IS NULL;
  UPDATE sessions SET expires_at = last_seen_at + 2592000000 WHERE expires_at = 0;
  CREATE UNIQUE INDEX idx_sessions_id ON sessions(id);
  `,
  // v13 — blob removal survives process exit and temporary filesystem errors.
  `
  CREATE TABLE pending_file_deletions (
    file_id TEXT PRIMARY KEY
  );
  `,
  // v14 — retain scheduling request identities even after cancellation/pruning.
  `
  CREATE TABLE scheduled_requests (
    user_id TEXT NOT NULL REFERENCES users(id),
    nonce TEXT NOT NULL,
    scheduled_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    PRIMARY KEY (user_id, nonce)
  );
  `,
  // v15 — account-scoped thread following and independent read cursors.
  `
  CREATE TABLE thread_follows (
    user_id TEXT NOT NULL REFERENCES users(id),
    root_id TEXT NOT NULL REFERENCES messages(id),
    following INTEGER NOT NULL DEFAULT 1,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL,
    PRIMARY KEY (user_id, root_id)
  );
  CREATE INDEX idx_thread_follows_user ON thread_follows(user_id, following);
  CREATE INDEX idx_thread_follows_root ON thread_follows(root_id);
  `,
  // v16 — replies their author chose to send to the channel as well.
  `
  ALTER TABLE messages ADD COLUMN broadcast INTEGER NOT NULL DEFAULT 0;
  `,
  // v17 — a password someone else chose, which its owner must replace.
  `
  ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
  `,
  // v18 — delegated authority belongs to membership, so leaving clears it.
  `
  ALTER TABLE channel_members ADD COLUMN is_manager INTEGER NOT NULL DEFAULT 0;
  `,
  // v19 — single-use tickets that let a browser stream a download to disk.
  `
  CREATE TABLE download_tokens (
    token_hash TEXT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_download_tokens_expiry ON download_tokens(expires_at);
  CREATE INDEX idx_download_tokens_user ON download_tokens(user_id, expires_at);
  CREATE INDEX idx_download_tokens_file ON download_tokens(file_id);
  CREATE INDEX idx_download_tokens_session ON download_tokens(session_hash);
  `,
  // v20 — durable, ordered delivery for outgoing integration events.
  `
  CREATE TABLE event_deliveries (
    id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
    channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
    event_seq INTEGER NOT NULL,
    body TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    failed_at INTEGER,
    last_error TEXT,
    UNIQUE (subscription_id, event_seq)
  );
  CREATE INDEX idx_event_deliveries_due
    ON event_deliveries(failed_at, next_attempt_at, event_seq);
  CREATE INDEX idx_event_deliveries_channel ON event_deliveries(channel_id);
  CREATE TRIGGER discard_revoked_event_deliveries AFTER DELETE ON channel_members
  BEGIN
    DELETE FROM event_deliveries
    WHERE channel_id = OLD.channel_id AND subscription_id IN (
      SELECT s.id FROM event_subscriptions s
      JOIN apps a ON a.id = s.app_id
      WHERE a.bot_user_id = OLD.user_id
    );
  END;
  `,
  // v21 — an endpoint that stays down must not grow its queue without end.
  `
  ALTER TABLE event_subscriptions ADD COLUMN dropped_count INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_event_deliveries_backlog
    ON event_deliveries(subscription_id, failed_at);
  `,
  // v22 — deleting a message has to reach the copy of its text in the event log.
  // Without a way to find those rows, the words someone deleted stay readable on
  // disk until the log is pruned, which can be months.
  `
  ALTER TABLE events ADD COLUMN message_id TEXT;
  UPDATE events SET message_id = json_extract(payload, '$.message.id')
    WHERE type IN ('message.created', 'message.updated');
  UPDATE events SET message_id = json_extract(payload, '$.messageId')
    WHERE type = 'message.deleted';
  CREATE INDEX idx_events_message ON events(message_id);
  `,
  // v23 — an invite that has got out has to be withdrawable. Kept rather than
  // deleted, so the list can still say a link existed and who withdrew it.
  `
  ALTER TABLE invites ADD COLUMN revoked_at INTEGER;
  ALTER TABLE invites ADD COLUMN revoked_by TEXT;
  CREATE INDEX idx_invites_created ON invites(created_at);
  `,
  // v24 — who changed what, for the administrative actions a workspace has to be
  // able to account for. No foreign keys: a record outlives what it describes.
  `
  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    details TEXT NOT NULL DEFAULT '{}'
  );
  `,
  // v25 — creating invite codes is something a member is given, not something
  // every member has. Owners and admins can regardless of this column.
  `
  ALTER TABLE users ADD COLUMN can_invite INTEGER NOT NULL DEFAULT 0;
  `,
  // v26 — a file waiting in a scheduled message belongs to that message alone,
  // held by a key rather than found by scanning JSON, so a second schedule or
  // an ordinary send cannot take it. A scheduled reply also remembers whether
  // it was to be shown in the channel. Outstanding rows claim their files in
  // the order they were queued; a file two of them named goes to the first.
  `
  ALTER TABLE scheduled_messages ADD COLUMN broadcast INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE scheduled_files (
    file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    scheduled_id TEXT NOT NULL REFERENCES scheduled_messages(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_scheduled_files_item ON scheduled_files(scheduled_id);
  INSERT OR IGNORE INTO scheduled_files (file_id, scheduled_id)
    SELECT j.value, s.id
    FROM scheduled_messages s,
      json_each(CASE WHEN json_valid(s.file_ids) AND json_type(s.file_ids) = 'array'
        THEN s.file_ids ELSE '[]' END) j
    WHERE s.status != 'sent'
      AND EXISTS (SELECT 1 FROM files f WHERE f.id = j.value AND f.message_id IS NULL)
    ORDER BY s.created_at, s.id;
  `,
  // v27 — a held scheduled message waits for its obstacle to clear, or for its
  // next attempt, instead of being checked again on every tick.
  `
  ALTER TABLE scheduled_messages ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_scheduled_held ON scheduled_messages(status, next_attempt_at);
  `,
  // v28 — a thread's replies in the order its pages read them. With only
  // thread_root_id indexed, SQLite read an old thread's newest page through
  // (channel_id, id) and walked past every newer message in the channel: 92 ms
  // at 200,000 messages, against 3 ms with this (scripts/measure-thread-index.mts).
  // It answers every lookup the single-column index did, so it replaces it
  // rather than joining it, which would cost writes and space for nothing.
  `
  CREATE INDEX idx_messages_thread_page ON messages(thread_root_id, id);
  DROP INDEX idx_messages_thread;
  `,
  // v29 — a queued app event says which message it carries, so editing or
  // deleting that message can take the old words out of every copy still
  // waiting to leave, as it already does in the event log. Rows queued before
  // this carry the message in their body, which is where the id comes from.
  `
  ALTER TABLE event_deliveries ADD COLUMN message_id TEXT;
  UPDATE event_deliveries SET message_id = CASE json_extract(body, '$.ownbase.type')
      WHEN 'message.created' THEN json_extract(body, '$.event.ts')
      WHEN 'message.updated' THEN json_extract(body, '$.event.ts')
      WHEN 'message.deleted' THEN json_extract(body, '$.event.deleted_ts')
    END
    WHERE json_valid(body);
  CREATE INDEX idx_event_deliveries_message ON event_deliveries(message_id)
    WHERE message_id IS NOT NULL;
  `,
  // v30 — a reply is read through its thread, never by the channel's cursor,
  // which reads only what the channel shows. A thread this account has no
  // cursor for is read up to its membership's replies_read_seq: where the
  // channel cursor stood at this upgrade, or where the workspace was when it
  // joined. Existing thread cursors are raised to the channel cursor too, so
  // nothing read before this upgrade, and no mention in it, comes back.
  `
  ALTER TABLE channel_members ADD COLUMN replies_read_seq INTEGER NOT NULL DEFAULT 0;
  UPDATE channel_members SET replies_read_seq = last_read_seq;
  UPDATE thread_follows SET last_read_seq = MAX(last_read_seq, COALESCE((
      SELECT cm.last_read_seq FROM messages root
      JOIN channel_members cm ON cm.channel_id = root.channel_id
        AND cm.user_id = thread_follows.user_id
      WHERE root.id = thread_follows.root_id
    ), 0));
  `,
  // v31 — who each message names, so counting someone's unread mentions reads
  // their mentions rather than every message in their channels. It was a scan
  // per member, and a message naming the whole room recounts every member: at
  // 200,000 messages and 50 members an `<!here>` held the server for 3.7 s
  // (scripts/measure-unread-counts.mts). user_id '!' is the whole room. The
  // rows are the same rule as Store.MENTIONS_ME: a message names X when its
  // text holds `<@X>`, which the walk below finds at every `<@` in turn.
  `
  CREATE TABLE message_mentions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX idx_message_mentions_user ON message_mentions(user_id, channel_id);
  INSERT INTO message_mentions (message_id, channel_id, user_id)
    SELECT id, channel_id, '!' FROM messages
    WHERE deleted_at IS NULL AND (instr(text, '<!here>') > 0
      OR instr(text, '<!channel>') > 0 OR instr(text, '<!everyone>') > 0);
  WITH RECURSIVE after_mark(message_id, channel_id, rest) AS (
    SELECT id, channel_id, substr(text, instr(text, '<@') + 2) FROM messages
    WHERE deleted_at IS NULL AND instr(text, '<@') > 0
    UNION ALL
    SELECT message_id, channel_id, substr(rest, instr(rest, '<@') + 2) FROM after_mark
    WHERE instr(rest, '<@') > 0
  )
  INSERT OR IGNORE INTO message_mentions (message_id, channel_id, user_id)
    SELECT message_id, channel_id, substr(rest, 1, instr(rest, '>') - 1) FROM after_mark
    WHERE instr(rest, '>') > 1
      AND substr(rest, 1, instr(rest, '>') - 1) NOT GLOB '*[^A-Za-z0-9_-]*';
  `,
  // v32 — the send keys of messages retention removed, so a retry held since
  // cannot post one again. Only who sent it, its key and when: no words, no
  // channel, nothing the removal was meant to discard.
  `
  CREATE TABLE purged_message_requests (
    user_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, nonce)
  ) WITHOUT ROWID;
  CREATE INDEX idx_purged_message_requests_sent ON purged_message_requests(sent_at);
  `,
  // v33 — marking a thread unread holds against the channel's cursor: where
  // that cursor stood then. Until the channel is read past it, a reply also
  // sent to the channel is read only through its thread. Null: no hold.
  `
  ALTER TABLE thread_follows ADD COLUMN unread_hold INTEGER;
  `,
  // v34 — a channel's managers without reading every member's row. Each
  // handshake lists the managers of every channel its reader can see, and a
  // channel of a thousand members has one or two (OPT-13).
  `
  CREATE INDEX idx_channel_managers ON channel_members(channel_id, user_id) WHERE is_manager = 1;
  `,
  // v35 — attachment removal that failed waits its turn instead of blocking
  // the rest (REV-02): how often it was tried, when it may be tried again,
  // and since when it has waited. A removal that can never succeed, such as
  // an id that cannot name a file, is set aside for good and stays counted.
  `
  ALTER TABLE pending_file_deletions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pending_file_deletions ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pending_file_deletions ADD COLUMN queued_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pending_file_deletions ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0;
  UPDATE pending_file_deletions SET queued_at = CAST(unixepoch('subsec') * 1000 AS INTEGER);
  CREATE INDEX idx_pending_file_deletions_due
    ON pending_file_deletions(next_attempt_at, file_id) WHERE rejected = 0;
  `,
  // v36 — an administrator's retry of an endpoint's failed app events waits
  // for room in its queue instead of overfilling it (REV-15): a failed row
  // asked to go again keeps its place until a slot frees up.
  `
  ALTER TABLE event_deliveries ADD COLUMN retry_requested INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_event_deliveries_retry
    ON event_deliveries(subscription_id, event_seq, id) WHERE retry_requested = 1;
  `,
  // v37 — remove redundant content from old completion/tombstone records
  // (N06/N07). Preserve current message buttons and every unsent schedule;
  // older message versions, including purged messages, are replay metadata.
  `
  UPDATE messages SET actions = '[]' WHERE deleted_at IS NOT NULL;
  UPDATE events SET payload = json_set(payload, '$.message.actions', json('[]'))
    WHERE type IN ('message.created', 'message.updated') AND json_valid(payload)
      AND message_id IS NOT NULL AND (
        NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = events.message_id AND m.deleted_at IS NULL)
        OR EXISTS (SELECT 1 FROM events newer WHERE newer.message_id = events.message_id
          AND newer.type IN ('message.created', 'message.updated') AND newer.seq > events.seq)
      );
  UPDATE scheduled_messages SET text = '', file_ids = '[]' WHERE status = 'sent';
  `,
  // v38 — inline replies: the message one answers in place, as Discord does
  // beside Slack's threads, and whether its author was notified. No foreign
  // key: the original can be removed with older history while its replies
  // stay, and they then say it is gone. Indexed for the replies of one
  // message, which an edit or deletion of it has to find.
  `
  ALTER TABLE messages ADD COLUMN reply_to_id TEXT;
  ALTER TABLE messages ADD COLUMN reply_ping INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_messages_reply_to ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;
  `,
  // v39 — a status that clears itself (UX-61): when, in epoch ms, or NULL for
  // one that stays until it is changed.
  `
  ALTER TABLE users ADD COLUMN status_expires_at INTEGER;
  `,
  // v40 — a conversation starred by one member, listed under Starred above
  // Channels for them alone (UX-20). It lives on the membership, as muting
  // does, so leaving drops it and an archived channel keeps it.
  `
  ALTER TABLE channel_members ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
  `,
  // v41 — a forwarded message: the one it passes on, shown under it as a card
  // (E1). No foreign key, as with replies: the original can go with older
  // history while the forward stays and says so. Indexed for the forwards of
  // one message, which its edit or deletion has to find.
  `
  ALTER TABLE messages ADD COLUMN forwarded_from_id TEXT;
  CREATE INDEX idx_messages_forwarded_from ON messages(forwarded_from_id)
    WHERE forwarded_from_id IS NOT NULL;
  `,
  // v42 — link previews (E2): what the server found at the first few web
  // addresses in a message, in their order, with the page's picture kept
  // here so no reader's device fetches it from the site. One the sender
  // removed stays as a row with nothing in it, so an edit that keeps the link
  // does not bring it back. Goes with its message's row.
  `
  CREATE TABLE link_previews (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    site_name TEXT NOT NULL,
    image BLOB,
    image_type TEXT,
    image_width INTEGER,
    image_height INTEGER,
    removed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (message_id, url)
  );
  `,
  // v43 — a thread muted by one account (E3): not followed, kept that way when
  // that account replies, and its replies notify only when addressed to it.
  `
  ALTER TABLE thread_follows ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
  `,
  // v44 — reminders (E4): one account's reminder about one message, when it
  // is to come due, and when it did (NULL while it waits). One per account and
  // message, so setting another changes it. Goes with the account or the
  // message row; a deleted message's reminders are dropped by the server.
  // Indexed for the soonest waiting one, which the server's timer is set for.
  `
  CREATE TABLE reminders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    remind_at INTEGER NOT NULL,
    due_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, message_id)
  );
  CREATE INDEX idx_reminders_waiting ON reminders(remind_at) WHERE due_at IS NULL;
  CREATE INDEX idx_reminders_message ON reminders(message_id);
  `,
  // v45 — polls (E6): a message whose words are a question, its choices in
  // order as JSON (a choice is known by its place, and they never change),
  // whether more than one may be chosen, whether who chose what is kept from
  // everyone, and when its author closed it. One row per choice a person
  // made. Both go with the message's row; a deleted message's poll is dropped
  // by the server. Indexed by voter, for the choices each account is sent.
  `
  CREATE TABLE polls (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    options TEXT NOT NULL,
    multiple INTEGER NOT NULL DEFAULT 0,
    anonymous INTEGER NOT NULL DEFAULT 0,
    closed_at INTEGER
  );
  CREATE TABLE poll_votes (
    message_id TEXT NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, option)
  );
  CREATE INDEX idx_poll_votes_user ON poll_votes(user_id);
  `,
  // v46 — sidebar sections (E8): one account's own named sections, in its
  // order, and on each membership the section it is kept in. No foreign key,
  // as with forwarded_from_id: deleting a section clears its members' column
  // in the same change, and a column with one could not be dropped again.
  `
  CREATE TABLE sidebar_sections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sidebar_sections_user ON sidebar_sections(user_id, position);
  ALTER TABLE channel_members ADD COLUMN section_id TEXT;
  `,
  // v47 — profiles (E9): a person's time zone, away by hand, and their
  // picture: its bytes in a table of their own, and on the user the version
  // that names them, so a user row says which picture to show without them.
  `
  ALTER TABLE users ADD COLUMN time_zone TEXT;
  ALTER TABLE users ADD COLUMN away INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN avatar_version TEXT;
  CREATE TABLE user_avatars (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    bytes BLOB NOT NULL
  );
  `,
  // v48 — call notes (E10): a message the server leaves about a call, such
  // as a huddle nobody answered, says which kind; null on every other message.
  `
  ALTER TABLE messages ADD COLUMN call_kind TEXT;
  `,
  // v49 — two-step sign-in (E11): an account's authenticator key (null while
  // it has none) and the last time step a code was accepted for, so no code
  // works twice; and its recovery codes, kept only as hashes, each used once.
  `
  ALTER TABLE users ADD COLUMN two_step_secret TEXT;
  ALTER TABLE users ADD COLUMN two_step_step INTEGER;
  CREATE TABLE two_step_codes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at INTEGER,
    PRIMARY KEY (user_id, code_hash)
  );
  `,
  // v50 — blocking and reporting (E12): whom each account blocked, and reports
  // of messages for the admins, each person's open one at most once per
  // message. A report goes with its message and its reporter; who resolved it
  // is a plain id, as an audit entry's actor is.
  `
  CREATE TABLE user_blocks (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, blocked_id)
  );
  CREATE TABLE message_reports (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolved_by TEXT,
    resolution TEXT
  );
  CREATE UNIQUE INDEX idx_message_reports_open
    ON message_reports(message_id, reporter_id) WHERE resolved_at IS NULL;
  CREATE INDEX idx_message_reports_reporter ON message_reports(reporter_id);
  `,
  // v51 — what each app may do (E18c), as a JSON list of Slack's scope names.
  // An app made before could do everything, so it keeps every scope there was
  // then; a scope added later has to be given to it.
  `
  ALTER TABLE apps ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]';
  UPDATE apps SET scopes = '["chat:write","chat:write.public","channels:history","groups:history","im:history","mpim:history","channels:read","groups:read","reactions:read","pins:read","users:read"]';
  `,
];

/** The schema this build understands. A workspace above it cannot be opened. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Builds a database at an older schema level, for testing that upgrades from
 * historical versions still work. Reading the same migration list the product
 * does is the point: a fixture written by hand drifts away from it silently.
 */
export function openDbAtVersion(path: string, version: number): DatabaseSync {
  if (version > MIGRATIONS.length) throw new Error(`No schema v${version} exists`);
  return openDb(path, version);
}

/** Where copies taken before an upgrade go, beside the workspace they came from. */
export const UPGRADE_BACKUP_DIR = "pre-upgrade";
/** How many of those copies are kept. Each is a whole database. */
export const UPGRADE_BACKUPS_KEPT = 3;

export interface OpenDbOptions {
  /**
   * Copy an existing workspace before migrating it. On by default. Turning it
   * off is for someone who has just taken their own backup and has no room for
   * a second copy, not for everyday use.
   */
  backupBeforeUpgrade?: boolean;
  /** Told where the copy went, once it has been written. */
  onUpgradeBackup?: (file: string) => void;
  /**
   * Told about an older copy that should have been removed and could not be.
   * The upgrade still goes ahead: the copy it needs is safe, and one too many
   * old ones costs only disk.
   */
  onUpgradeBackupPruneFailure?: (file: string, error: Error) => void;
}

/**
 * A consistent copy of the database as it is before any migration touches it.
 *
 * A migration runs in a transaction, so one that fails leaves the old schema
 * behind. What a transaction cannot undo is a migration that succeeds and is
 * wrong, or an upgrade someone wants to walk back a week later: rolling back
 * means the old application with the old data, and without a copy there is no
 * old data to roll back to. This is that copy, taken before the first change,
 * with nothing asked of the host.
 *
 * `VACUUM INTO` writes a snapshot including anything still in the write-ahead
 * log. Attachments are not copied: no migration touches them.
 */
function backupBeforeUpgrade(
  db: DatabaseSync,
  path: string,
  from: number,
  to: number,
  onPruneFailure?: (file: string, error: Error) => void,
): string {
  const dir = join(dirname(path), UPGRADE_BACKUP_DIR);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const file = join(dir, `workspace-v${from}-before-v${to}-${stamp}.db`);
  try {
    mkdirSync(dir, { recursive: true });
    db.prepare("VACUUM INTO ?").run(file);
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      const { user_version } = copy.prepare("PRAGMA user_version").get() as {
        user_version: number;
      };
      if (user_version !== from) throw new Error("the copy has the wrong schema version");
    } finally {
      copy.close();
    }
  } catch (err) {
    // Best effort. Whatever stopped the copy can stop this too — on Linux a
    // file where the directory should be makes even removing a missing file
    // fail — and the reason worth reporting is the first one.
    try {
      rmSync(file, { force: true });
    } catch {
      // Nothing was written that needs removing, or it cannot be removed.
    }
    throw new Error(
      `Could not back up this workspace before upgrading it, so it has not been upgraded ` +
        `and nothing has changed. ${(err as Error).message}. Free some disk space and start ` +
        `again, or take a backup yourself and start with --skip-upgrade-backup.`,
    );
  }
  pruneUpgradeCopies(db, dir, basename(file), onPruneFailure);
  // Nothing above removes the copy just made, but reporting a path that is not
  // there would be worse than refusing: it is the one thing a rollback needs.
  if (!existsSync(file)) {
    throw new Error(
      `The copy taken before upgrading this workspace is missing (${file}), so it has not ` +
        `been upgraded and nothing has changed. Start again to take a new one.`,
    );
  }
  return file;
}

const UPGRADE_COPY_NAME = /^workspace-v(\d+)-before-v(\d+)-(.+)\.db$/;

/**
 * Keeps the copy just taken and the most recent others, up to
 * UPGRADE_BACKUPS_KEPT in all. One copy per upgrade is what rolling back the
 * last few needs; keeping every one would fill the disk a database at a time.
 *
 * "Most recent" is by the schema each copy was taken from, then by the time in
 * its name. Schemas only move forward, so a copy from before a later upgrade is
 * newer whatever the clock said when either was taken; a clock that was set
 * back, or ahead, only decides between copies of the same schema. The copy just
 * taken is never a candidate, wherever its time sorts.
 *
 * Only copies that could be restored count towards the few kept: one that does
 * not open, holds a different schema from the one its name says, belongs to
 * another workspace, or whose pages do not hold together is left where it is
 * for a person to look at, and does not push out a copy that works. Files
 * outside the naming format are not ours.
 */
function pruneUpgradeCopies(
  db: DatabaseSync,
  dir: string,
  current: string,
  onPruneFailure?: (file: string, error: Error) => void,
): void {
  const workspaceId = metaValue(db, "workspace_id");
  const others = readdirSync(dir)
    .map((name) => ({ name, match: UPGRADE_COPY_NAME.exec(name) }))
    .filter(
      (entry): entry is { name: string; match: RegExpExecArray } =>
        entry.match !== null && entry.name !== current,
    )
    .map(({ name, match }) => ({
      name,
      from: Number(match[1]),
      to: Number(match[2]),
      taken: match[3]!,
    }))
    .filter((copy) => isRestorableCopy(join(dir, copy.name), copy.from, workspaceId))
    .sort((a, b) => b.from - a.from || b.to - a.to || b.taken.localeCompare(a.taken));
  for (const old of others.slice(Math.max(0, UPGRADE_BACKUPS_KEPT - 1))) {
    try {
      rmSync(join(dir, old.name), { force: true });
    } catch (err) {
      // An extra copy left behind costs disk, not safety; the upgrade goes on.
      onPruneFailure?.(join(dir, old.name), err as Error);
    }
  }
}

function metaValue(db: DatabaseSync, key: string): string | null {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a managed copy opens, at the schema its name records, as this
 * workspace, with pages that pass SQLite's quick check.
 */
function isRestorableCopy(path: string, from: number, workspaceId: string | null): boolean {
  let copy: DatabaseSync | undefined;
  try {
    // Immutable: a read-only open of a database left in WAL mode would
    // otherwise create -wal and -shm files beside a copy only being looked at.
    const url = pathToFileURL(path);
    url.searchParams.set("immutable", "1");
    copy = new DatabaseSync(url, { readOnly: true });
    const { user_version } = copy.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (user_version !== from) return false;
    const copyId = metaValue(copy, "workspace_id");
    // A copy from before the workspace had an id, or of one that still has
    // none, cannot be told apart and is taken to be this one.
    if (workspaceId !== null && copyId !== null && copyId !== workspaceId) return false;
    // Its pages hold together. Header and schema can read perfectly well over
    // history a failing disk has lost, and such a copy must not push out one
    // that can still be restored. quick_check walks every page but not every
    // index entry; foreign keys are not checked, since a workspace can hold
    // rows from before they were enforced and its copies would all fail.
    const check = copy.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
    return check.length === 1 && check[0]!.quick_check === "ok";
  } catch {
    return false;
  } finally {
    copy?.close();
  }
}

export function openDb(
  path: string,
  upTo = MIGRATIONS.length,
  options: OpenDbOptions = {},
): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (user_version > MIGRATIONS.length) {
    db.close();
    throw new Error(
      "This workspace was created by a newer server version. Upgrade the server before opening it.",
    );
  }
  // Version 0 is a file that has only just been created: nothing to lose yet.
  if (
    path !== ":memory:" &&
    user_version > 0 &&
    user_version < upTo &&
    options.backupBeforeUpgrade !== false
  ) {
    let file: string;
    try {
      file = backupBeforeUpgrade(db, path, user_version, upTo, options.onUpgradeBackupPruneFailure);
    } catch (err) {
      db.close();
      throw err;
    }
    options.onUpgradeBackup?.(file);
  }
  // Every step or none (OPS-05). An upgrade that fails, or is cut off, partway
  // through several versions leaves the workspace as it was, which the release
  // it came from still opens, rather than at a version between the two that no
  // release a person has would open.
  if (user_version < upTo) {
    db.exec("BEGIN");
    try {
      for (let v = user_version; v < upTo; v++) {
        db.exec(MIGRATIONS[v]!);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // SQLite has already rolled back after some failures, a full disk
        // among them; the error worth reporting is the one that stopped it.
      }
      // Leave nothing holding the file: on Windows a leaked handle blocks the
      // caller from even moving the workspace aside to recover it.
      db.close();
      throw err;
    }
  }
  return db;
}
