/**
 * What a huddle of 2 to 6 people costs each of them (E13, H05). Huddles are a
 * mesh: everyone sends their microphone and camera to everyone else on a
 * connection of its own, so each person encodes and uploads once per other
 * person. This starts one headless Chromium per person, with the fake
 * microphone and camera, puts them all in one huddle on a server in this
 * process, lets the connections settle, and then for `--seconds` records:
 *
 *  - CPU: every process of each person's browser, as a share of one core, and
 *    the whole machine's, since all of them share this one.
 *  - Bandwidth: bytes each person's connections sent and received (transport
 *    level, so headers, RTCP and DTLS count), and the audio and video parts.
 *  - Round trip and jitter: the round trip RTCP reports for each connection,
 *    the jitter each listener measures on incoming audio, and the jitter
 *    buffer's delay.
 *  - What the encoder made of it: the camera's sent height and frame rate,
 *    the share of time it was held back by CPU or bandwidth, the received
 *    frame rate, freezes, and how much incoming audio had to be concealed.
 *
 * Everyone is on one machine and the connections run over loopback, so the
 * network adds no delay or loss: round trip and jitter here show what the
 * load does to the call, and bandwidth shows what a real uplink would need.
 * The camera plays a clip made here, not Chromium's own fake picture, which
 * is flat colour and costs the encoder next to nothing. Once the machine is
 * busy all the time, the browsers are fighting each other for it, and the
 * figures stop saying what one person's own computer would spend.
 * Needs `pnpm --filter @slackoss/web build` first.
 *
 *   pnpm --filter @slackoss/server exec tsx ../../scripts/measure-calls.mts \
 *     [--sizes=2,3,4,5,6] [--seconds=120] [--settle=20] [--every=5] \
 *     [--camera=on|off] [--out=calls.json] [--shots=<folder for a failed call's windows>]
 *
 * Set CHROMIUM to a browser executable to use one other than Playwright's own.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve, sep } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createWorkspaceServer, type WorkspaceServer } from "../packages/server/src/index.js";
import { check } from "./build-identity.mjs";

const value = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const number = (name: string, fallback: number) => Number(value(name) ?? fallback);
const params = {
  sizes: (value("sizes") ?? "2,3,4,5,6").split(",").map(Number),
  seconds: number("seconds", 120),
  settleSeconds: number("settle", 20),
  sampleEverySeconds: number("every", 5),
  camera: (value("camera") ?? "on") !== "off",
};
const out = value("out");
const shots = value("shots");
if (params.sizes.some((n) => !Number.isInteger(n) || n < 2))
  throw new Error("--sizes takes whole numbers of 2 or more, such as --sizes=2,4,6");
const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "apps/web/dist");
const viewport = { width: 1280, height: 800 };

/** Middle, near-worst and extremes of a list of numbers, to one decimal. */
function summary(values: number[]) {
  const all = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const at = (q: number) =>
    all.length ? +all[Math.min(all.length - 1, Math.floor(q * all.length))]!.toFixed(1) : null;
  return {
    samples: all.length,
    p50: at(0.5),
    p95: at(0.95),
    min: all.length ? +all[0]!.toFixed(1) : null,
    max: all.length ? +all.at(-1)!.toFixed(1) : null,
  };
}
const mean = (values: number[]) =>
  values.length ? +(values.reduce((s, x) => s + x, 0) / values.length).toFixed(1) : null;

function revision() {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
    return { revision: head, dirty };
  } catch {
    return { revision: process.env.GITHUB_SHA ?? "unknown", dirty: null };
  }
}

