import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { Route } from "./route.js";
import type {
  ExtensionStatus,
  ServerNotice,
  SettingsPanel,
  SignInMethod,
  User,
} from "@ownbase/protocol";

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
    byHandle(handle: string): User | null;
    /**
     * A new member, with no password anyone knows, joined to the public
     * channels as anyone joining is. Refused while nobody owns the workspace,
     * and for a handle taken.
     */
    create(input: { handle: string; displayName: string }): Promise<User>;
  };
  /** Signs `userId` in, as a password would: a new session, and its token. */
  startSession(userId: string, req: FastifyRequest): { token: string; user: User };
  /** How others reach this server, when it was told (--public-url). */
  publicUrl(): string | undefined;
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
export interface CommandLineExtension {
  options: Record<string, ExtensionOption>;
  /** Lines for --help, already indented as the server's own. */
  help: string;
  create(
    values: Record<string, string | boolean | undefined>,
    env: (name: string) => string | undefined,
  ): ServerExtension | Promise<ServerExtension>;
}
