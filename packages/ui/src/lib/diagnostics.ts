import { CALL_CAUSES, type CallLogLine, type HuddleState } from "@slackoss/client-core";
import type {
  BuildRevision,
  CallLogEntry,
  CandidateCounts,
  ServerInfo,
  WorkspaceStatus,
} from "@slackoss/protocol";
import { PROTOCOL_VERSION } from "@slackoss/protocol";
import { formatBytes } from "./format.js";
import { APP_BUILD, describeBuild } from "./build.js";

/** What a report can say about the device it came from. */
export interface DiagnosticsInput {
  app: "web" | "desktop";
  address: string;
  status: string;
  /** The server's own description, or why it could not be read. */
  server: ServerInfo | { error: string };
  /** Which source this app was built from; the running build's own when left out. */
  appBuild?: BuildRevision | null;
  huddle: HuddleState | null;
  /** Messages waiting to send, counted, never quoted. */
  waitingToSend: number;
  userAgent: string;
  online: boolean;
  width: number;
  height: number;
  pixelRatio: number;
  notifications: string;
  /**
   * How the server is keeping up, for the owner and admins, or why it could
   * not be read; left out for everyone else.
   */
  workspace?: WorkspaceStatus | { error: string };
  /** Every step of the current or last huddle on this device. */
  callLog?: CallLogLine[];
  /** The server's call log, for the owner and admins, or why it could not be read. */
  calls?: CallLogEntry[] | { error: string };
  /** How a person or conversation is named in the call logs. */
  names?: { person: (id: string) => string; conversation: (id: string) => string };
  now: Date;
}

/**
 * A plain-text report for whoever helps when something is wrong: versions,
 * the connection and the device, and never what anybody wrote. People see
 * all of it before they copy it.
 */
export function diagnosticsReport(input: DiagnosticsInput): string {
  const server =
    "error" in input.server
      ? `not reachable (${input.server.error})`
      : `v${input.server.serverVersion}, protocol ${input.server.protocolVersion}, build ${describeBuild(input.server.build)}`;
  const huddle = input.huddle
    ? `in a call with ${input.huddle.peers.length} other${input.huddle.peers.length === 1 ? "" : "s"}, ` +
      `${input.huddle.peers.filter((peer) => peer.connected).length} connected`
    : "not in a call";
  return [
    "Tandem diagnostics",
    `Taken: ${input.now.toISOString()}`,
    `App: ${input.app === "desktop" ? "desktop app" : "browser"}, protocol ${PROTOCOL_VERSION}, build ${describeBuild(input.appBuild === undefined ? APP_BUILD : input.appBuild)}`,
    `Server: ${server}`,
    `Address: ${input.address}`,
    `Connection: ${input.status}${input.online ? "" : " (this device is offline)"}`,
    `Waiting to send: ${input.waitingToSend}`,
    `Huddle: ${huddle}`,
    `Notifications: ${input.notifications}`,
    `Window: ${input.width}×${input.height} at ${input.pixelRatio}×`,
    `Browser: ${input.userAgent}`,
    ...(input.workspace ? ["", ...workspaceLines(input.workspace, input.now.getTime())] : []),
    ...(input.callLog?.length ? ["", ...callLogLines(input.callLog, names(input))] : []),
    ...(input.calls ? ["", ...serverCallLines(input.calls, names(input))] : []),
  ].join("\n");
}

type Names = NonNullable<DiagnosticsInput["names"]>;
const names = (input: DiagnosticsInput): Names =>
  input.names ?? { person: (id) => id, conversation: (id) => id };

/** A time of day to the millisecond, in UTC, so both sides' logs line up. */
const clock = (at: number) => new Date(at).toISOString().slice(11, 23);

/** Where this device's call log starts in a report, for opening at it. */
export const CALL_LOG_HEADING = "Call log on this device";

/** This device's account of its last huddle, step by step. */
function callLogLines(lines: CallLogLine[], named: Names): string[] {
  return [
    `${CALL_LOG_HEADING} (times in UTC)`,
    ...lines.map(
      (line) =>
        `${clock(line.at)} ${line.peerId ? `[${named.person(line.peerId)}] ` : ""}${line.text}`,
    ),
  ];
}

const counted = (counts: CandidateCounts) =>
  (Object.keys(counts) as (keyof CandidateCounts)[])
    .filter((kind) => counts[kind] > 0)
    .map((kind) => `${counts[kind]} ${kind}`)
    .join(", ") || "none";

/**
 * The server's call log (memory only): who joined and left, the setups it
 * passed on or could not, and what each side said of its connection.
 */
