import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { ExtensionStatus, ServerNotice, User } from "@slackoss/protocol";

/** Refuses a setting an extension cannot use, as the server's own are refused. */
export { ConfigError } from "./config.js";

/**
 * A part of the server that lives outside this package, such as the
 * Enterprise features in ee/ (P6). This package never imports one: whoever
 * puts a server together hands its extensions over, in
 * `ServerOptions.extensions` or, for the command line, through
 * `addCommandLineExtension` before main.ts runs, and the server calls them at
 * fixed points. Without any, the server is complete.
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
}

/** What an extension may use of the server it is part of. */
export interface ExtensionContext {
  /** Routes go here, under /api/ like the server's own. */
  app: FastifyInstance;
  /** The signed-in person, or the request fails as the server's own routes do. */
  requireUser(req: FastifyRequest): User;
  /** The signed-in owner or an admin, or the request fails. */
  requireAdmin(req: FastifyRequest): User;
  /** The signed-in owner, or the request fails. */
  requireOwner(req: FastifyRequest): User;
  /** People who can sign in now, as a plan counts them (`planMembers`). */
  memberCount(): number;
  log: FastifyBaseLogger;
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

const forCommandLine: CommandLineExtension[] = [];

/** Puts an extension in the command line's server. Called before main.ts is imported. */
export function addCommandLineExtension(extension: CommandLineExtension): void {
  forCommandLine.push(extension);
}

/** The command line's extensions, in the order they were added. */
export function commandLineExtensions(): readonly CommandLineExtension[] {
  return forCommandLine;
}
