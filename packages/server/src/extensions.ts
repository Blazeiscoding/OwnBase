import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import type { Route, Router } from "./route.js";
import type { Keep, RecordedMessage } from "./messages/store.js";
import type {
  AuditEntry,
  Channel,
  ExtensionStatus,
  ID,
  ServerNotice,
  SettingsPanel,
  SignInMethod,
  User,
} from "@ownbase/protocol";

export type { Keep, RecordedMessage };

/** Refuses a setting an extension cannot use, as the server's own are refused. */
export { ConfigError } from "./config.js";

/**
 * A part of the server that lives outside this package, such as the
 * Enterprise features in ee/ (P6). This package never imports one: whoever
 * puts a server together hands its extensions over, in
 * `ServerOptions.extensions` or, for the command line, to `runServerCli`,
 * and the server calls them at fixed points. Without any, the server is complete.
 */
export interface ServerExtension {
  /** Short, for logs and the workspace status, such as "enterprise". */
  name: string;
  /** Adds its routes, after the server's own and before it listens. */
  register?(context: ExtensionContext): void | Promise<void>;
  /** What the owner and admins read about it in the workspace status. */
  status?(): ExtensionStatus;
  /** Something the owner and admins should see now, under the conversation's header. */
  notice?(): ServerNotice | null;
  /** Ends what it started, as the server stops. */
  stop?(): void | Promise<void>;
  /** Ways to sign in besides a password, on the sign-in screen (P9). */
  signInMethods?(): SignInMethod[];
  /**
   * Whether everyone but the owner signs in the extension's way now. A
   * password then signs in the owner alone, the way back in if the other way
   * breaks, and makes no new account: both are refused with `sso_required`.
   */
  requiresSingleSignOn?(): boolean;
  /** Panels the owner sees in Workspace settings, saved through the extension's own routes. */
  settingsPanels?(): SettingsPanel[];
  /**
   * People and conversations whose messages must stay, as a legal hold asks
   * (P12). Retention skips their messages, and every thread one of them is in.
   * Deleting one is refused for everyone, its author, admins and apps alike,
   * and so is deleting the first message of a thread one of them is in, since
   * that takes the replies with it. Asked each time, so it is kept cheap.
   */
  keeps?(): Keep;
  /**
   * Told a message's words just before an edit replaces them, inside the same
   * change: what it stores of them is saved with the edit or not at all. The
   * server keeps no earlier version itself.
   */
  editing?(earlier: EarlierWords): void;
}

/** The words a message had before an edit (P12). */
export interface EarlierWords {
  messageId: ID;
  channelId: ID;
  userId: ID;
  text: string;
  /** When they were written: the last edit, or when the message was sent. */
  writtenAt: number;
}

/**
 * What an extension keeps, in the workspace's own database: text under keys
 * of its own, kept apart from other extensions' and the server's.
 */
export interface ExtensionStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  list(prefix: string): { key: string; value: string }[];
}

/** What an extension may use of the server it is part of. */
export interface ExtensionContext {
  /**
   * Registers a route the extension declares, as the server registers its
   * own: signed in, checked and validated by its declaration.
   */
  route: Route;
  /** People who can sign in now, as a plan counts them (`planMembers`). */
  memberCount(): number;
  log: FastifyBaseLogger;
  storage: ExtensionStorage;
  users: {
    get(id: string): User | null;
    /** Everyone with an account, apps and guests included, deactivated or not. */
    list(): User[];
    byHandle(handle: string): User | null;
    /**
     * A new member, with no password anyone knows, joined to the public
     * channels as anyone joining is. Refused while nobody owns the workspace,
     * for a handle taken, and for a handle or name joining would refuse.
     */
    create(input: { handle: string; displayName: string }): Promise<User>;
    /**
     * Renames, deactivates or reactivates a person, as an admin would, and
     * tells everyone. Deactivating ends their sessions at once. A change of
     * `deactivated` goes in the audit log as made by `by`, such as "SCIM
     * provisioning". Refused for an app, and for deactivating the owner.
     */
    update(id: string, patch: { displayName?: string; deactivated?: boolean }, by: string): User;
  };
  /** Signs `userId` in, as a password would: a new session, and its token. */
  startSession(userId: string, req: FastifyRequest): { token: string; user: User };
  /** How others reach this server, when it was told (--public-url). */
  publicUrl(): string | undefined;
  /** The administrative record (P12). */
  audit: {
    /**
     * Adds an entry that reads "<who> <did>", such as "changed the legal
     * hold". Never put in it what anyone wrote or a credential.
     */
    record(entry: { actorId: ID | null; did: string; details?: AuditEntry["details"] }): void;
    /** Oldest first, the entries after `afterId`, or from the first; see `AuditLog.after`. */
    after(afterId: ID | null, limit: number): AuditEntry[];
    /** Called soon after entries are written and committed. Returns what stops it. */
    onRecord(listener: () => void): () => void;
  };
  messages: {
    /**
     * Messages written in a time range, by some people or in some
     * conversations, oldest first, a page at a time: thread replies and
     * deleted ones included. A deleted message keeps who wrote it, where and
     * when, and when it was deleted; its words and files are gone. An edited
     * one has its newest words and when they were written.
     */
    recorded(query: {
      from: number;
      to: number;
      userIds: readonly ID[];
      channelIds: readonly ID[];
      afterId?: ID;
      limit: number;
    }): RecordedMessage[];
  };
  /** Every conversation, archived and direct ones included. */
  channels: { list(): Channel[] };
  files: {
    /** An attachment's bytes, or null when the server keeps no files (an in-memory workspace). */
    open(id: ID): Readable | null;
  };
  /**
   * POSTs `body` to an address someone set, through the guard the server's
   * own webhooks use: private addresses are refused unless the host allowed
   * them (--allow-private-hooks), redirects are not followed, and nothing is
   * sent from an isolated copy of the workspace.
   */
  post(
    url: string,
    body: string,
    opts: { contentType: string; headers?: Record<string, string> },
  ): Promise<{ status: number; body: string }>;
  /**
   * A one-time ticket that opens a download route the extension declared
   * with `ticket: true`, for the session `req` was signed in with, as
   * `?download=<token>`.
   */
  ticketFor: Router["ticketFor"];
}

/** A command-line flag an extension reads, as `node:util` parseArgs takes it. */
export interface ExtensionOption {
  type: "string" | "boolean";
}

/**
 * An extension the command line starts the server with. It names the flags it
 * reads and the help it adds, and makes its extension from them, refusing a
 * setting it cannot use with a `ConfigError`.
 */
export interface CommandLineExtension<Env extends string = string> {
  options: Record<string, ExtensionOption>;
  /** The environment variables it reads, each as `OWNBASE_<name>`. */
  env: readonly Env[];
  /** Lines for --help, already indented as the server's own. */
  help: string;
  create(
    values: Record<string, string | boolean | undefined>,
    env: (name: Env) => string | undefined,
  ): ServerExtension | Promise<ServerExtension>;
}
