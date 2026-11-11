/** The backup, on a worker thread, as the desktop app now runs it. See measure-stall.mts. */
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

// A worker does not inherit the TypeScript loader tsx gave the main thread,
// so it registers its own before reading the server's sources.
const { tsxApi, ...options } = workerData as { tsxApi: string; dataDir: string; out: string };
const { register } = (await import(pathToFileURL(tsxApi).href)) as { register: () => void };
register();
const { backupWorkspace } = await import("../packages/server/src/backups/backup.js");
await backupWorkspace(options);
parentPort!.postMessage("done");
