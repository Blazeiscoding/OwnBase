import {
  APP_SCOPES,
  type App,
  type AppEventType,
  type AppScope,
  type EventSubscription,
  type ID,
  type SlashCommand,
  type User,
  type Webhook,
} from "@ownbase/protocol";
import type { DatabaseSync } from "node:sqlite";
import { ulid } from "../ids.js";
import type { Store } from "../store.js";

interface AppRow {
  id: string;
  name: string;
  bot_user_id: string;
  created_by: string;
  created_at: number;
  signing_secret: string;
  interactivity_url: string;
  scopes: string;
}

interface WebhookRow {
  id: string;
  app_id: string;
  channel_id: string;
  token_hash: string;
  created_at: number;
}

interface CommandRow {
  id: string;
  app_id: string;
  command: string;
  url: string;
  description: string;
  usage_hint: string;
  created_at: number;
}

interface SubscriptionRow {
  id: string;
  app_id: string;
  url: string;
  event_types: string;
  created_at: number;
  dropped_count: number;
}

/** A subscription with how its deliveries are going, as the Apps dialog shows it. */
interface SubscriptionStatusRow extends SubscriptionRow {
  pending_count: number;
  failed_count: number;
  retrying_count: number;
  last_error: string | null;
  last_failed_at: number | null;
}

/** Known scopes only, each once, in one order, so two lists compare as text. */
function scopeList(scopes: readonly unknown[]): AppScope[] {
  return APP_SCOPES.filter((scope) => scopes.includes(scope));
}

