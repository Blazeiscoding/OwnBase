import { createHash, timingSafeEqual } from "node:crypto";
import type { WorkspaceStatus } from "@ownbase/protocol";
import type { FastifyInstance } from "fastify";
import { SERVER_VERSION } from "./version.js";

/**
 * `GET /metrics` for whoever keeps the server running (G15), in Prometheus's
 * text format, written by hand: it is a few lines a metric and needs no
 * package. Only for a request bearing the host's token, and only counts:
 * no names, no ids, no message text. Routes are named by their pattern, such
 * as `/api/channels/:id/messages`, never by the address asked for.
 */

/** The shortest token accepted, so a guessable one is refused at start. */
export const METRICS_TOKEN_MIN_LENGTH = 16;

/** Upper bounds of the request-duration buckets, in seconds. */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** The methods a route can have; anything else a client sends is counted as OTHER. */
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** What the metrics read from the running server, each at scrape time. */
export interface MetricsSources {
  status(): WorkspaceStatus;
  liveSessions(): number;
  /** The sequence number of the last event written: it only ever goes up. */
  eventsWritten(): number;
  storedFiles(): number;
  huddles(): { huddles: number; people: number };
}

type Labels = Record<string, string>;

const escapeLabel = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const labelText = (labels: Labels) => {
  const entries = Object.entries(labels);
  return entries.length === 0
    ? ""
    : `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;
};

/** A number as Prometheus reads it. */
const valueText = (value: number) =>
  Number.isFinite(value) ? String(value) : value > 0 ? "+Inf" : value < 0 ? "-Inf" : "NaN";

/** One metric family: its HELP and TYPE lines, then a line a sample. */
function family(
  out: string[],
  name: string,
  type: "gauge" | "counter" | "histogram",
  help: string,
  samples: { labels?: Labels; value: number; suffix?: string }[],
) {
  if (samples.length === 0) return;
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const sample of samples)
    out.push(
      `${name}${sample.suffix ?? ""}${labelText(sample.labels ?? {})} ${valueText(sample.value)}`,
    );
}

interface RouteStats {
  method: string;
  route: string;
  codes: Map<number, number>;
  /** Requests at or under each of BUCKETS, cumulative as Prometheus wants. */
  buckets: number[];
  sum: number;
  count: number;
}

/**
 * Starts counting requests (before any route is added, so every one is
 * counted) and returns how to serve the result once everything it reads
 * exists. The token is checked by the caller's options check.
 */
export function createMetrics(app: FastifyInstance, token: string) {
  const routes = new Map<string, RouteStats>();
  app.addHook("onResponse", async (req, reply) => {
    // The pattern, never the address: an id in a path is a person's or a channel's.
    const route = req.routeOptions.url ?? "unmatched";
    const method = METHODS.has(req.method) ? req.method : "OTHER";
    const key = `${method} ${route}`;
    let stats = routes.get(key);
    if (!stats) {
      stats = { method, route, codes: new Map(), buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
      routes.set(key, stats);
    }
    const seconds = reply.elapsedTime / 1000;
    stats.codes.set(reply.statusCode, (stats.codes.get(reply.statusCode) ?? 0) + 1);
    BUCKETS.forEach((bound, i) => {
      if (seconds <= bound) stats.buckets[i]!++;
    });
    stats.sum += seconds;
    stats.count++;
  });

  // Compared as hashes, so the comparison takes as long whatever was sent.
  const expected = createHash("sha256").update(token).digest();
  const authorized = (header: string | undefined) => {
    const bearer = /^Bearer (.+)$/.exec(header ?? "");
    return !!bearer && timingSafeEqual(createHash("sha256").update(bearer[1]!).digest(), expected);
  };

  const render = (sources: MetricsSources) => {
    const status = sources.status();
    const out: string[] = [];
    family(out, "ownbase_info", "gauge", "The server's version.", [
      { labels: { version: SERVER_VERSION }, value: 1 },
    ]);
    family(out, "ownbase_uptime_seconds", "gauge", "Seconds since the server started.", [
      { value: status.uptimeSeconds },
    ]);
    family(out, "ownbase_open_sockets", "gauge", "Sockets open now, signed in or not yet.", [
      { value: status.connections.sockets },
    ]);
    family(
      out,
      "ownbase_connected_people",
      "gauge",
      "People connected now, each counted once however many devices they use.",
      [{ value: status.connections.people }],
    );
    family(out, "ownbase_signed_in_sessions", "gauge", "Sessions signed in and not expired.", [
      { value: sources.liveSessions() },
    ]);
    family(
      out,
      "ownbase_events_written_total",
      "counter",
      "Events written to the workspace's log; its rate is events a second.",
      [{ value: sources.eventsWritten() }],
    );
    const stats = [...routes.values()].sort((a, b) =>
      a.route === b.route ? a.method.localeCompare(b.method) : a.route.localeCompare(b.route),
    );
    family(
      out,
      "ownbase_http_requests_total",
      "counter",
      "HTTP requests answered, by method, route pattern and status code.",
      stats.flatMap((s) =>
        [...s.codes]
          .sort(([a], [b]) => a - b)
          .map(([code, value]) => ({
            labels: { method: s.method, route: s.route, code: String(code) },
            value,
          })),
      ),
    );
    family(
      out,
      "ownbase_http_request_duration_seconds",
      "histogram",
      "How long HTTP requests took to answer, by method and route pattern.",
      stats.flatMap((s) => {
        const labels = { method: s.method, route: s.route };
        return [
          ...BUCKETS.map((bound, i) => ({
            suffix: "_bucket",
            labels: { ...labels, le: String(bound) },
            value: s.buckets[i]!,
          })),
          { suffix: "_bucket", labels: { ...labels, le: "+Inf" }, value: s.count },
          { suffix: "_sum", labels, value: +s.sum.toFixed(6) },
          { suffix: "_count", labels, value: s.count },
        ];
      }),
    );
    family(out, "ownbase_database_bytes", "gauge", "Size of the database file.", [
      { value: status.database.bytes },
    ]);
    family(out, "ownbase_database_wal_bytes", "gauge", "Size of the database's write-ahead log.", [
      { value: status.database.walBytes },
    ]);
    if (status.diskFreeBytes !== null)
      family(out, "ownbase_disk_free_bytes", "gauge", "Free space where the workspace is kept.", [
        { value: status.diskFreeBytes },
      ]);
    family(out, "ownbase_files_stored", "gauge", "Attachments stored.", [
      { value: sources.storedFiles() },
    ]);
    family(out, "ownbase_files_stored_bytes", "gauge", "Bytes of attachments stored.", [
      { value: status.attachments.bytes },
    ]);
    if (status.attachments.limitBytes !== null)
      family(out, "ownbase_files_limit_bytes", "gauge", "The storage limit for attachments.", [
        { value: status.attachments.limitBytes },
      ]);
    const removal = status.attachments.removal;
    family(
      out,
      "ownbase_file_removals",
      "gauge",
      "Deleted attachments whose files are still to be removed, by state.",
      [
        { labels: { state: "waiting" }, value: removal.waiting },
        { labels: { state: "retrying" }, value: removal.retrying },
        { labels: { state: "rejected" }, value: removal.rejected },
      ],
    );
    family(
      out,
      "ownbase_app_deliveries",
      "gauge",
      "Events for apps: waiting to be delivered, and given up on.",
      [
        { labels: { state: "waiting" }, value: status.deliveries.waiting },
        { labels: { state: "failed" }, value: status.deliveries.failed },
      ],
    );
    family(out, "ownbase_scheduled_messages", "gauge", "Scheduled messages, by state.", [
      { labels: { state: "queued" }, value: status.scheduled.queued },
      { labels: { state: "held" }, value: status.scheduled.held },
      { labels: { state: "failed" }, value: status.scheduled.failed },
    ]);
    const backups = status.backups;
    family(out, "ownbase_backups_enabled", "gauge", "1 when the server takes backups on a timer.", [
      { value: backups.enabled ? 1 : 0 },
    ]);
    if (backups.enabled) {
      if (backups.lastSuccessAt !== null)
        family(
          out,
          "ownbase_backup_last_success_age_seconds",
          "gauge",
          "Seconds since the last scheduled backup finished well.",
          [{ value: Math.max(0, Math.round((Date.now() - backups.lastSuccessAt) / 1000)) }],
        );
      family(
        out,
        "ownbase_backup_failures",
        "gauge",
        "Scheduled backups failed since the last that finished well.",
        [{ value: backups.failures }],
      );
    }
    if (status.retention.enabled)
      family(
        out,
        "ownbase_retention_failures",
        "gauge",
        "Removals of old history failed since the last that finished well.",
        [{ value: status.retention.failures }],
      );
    if (status.eventLoopDelayMs)
      family(
        out,
        "ownbase_event_loop_delay_seconds",
        "gauge",
        "How late the event loop ran over the last full minute, by quantile (1 is the most).",
        [
          { labels: { quantile: "0.5" }, value: status.eventLoopDelayMs.p50 / 1000 },
          { labels: { quantile: "0.99" }, value: status.eventLoopDelayMs.p99 / 1000 },
          { labels: { quantile: "1" }, value: status.eventLoopDelayMs.max / 1000 },
        ],
      );
    family(out, "ownbase_background_queues_failing", "gauge", "Background queues failing now.", [
      { value: status.backgroundFailures.length },
    ]);
    const huddles = sources.huddles();
    family(out, "ownbase_huddles", "gauge", "Huddles going now.", [{ value: huddles.huddles }]);
    family(out, "ownbase_huddle_people", "gauge", "People in huddles now.", [
      { value: huddles.people },
    ]);
    return out.join("\n") + "\n";
  };

  return {
    serve(sources: MetricsSources) {
      app.get("/metrics", async (req, reply) => {
        reply.header("cache-control", "no-store");
        if (!authorized(req.headers.authorization))
          return reply
            .status(401)
            .header("www-authenticate", 'Bearer realm="metrics"')
            .send({ error: "unauthorized" });
        return reply
          .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
          .send(render(sources));
      });
    },
  };
}
