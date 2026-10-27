import { parentPort, workerData } from "node:worker_threads";
// The backup module alone: the server's barrel would load Fastify, sockets and
// discovery into every backup job, which uses none of them (REV-07).
import {
  backupWorkspace,
  inventoryBackup,
  restoreWorkspace,
  verifyBackup,
} from "@ownbase/server/backup";

/**
 * Backing up, checking and restoring a workspace, off the main thread. Each
 * is one long synchronous SQLite call at heart (`VACUUM INTO`, `PRAGMA
 * integrity_check`), and the main thread is the one the window and the
 * hosted server share: on a 200,000-message workspace a backup held both for
 * about two thirds of a second. One job per worker, which exits when done.
 */
export type BackupJob =
  | { kind: "backup"; dataDir: string; out: string }
  | { kind: "verify"; dir: string }
  | { kind: "inventory"; dir: string }
  | { kind: "restore"; backupDir: string; dataDir: string };

export type BackupReply = { ok: true; result: unknown } | { ok: false; message: string };

async function run(job: BackupJob): Promise<unknown> {
  switch (job.kind) {
    case "backup":
      return backupWorkspace({ dataDir: job.dataDir, out: job.out });
    case "verify":
      return verifyBackup(job.dir);
    case "inventory":
      return inventoryBackup(job.dir);
    case "restore":
      return restoreWorkspace({ backupDir: job.backupDir, dataDir: job.dataDir });
  }
}

let reply: BackupReply;
try {
  reply = { ok: true, result: await run(workerData as BackupJob) };
} catch (error) {
  // Only the words cross back: the caller shows them, and needs nothing else.
  reply = { ok: false, message: error instanceof Error ? error.message : String(error) };
}
parentPort!.postMessage(reply);
