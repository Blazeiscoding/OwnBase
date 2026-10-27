/**
 * Checking what a host typed before the server acts on it.
 *
 * A bad setting should stop the server at the door with the flag named and the
 * value quoted, not surface later as a stack trace from inside Node, and not be
 * accepted and quietly mean something else. The worst of these is the second
 * kind: an address that is not an address is handed to every app as the place
 * to send its replies, and nothing fails until an app tries.
 */

import type { AccessPolicy, MemberNotice } from "@ownbase/protocol";

/** A setting that cannot be used, with a message meant for the person who set it. */
export class ConfigError extends Error {}

/** Reads a setting from the environment, as OWNBASE_<name>. */
export function envSetting(name: string): string | undefined {
  return process.env[`OWNBASE_${name}`];
}

/** A TCP port: a whole number from 0 (any free port) to 65535. */
export function parsePort(raw: string | number, flag = "--port"): number {
  const text = String(raw).trim();
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`${flag} needs a port number from 0 to 65535, not "${raw}"`);
  }
  return port;
}

/**
 * The address others reach this server on, as the base of URLs handed to apps.
 *
 * It must be http or https, since that is what an app will call. A path is
 * allowed, for a server published under one behind a proxy. Credentials, a
 * query or a fragment are not: each would be carried into every URL built from
 * it, and a password there would be handed to every app along with it.
 */
export function parsePublicUrl(raw: string, flag = "--public-url"): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(
      `${flag} needs a full address such as https://chat.example.com, not "${raw}"`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${flag} must start with http:// or https://, not "${url.protocol}//"`);
  }
  if (url.username || url.password) {
    throw new ConfigError(
      `${flag} must not contain a username or password; it is shown to every app`,
    );
  }
  if (url.search || url.hash) {
    throw new ConfigError(`${flag} must not contain a query or a #fragment`);
  }
  return url.href.replace(/\/+$/, "");
}

/** The longest plan name: it sits inside a sentence. */
const PLAN_NAME_MAX = 40;

/**
 * --member-notice and its two companions (P5): how many members the plan
 * includes, the plan's name and where to choose a bigger one. A name or an
 * address means nothing without the number, so either alone is refused.
 */
export function parseMemberNotice(raw: {
  members: string | undefined;
  planName: string | undefined;
  upgradeUrl: string | undefined;
}): MemberNotice | undefined {
  if (raw.members === undefined) {
    if (raw.planName !== undefined || raw.upgradeUrl !== undefined)
      throw new ConfigError(
        "--plan-name and --upgrade-url need --member-notice, the number of members the plan includes",
      );
    return undefined;
  }
  const members = parseWholeNumber(raw.members, "--member-notice", 0);
  if (members < 1) throw new ConfigError("--member-notice must be at least 1");
  const notice: MemberNotice = { members };
  if (raw.planName !== undefined) {
    const name = raw.planName.trim();
    if (!name || name.length > PLAN_NAME_MAX || /[\p{Cc}\p{Cf}]/u.test(name))
      throw new ConfigError(
        `--plan-name needs the plan's name, such as Team, up to ${PLAN_NAME_MAX} characters, not "${raw.planName}"`,
      );
    notice.planName = name;
  }
  if (raw.upgradeUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(raw.upgradeUrl);
    } catch {
      throw new ConfigError(
        `--upgrade-url needs a full address such as https://example.com/plans, not "${raw.upgradeUrl}"`,
      );
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      throw new ConfigError(
        `--upgrade-url must start with https:// or http://, not "${url.protocol}//"`,
      );
    if (url.username || url.password)
      throw new ConfigError("--upgrade-url must not contain a username or password");
    notice.upgradeUrl = url.href;
  }
  return notice;
}

/** A count of whole units, such as days, where a fraction would be silently rounded. */
export function parseWholeNumber(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const text = raw.trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new ConfigError(`${flag} needs a whole number of 0 or more, not "${raw}"`);
  }
  return Number(text);
}

/**
 * What to tell someone whose server would not start, for the failures a host
 * can do something about. Anything else is returned as its own message.
 */
export function describeStartupError(
  err: unknown,
  settings: { port?: number; host?: string },
): string {
  if (err instanceof ConfigError) return err.message;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const port = settings.port ?? "that port";
  switch (code) {
    case "EADDRINUSE":
      return `Port ${port} is already in use, probably by another server. Choose another with --port, or stop the other one.`;
    case "EACCES":
      return `This account is not allowed to listen on port ${port}. Ports below 1024 usually need administrator rights; choose a higher one with --port.`;
    case "ENOTFOUND":
    case "EADDRNOTAVAIL":
      return `Cannot listen on --host ${settings.host ?? ""}: this machine has no such address. Use 0.0.0.0 for every address, or 127.0.0.1 for this machine only.`;
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

/**
 * What a start was asked for and did not do, a line for each. A workspace
 * with an owner keeps its own name and its own rule for who may join, which
 * its owner and admins change in Workspace settings, so a flag that disagrees
 * is not applied. Said every start, so a flag left in a service file does not
 * look as if it still decides. Nothing when the flags agree or were not given.
 */
export function keptSettingsNotes(start: {
  name?: string;
  accessPolicy?: AccessPolicy;
  inviteOnly?: boolean;
  /** What the workspace holds now that it has started. */
  kept: { name: string; accessPolicy: AccessPolicy };
}): string[] {
  const notes: string[] = [];
  if (start.name && start.name !== start.kept.name)
    notes.push(
      `This workspace keeps its own name, "${start.kept.name}", not --name "${start.name}". Owners and admins rename it in Workspace settings.`,
    );
  const asked = start.accessPolicy ?? (start.inviteOnly ? "invite_only" : undefined);
  if (asked && asked !== start.kept.accessPolicy)
    notes.push(
      `This workspace keeps its own rule for who may join, ${start.kept.accessPolicy}, not ${
        start.accessPolicy ? `--access-policy ${start.accessPolicy}` : "--invite-only"
      }. Owners and admins change it in Workspace settings.`,
    );
  return notes;
}