function serverCallLines(calls: CallLogEntry[] | { error: string }, named: Names): string[] {
  if ("error" in calls) return ["Calls on this server", `Not available: ${calls.error}`];
  if (calls.length === 0) return ["Calls on this server", "No huddles since the server started."];
  return [
    "Calls on this server (times in UTC)",
    ...calls.map((entry) => {
      const who = named.person(entry.userId);
      const peer = entry.peerId ? named.person(entry.peerId) : "someone";
      const where = named.conversation(entry.channelId);
      const head = `${clock(entry.at)} ${where}:`;
      switch (entry.kind) {
        case "joined":
          return `${head} ${who} joined`;
        case "left":
          return `${head} ${who} ${entry.reason === "disconnected" ? "disconnected" : entry.reason === "lost access" ? "lost access" : "left"}`;
        case "refused":
          return `${head} ${who} was not let in (${entry.reason ?? "no reason given"})`;
        case "offer":
          return `${head} passed on ${who}'s call setup to ${peer}`;
        case "answer":
          return `${head} passed on ${who}'s answer to ${peer}`;
        case "dropped":
          return `${head} did not pass on from ${who} to ${peer}: ${entry.reason ?? ""}`;
        case "report": {
          const r = entry.report;
          if (!r) return `${head} ${who} reported on ${peer}`;
          const outcome =
            r.outcome === "connected"
              ? `connected to ${peer} after ${(r.afterMs / 1000).toFixed(1)} s${
                  r.route
                    ? ` (${r.route.local} here, ${r.route.remote} there, ${r.route.protocol})`
                    : ""
                }`
              : `${r.outcome === "failed" ? "failed to connect to" : "still not connected to"} ${peer} after ${Math.round(r.afterMs / 1000)} s`;
          return [
            `${head} ${who} ${outcome}.`,
            `routes here ${counted(r.local)}; from them ${counted(r.remote)};`,
            `${r.iceServers.stun} STUN, ${r.iceServers.turn} TURN;`,
            `ICE ${r.iceConnectionState}${r.retries ? `, tried again ${r.retries}×` : ""}.`,
            ...(r.cause ? [CALL_CAUSES[r.cause]] : []),
          ].join(" ");
        }
      }
    }),
  ];
}

/**
 * The name a saved report gets: when it was taken, so several kept side by
 * side sort by time, with nothing about the workspace or person in it.
 */
export function diagnosticsFileName(taken: Date): string {
  return `tandem-diagnostics-${taken.toISOString().slice(0, 19).replaceAll(":", "-")}Z.txt`;
}

/** A span of time, roughly: "45 s", "12 min", "3 h 5 min", "2 d 4 h". */
function roughDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Backups: every 24 h, keeping 7; last done …, next …", or that they are off. */
function backupLine(backups: NonNullable<WorkspaceStatus["backups"]>): string {
  if (!backups.enabled) return "Backups: not scheduled";
  const hours = backups.everyMs / 3600_000;
  return [
    `Backups: every ${Number.isInteger(hours) ? `${hours} h` : roughDuration(backups.everyMs)}, keeping ${backups.keep}`,
    backups.running
      ? "one running now"
      : backups.lastSuccessAt === null
        ? "none yet"
        : `last done ${new Date(backups.lastSuccessAt).toISOString()}`,
    ...(backups.failures ? [`${plural(backups.failures, "failure")} since`] : []),
    ...(backups.nextAt === null ? [] : [`next ${new Date(backups.nextAt).toISOString()}`]),
  ].join("; ");
}

/**
 * The server's own account of itself (OPS-10): sizes, queues and timings, and
 * never what is in them. It holds no message, name, file, address or token.
 */
function workspaceLines(status: WorkspaceStatus | { error: string }, now: number): string[] {
  if ("error" in status) return ["Workspace status", `Not available: ${status.error}`];
  const { database, attachments, deliveries, scheduled, retention, connections } = status;
  const loop = status.eventLoopDelayMs;
  return [
    "Workspace status",
    `Server: v${status.serverVersion}, schema ${status.schemaVersion}, up ${roughDuration(status.uptimeSeconds * 1000)}`,
    `Database: ${formatBytes(database.bytes)}, log ${formatBytes(database.walBytes)}`,
    `Attachments: ${formatBytes(attachments.bytes)}${
      attachments.limitBytes === null ? ", no limit" : ` of ${formatBytes(attachments.limitBytes)}`
    }`,
    // Servers before REV-02 do not say how removing deleted attachments goes.
    ...(attachments.removal
      ? [
          `Attachment removal: ${attachments.removal.waiting} waiting${
            attachments.removal.oldestQueuedAt === null
              ? ""
              : ` (oldest for ${roughDuration(now - attachments.removal.oldestQueuedAt)})`
          }, ${attachments.removal.retrying} retrying, ${attachments.removal.rejected} set aside`,
        ]
      : []),
    `Free disk: ${status.diskFreeBytes === null ? "unknown" : formatBytes(status.diskFreeBytes)}`,
    `App deliveries: ${deliveries.waiting} waiting${
      deliveries.oldestWaitingAt === null
        ? ""
        : ` (oldest for ${roughDuration(now - deliveries.oldestWaitingAt)})`
    }, ${deliveries.failed} given up`,
    `Scheduled messages: ${scheduled.queued} queued, ${scheduled.held} held for a retry, ${scheduled.failed} failed`,
    `History removal: ${
      !retention.enabled
        ? "off"
        : (retention.lastSuccessAt === null
            ? "not run yet"
            : `last done ${new Date(retention.lastSuccessAt).toISOString()}`) +
          (retention.failures ? `, ${plural(retention.failures, "failure")} since` : "")
    }`,
    // Servers before scheduled backups do not say, and a line would guess.
    ...(status.backups ? [backupLine(status.backups)] : []),
    `Connections: ${plural(connections.sockets, "socket")} for ${plural(connections.people, "person", "people")}`,
    `Event loop delay: ${
      loop
        ? `p50 ${loop.p50} ms, p99 ${loop.p99} ms, max ${loop.max} ms`
        : "not measured until the server has run a minute"
    }`,
    // Servers before REV-01 do not say, and a line would guess.
    ...(status.backgroundFailures
      ? [
          status.backgroundFailures.length === 0
            ? "Background work: all running"
            : `Background work failing: ${status.backgroundFailures
                .map(
                  (f) =>
                    `${f.queue} (${plural(f.failures, "time")} in a row, for ${roughDuration(now - f.since)})`,
                )
                .join("; ")}`,
        ]
      : []),
  ];
}