async function succeeded<T = any>(response: Response): Promise<T> {
  if (!response.ok)
    throw new Error(`${response.url} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** A small seeded generator, so the clip is the same on every run. */
function generator(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What the fake camera plays: someone swaying in front of a wall and a shelf
 * of books, with the grain a webcam's picture has, which is most of what an
 * encoder spends its bits on. Two seconds at the 960 by 540 and 24 frames a
 * second the app asks a camera for, in Y4M, looping without a jump.
 */
function cameraClip(path: string) {
  const W = 960;
  const H = 540;
  const FRAMES = 48;
  const random = generator(7);
  const wall = new Uint8Array(W * H);
  const books = (x: number, y: number) => x < 300 && y > 60 && y < 420;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      wall[y * W + x] = books(x, y)
        ? 60 + ((x >> 4) % 5) * 22 + Math.floor(y / 120) * 6 + (((x * 7) ^ (y * 3)) & 7)
        : 120 + (x / W) * 50 - (y / H) * 20;
  const fd = openSync(path, "w");
  try {
    writeSync(fd, `YUV4MPEG2 W${W} H${H} F24:1 Ip A1:1 C420jpeg\n`);
    const frame = Buffer.alloc(W * H * 1.5);
    for (let f = 0; f < FRAMES; f++) {
      const turn = (2 * Math.PI * f) / FRAMES;
      const cx = 560 + 60 * Math.sin(turn);
      const cy = 250 + 12 * Math.sin(2 * turn);
      const head = (x: number, y: number) => ((x - cx) / 110) ** 2 + ((y - cy) / 140) ** 2 < 1;
      const shirt = (x: number, y: number) =>
        ((x - cx) / 280) ** 2 + ((y - (H + 60)) / 200) ** 2 < 1;
      const eye = (x: number, y: number) =>
        ((Math.abs(x - cx) - 40) / 14) ** 2 + ((y - (cy - 25)) / 8) ** 2 < 1;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          let v = wall[y * W + x]!;
          if (head(x, y)) v = eye(x, y) ? 40 : 150 - 30 * ((x - cx) / 110) + ((x ^ y) & 3);
          else if (shirt(x, y)) v = 70 + (((x + f) >> 3) & 1) * 8;
          frame[y * W + x] = Math.max(16, Math.min(235, v + Math.floor(random() * 7) - 3));
        }
      const U = W * H;
      const V = U + (W / 2) * (H / 2);
      for (let y = 0; y < H / 2; y++)
        for (let x = 0; x < W / 2; x++) {
          const [u, v] = head(x * 2, y * 2)
            ? [110, 150]
            : shirt(x * 2, y * 2)
              ? [150, 110]
              : books(x * 2, y * 2)
                ? [100 + ((x >> 3) % 4) * 18, 160 - ((x >> 3) % 3) * 20]
                : [118, 134];
          frame[U + y * (W / 2) + x] = u;
          frame[V + y * (W / 2) + x] = v;
        }
      writeSync(fd, "FRAME\n");
      writeSync(fd, frame);
    }
  } finally {
    closeSync(fd);
  }
}

/** Busy and total CPU time of the whole machine so far, in milliseconds. */
function machineTimes() {
  let busy = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const { user, nice, sys, irq, idle } = cpu.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + irq + idle;
  }
  return { busy, total };
}

/**
 * Runs in each page before the app: keeps every peer connection where the
 * reader below can find it, and takes the call preferences a person would
 * have saved, so joining asks nothing. The fake microphone plays a tone,
 * which strong noise suppression takes out as noise.
 */
const PREPARE = () => {
  const Original = window.RTCPeerConnection;
  const w = window as unknown as { peers: RTCPeerConnection[] };
  w.peers = [];
  window.RTCPeerConnection = class extends Original {
    constructor(config?: RTCConfiguration) {
      super(config);
      w.peers.push(this);
    }
  };
  localStorage.setItem(
    "slackoss:call-preferences",
    JSON.stringify({ joinMuted: false, noiseFilter: false, devicesChecked: true }),
  );
};

/** One reading of a person's connections: running totals and what is true now. */
interface Reading {
  at: number;
  connected: number;
  /** Connections that are receiving the camera's frames. */
  videoFrom: number;
  /** Transport bytes, all connections together. */
  sent: number;
  received: number;
  sentAudio: number;
  sentVideo: number;
  /** Seconds the camera's encoders spent held back, all connections together. */
  limitedCpu: number;
  limitedBandwidth: number;
  limitedTotal: number;
  concealed: number;
  samplesReceived: number;
  jitterBufferDelay: number;
  jitterBufferEmitted: number;
  freezes: number;
  packetsLost: number;
  packetsReceived: number;
  /** Now, one entry per connection that has a value. */
  rttMs: number[];
  audioJitterMs: number[];
  sentHeight: number[];
  sentFps: number[];
  receivedFps: number[];
  /** What each camera encoder aims for, and what the bandwidth estimate allows each connection, in bit/s. */
  targetBps: number[];
  availableBps: number[];
  /** The camera's codec and encoder, such as "video/VP8 libvpx". */
  encoders: string[];
}

const READ = async (): Promise<Reading> => {
  type Entry = Record<string, any>;
  const peers = (window as unknown as { peers: RTCPeerConnection[] }).peers.filter(
    (p) => p.connectionState !== "closed",
  );
  const r: Reading = {
    at: performance.now(),
    connected: 0,
    videoFrom: 0,
    sent: 0,
    received: 0,
    sentAudio: 0,
    sentVideo: 0,
    limitedCpu: 0,
    limitedBandwidth: 0,
    limitedTotal: 0,
    concealed: 0,
    samplesReceived: 0,
    jitterBufferDelay: 0,
    jitterBufferEmitted: 0,
    freezes: 0,
    packetsLost: 0,
    packetsReceived: 0,
    rttMs: [],
    audioJitterMs: [],
    sentHeight: [],
    sentFps: [],
    receivedFps: [],
    targetBps: [],
    availableBps: [],
    encoders: [],
  };
  for (const pc of peers) {
    if (pc.connectionState === "connected") r.connected++;
    const entries: Entry[] = [];
    (await pc.getStats()).forEach((e: Entry) => entries.push(e));
    let decoding = false;
    for (const e of entries) {
      if (e.type === "transport") {
        r.sent += e.bytesSent ?? 0;
        r.received += e.bytesReceived ?? 0;
        const pair = entries.find((c) => c.id === e.selectedCandidatePairId);
        if (pair?.availableOutgoingBitrate !== undefined)
          r.availableBps.push(pair.availableOutgoingBitrate);
      } else if (e.type === "outbound-rtp" && (e.bytesSent ?? 0) > 0) {
        const bytes = (e.bytesSent ?? 0) + (e.headerBytesSent ?? 0);
        if (e.kind === "audio") r.sentAudio += bytes;
        else {
          r.sentVideo += bytes;
          const held = e.qualityLimitationDurations ?? {};
          r.limitedCpu += held.cpu ?? 0;
          r.limitedBandwidth += held.bandwidth ?? 0;
          r.limitedTotal += (held.cpu ?? 0) + (held.bandwidth ?? 0) + (held.none ?? 0);
          r.limitedTotal += held.other ?? 0;
          if (e.frameHeight) r.sentHeight.push(e.frameHeight);
          if (e.framesPerSecond !== undefined) r.sentFps.push(e.framesPerSecond);
          if (e.targetBitrate !== undefined) r.targetBps.push(e.targetBitrate);
          const codec = entries.find((c) => c.id === e.codecId)?.mimeType ?? "?";
          const encoder = `${codec} ${e.encoderImplementation ?? "?"}`;
          if (!r.encoders.includes(encoder)) r.encoders.push(encoder);
        }
      } else if (e.type === "remote-inbound-rtp" && e.kind === "audio") {
        if (e.roundTripTime !== undefined) r.rttMs.push(e.roundTripTime * 1000);
      } else if (e.type === "inbound-rtp" && (e.packetsReceived ?? 0) > 0) {
        r.packetsLost += Math.max(0, e.packetsLost ?? 0);
        r.packetsReceived += e.packetsReceived ?? 0;
        if (e.kind === "audio") {
          r.concealed += e.concealedSamples ?? 0;
          r.samplesReceived += e.totalSamplesReceived ?? 0;
          r.jitterBufferDelay += e.jitterBufferDelay ?? 0;
          r.jitterBufferEmitted += e.jitterBufferEmittedCount ?? 0;
          if (e.jitter !== undefined) r.audioJitterMs.push(e.jitter * 1000);
        } else if ((e.framesDecoded ?? 0) > 0) {
          decoding = true;
          r.freezes += e.freezeCount ?? 0;
          if (e.framesPerSecond !== undefined) r.receivedFps.push(e.framesPerSecond);
        }
      }
    }
    if (decoding) r.videoFrom++;
  }
  return r;
};

/** CPU seconds every process of one browser has used so far. */
async function browserCpuSeconds(browser: Browser): Promise<number> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as {
      processInfo: { type: string; cpuTime: number }[];
    };
    return processInfo.reduce((sum, p) => sum + p.cpuTime, 0);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

const until = async (what: string, ms: number, ok: () => Promise<boolean>) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not happen within ${ms / 1000} s`);
};

