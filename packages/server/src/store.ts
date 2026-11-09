import type {
  App,
  AppEventType,
  AppScope,
  AuditAction,
  AuditEntry,
  AuditTargetType,
  EventEnvelope,
  EventSubscription,
  ID,
  MessageAction,
  ReplyReference,
  SlashCommand,
  User,
  Webhook,
  WorkspaceEvent,
} from "@ownbase/protocol";
import { APP_SCOPES } from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { AccountStore } from "./accounts/store.js";
import { ChannelStore } from "./channels/store.js";
import { Settings } from "./core/settings.js";
import { Outbox } from "./events/outbox.js";
import { FileStore } from "./files/store.js";
import { ulid } from "./ids.js";
import { MessageStore } from "./messages/store.js";
import { PeopleStore } from "./people/store.js";
import { PollStore } from "./polls/store.js";
import { ReminderStore } from "./reminders/store.js";
import { SavedStore } from "./saved/store.js";
import { ScheduledStore } from "./scheduled/store.js";
import { SearchStore } from "./search/store.js";
import { ThreadStore } from "./threads/store.js";

/** Known scopes only, each once, in one order, so two lists compare as text. */
function scopeList(scopes: readonly unknown[]): AppScope[] {
  return APP_SCOPES.filter((scope) => scopes.includes(scope));
}

