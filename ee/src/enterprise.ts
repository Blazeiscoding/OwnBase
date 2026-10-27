import { readFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import type { ExtensionStatus, ServerNotice } from "@ownbase/protocol";
import {
  ConfigError,
  type CommandLineExtension,
  type ServerExtension,
} from "@ownbase/server/extensions";
import { trustedLicenseKeys } from "./keys.js";
import { featuresOn, readLicense, type LicenseClaims, type LicenseState } from "./license.js";

/** Within this long of its end, the owner is told an active license is ending. */
export const ENDING_SOON_MS = 30 * 24 * 60 * 60 * 1000;

/** The Enterprise edition as the server holds it (P6). */
export interface Enterprise extends ServerExtension {
  /** The license, where it stands now. */
  license(): LicenseState;
  /** Whether an Enterprise feature is on now. Chat never asks this. */
  has(feature: string): boolean;
}

/** What `GET /api/admin/license` answers the owner and admins. */
export interface LicenseView {
  state: LicenseState["state"];
  /** Why a license given was not accepted. */
  reason?: string;
  licensee?: string;
  plan?: string;
  members?: number;
  features?: string[];
  issuedAt?: number;
  expiresAt?: number;
  graceEndsAt?: number;
  /** Members the workspace has now, as a license counts them. */
  memberCount: number;
}

/** "27 October 2026", the same wherever the server runs. */
const day = (at: number) =>
  new Date(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

const count = (n: number) => n.toLocaleString("en-US");

/** What the owner is told about a license, as a status line and, when it needs them, a notice. */
function words(
  license: LicenseState,
  members: number,
  now: number,
): { status: ExtensionStatus; notice: ServerNotice | null } {
  const status = (summary: string, health: ExtensionStatus["health"]): ExtensionStatus => ({
    name: "enterprise",
    summary,
    health,
  });
  switch (license.state) {
    case "none":
      return { status: status("No Enterprise license: the free edition", "ok"), notice: null };
    case "invalid":
      return {
        status: status(`The Enterprise license was not accepted. ${license.reason}`, "problem"),
        notice: null,
      };
    case "expired": {
      const text = `The Enterprise license for ${license.claims.licensee} ended on ${day(license.claims.expiresAt)}, and its features are off. Chat keeps working.`;
      return {
        status: status(text, "problem"),
        notice: { id: `license:${license.claims.id}:expired`, tone: "alert", text },
      };
    }
    case "grace": {
      const text = `The Enterprise license for ${license.claims.licensee} ended on ${day(license.claims.expiresAt)}. Its features stop on ${day(license.graceEndsAt)}; chat keeps working.`;
      return {
        status: status(text, "problem"),
        notice: { id: `license:${license.claims.id}:grace`, tone: "alert", text },
      };
    }
    case "active":
      return active(license.claims, members, now, status);
  }
}

function active(
  claims: LicenseClaims,
  members: number,
  now: number,
  status: (summary: string, health: ExtensionStatus["health"]) => ExtensionStatus,
): { status: ExtensionStatus; notice: ServerNotice | null } {
  const covered = `Enterprise license for ${claims.licensee}, ${count(claims.members)} members, until ${day(claims.expiresAt)}`;
  if (claims.expiresAt - now <= ENDING_SOON_MS)
    return {
      status: status(covered, "warning"),
      notice: {
        id: `license:${claims.id}:ending`,
        tone: "status",
        text: `The Enterprise license for ${claims.licensee} ends on ${day(claims.expiresAt)}. Renew it to keep its features.`,
      },
    };
  if (members > claims.members)
    return {
      status: status(`${covered}; the workspace has ${count(members)}`, "warning"),
      notice: {
        id: `license:${claims.id}:members`,
        tone: "status",
        text: `This workspace has ${count(members)} members, more than the ${count(claims.members)} its Enterprise license covers. Nobody is locked out.`,
      },
    };
  return { status: status(covered, "ok"), notice: null };
}

/**
 * The Enterprise extension for a license's text, or for none. Where the
 * license stands is worked out each time it is asked, so one that ends while
 * the server runs ends on time.
 */
export function enterprise(opts: {
  license: string | null;
  trusted?: KeyObject[];
  now?: () => number;
}): Enterprise {
  const now = opts.now ?? Date.now;
  const trusted = opts.trusted ?? trustedLicenseKeys();
  const license = () => readLicense(opts.license, trusted, now());
  let members = () => 0;
  return {
    name: "enterprise",
    license,
    has: (feature) => featuresOn(license()).has(feature),
    register(context) {
      members = context.memberCount;
      context.app.get("/api/admin/license", async (req, reply): Promise<LicenseView> => {
        context.requireAdmin(req);
        reply.header("cache-control", "no-store");
        const at = license();
        return {
          state: at.state,
          ...(at.state === "invalid" ? { reason: at.reason } : {}),
          ...("claims" in at
            ? {
                licensee: at.claims.licensee,
                plan: at.claims.plan,
                members: at.claims.members,
                features: at.claims.features,
                issuedAt: at.claims.issuedAt,
                expiresAt: at.claims.expiresAt,
              }
            : {}),
          ...(at.state === "grace" ? { graceEndsAt: at.graceEndsAt } : {}),
          memberCount: members(),
        };
      });
    },
    status: () => words(license(), members(), now()).status,
    notice: () => words(license(), members(), now()).notice,
  };
}

/**
 * The command line's part: --license <file>, or the license itself in the
 * environment. A license that is not one stops the server at the door, as
 * any setting it cannot use does; one that has ended does not, since chat
 * never depends on it.
 */
export const enterpriseCommandLine: CommandLineExtension = {
  options: { license: { type: "string" } },
  help: `Enterprise

  --license <file>  An OwnBase Enterprise license, the file OwnBase sends. It
                    is checked here, offline. Without one the server is the
                    free edition, and when one ends its features stop after
                    14 days; chat keeps working either way. Also settable with
                    OWNBASE_LICENSE_FILE, or OWNBASE_LICENSE holding the
                    license itself.`,
  create(values, env) {
    const file = (values.license as string | undefined) ?? env("LICENSE_FILE");
    const inline = env("LICENSE");
    if (file !== undefined && inline !== undefined)
      throw new ConfigError(
        "Give the license once: --license or OWNBASE_LICENSE_FILE, or OWNBASE_LICENSE",
      );
    let text = inline ?? null;
    if (file !== undefined) {
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        throw new ConfigError(
          `--license: ${file} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`,
        );
      }
    }
    const extension = enterprise({ license: text });
    const at = extension.license();
    if (at.state === "invalid") throw new ConfigError(`--license: ${at.reason}`);
    return extension;
  },
};