const dir = realpathSync(mkdtempSync(join(tmpdir(), "tandem-calls-")));
let server: WorkspaceServer | undefined;
const browsers: Browser[] = [];
try {
  const stale = check(["web"]);
  if (stale.length)
    throw new Error(`the web client is not built from this checkout:\n${stale.join("\n")}`);
  server = await createWorkspaceServer({
    dataDir: dir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
    webDistPath: WEB,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const most = Math.max(...params.sizes);
  const people = Array.from({ length: most }, (_, i) => `person${i + 1}`);
  for (const handle of people)
    await succeeded(
      await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
      }),
    );

  const clip = join(dir, "camera.y4m");
  cameraClip(clip);
  const launch = () =>
    chromium.launch({
      executablePath: process.env.CHROMIUM || undefined,
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-video-capture=${clip}`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    });

  // Sign each person in once through the client and start every call from
  // what that left in storage.
  const signedIn: Awaited<ReturnType<BrowserContext["storageState"]>>[] = [];
  {
    const browser = await launch();
    browsers.push(browser);
    for (const handle of people) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto(base);
      await page.getByLabel("Username", { exact: true }).waitFor();
      const signInTab = page.getByRole("tab", { name: "Sign in", exact: true }).first();
      if (await signInTab.isVisible().catch(() => false)) await signInTab.click();
      await page.getByLabel("Username", { exact: true }).fill(handle);
      await page.getByLabel("Password", { exact: true }).fill("password123");
      await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
      await page.locator("textarea").waitFor();
      signedIn.push(await context.storageState({ indexedDB: true }));
      await context.close();
    }
    await browser.close();
    browsers.length = 0;
  }

  const calls = [];
  for (const size of params.sizes) {
    process.stderr.write(`${size} people: joining\n`);
    const errors: string[] = [];
    const pages: Page[] = [];
    try {
      for (let i = 0; i < size; i++) {
        const browser = await launch();
        browsers.push(browser);
        const context = await browser.newContext({
          storageState: signedIn[i],
          viewport,
          permissions: ["microphone", "camera"],
        });
        await context.addInitScript(PREPARE);
        const page = await context.newPage();
        pages.push(page);
        page.on("pageerror", (err) => errors.push(`${people[i]}: ${err.message}`));
        await page.goto(base);
        await page.getByRole("textbox", { name: "Message #general", exact: true }).waitFor();
        await page
          .getByRole("button", { name: i === 0 ? "Start a huddle" : /^Join the huddle with / })
          .click();
        await page.getByRole("button", { name: "Leave", exact: true }).first().waitFor();
        if (params.camera)
          await page.getByRole("button", { name: "Camera", exact: true, pressed: false }).click();
      }
      // Everyone is connected to everyone else, and sees each camera.
      await until(`a call of ${size} connecting`, 60_000, async () => {
        const readings = await Promise.all(pages.map((p) => p.evaluate(READ)));
        return readings.every(
          (r) => r.connected === size - 1 && (!params.camera || r.videoFrom === size - 1),
        );
      });
      process.stderr.write(`${size} people: settling for ${params.settleSeconds} s\n`);
      await new Promise((r) => setTimeout(r, params.settleSeconds * 1000));

      const cpuBefore = await Promise.all(browsers.map(browserCpuSeconds));
      const machineBefore = machineTimes();
      const first = await Promise.all(pages.map((p) => p.evaluate(READ)));
      const began = Date.now();
      const samples: Reading[][] = pages.map(() => []);
      process.stderr.write(`${size} people: measuring for ${params.seconds} s\n`);
      while (Date.now() - began < params.seconds * 1000) {
        await new Promise((r) => setTimeout(r, params.sampleEverySeconds * 1000));
        const readings = await Promise.all(pages.map((p) => p.evaluate(READ)));
        readings.forEach((r, i) => samples[i]!.push(r));
      }
      const last = samples.map((s) => s.at(-1)!);
      const cpuAfter = await Promise.all(browsers.map(browserCpuSeconds));
      const machineAfter = machineTimes();
      const seconds = (Date.now() - began) / 1000;

      const kbps = (bytes: number, s: number) => (bytes * 8) / s / 1000;
      const each = pages.map((_, i) => {
        const a = first[i]!;
        const b = last[i]!;
        const s = (b.at - a.at) / 1000;
        const limited = b.limitedTotal - a.limitedTotal;
        return {
          cpuPctOfOneCore: ((cpuAfter[i]! - cpuBefore[i]!) / seconds) * 100,
          sentKbps: kbps(b.sent - a.sent, s),
          receivedKbps: kbps(b.received - a.received, s),
          sentAudioKbps: kbps(b.sentAudio - a.sentAudio, s),
          sentVideoKbps: kbps(b.sentVideo - a.sentVideo, s),
          cpuLimitedPct: limited > 0 ? ((b.limitedCpu - a.limitedCpu) / limited) * 100 : 0,
          bandwidthLimitedPct:
            limited > 0 ? ((b.limitedBandwidth - a.limitedBandwidth) / limited) * 100 : 0,
          audioConcealedPct:
            b.samplesReceived > a.samplesReceived
              ? ((b.concealed - a.concealed) / (b.samplesReceived - a.samplesReceived)) * 100
              : 0,
          jitterBufferMs:
            b.jitterBufferEmitted > a.jitterBufferEmitted
              ? ((b.jitterBufferDelay - a.jitterBufferDelay) /
                  (b.jitterBufferEmitted - a.jitterBufferEmitted)) *
                1000
              : null,
          freezes: b.freezes - a.freezes,
          packetsLostPct:
            b.packetsReceived > a.packetsReceived
              ? ((b.packetsLost - a.packetsLost) /
                  (b.packetsReceived - a.packetsReceived + b.packetsLost - a.packetsLost)) *
                100
              : 0,
          // Whether every connection stayed up, and every camera came through.
          stayedConnected: samples[i]!.every((r) => r.connected === size - 1),
          videoThroughout: !params.camera || samples[i]!.every((r) => r.videoFrom === size - 1),
        };
      });
      const all = (pick: (r: Reading) => number[]) => samples.flat().flatMap(pick);
      const per = (key: keyof (typeof each)[number]) =>
        each.map((e) => e[key]).filter((v): v is number => typeof v === "number");
      const call = {
        size,
        seconds: +seconds.toFixed(1),
        machineBusyPct: +(
          ((machineAfter.busy - machineBefore.busy) / (machineAfter.total - machineBefore.total)) *
          100
        ).toFixed(1),
        perPerson: {
          cpuPctOfOneCore: {
            mean: mean(per("cpuPctOfOneCore")),
            ...summary(per("cpuPctOfOneCore")),
          },
          sentKbps: { mean: mean(per("sentKbps")), ...summary(per("sentKbps")) },
          receivedKbps: { mean: mean(per("receivedKbps")), ...summary(per("receivedKbps")) },
          sentAudioKbps: mean(per("sentAudioKbps")),
          sentVideoKbps: mean(per("sentVideoKbps")),
          cpuLimitedPct: mean(per("cpuLimitedPct")),
          bandwidthLimitedPct: mean(per("bandwidthLimitedPct")),
          audioConcealedPct: {
            mean: mean(per("audioConcealedPct")),
            ...summary(per("audioConcealedPct")),
          },
          jitterBufferMs: mean(per("jitterBufferMs")),
          freezes: per("freezes").reduce((s, x) => s + x, 0),
          packetsLostPct: mean(per("packetsLostPct")),
        },
        rttMs: summary(all((r) => r.rttMs)),
        audioJitterMs: summary(all((r) => r.audioJitterMs)),
        sentHeight: summary(all((r) => r.sentHeight)),
        sentFps: summary(all((r) => r.sentFps)),
        receivedFps: summary(all((r) => r.receivedFps)),
        // Per connection: what the camera's encoder aims for, and what the
        // bandwidth estimate would let it send.
        targetKbps: summary(all((r) => r.targetBps).map((b) => b / 1000)),
        availableKbps: summary(all((r) => r.availableBps).map((b) => b / 1000)),
        encoders: [...new Set(samples.flat().flatMap((r) => r.encoders))],
        everyoneStayedConnected: each.every((e) => e.stayedConnected),
        everyCameraThroughout: each.every((e) => e.videoThroughout),
        people: each.map((e) =>
          Object.fromEntries(
            Object.entries(e).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(1) : v]),
          ),
        ),
        errors,
      };
      calls.push(call);
      const p = call.perPerson;
      process.stderr.write(
        `${size} people: CPU ${p.cpuPctOfOneCore.mean}% of a core each (machine ${call.machineBusyPct}%), ` +
          `up ${p.sentKbps.mean} kbit/s, down ${p.receivedKbps.mean} kbit/s, ` +
          `sent ${call.sentHeight.p50}p at ${call.sentFps.p50} fps, ` +
          `round trip p95 ${call.rttMs.p95} ms, jitter p95 ${call.audioJitterMs.p95} ms, ` +
          `concealed ${p.audioConcealedPct.mean}%\n`,
      );
    } catch (error) {
      calls.push({ size, failed: error instanceof Error ? error.message : String(error), errors });
      process.stderr.write(`${size} people: failed: ${String(error)}\n`);
      // What each person's window showed, to see where it stopped.
      if (shots)
        await Promise.all(
          pages.map((p, i) =>
            p.screenshot({ path: join(shots, `failed-${size}-${people[i]}.png`) }).catch(() => {}),
          ),
        );
    } finally {
      await Promise.all(browsers.map((b) => b.close().catch(() => {})));
      browsers.length = 0;
    }
    // Let the server hear everyone leave before the next call starts.
    await new Promise((r) => setTimeout(r, 2000));
  }

  const probe = await launch();
  const chromiumVersion = probe.version();
  await probe.close();
  const result = {
    measured: "calls",
    ...revision(),
    at: new Date().toISOString(),
    params,
    machine: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memoryGiB: +(totalmem() / 2 ** 30).toFixed(1),
      node: process.version,
      chromium: chromiumVersion,
      viewport,
    },
    calls,
  };
  const text = JSON.stringify(result, null, 2) + "\n";
  if (out) writeFileSync(out, text);
  process.stdout.write(text);
} finally {
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  await server?.stop();
  if (dir.startsWith(realpathSync(tmpdir()) + sep) && existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
}