/** A stored JSON list, or empty when it is missing or not a list. */
function parseJsonArray(text: string | undefined): unknown[] {
  try {
    const value: unknown = JSON.parse(text ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export interface MessageRow {
  id: string;
  channel_id: string;
  user_id: string;
  text: string;
  thread_root_id: string | null;
  broadcast: number;
  nonce: string | null;
  seq: number;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  actions: string;
  reply_to_id: string | null;
  reply_ping: number;
  forwarded_from_id: string | null;
  /** A note the server left about a call (E10); absent from rows read without it. */
  call_kind?: string | null;
}

/**
 * Buttons come back out of one JSON column. A row written by a future version,
 * or corrupted somehow, costs its buttons rather than the whole message.
 */
export function parseActions(raw: string | null): MessageAction[] {
  if (!raw || raw === "[]") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MessageAction[]) : [];
  } catch {
    return [];
  }
}

/** How long a session survives without being used. */
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

export class Store {
  /** What the writes here have to tell people, sent once they are committed. */
  readonly outbox: Outbox = new Outbox({
    memberIds: (channelId) => this.channels.memberIds(channelId),
    unreadMentionCounts: (userId) => this.channels.unreadMentionCounts(userId),
  });
  /** The workspace's settings, kept in `meta`; see core/settings.ts. */
  readonly settings: Settings;
  // features: fields
  readonly accounts: AccountStore;
  readonly people: PeopleStore;
  readonly channels: ChannelStore;
  readonly messages: MessageStore;
  readonly files: FileStore;
  readonly search: SearchStore;
  readonly threads: ThreadStore;
  readonly scheduled: ScheduledStore;
  readonly saved: SavedStore;
  readonly polls: PollStore;
  readonly reminders: ReminderStore;

  constructor(readonly db: DatabaseSync) {
    this.settings = new Settings(this);
    // features: made
    this.accounts = new AccountStore(db, this);
    this.people = new PeopleStore(db, this);
    this.channels = new ChannelStore(db, this);
    this.messages = new MessageStore(db, this);
    this.files = new FileStore(db, this);
    this.search = new SearchStore(db, this);
    this.threads = new ThreadStore(db, this);
    this.scheduled = new ScheduledStore(db, this);
    this.saved = new SavedStore(db, this);
    this.polls = new PollStore(db, this);
    this.reminders = new ReminderStore(db, this);
  }

  /** Only synchronous database work belongs here; publish events after this returns. */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    const mark = this.outbox.begin();
    let value: T;
    try {
      value = work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.outbox.rollback(mark);
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.outbox.commit();
    return value;
  }

  // ---------- meta ----------

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  /** Every meta key starting with `prefix`, in key order. */
  listMeta(prefix: string): { key: string; value: string }[] {
    return this.db
      .prepare("SELECT key, value FROM meta WHERE substr(key, 1, ?) = ? ORDER BY key")
      .all(prefix.length, prefix) as { key: string; value: string }[];
  }

  /**
   * True if the user may read the channel (public, or member of non-public).
   * A guest reads public channels only, whatever membership it might be given.
   */
  canAccess(channelId: ID, userId: ID): boolean {
    const r = this.db.prepare("SELECT type FROM channels WHERE id = ?").get(channelId) as
      { type: string } | undefined;
    if (!r) return false;
    if (r.type === "public") return true;
    return this.channels.isMember(channelId, userId) && !this.people.isGuest(userId);
  }

  // ---------- apps, tokens and webhooks ----------

  /** Creates the bot user that an app posts as. */
  createBotUser(handle: string, displayName: string, passwordHash: string, salt: string): User {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO users (id, handle, display_name, password_hash, salt, role, is_bot, created_at)
         VALUES (?, ?, ?, ?, ?, 'member', 1, ?)`,
      )
      .run(id, handle, displayName, passwordHash, salt, Date.now());
    return this.people.get(id)!;
  }

  createApp(input: {
    name: string;
    botUserId: ID;
    createdBy: ID;
    signingSecret: string;
    /** Left out, everything, as every app could before scopes (E18c). */
    scopes?: readonly AppScope[];
  }): App {
    const id = ulid();
    const now = Date.now();
    const scopes = scopeList(input.scopes ?? APP_SCOPES);
    this.db
      .prepare(
        "INSERT INTO apps (id, name, bot_user_id, created_by, created_at, signing_secret, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.name,
        input.botUserId,
        input.createdBy,
        now,
        input.signingSecret,
        JSON.stringify(scopes),
      );
    return {
      id,
      name: input.name,
      botUserId: input.botUserId,
      createdBy: input.createdBy,
      createdAt: now,
      interactivityUrl: "",
      scopes,
    };
  }

  /** Replaces what an app may do (E18c). */
  setAppScopes(id: ID, scopes: readonly AppScope[]): boolean {
    return (
      this.db
        .prepare("UPDATE apps SET scopes = ? WHERE id = ?")
        .run(JSON.stringify(scopeList(scopes)), id).changes > 0
    );
  }

  /** Where this app's button clicks go. Empty leaves its buttons inert. */
  setInteractivityUrl(id: ID, url: string): boolean {
    return (
      this.db.prepare("UPDATE apps SET interactivity_url = ? WHERE id = ?").run(url, id).changes > 0
    );
  }

  /** The app a bot user posts as, for tracing a message back to its owner. */
  appForBotUser(botUserId: ID): App | null {
    const r = this.db.prepare("SELECT * FROM apps WHERE bot_user_id = ?").get(botUserId) as
      Parameters<Store["toApp"]>[0] | undefined;
    return r ? this.toApp(r) : null;
  }

  /**
   * The key an app signs with. Admin-visible by design — the receiving end
   * needs it to verify, exactly as Slack shows a signing secret in app config.
   */
  appSigningSecret(id: ID): string | null {
    const r = this.db.prepare("SELECT signing_secret FROM apps WHERE id = ?").get(id) as
      { signing_secret: string } | undefined;
    return r?.signing_secret ?? null;
  }

  private toApp(r: {
    id: string;
    name: string;
    bot_user_id: string;
    created_by: string;
    created_at: number;
    interactivity_url?: string;
    scopes?: string;
  }): App {
    return {
      id: r.id,
      name: r.name,
      botUserId: r.bot_user_id,
      createdBy: r.created_by,
      createdAt: r.created_at,
      interactivityUrl: r.interactivity_url ?? "",
      scopes: scopeList(parseJsonArray(r.scopes)),
    };
  }

  getApp(id: ID): App | null {
    const r = this.db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as
      Parameters<Store["toApp"]>[0] | undefined;
    return r ? this.toApp(r) : null;
  }

  listApps(): App[] {
    const rows = this.db
      .prepare("SELECT * FROM apps ORDER BY created_at DESC")
      .all() as unknown as Parameters<Store["toApp"]>[0][];
    return rows.map((r) => this.toApp(r));
  }

  deleteApp(id: ID): void {
    // Tokens and hooks are meaningless without their app.
    this.db.prepare("DELETE FROM slash_commands WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM event_subscriptions WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM webhooks WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM app_tokens WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM apps WHERE id = ?").run(id);
  }

  addAppToken(appId: ID, tokenHash: string): void {
    this.db
      .prepare("INSERT INTO app_tokens (token_hash, app_id, created_at) VALUES (?, ?, ?)")
      .run(tokenHash, appId, Date.now());
  }

  /**
   * Swaps every token an app holds for one new one. The old ones stop working
   * with this write rather than after some overlap: rotating is what someone
   * does when a token has leaked, and a window in which both work is a window
   * in which the leaked one still does.
   */
  replaceAppTokens(appId: ID, tokenHash: string): void {
    this.db.prepare("DELETE FROM app_tokens WHERE app_id = ?").run(appId);
    this.addAppToken(appId, tokenHash);
  }

  setAppSigningSecret(appId: ID, signingSecret: string): boolean {
    return (
      this.db.prepare("UPDATE apps SET signing_secret = ? WHERE id = ?").run(signingSecret, appId)
        .changes > 0
    );
  }

  /** The app a bot token belongs to, or null if it is unknown. */
  /**
   * The app a bot token belongs to. A deactivated bot user is refused here as
   * well as at the login form: silencing a misbehaving integration should not
   * mean deleting it and losing its configuration.
   */
  appForToken(tokenHash: string): App | null {
    const r = this.db
      .prepare(
        `SELECT a.* FROM app_tokens t
         JOIN apps a ON a.id = t.app_id
         JOIN users u ON u.id = a.bot_user_id
         WHERE t.token_hash = ? AND u.deactivated = 0`,
      )
      .get(tokenHash) as Parameters<Store["toApp"]>[0] | undefined;
    return r ? this.toApp(r) : null;
  }

  createWebhook(input: { appId: ID; channelId: ID; tokenHash: string }): Webhook {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO webhooks (id, app_id, channel_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, input.appId, input.channelId, input.tokenHash, now);
    return { id, appId: input.appId, channelId: input.channelId, createdAt: now };
  }

  /** A new secret for an existing webhook, which keeps its channel and its id. */
  replaceWebhookToken(id: ID, tokenHash: string): Webhook | null {
    const changed = this.db
      .prepare("UPDATE webhooks SET token_hash = ? WHERE id = ?")
      .run(tokenHash, id).changes;
    if (changed === 0) return null;
    const r = this.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as {
      id: string;
      app_id: string;
      channel_id: string;
      created_at: number;
    };
    return { id: r.id, appId: r.app_id, channelId: r.channel_id, createdAt: r.created_at };
  }

  /** Resolves an incoming webhook secret to its app and target channel. */
  webhookForToken(tokenHash: string): { webhook: Webhook; app: App } | null {
    const r = this.db.prepare("SELECT * FROM webhooks WHERE token_hash = ?").get(tokenHash) as
      { id: string; app_id: string; channel_id: string; created_at: number } | undefined;
    if (!r) return null;
    const app = this.getApp(r.app_id);
    // Same as a bot token: a deactivated bot's webhooks go quiet too.
    if (!app || this.people.get(app.botUserId)?.deactivated) return null;
    return {
      webhook: { id: r.id, appId: r.app_id, channelId: r.channel_id, createdAt: r.created_at },
      app,
    };
  }

  getWebhook(id: ID): Webhook | null {
    const r = this.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as
      { id: string; app_id: string; channel_id: string; created_at: number } | undefined;
    return r
      ? { id: r.id, appId: r.app_id, channelId: r.channel_id, createdAt: r.created_at }
      : null;
  }

  listWebhooks(appId: ID): Webhook[] {
    const rows = this.db
      .prepare("SELECT * FROM webhooks WHERE app_id = ? ORDER BY created_at")
      .all(appId) as unknown as {
      id: string;
      app_id: string;
      channel_id: string;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      appId: r.app_id,
      channelId: r.channel_id,
      createdAt: r.created_at,
    }));
  }

  deleteWebhook(id: ID): boolean {
    return this.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id).changes > 0;
  }

  // ---------- slash commands ----------

  private toCommand(r: {
    id: string;
    app_id: string;
    command: string;
    url: string;
    description: string;
    usage_hint: string;
    created_at: number;
  }): SlashCommand {
    return {
      id: r.id,
      appId: r.app_id,
      command: r.command,
      url: r.url,
      description: r.description,
      usageHint: r.usage_hint,
      createdAt: r.created_at,
    };
  }

  createSlashCommand(input: {
    appId: ID;
    command: string;
    url: string;
    description: string;
    usageHint: string;
  }): SlashCommand {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO slash_commands (id, app_id, command, url, description, usage_hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.appId, input.command, input.url, input.description, input.usageHint, now);
    return { id, ...input, createdAt: now };
  }

  /** Looks a command up by the word the user typed, without its slash. */
  slashCommandByName(command: string): { command: SlashCommand; app: App } | null {
    const r = this.db.prepare("SELECT * FROM slash_commands WHERE command = ?").get(command) as
      Parameters<Store["toCommand"]>[0] | undefined;
    if (!r) return null;
    const app = this.getApp(r.app_id);
    return app ? { command: this.toCommand(r), app } : null;
  }

  getSlashCommand(id: ID): SlashCommand | null {
    const r = this.db.prepare("SELECT * FROM slash_commands WHERE id = ?").get(id) as
      Parameters<Store["toCommand"]>[0] | undefined;
    return r ? this.toCommand(r) : null;
  }

  listSlashCommands(appId: ID): SlashCommand[] {
    const rows = this.db
      .prepare("SELECT * FROM slash_commands WHERE app_id = ? ORDER BY command")
      .all(appId) as unknown as Parameters<Store["toCommand"]>[0][];
    return rows.map((r) => this.toCommand(r));
  }

  /** Every command in the workspace — what the composer's hint list shows. */
  listAllSlashCommands(): SlashCommand[] {
    const rows = this.db
      .prepare("SELECT * FROM slash_commands ORDER BY command")
      .all() as unknown as Parameters<Store["toCommand"]>[0][];
    return rows.map((r) => this.toCommand(r));
  }

  deleteSlashCommand(id: ID): boolean {
    return this.db.prepare("DELETE FROM slash_commands WHERE id = ?").run(id).changes > 0;
  }

  // ---------- outgoing event subscriptions ----------

  private toSubscription(r: {
    id: string;
    app_id: string;
    url: string;
    event_types: string;
    created_at: number;
    dropped_count?: number;
    pending_count?: number;
    failed_count?: number;
    retrying_count?: number;
    last_error?: string | null;
    last_failed_at?: number | null;
  }): EventSubscription {
    return {
      id: r.id,
      appId: r.app_id,
      url: r.url,
      eventTypes: JSON.parse(r.event_types) as AppEventType[],
      createdAt: r.created_at,
      ...(r.pending_count !== undefined
        ? {
            delivery: {
              pending: r.pending_count,
              failed: r.failed_count ?? 0,
              retrying: r.retrying_count ?? 0,
              dropped: r.dropped_count ?? 0,
              lastError: r.last_error ?? null,
              lastFailedAt: r.last_failed_at ?? null,
            },
          }
        : {}),
    };
  }

  createSubscription(input: {
    appId: ID;
    url: string;
    eventTypes: AppEventType[];
  }): EventSubscription {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO event_subscriptions (id, app_id, url, event_types, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, input.appId, input.url, JSON.stringify(input.eventTypes), now);
    return { id, ...input, createdAt: now };
  }

  listSubscriptions(appId: ID): EventSubscription[] {
    const rows = this.db
      .prepare(
        `SELECT s.*,
          (SELECT COUNT(*) FROM event_deliveries d
           WHERE d.subscription_id = s.id AND d.failed_at IS NULL) AS pending_count,
          (SELECT COUNT(*) FROM event_deliveries d
           WHERE d.subscription_id = s.id AND d.failed_at IS NOT NULL
             AND d.retry_requested = 0) AS failed_count,
          (SELECT COUNT(*) FROM event_deliveries d
           WHERE d.subscription_id = s.id AND d.retry_requested = 1) AS retrying_count,
          (SELECT d.last_error FROM event_deliveries d
           WHERE d.subscription_id = s.id AND d.failed_at IS NOT NULL
           ORDER BY d.failed_at DESC, d.id DESC LIMIT 1) AS last_error,
          (SELECT d.failed_at FROM event_deliveries d
           WHERE d.subscription_id = s.id AND d.failed_at IS NOT NULL
           ORDER BY d.failed_at DESC, d.id DESC LIMIT 1) AS last_failed_at
         FROM event_subscriptions s WHERE s.app_id = ? ORDER BY s.created_at`,
      )
      .all(appId) as unknown as Parameters<Store["toSubscription"]>[0][];
    return rows.map((r) => this.toSubscription(r));
  }

  getSubscription(id: ID): EventSubscription | null {
    const row = this.db.prepare("SELECT * FROM event_subscriptions WHERE id = ?").get(id) as
      Parameters<Store["toSubscription"]>[0] | undefined;
    return row ? this.toSubscription(row) : null;
  }

  /** Every subscription plus its app, so delivery needs one query per event. */
  listAllSubscriptions(): { subscription: EventSubscription; app: App }[] {
    const rows = this.db
      .prepare(
        "SELECT s.*, a.id AS a_id, a.name AS a_name, a.bot_user_id, a.created_by, a.created_at AS a_created_at, a.scopes AS a_scopes" +
          " FROM event_subscriptions s JOIN apps a ON a.id = s.app_id" +
          " JOIN users u ON u.id = a.bot_user_id WHERE u.deactivated = 0",
      )
      .all() as unknown as (Parameters<Store["toSubscription"]>[0] & {
      a_id: string;
      a_name: string;
      bot_user_id: string;
      created_by: string;
      a_created_at: number;
      a_scopes: string;
    })[];
    return rows.map((r) => ({
      subscription: this.toSubscription(r),
      app: this.toApp({
        id: r.a_id,
        name: r.a_name,
        bot_user_id: r.bot_user_id,
        created_by: r.created_by,
        created_at: r.a_created_at,
        scopes: r.a_scopes,
      }),
    }));
  }

  deleteSubscription(id: ID): boolean {
    return this.db.prepare("DELETE FROM event_subscriptions WHERE id = ?").run(id).changes > 0;
  }

  // ---------- durable outgoing event delivery ----------

  /**
   * The most events one endpoint may have waiting. Delivery is ordered, so a
   * receiver that stops answering holds up everything behind it; without a
   * ceiling its queue would grow for as long as the workspace stays busy, and
   * every row carries a full event body. Past the ceiling the event is counted
   * as dropped instead, which is visible to an administrator and bounded.
   */
  static readonly MAX_PENDING_DELIVERIES = 500;
  /**
   * The most events given up on that one endpoint keeps for an administrator
   * to retry (REV-15). A dead endpoint fails a full queue every few hours, so
   * a week's history would otherwise be thousands of rows; past this the
   * oldest go, counted as dropped. With message text capped at 4,000
   * characters, an endpoint's waiting and given-up rows stay within tens of
   * megabytes.
   */
  static readonly MAX_FAILED_DELIVERIES = 1_000;

  /** True if the event was queued, false if the backlog was already full. */
  enqueueEventDelivery(
    subscriptionId: ID,
    channelId: ID | null,
    eventSeq: number,
    body: string,
    now = Date.now(),
    /** The message whose words the body carries, so an edit or delete can find it. */
    messageId: ID | null = null,
  ): boolean {
    // OFFSET stops the scan at the ceiling rather than counting a long backlog
    // on every event.
    const full = this.db
      .prepare(
        "SELECT 1 FROM event_deliveries WHERE subscription_id = ? AND failed_at IS NULL LIMIT 1 OFFSET ?",
      )
      .get(subscriptionId, Store.MAX_PENDING_DELIVERIES - 1);
    if (full) {
      this.db
        .prepare("UPDATE event_subscriptions SET dropped_count = dropped_count + 1 WHERE id = ?")
        .run(subscriptionId);
      return false;
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO event_deliveries
           (id, subscription_id, channel_id, event_seq, body, next_attempt_at, created_at, message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ulid(), subscriptionId, channelId, eventSeq, body, now, now, messageId);
    return true;
  }

  /**
   * At most one event per subscription is returned. An older retry blocks newer
   * events for that endpoint, preserving event-sequence order. Subscriptions in
   * `busy` (an event of theirs is already on its way) are left out entirely.
   */
  dueEventDeliveries(
    now = Date.now(),
    limit = 10,
    busy: readonly ID[] = [],
  ): {
    id: ID;
    subscriptionId: ID;
    eventSeq: number;
    body: string;
    attempts: number;
    url: string;
    signingSecret: string;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.subscription_id, d.event_seq, d.body, d.attempts,
                s.url, a.signing_secret
         FROM event_deliveries d
         JOIN event_subscriptions s ON s.id = d.subscription_id
         JOIN apps a ON a.id = s.app_id
         JOIN users u ON u.id = a.bot_user_id
         WHERE d.failed_at IS NULL AND d.next_attempt_at <= ? AND u.deactivated = 0
           AND (d.channel_id IS NULL OR EXISTS (
             SELECT 1 FROM channel_members cm
             WHERE cm.channel_id = d.channel_id AND cm.user_id = a.bot_user_id
           ))
           AND NOT EXISTS (
             SELECT 1 FROM event_deliveries older
             WHERE older.subscription_id = d.subscription_id
               AND older.failed_at IS NULL
               AND (older.event_seq < d.event_seq OR
                    (older.event_seq = d.event_seq AND older.id < d.id))
           )
           AND d.subscription_id NOT IN (SELECT value FROM json_each(?))
         ORDER BY d.next_attempt_at, d.event_seq, d.id LIMIT ?`,
      )
      .all(now, JSON.stringify(busy), limit) as unknown as {
      id: string;
      subscription_id: string;
      event_seq: number;
      body: string;
      attempts: number;
      url: string;
      signing_secret: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      subscriptionId: r.subscription_id,
      eventSeq: r.event_seq,
      body: r.body,
      attempts: r.attempts,
      url: r.url,
      signingSecret: r.signing_secret,
    }));
  }

  completeEventDelivery(id: ID, subscriptionId: ID): boolean {
    const done = this.db.prepare("DELETE FROM event_deliveries WHERE id = ?").run(id).changes > 0;
    // A slot has freed up: an event waiting to be retried takes it before a
    // new event can, so a retry drains however busy the workspace is.
    if (done) this.promoteEventRetries(subscriptionId);
    // Events lost to a full backlog stop being current news once the endpoint
    // is answering again. The guard keeps this free on the usual path, where
    // there is nothing to clear.
    this.db
      .prepare(
        "UPDATE event_subscriptions SET dropped_count = 0 WHERE id = ? AND dropped_count != 0",
      )
      .run(subscriptionId);
    return done;
  }

  failEventDelivery(
    id: ID,
    error: string,
    nextAttemptAt: number,
    maxAttempts: number,
    now = Date.now(),
  ): { attempts: number; terminal: boolean } | null {
    this.db
      .prepare(
        `UPDATE event_deliveries SET
           attempts = attempts + 1,
           next_attempt_at = ?,
           last_error = ?,
           failed_at = CASE WHEN attempts + 1 >= ? THEN ? ELSE NULL END
         WHERE id = ?`,
      )
      .run(nextAttemptAt, error.slice(0, 500), maxAttempts, now, id);
    const row = this.db
      .prepare("SELECT attempts, failed_at FROM event_deliveries WHERE id = ?")
      .get(id) as { attempts: number; failed_at: number | null } | undefined;
    return row ? { attempts: row.attempts, terminal: row.failed_at !== null } : null;
  }

  /**
   * Gives up on everything still queued for one endpoint.
   *
   * Called once a delivery has exhausted its attempts. Spending the full ladder
   * on each event in turn would mean a dead endpoint is retried forever while
   * its queue keeps growing, and would leave an administrator repairing it with
   * a backlog that drains one event every few hours. Failing the rest together
   * makes "retry failed" the single way back, and it restores them in order.
   */
  abandonEventBacklog(subscriptionId: ID, error: string, now = Date.now()): number {
    const abandoned = Number(
      this.db
        .prepare(
          `UPDATE event_deliveries SET failed_at = ?, last_error = ?
           WHERE subscription_id = ? AND failed_at IS NULL`,
        )
        .run(now, error.slice(0, 500), subscriptionId).changes,
    );
    // The endpoint failed again, so what was still waiting to be retried waits
    // for another retry, kept with the rest of what was given up on. It is
    // given up on now, so it is kept for the whole history window from now
    // rather than expiring at once for having first failed long ago (F04).
    this.db
      .prepare(
        "UPDATE event_deliveries SET retry_requested = 0, failed_at = ? WHERE subscription_id = ? AND retry_requested = 1",
      )
      .run(now, subscriptionId);
    this.trimFailedEventDeliveries(subscriptionId);
    return abandoned;
  }

  /**
   * Keeps an endpoint's given-up events within MAX_FAILED_DELIVERIES, the
   * newest kept, the rest counted as dropped (REV-15).
   */
  private trimFailedEventDeliveries(subscriptionId: ID): void {
    const trimmed = Number(
      this.db
        .prepare(
          `DELETE FROM event_deliveries WHERE id IN (
             SELECT id FROM event_deliveries
             WHERE subscription_id = ? AND failed_at IS NOT NULL AND retry_requested = 0
             ORDER BY event_seq DESC, id DESC LIMIT -1 OFFSET ?)`,
        )
        .run(subscriptionId, Store.MAX_FAILED_DELIVERIES).changes,
    );
    if (trimmed > 0)
      this.db
        .prepare("UPDATE event_subscriptions SET dropped_count = dropped_count + ? WHERE id = ?")
        .run(trimmed, subscriptionId);
  }

  /**
   * Moves events waiting to be retried into the endpoint's queue as far as
   * it has room under MAX_PENDING_DELIVERIES, oldest first (REV-15). Returns
   * how many went in.
   */
  private promoteEventRetries(subscriptionId: ID, now = Date.now()): number {
    const waiting = this.db
      .prepare(
        "SELECT 1 FROM event_deliveries WHERE subscription_id = ? AND retry_requested = 1 LIMIT 1",
      )
      .get(subscriptionId);
    if (!waiting) return 0;
    const { queued } = this.db
      .prepare(
        "SELECT COUNT(*) AS queued FROM event_deliveries WHERE subscription_id = ? AND failed_at IS NULL",
      )
      .get(subscriptionId) as { queued: number };
    const room = Store.MAX_PENDING_DELIVERIES - queued;
    if (room <= 0) return 0;
    return Number(
      this.db
        .prepare(
          `UPDATE event_deliveries SET attempts = 0, next_attempt_at = ?, failed_at = NULL,
             last_error = NULL, retry_requested = 0
           WHERE id IN (SELECT id FROM event_deliveries
             WHERE subscription_id = ? AND retry_requested = 1
             ORDER BY event_seq, id LIMIT ?)`,
        )
        .run(now, subscriptionId, room).changes,
    );
  }

  /** Every endpoint's waiting retries, as far as each has room. Returns how many went in. */
  promoteAllEventRetries(now = Date.now()): number {
    const subscriptions = this.db
      .prepare("SELECT DISTINCT subscription_id FROM event_deliveries WHERE retry_requested = 1")
      .all() as { subscription_id: string }[];
    let promoted = 0;
    for (const { subscription_id } of subscriptions)
      promoted += this.promoteEventRetries(subscription_id, now);
    return promoted;
  }

  /**
   * Forgets given-up events older than the history window. An event an
   * administrator has asked to retry is not history but accepted work waiting
   * for room, however long the queue stays full, so it stays until it goes
   * out or the endpoint fails again (F04).
   */
  pruneEventDeliveries(failedBefore: number): void {
    this.db
      .prepare("DELETE FROM event_deliveries WHERE failed_at < ? AND retry_requested = 0")
      .run(failedBefore);
  }

  /**
   * Asks for an endpoint's given-up events to be sent again (REV-15). They go
   * back into its queue only as far as it has room, oldest first; the rest are
   * kept, waiting, and take each slot that frees up as the endpoint answers.
   * Returns how many were asked for, and how many still wait for room.
   */
  retryFailedEventDeliveries(
    subscriptionId: ID,
    now = Date.now(),
  ): { retried: number; waiting: number } {
    const retried = Number(
      this.db
        .prepare(
          `UPDATE event_deliveries SET retry_requested = 1
           WHERE subscription_id = ? AND failed_at IS NOT NULL AND retry_requested = 0`,
        )
        .run(subscriptionId).changes,
    );
    this.promoteEventRetries(subscriptionId, now);
    const { waiting } = this.db
      .prepare(
        "SELECT COUNT(*) AS waiting FROM event_deliveries WHERE subscription_id = ? AND retry_requested = 1",
      )
      .get(subscriptionId) as { waiting: number };
    // The tally is what an administrator was shown before deciding to retry, so
    // clearing it here marks that report as read rather than losing it.
    this.db
      .prepare("UPDATE event_subscriptions SET dropped_count = 0 WHERE id = ?")
      .run(subscriptionId);
    return { retried, waiting };
  }

  // ---------- audit log ----------

  /** Call inside the transaction that makes the change, so neither exists without the other. */
  recordAudit(
    entry: {
      actorId: ID | null;
      action: AuditAction;
      targetType: AuditTargetType;
      targetId: string | null;
      details?: AuditEntry["details"];
    },
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        "INSERT INTO audit_log (id, at, actor_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        ulid(now),
        now,
        entry.actorId,
        entry.action,
        entry.targetType,
        entry.targetId,
        JSON.stringify(entry.details ?? {}),
      );
  }

  /**
   * Newest first. `before` is the id of the last entry already seen.
   *
   * Ordered by insertion rather than by id: ids made in the same millisecond
   * are not ordered among themselves, and two changes a moment apart must not
   * be listed the wrong way round.
   */
  listAudit(opts: { before?: ID; limit: number }): AuditEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_log
         ${opts.before ? "WHERE rowid < (SELECT rowid FROM audit_log WHERE id = ?)" : ""}
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...(opts.before ? [opts.before] : []), opts.limit) as {
      id: string;
      at: number;
      actor_id: string | null;
      action: AuditAction;
      target_type: AuditTargetType;
      target_id: string | null;
      details: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actorId: r.actor_id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      details: JSON.parse(r.details) as AuditEntry["details"],
    }));
  }

  // ---------- event log ----------

  appendEvent(event: WorkspaceEvent, channelId: ID | null): EventEnvelope {
    const res = this.db
      .prepare(
        "INSERT INTO events (channel_id, type, payload, created_at, message_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(channelId, event.type, JSON.stringify(event), Date.now(), Store.eventMessageId(event));
    return { seq: Number(res.lastInsertRowid), event };
  }

  /**
   * Which message an event is about, or null if it is not about one. This is
   * stored beside the payload so that deleting a message can find every copy of
   * its words without reading the whole log.
   */
  static eventMessageId(event: WorkspaceEvent): ID | null {
    if (event.type === "message.created" || event.type === "message.updated") {
      return event.message.id;
    }
    if (event.type === "message.deleted") return event.messageId;
    return null;
  }

  /**
   * Takes the text and attachment names of one message out of the event log,
   * leaving the events themselves in place.
   *
   * The events have to stay: a client catching up replays them in order, and a
   * missing sequence number is indistinguishable from a log it has fallen off
   * the end of, which would send it back for a whole new snapshot. What it
   * replays instead is a message with no words in it, immediately followed by
   * the edit or the deletion that supersedes it, so the state it arrives at is
   * the same one it would have reached anyway.
   *
   * Returns how many events were changed.
   */
  redactMessageEvents(messageId: ID, keepSeq?: number): number {
    const rows = this.db
      .prepare(
        `SELECT seq, payload FROM events
         WHERE message_id = ? AND type IN ('message.created', 'message.updated')
         ${keepSeq === undefined ? "" : "AND seq != ?"}`,
      )
      .all(messageId, ...(keepSeq === undefined ? [] : [keepSeq])) as {
      seq: number;
      payload: string;
    }[];
    const changed = this.redactEventRows(rows);
    this.redactQueuedDeliveries(
      this.db
        .prepare(
          `SELECT id, body FROM event_deliveries WHERE message_id = ?
           ${keepSeq === undefined ? "" : "AND event_seq != ?"}`,
        )
        .all(messageId, ...(keepSeq === undefined ? [] : [keepSeq])) as {
        id: string;
        body: string;
      }[],
    );
    return changed;
  }

  /**
   * Takes a message's words out of app events still waiting to be delivered,
   * or that gave up. Those are copies OwnBase still holds, and an edit or a
   * deletion is often someone taking back what they wrote. The events stay,
   * in order and under the same id: a receiver gets a message with no words,
   * then the edit or deletion that supersedes it, as a client replaying the
   * log does. What has already been delivered is the app's, and cannot be
   * called back.
   */
  redactQueuedDeliveries(rows: { id: string; body: string }[]): void {
    const update = this.db.prepare("UPDATE event_deliveries SET body = ? WHERE id = ?");
    for (const row of rows) {
      let body: {
        ownbase?: { type?: string };
        event?: { text?: string; message?: { text?: string } };
      };
      try {
        body = JSON.parse(row.body);
      } catch {
        continue;
      }
      const type = body.ownbase?.type;
      if (type === "message.created" && body.event) body.event.text = "";
      else if (type === "message.updated" && body.event?.message) body.event.message.text = "";
      else continue;
      const after = JSON.stringify(body);
      if (after !== row.body) update.run(after, row.id);
    }
  }

  /**
   * Brings the log's copies of these messages, quoted in replies to them, up
   * to date: an edit's new words, or nothing at all once they are deleted
   * (null). A reply's events stay where they are, as with `redactMessageEvents`,
   * and the original's own edit or deletion still follows them on replay.
   */
  requoteEvents(quotedIds: ID[], now: Pick<ReplyReference, "text" | "fileCount"> | null): void {
    if (quotedIds.length === 0) return;
    const quoted = new Set(quotedIds);
    const ph = quotedIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT seq, payload FROM events WHERE type IN ('message.created', 'message.updated')
         AND message_id IN (SELECT id FROM messages WHERE reply_to_id IN (${ph}))`,
      )
      .all(...quotedIds) as { seq: number; payload: string }[];
    const update = this.db.prepare("UPDATE events SET payload = ? WHERE seq = ?");
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
   * As `requoteEvents`, for forwards: the log's copies of messages forwarding
   * these follow an edit's new words, or say the original is gone (null). A
   * hidden one shows no words either way.
   */
  reforwardEvents(ids: ID[], now: { text: string } | null): void {
    if (ids.length === 0) return;
    const forwarded = new Set(ids);
    const ph = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT seq, payload FROM events WHERE type IN ('message.created', 'message.updated')
         AND message_id IN (SELECT id FROM messages WHERE forwarded_from_id IN (${ph}))`,
      )
      .all(...ids) as { seq: number; payload: string }[];
    const update = this.db.prepare("UPDATE events SET payload = ? WHERE seq = ?");
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

  redactEventRows(rows: { seq: number; payload: string }[]): number {
    const update = this.db.prepare("UPDATE events SET payload = ? WHERE seq = ?");
    let changed = 0;
    for (const row of rows) {
      const event = JSON.parse(row.payload) as WorkspaceEvent;
      if (event.type !== "message.created" && event.type !== "message.updated") continue;
      const before = row.payload;
      event.message.text = "";
      // A filename is often as telling as the message it was attached to.
      event.message.files = [];
      // Labels, values and URLs can be as revealing as the message's words.
      // Superseded/deleted copies must not transmit their buttons on replay.
      event.message.actions = [];
      // A preview names the link and says what is there.
      if (event.message.previews) event.message.previews = [];
      // A poll's choices are words too.
      delete event.message.poll;
      const after = JSON.stringify(event);
      if (after === before) continue;
      update.run(after, row.seq);
      changed++;
    }
    return changed;
  }

  currentSeq(): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(seq), 0) s FROM events").get() as { s: number };
    return r.s;
  }

  minSeq(): number {
    const r = this.db.prepare("SELECT COALESCE(MIN(seq), 0) s FROM events").get() as { s: number };
    return r.s;
  }

  /** Events after `afterSeq` visible to the user. Null = too far behind, client must resync. */
  eventsSince(afterSeq: number, userId: ID, limit = 2000): EventEnvelope[] | null {
    const min = this.minSeq();
    if (min > 0 && afterSeq < min - 1) return null;
    const rows = this.db
      .prepare(
        `SELECT e.seq, e.payload FROM events e
         LEFT JOIN channels c ON c.id = e.channel_id
         WHERE e.seq > ? AND (
           e.channel_id IS NULL
           OR c.type = 'public'
           OR EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = e.channel_id AND m.user_id = ?)
         )
         ORDER BY e.seq LIMIT ?`,
      )
      .all(afterSeq, userId, limit + 1) as { seq: number; payload: string }[];
    if (rows.length > limit) return null;
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload) as WorkspaceEvent }));
  }

  pruneEvents(keep = 20000): void {
    this.db
      .prepare("DELETE FROM events WHERE seq <= (SELECT COALESCE(MAX(seq), 0) FROM events) - ?")
      .run(keep);
  }

  /** The queues and sizes `WorkspaceStatus` reports: counts only (OPS-10). */
  operationalCounts(): {
    databaseBytes: number;
    deliveries: { waiting: number; oldestWaitingAt: number | null; failed: number };
    scheduled: { queued: number; held: number; failed: number };
  } {
    const pages = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
    const size = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
    const deliveries = this.db
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE failed_at IS NULL) AS waiting,
                MIN(created_at) FILTER (WHERE failed_at IS NULL) AS oldest,
                COUNT(*) FILTER (WHERE failed_at IS NOT NULL) AS failed
         FROM event_deliveries`,
      )
      .get() as { waiting: number; oldest: number | null; failed: number };
    const scheduled = this.db
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE status = 'queued') AS queued,
                COUNT(*) FILTER (WHERE status = 'held') AS held,
                COUNT(*) FILTER (WHERE status = 'failed') AS failed
         FROM scheduled_messages`,
      )
      .get() as { queued: number; held: number; failed: number };
    return {
      databaseBytes: pages.page_count * size.page_size,
      deliveries: {
        waiting: deliveries.waiting,
        oldestWaitingAt: deliveries.oldest,
        failed: deliveries.failed,
      },
      scheduled,
    };
  }
}