/** A stored JSON list, or empty when it is missing or not a list. */
function parseJsonArray(text: string): unknown[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const toApp = (r: AppRow): App => ({
  id: r.id,
  name: r.name,
  botUserId: r.bot_user_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  interactivityUrl: r.interactivity_url,
  scopes: scopeList(parseJsonArray(r.scopes)),
});

const toWebhook = (r: WebhookRow): Webhook => ({
  id: r.id,
  appId: r.app_id,
  channelId: r.channel_id,
  createdAt: r.created_at,
});

const toCommand = (r: CommandRow): SlashCommand => ({
  id: r.id,
  appId: r.app_id,
  command: r.command,
  url: r.url,
  description: r.description,
  usageHint: r.usage_hint,
  createdAt: r.created_at,
});

const toSubscription = (r: SubscriptionRow): EventSubscription => ({
  id: r.id,
  appId: r.app_id,
  url: r.url,
  eventTypes: JSON.parse(r.event_types) as AppEventType[],
  createdAt: r.created_at,
});

/** The app columns under an `a_` prefix, for a query that joins them to another table. */
const APP_COLUMNS_AS_A = [
  "id",
  "name",
  "bot_user_id",
  "created_by",
  "created_at",
  "signing_secret",
  "interactivity_url",
  "scopes",
]
  .map((column) => `a.${column} AS a_${column}`)
  .join(", ");

type PrefixedAppRow = { [K in keyof AppRow as `a_${K}`]: AppRow[K] };

const unprefixApp = (r: PrefixedAppRow): AppRow => ({
  id: r.a_id,
  name: r.a_name,
  bot_user_id: r.a_bot_user_id,
  created_by: r.a_created_by,
  created_at: r.a_created_at,
  signing_secret: r.a_signing_secret,
  interactivity_url: r.a_interactivity_url,
  scopes: r.a_scopes,
});

/**
 * Apps and what they are reached by: their bot users and tokens, incoming
 * webhooks, slash commands and event subscriptions.
 */
export class AppStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Store,
  ) {}

  /** Creates the bot user that an app posts as. */
  createBotUser(handle: string, displayName: string, passwordHash: string, salt: string): User {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO users (id, handle, display_name, password_hash, salt, role, is_bot, created_at)
         VALUES (?, ?, ?, ?, ?, 'member', 1, ?)`,
      )
      .run(id, handle, displayName, passwordHash, salt, Date.now());
    return this.store.people.get(id)!;
  }

  create(input: {
    name: string;
    botUserId: ID;
    createdBy: ID;
    signingSecret: string;
    scopes: readonly AppScope[];
  }): App {
    const id = ulid();
    const now = Date.now();
    const scopes = scopeList(input.scopes);
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
  setScopes(id: ID, scopes: readonly AppScope[]): boolean {
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
  forBotUser(botUserId: ID): App | null {
    const r = this.db.prepare("SELECT * FROM apps WHERE bot_user_id = ?").get(botUserId) as
      AppRow | undefined;
    return r ? toApp(r) : null;
  }

  /**
   * The key an app signs with. Admin-visible by design — the receiving end
   * needs it to verify, exactly as Slack shows a signing secret in app config.
   */
  signingSecret(id: ID): string | null {
    const r = this.db.prepare("SELECT signing_secret FROM apps WHERE id = ?").get(id) as
      Pick<AppRow, "signing_secret"> | undefined;
    return r?.signing_secret ?? null;
  }

  setSigningSecret(appId: ID, signingSecret: string): boolean {
    return (
      this.db.prepare("UPDATE apps SET signing_secret = ? WHERE id = ?").run(signingSecret, appId)
        .changes > 0
    );
  }

  get(id: ID): App | null {
    const r = this.db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as AppRow | undefined;
    return r ? toApp(r) : null;
  }

  list(): App[] {
    const rows = this.db
      .prepare("SELECT * FROM apps ORDER BY created_at DESC")
      .all() as unknown as AppRow[];
    return rows.map(toApp);
  }

  delete(id: ID): void {
    // Tokens and hooks are meaningless without their app.
    this.db.prepare("DELETE FROM slash_commands WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM event_subscriptions WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM webhooks WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM app_tokens WHERE app_id = ?").run(id);
    this.db.prepare("DELETE FROM apps WHERE id = ?").run(id);
  }

  addToken(appId: ID, tokenHash: string): void {
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
  replaceTokens(appId: ID, tokenHash: string): void {
    this.db.prepare("DELETE FROM app_tokens WHERE app_id = ?").run(appId);
    this.addToken(appId, tokenHash);
  }

  /**
   * The app a bot token belongs to. A deactivated bot user is refused here as
   * well as at the login form: silencing a misbehaving integration should not
   * mean deleting it and losing its configuration.
   */
  forToken(tokenHash: string): App | null {
    const r = this.db
      .prepare(
        `SELECT a.* FROM app_tokens t
         JOIN apps a ON a.id = t.app_id
         JOIN users u ON u.id = a.bot_user_id
         WHERE t.token_hash = ? AND u.deactivated = 0`,
      )
      .get(tokenHash) as AppRow | undefined;
    return r ? toApp(r) : null;
  }

  // ---------- incoming webhooks ----------

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
    return this.getWebhook(id);
  }

  /** Resolves an incoming webhook secret to its app and target channel. */
  webhookForToken(tokenHash: string): { webhook: Webhook; app: App } | null {
    const r = this.db.prepare("SELECT * FROM webhooks WHERE token_hash = ?").get(tokenHash) as
      WebhookRow | undefined;
    if (!r) return null;
    const app = this.get(r.app_id);
    // Same as a bot token: a deactivated bot's webhooks go quiet too.
    if (!app || this.store.people.get(app.botUserId)?.deactivated) return null;
    return { webhook: toWebhook(r), app };
  }

  getWebhook(id: ID): Webhook | null {
    const r = this.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as
      WebhookRow | undefined;
    return r ? toWebhook(r) : null;
  }

  listWebhooks(appId: ID): Webhook[] {
    const rows = this.db
      .prepare("SELECT * FROM webhooks WHERE app_id = ? ORDER BY created_at")
      .all(appId) as unknown as WebhookRow[];
    return rows.map(toWebhook);
  }

  deleteWebhook(id: ID): boolean {
    return this.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id).changes > 0;
  }

  // ---------- slash commands ----------

  createCommand(input: {
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
  commandByName(command: string): { command: SlashCommand; app: App } | null {
    const r = this.db.prepare("SELECT * FROM slash_commands WHERE command = ?").get(command) as
      CommandRow | undefined;
    if (!r) return null;
    const app = this.get(r.app_id);
    return app ? { command: toCommand(r), app } : null;
  }

  getCommand(id: ID): SlashCommand | null {
    const r = this.db.prepare("SELECT * FROM slash_commands WHERE id = ?").get(id) as
      CommandRow | undefined;
    return r ? toCommand(r) : null;
  }

  listCommands(appId: ID): SlashCommand[] {
    const rows = this.db
      .prepare("SELECT * FROM slash_commands WHERE app_id = ? ORDER BY command")
      .all(appId) as unknown as CommandRow[];
    return rows.map(toCommand);
  }

  /** Every command in the workspace — what the composer's hint list shows. */
  listAllCommands(): SlashCommand[] {
    const rows = this.db
      .prepare("SELECT * FROM slash_commands ORDER BY command")
      .all() as unknown as CommandRow[];
    return rows.map(toCommand);
  }

  deleteCommand(id: ID): boolean {
    return this.db.prepare("DELETE FROM slash_commands WHERE id = ?").run(id).changes > 0;
  }

  // ---------- outgoing event subscriptions ----------

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

  /** An app's subscriptions, each with how its deliveries are going. */
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
      .all(appId) as unknown as SubscriptionStatusRow[];
    return rows.map((r) => ({
      ...toSubscription(r),
      delivery: {
        pending: r.pending_count,
        failed: r.failed_count,
        retrying: r.retrying_count,
        dropped: r.dropped_count,
        lastError: r.last_error,
        lastFailedAt: r.last_failed_at,
      },
    }));
  }

  getSubscription(id: ID): EventSubscription | null {
    const row = this.db.prepare("SELECT * FROM event_subscriptions WHERE id = ?").get(id) as
      SubscriptionRow | undefined;
    return row ? toSubscription(row) : null;
  }

  /** Every subscription of an active bot, with its app, so delivery needs one query per event. */
  allSubscriptions(): { subscription: EventSubscription; app: App }[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, ${APP_COLUMNS_AS_A}
         FROM event_subscriptions s JOIN apps a ON a.id = s.app_id
         JOIN users u ON u.id = a.bot_user_id WHERE u.deactivated = 0`,
      )
      .all() as unknown as (SubscriptionRow & PrefixedAppRow)[];
    return rows.map((r) => ({ subscription: toSubscription(r), app: toApp(unprefixApp(r)) }));
  }

  deleteSubscription(id: ID): boolean {
    return this.db.prepare("DELETE FROM event_subscriptions WHERE id = ?").run(id).changes > 0;
  }
}
