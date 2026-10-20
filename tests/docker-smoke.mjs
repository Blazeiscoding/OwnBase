import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const name = `slackoss-test-${randomUUID()}`;
const volume = `${name}-data`;
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", windowsHide: true }).trim();
const sockets = [];
let base;
async function waitFor(check, label) {
  for (let n = 0; n < 100; n++) {
    if (await check().catch(() => false)) return;
    await delay(200);
  }
  throw new Error(`Timed out: ${label}`);
}
async function api(path, token, body, method = body ? "POST" : "GET") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.ok, `${path}: ${response.status}`);
  return response.json();
}
// Compose hands the server its ICE servers under their Tandem name. A
// value still set under the previous name has to arrive, rather than the
// default being passed in its place. A Cloudflare TURN key is passed as set,
// and empty, meaning no relay, when it is not.
const composeFile = fileURLToPath(new URL("../docker/docker-compose.yml", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "tandem-compose-"));
try {
  // An empty settings file, so a docker/.env on this machine changes nothing.
  const envFile = join(scratch, "empty.env");
  writeFileSync(envFile, "");
  const composed = (settings) => {
    const env = { ...process.env, ...settings };
    for (const key of [
      "TANDEM_ICE_SERVERS",
      "GATHERLINE_ICE_SERVERS",
      "SLACKOSS_ICE_SERVERS",
      "TANDEM_CLOUDFLARE_TURN_KEY_ID",
      "TANDEM_CLOUDFLARE_TURN_API_TOKEN",
    ])
      if (!(key in settings)) delete env[key];
    const config = execFileSync(
      "docker",
      ["compose", "-f", composeFile, "--env-file", envFile, "config", "--format", "json"],
      { encoding: "utf8", windowsHide: true, env },
    );
    return JSON.parse(config).services.slackoss.environment;
  };
  const stun = (host) => JSON.stringify([{ urls: `stun:${host}:3478` }]);
  const noRelay = { TANDEM_CLOUDFLARE_TURN_KEY_ID: "", TANDEM_CLOUDFLARE_TURN_API_TOKEN: "" };
  assert.deepEqual(composed({}), { TANDEM_ICE_SERVERS: "[]", ...noRelay });
  assert.deepEqual(composed({ SLACKOSS_ICE_SERVERS: stun("old.example.org") }), {
    TANDEM_ICE_SERVERS: stun("old.example.org"),
    ...noRelay,
  });
  assert.deepEqual(
    composed({
      SLACKOSS_ICE_SERVERS: stun("old.example.org"),
      GATHERLINE_ICE_SERVERS: stun("newer.example.org"),
    }),
    { TANDEM_ICE_SERVERS: stun("newer.example.org"), ...noRelay },
  );
  assert.deepEqual(
    composed({
      SLACKOSS_ICE_SERVERS: stun("old.example.org"),
      GATHERLINE_ICE_SERVERS: stun("newer.example.org"),
      TANDEM_ICE_SERVERS: stun("new.example.org"),
    }),
    { TANDEM_ICE_SERVERS: stun("new.example.org"), ...noRelay },
  );
  const relay = {
    TANDEM_CLOUDFLARE_TURN_KEY_ID: "turn-key-id",
    TANDEM_CLOUDFLARE_TURN_API_TOKEN: "turn-key-token",
  };
  assert.deepEqual(composed(relay), { TANDEM_ICE_SERVERS: "[]", ...relay });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

try {
  docker("volume", "create", volume);
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--init",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-p",
    "127.0.0.1::8543",
    "-v",
    `${volume}:/data`,
    "slackoss:local",
    "--name",
    "Docker Smoke",
    "--invite-only",
    // This measures what the container does under load: 300 messages fanned
    // out to 20 sockets. Deliberate load is indistinguishable from abuse to
    // the limiter, which is the point of it.
    "--no-rate-limits",
  );
  base = `http://${docker("port", name, "8543/tcp").split(/\r?\n/)[0]}`;
  await waitFor(async () => (await fetch(base + "/api/health")).ok, "healthy server");
  assert.notEqual(docker("exec", name, "id", "-u"), "0");
  // The image says which source it was built from (IMP-08).
  const info = await (await fetch(base + "/api/server-info")).json();
  assert.match(info.build?.revision ?? "", /^([0-9a-f]{40}|unknown)$/);
  const page = await (await fetch(base)).text();
  assert.match(page, /<div id="root">/);
  // The image keeps the client's compressed copies (REV-13): the entry script
  // arrives as Brotli, decodes to the same script, and is cached by its name.
  // The module is the app; the classic script before it only puts the theme on the page.
  const entry = new URL(page.match(/<script type="module"[^>]+src="([^"]+)"/)[1], base);
  const compressed = await fetch(entry, { headers: { "accept-encoding": "br" } });
  const plain = await fetch(entry, { headers: { "accept-encoding": "identity" } });
  assert.equal(compressed.headers.get("content-encoding"), "br");
  assert.equal(plain.headers.get("content-encoding"), null);
  assert.equal(compressed.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await compressed.text(), await plain.text());
  const idle = docker("stats", "--no-stream", "--format", "{{.MemUsage}}", name);
  // Published ports reach the server through Docker's bridge, so claim the
  // workspace with the same startup secret a remote administrator needs.
  const claimCode = docker("logs", name).match(/Claim code: (\S+)/)?.[1];
  assert(claimCode, "server printed its initial workspace claim code");
  const owner = await api("/api/auth/register", null, {
    handle: "owner",
    displayName: "Owner",
    password: "test-password",
    claimCode,
  });
  const invite = await api("/api/invites", owner.token, { maxUses: 1 });
  const guest = await api("/api/auth/register", null, {
    handle: "guest",
    displayName: "Guest",
    password: "test-password",
    inviteCode: invite.invite.code,
  });
  await api(`/api/friends/${guest.user.id}`, owner.token, undefined, "POST");
  await api(`/api/friends/${owner.user.id}`, guest.token, undefined, "PUT");
  const { channels } = await api("/api/channels", owner.token);
  const channel = channels.find((c) => c.name === "general");
  const received = Array(20).fill(0);
  await Promise.all(
    received.map(
      (_, index) =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(base.replace("http", "ws") + "/ws");
          sockets.push(ws);
          ws.onopen = () =>
            ws.send(
              JSON.stringify({
                type: "hello",
                token: guest.token,
                lastSeq: null,
                protocolVersion: 1,
              }),
            );
          ws.onerror = reject;
          ws.onmessage = ({ data }) => {
            const frame = JSON.parse(data);
            if (frame.type === "ready") resolve();
            if (frame.type === "event" && frame.envelope.event.type === "message.created")
              received[index]++;
          };
        }),
    ),
  );
  const timings = [];
  for (let i = 0; i < 300; i++) {
    const started = performance.now();
    await api(`/api/channels/${channel.id}/messages`, owner.token, {
      text: `Load message ${i}`,
      nonce: `smoke-${i}`,
    });
    timings.push(performance.now() - started);
  }
  await waitFor(async () => received.every((n) => n === 300), "all 6,000 message deliveries");
  const loaded = docker("stats", "--no-stream", "--format", "{{.MemUsage}}", name);
  for (const ws of sockets) ws.close();
  docker("restart", name);
  base = `http://${docker("port", name, "8543/tcp").split(/\r?\n/)[0]}`;
  await waitFor(async () => (await fetch(base + "/api/health")).ok, "restart");
  const login = await api("/api/auth/login", null, { handle: "owner", password: "test-password" });
  assert.equal((await api("/api/friends", login.token)).friends[0].status, "accepted");
  assert.equal(
    (await api(`/api/channels/${channel.id}/messages`, login.token)).messages[0].text,
    "Load message 299",
  );
  timings.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        sockets: 20,
        messages: 300,
        deliveries: 6000,
        cpuLimit: 1,
        memoryLimitMiB: 256,
        idleMemory: idle,
        afterLoadMemory: loaded,
        postLatencyP50Ms: +timings[150].toFixed(2),
        postLatencyP95Ms: +timings[285].toFixed(2),
        restartPersistence: true,
      },
      null,
      2,
    ),
  );
} catch (err) {
  console.error(docker("logs", "--tail", "12", name));
  throw err;
} finally {
  for (const ws of sockets) ws.close();
  // Only this run's randomly named container and disposable volume are removed.
  try {
    docker("rm", "-f", name);
  } catch {}
  try {
    docker("volume", "rm", volume);
  } catch {}
}
