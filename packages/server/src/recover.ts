import { join } from "node:path";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.js";
import { holdWorkspace } from "./ownership.js";
import { Store } from "./store.js";
import { hashPassword } from "./auth.js";
import { secretToken } from "./ids.js";

export interface RecoverableAccount {
  handle: string;
  displayName: string;
  role: string;
  deactivated: boolean;
  mustChangePassword: boolean;
}

/**
 * Emergency recovery runs on the machine holding the workspace, against the
 * database file directly. That is deliberately the only way in: whoever has the
 * file already has everything in it, so no new trust is granted, and a locked
 * out owner does not need a working sign-in to get back.
 *
 * The server must be stopped, and is refused if it is not. SQLite would let a
 * second writer in, and handing out a password while the old sessions are
 * still live is not a recovery.
 */
function openWorkspace(dataDir: string) {
  const path = join(dataDir, "workspace.db");
  if (!existsSync(path)) {
    throw new Error(`No workspace found at ${path}. Check --data points at the data directory.`);
  }
  const hold = holdWorkspace(dataDir, "an account recovery");
  let db: DatabaseSync;
  try {
    db = openDb(path);
  } catch (err) {
    hold.release();
    throw err;
  }
  return {
    db,
    close: () => {
      try {
        db.close();
      } finally {
        hold.release();
      }
    },
  };
}

export function listAccounts(dataDir: string): RecoverableAccount[] {
  const { db, close } = openWorkspace(dataDir);
  try {
    const store = new Store(db);
    return store
      .listUsers()
      .filter((user) => !user.isBot)
      .map((user) => ({
        handle: user.handle,
        displayName: user.displayName,
        role: user.role,
        deactivated: user.deactivated,
        mustChangePassword: store.mustChangePassword(user.id),
      }));
  } finally {
    close();
  }
}

/**
 * Issues a one-time password for an account and ends its sessions. The account
 * cannot use the workspace again until it chooses its own password, so a
 * password typed into a terminal and read aloud cannot become a lasting one.
 */
export async function recoverAccount(opts: {
  dataDir: string;
  handle: string;
  /** Also make this account the owner. For a workspace whose owner is gone. */
  makeOwner?: boolean;
}): Promise<{
  temporaryPassword: string;
  role: string;
  revokedSessions: number;
  /** Whether two-step sign-in was on, and is now off (E11). */
  twoStepCleared: boolean;
}> {
  const { db, close } = openWorkspace(opts.dataDir);
  try {
    const store = new Store(db);
    const user = store.getUserAuthByHandle(opts.handle);
    if (!user) throw new Error(`No account with the handle "${opts.handle}".`);
    if (user.isBot)
      throw new Error(`"${opts.handle}" is an app, which has a token rather than a password.`);

    const temporaryPassword = secretToken().slice(0, 16);
    const credentials = await hashPassword(temporaryPassword);
    const { revoked, role, twoStepCleared } = store.transaction(() => {
      store.setPassword(user.id, credentials.hash, credentials.salt, true);
      // Whoever lost their password may have lost their authenticator too, and
      // the host on this machine is trusted with both (E11).
      const twoStepCleared = store.disableTwoStep(user.id);
      // Recovery is pointless if the account cannot sign in at all.
      if (user.deactivated) store.updateUser(user.id, { deactivated: false });
      if (opts.makeOwner) {
        // The existing owner steps down to admin rather than out, matching what
        // an ordinary ownership transfer does.
        for (const other of store.listUsers()) {
          if (other.role === "owner" && other.id !== user.id) {
            store.updateUser(other.id, { role: "admin" });
          }
        }
        store.updateUser(user.id, { role: "owner" });
      }
      const revoked = store.revokeSessions(user.id).length;
      // No actor: the host did this from the command line, without signing in,
      // which is exactly the kind of change the record exists to show.
      store.recordAudit({
        actorId: null,
        action: "account.recovered",
        targetType: "user",
        targetId: user.id,
        details: {
          madeOwner: opts.makeOwner === true,
          reactivated: user.deactivated,
          sessionsEnded: revoked,
          twoStepCleared,
        },
      });
      return { revoked, role: store.getUser(user.id)!.role, twoStepCleared };
    });
    return { temporaryPassword, role, revokedSessions: revoked, twoStepCleared };
  } finally {
    close();
  }
}
