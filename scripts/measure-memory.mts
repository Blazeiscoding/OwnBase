/**
 * What the desktop app holds in memory, stage by stage: at the welcome
 * screen, in a workspace, after using it for a while, in a huddle of four
 * (sound only, then with cameras), and after leaving, once and several times
 * over, which is where a leak would show.
 *
 * The app is the one built in this checkout (`pnpm --filter @ownbase/desktop
 * build`), run by Electron on a throwaway profile with its window showing, so
 * the graphics process holds what it would for a person. It joins a workspace
 * served by this script, filled by `seed-demo.mjs` and then with a few hundred
 * messages and some large pictures. The other three people in the huddle are
 * pages of one headless Chromium, on the web client (`pnpm --filter
 * @ownbase/web build`), with the fake microphone and a camera clip.
 *
 * The app is driven over CDP by hand, with real clicks and keys, and not by
 * Playwright: Playwright turns on the debugger's network recording, which
 * keeps a copy of every file the page loads, so each picture scrolled past
 * stayed in the page's memory for good and the figures came out far too high.
 * Nothing is turned on here but what one reading needs.
 *
 * At each stage it waits, collects garbage in the page, and reads:
 *
 *  - every process of the app from Windows: its private working set (what
 *    Task Manager shows as Memory) and its private bytes (what it has asked
 *    the system for), by kind of process;
 *  - the page's JavaScript heap and DOM nodes;
 *  - with `--infra`, Chromium's own account of each process by allocator.
 *
 * Windows only, since the process figures come from its counters.
 *
 *   pnpm --filter @ownbase/server exec tsx ../../scripts/measure-memory.mts \
 *     [--settle=8] [--messages=600] [--pictures=8] [--rounds=3] [--out=memory.json] \
 *     [--infra] [--heap=<folder>] [--shots=<folder>] [--electron=<electron.exe>] [--no-huddle] \
 *     [--hold=<file>] [--arg=<extra switch for the app>]...
 *
 * `--hold=<file>` stops in the workspace and writes the CDP port there, for
 * looking into the app by hand; deleting the file ends the run.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { cpus, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { chromium, type Browser, type Page } from "@playwright/test";
import { createWorkspaceServer, type WorkspaceServer } from "../packages/server/src/index.js";

const value = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const flag = (name: string) => process.argv.includes(`--${name}`);
const number = (name: string, fallback: number) => Number(value(name) ?? fallback);
const params = {
  settleSeconds: number("settle", 8),
  messages: number("messages", 600),
  pictures: number("pictures", 8),
  rounds: number("rounds", 3),
  huddle: !flag("no-huddle"),
  infra: flag("infra"),
  extraArgs: process.argv.filter((a) => a.startsWith("--arg=")).map((a) => a.slice(6)),
};
const out = value("out");
const shots = value("shots");
const hold = value("hold");
const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "apps/web/dist");
const DESKTOP = join(ROOT, "apps/desktop");
const PASSWORD = "password123";
const MiB = 2 ** 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (text: string) => process.stderr.write(`${text}\n`);

function electronPath(): string {
  const given = value("electron") ?? process.env.ELECTRON_EXEC_PATH;
  if (given) return given;
  const require = createRequire(join(DESKTOP, "package.json"));
  return require("electron") as unknown as string;
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

/** A noisy picture, so decoding it costs what a photo's would. */
function picture(width: number, height: number, seed: number): Buffer {
  const stride = width * 3 + 1;
  const rows = Buffer.alloc(stride * height);
  let a = seed >>> 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
      const at = y * stride + 1 + x * 3;
      rows[at] = ((x * 255) / width + (a & 31)) & 255;
      rows[at + 1] = ((y * 255) / height + ((a >> 5) & 31)) & 255;
      rows[at + 2] = (seed * 40 + ((a >> 10) & 31)) & 255;
    }
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type), body]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Two seconds of a moving, grainy picture for the fake cameras, in Y4M. */
function cameraClip(path: string) {
  const W = 960;
  const H = 540;
  const fd = openSync(path, "w");
  try {
    writeSync(fd, `YUV4MPEG2 W${W} H${H} F24:1 Ip A1:1 C420jpeg\n`);
    const frame = Buffer.alloc(W * H * 1.5, 128);
    let a = 7;
    for (let f = 0; f < 48; f++) {
      const cx = 480 + 120 * Math.sin((2 * Math.PI * f) / 48);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
          const head = ((x - cx) / 110) ** 2 + ((y - 250) / 140) ** 2 < 1;
          frame[y * W + x] = (head ? 150 : 90 + (x >> 4)) + (a & 7);
        }
      writeSync(fd, "FRAME\n");
      writeSync(fd, frame);
    }
  } finally {
    closeSync(fd);
  }
}

// ---------- CDP, by hand ----------

class Cdp {
  private next = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(params: any) => void>>();
  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id !== undefined) {
        const waiter = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result);
      } else if (message.method)
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.waiting.values()) waiter.reject(new Error("CDP closed"));
      this.waiting.clear();
    });
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((done, fail) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => done(new Cdp(socket)), { once: true });
      socket.addEventListener("error", () => fail(new Error(`could not open ${url}`)), {
        once: true,
      });
    });
  }
  send<T = any>(method: string, params: object = {}): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      // An answer that never comes should end the run, not hang it.
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} was not answered within 60 s`));
      }, 60_000);
      this.waiting.set(id, {
        resolve: (answer) => (clearTimeout(timer), resolve(answer)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(event: string, listener: (params: any) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => void set.delete(listener);
  }
  close(): void {
    this.socket.close();
  }
}

/** What each lookup in the app's page starts with: finding things as a person names them. */
const IN_PAGE = `
const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
const nameOf = (el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\\s+/g, " ").trim();
const fits = (name, want) => want.startsWith("/") ? new RegExp(want.slice(1, want.lastIndexOf("/"))).test(name) : name === want;
const within = (scope) => scope ? [...document.querySelectorAll('[role="dialog"]')].find((d) => shown(d) && nameOf({ getAttribute: (n) => d.getAttribute(n), textContent: "" }) === scope) : document;
const all = (selector, want, scope) => { const root = within(scope); return root ? [...root.querySelectorAll(selector)].filter((el) => shown(el) && (want === null || fits(nameOf(el), want))) : []; };
const field = (label, scope) => { const root = within(scope); if (!root) return null;
  for (const el of root.querySelectorAll("input, textarea, select")) if (shown(el) && (el.getAttribute("aria-label") === label || el.getAttribute("placeholder") === label)) return el;
  for (const l of root.querySelectorAll("label")) if (l.textContent.replace(/\\s+/g, " ").trim() === label) { const c = l.control ?? l.querySelector("input, textarea, select"); if (c && shown(c)) return c; }
  return null; };
const centre = (el) => { el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
`;

/** The app's window, driven as a person would: looked at, clicked, typed into. */
class AppPage {
  constructor(readonly cdp: Cdp) {}

  async evaluate<T>(body: string): Promise<T> {
    const answer = await this.cdp.send<{
      result: { value: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression: `(async () => { ${IN_PAGE}\n${body} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (answer.exceptionDetails)
      throw new Error(
        answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text,
      );
    return answer.result.value;
  }

  async until(what: string, body: string, ms = 60_000): Promise<void> {
    const end = Date.now() + ms;
    for (;;) {
      if (await this.evaluate<boolean>(`return !!(${body});`).catch(() => false)) return;
      if (Date.now() > end) throw new Error(`${what} did not happen within ${ms / 1000} s`);
      await sleep(250);
    }
  }

  private async clickAt(point: { x: number; y: number }): Promise<void> {
    const at = { x: point.x, y: point.y, button: "left", clickCount: 1 };
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
  }

  /** Clicks what `find` evaluates to, once it is there. */
  private async clickFound(what: string, find: string): Promise<void> {
    await this.until(what, find);
    const point = await this.evaluate<{ x: number; y: number }>(`return centre(${find});`);
    await this.clickAt(point);
  }

  /** A name is exact, or a regular expression written "/…/". The last match with `last`. */
  click(
    selector: string,
    name: string | null,
    options: { scope?: string; last?: boolean } = {},
  ): Promise<void> {
    const found = `all(${JSON.stringify(selector)}, ${JSON.stringify(name)}, ${JSON.stringify(options.scope ?? null)})`;
    return this.clickFound(
      `${selector} "${name}"`,
      options.last ? `${found}.at(-1)` : `${found}[0]`,
    );
  }

  has(selector: string, name: string | null, scope?: string): Promise<boolean> {
    return this.evaluate<boolean>(
      `return all(${JSON.stringify(selector)}, ${JSON.stringify(name)}, ${JSON.stringify(scope ?? null)}).length > 0;`,
    );
  }

  waitFor(selector: string, name: string | null, scope?: string): Promise<void> {
    return this.until(
      `${selector} "${name}"`,
      `all(${JSON.stringify(selector)}, ${JSON.stringify(name)}, ${JSON.stringify(scope ?? null)}).length`,
    );
  }

  hasDialog(name: string): Promise<boolean> {
    return this.evaluate<boolean>(`return !!within(${JSON.stringify(name)});`);
  }

  async fill(label: string, text: string, scope?: string): Promise<void> {
    const find = `field(${JSON.stringify(label)}, ${JSON.stringify(scope ?? null)})`;
    await this.clickFound(`the field ${label}`, find);
    await this.evaluate(`${find}.select?.();`);
    await this.cdp.send("Input.insertText", { text });
  }

  async press(key: "Enter" | "Escape"): Promise<void> {
    const code = key === "Enter" ? 13 : 27;
    const event = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...event,
      ...(key === "Enter" ? { text: "\r" } : {}),
    });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  }

  async shot(path: string): Promise<void> {
    const { data } = await this.cdp.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    writeFileSync(path, Buffer.from(data, "base64"));
  }
}

// ---------- readings ----------

interface ProcessReading {
  pid: number;
  kind: string;
  /** Private working set: Task Manager's Memory column. */
  privateWorkingSetMiB: number;
  /** Private bytes: what the process has committed. */
  privateBytesMiB: number;
}

/** Every process of the app whose main process is `pid`, as Windows counts them. */
function processes(pid: number): ProcessReading[] {
  const script = `
$all = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${pid} -or $_.ParentProcessId -eq ${pid} }
$perf = @{}
Get-CimInstance Win32_PerfRawData_PerfProc_Process | ForEach-Object { $perf[[int]$_.IDProcess] = $_.WorkingSetPrivate }
$all | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name; cmd = $_.CommandLine; priv = $_.PrivatePageCount; pws = $perf[[int]$_.ProcessId] } } | ConvertTo-Json -Compress`;
  const text = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", maxBuffer: 16 * MiB },
  );
  const parsed = JSON.parse(text) as unknown;
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as {
    pid: number;
    name: string;
    cmd: string | null;
    priv: number;
    pws: number | null;
  }[];
  return rows.map((row) => {
    const cmd = row.cmd ?? "";
    const type = /--type=([\w-]+)/.exec(cmd)?.[1];
    // Such as network.mojom.NetworkService or audio.mojom.AudioService.
    const service = /--utility-sub-type=([\w.]+)/.exec(cmd)?.[1]?.split(".").at(-1);
    const kind = !type
      ? row.pid === pid
        ? "main"
        : row.name.replace(/\.exe$/i, "")
      : type === "utility"
        ? (service ?? "utility").replace(/Service$/, "").toLowerCase()
        : type === "gpu-process"
          ? "gpu"
          : type;
    return {
      pid: row.pid,
      kind,
      privateWorkingSetMiB: +((row.pws ?? 0) / MiB).toFixed(1),
      privateBytesMiB: +(row.priv / MiB).toFixed(1),
    };
  });
}

interface StageReading {
  stage: string;
  totalPrivateWorkingSetMiB: number;
  totalPrivateBytesMiB: number;
  byKind: Record<string, { privateWorkingSetMiB: number; privateBytesMiB: number; count: number }>;
  page: { heapUsedMiB: number; heapTotalMiB: number; nodes: number };
  /** With --infra: Chromium's own account of each process, by allocator, in MiB. */
  infra?: Record<string, Record<string, number>>;
}

/**
 * Chromium's own account of where each process's memory is (memory-infra),
 * two levels of allocator deep. Some of these overlap: Skia's, the
 * compositor's and the fonts' caches are inside malloc or discardable.
 */
async function infraDump(browser: Cdp): Promise<Record<string, Record<string, number>>> {
  type TraceEvent = { ph: string; pid: number; name: string; args?: any };
  const events: TraceEvent[] = [];
  const stop = browser.on("Tracing.dataCollected", (data: { value: TraceEvent[] }) =>
    events.push(...data.value),
  );
  const done = new Promise<void>((resolve) => {
    const off = browser.on("Tracing.tracingComplete", () => {
      off();
      resolve();
    });
  });
  await browser.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      includedCategories: ["disabled-by-default-memory-infra"],
      excludedCategories: ["*"],
      memoryDumpConfig: { triggers: [] },
    },
  });
  await browser.send("Tracing.requestMemoryDump", { levelOfDetail: "detailed" });
  await browser.send("Tracing.end");
  await done;
  stop();
  const names = new Map<number, string>();
  for (const e of events)
    if (e.ph === "M" && e.name === "process_name") names.set(e.pid, String(e.args?.name));
  const result: Record<string, Record<string, number>> = {};
  for (const e of events) {
    const allocators = e.args?.dumps?.allocators as
      Record<string, { attrs?: Record<string, { value?: string; units?: string }> }> | undefined;
    if (e.ph !== "v" || !allocators) continue;
    const process = (result[`${names.get(e.pid) ?? "?"} ${e.pid}`] ??= {});
    const bytes = (name: string) => {
      const size = allocators[name]?.attrs?.size;
      return size?.units === "bytes" && size.value ? parseInt(size.value, 16) : undefined;
    };
    // A node's own size where it has one; otherwise its children's, summed.
    const sized = (prefix: string): number => {
      const own = bytes(prefix);
      if (own !== undefined) return own;
      const children = new Set<string>();
      for (const name of Object.keys(allocators))
        if (name.startsWith(`${prefix}/`))
          children.add(`${prefix}/${name.slice(prefix.length + 1).split("/")[0]}`);
      let sum = 0;
      for (const child of children) sum += sized(child);
      return sum;
    };
    const groups = new Set<string>();
    for (const name of Object.keys(allocators)) {
      if (name.startsWith("global/")) continue;
      const parts = name.split("/");
      groups.add(parts[0]!);
      if (parts.length > 1) groups.add(`${parts[0]}/${parts[1]}`);
    }
    for (const group of groups) {
      const mib = +(sized(group) / MiB).toFixed(1);
      if (mib >= 0.5) process[group] = Math.max(process[group] ?? 0, mib);
    }
  }
  return result;
}

/**
 * With --heap=<folder>: the page's JavaScript heap, as bytes held by each kind
 * and name of object, written per stage for comparing two of them. Taking it
 * costs the page memory of its own, so the other figures of such a run read high.
 */
async function heapSummary(page: Cdp): Promise<Record<string, number>> {
  const chunks: string[] = [];
  const stop = page.on("HeapProfiler.addHeapSnapshotChunk", (data: { chunk: string }) =>
    chunks.push(data.chunk),
  );
  await page.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  stop();
  const snapshot = JSON.parse(chunks.join("")) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[], ...unknown[]] } };
    nodes: number[];
    strings: string[];
  };
  const fields = snapshot.snapshot.meta.node_fields;
  const types = snapshot.snapshot.meta.node_types[0];
  const [type, name, size] = ["type", "name", "self_size"].map((f) => fields.indexOf(f)) as [
    number,
    number,
    number,
  ];
  const sums: Record<string, number> = {};
  for (let i = 0; i < snapshot.nodes.length; i += fields.length) {
    const kind = types[snapshot.nodes[i + type]!]!;
    let label = snapshot.strings[snapshot.nodes[i + name]!] ?? "";
    // Strings are told apart by size, not by what they say.
    if (kind === "string" || kind === "concatenated string" || kind === "sliced string")
      label = snapshot.nodes[i + size]! > 65536 ? `big: ${label.slice(0, 60)}` : "(small)";
    else if (label.length > 80) label = label.slice(0, 80);
    const key = `${kind}: ${label}`;
    sums[key] = (sums[key] ?? 0) + snapshot.nodes[i + size]!;
  }
  return Object.fromEntries(
    Object.entries(sums)
      .filter(([, bytes]) => bytes >= 20_000)
      .sort((a, b) => b[1] - a[1]),
  );
}

async function succeeded<T = any>(response: Response): Promise<T> {
  if (!response.ok)
    throw new Error(`${response.url} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

const dir = mkdtempSync(join(tmpdir(), "ownbase-memory-"));
let server: WorkspaceServer | undefined;
let peersBrowser: Browser | undefined;
let app: ChildProcess | undefined;
const sockets: Cdp[] = [];
const readings: StageReading[] = [];

try {
  // ---------- the workspace ----------
  server = await createWorkspaceServer({
    dataDir: join(dir, "server"),
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: false,
    webDistPath: WEB,
  });
  const base = `http://127.0.0.1:${server.port}`;
  // Not execFileSync: the server it talks to runs in this process.
  await new Promise<void>((done, fail) => {
    const seeding = spawn(
      process.execPath,
      [join(ROOT, "scripts/seed-demo.mjs"), base, "--password", PASSWORD],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    seeding.once("error", fail);
    seeding.once("exit", (code) =>
      code === 0 ? done() : fail(new Error(`seeding the workspace failed (exit ${code})`)),
    );
  });
  const tokens: Record<string, string> = {};
  for (const handle of ["maya", "sam", "priya", "alex"]) {
    const { token } = await succeeded<{ token: string }>(
      await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle, password: PASSWORD }),
      }),
    );
    tokens[handle] = token;
    // An account with no time zone is given one on its first connection, which
    // changes it for everyone; set here so that is not counted as a call's cost.
    await succeeded(
      await fetch(`${base}/api/me`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ timeZone: "Asia/Kolkata" }),
      }),
    );
  }
  const { channels } = await succeeded<{ channels: { id: string; name: string }[] }>(
    await fetch(`${base}/api/channels`, { headers: { authorization: `Bearer ${tokens.maya}` } }),
  );
  const general = channels.find((c) => c.name === "general")!;
  const post = (handle: string, body: unknown) =>
    fetch(`${base}/api/channels/${general.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens[handle]}` },
      body: JSON.stringify(body),
    }).then(succeeded);
  const handles = Object.keys(tokens);
  say(`seeding ${params.messages} messages and ${params.pictures} pictures`);
  const every = Math.max(1, Math.floor(params.messages / Math.max(1, params.pictures)));
  for (let i = 0; i < params.messages; i++) {
    const handle = handles[i % handles.length]!;
    // Never the very last message, so the newest screen is text, as most are.
    if (params.pictures && i % every === every - 20 && i / every < params.pictures) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(picture(1920, 1080, i))], { type: "image/png" }),
        `photo-${i}.png`,
      );
      const { file } = await succeeded<{ file: { id: string } }>(
        await fetch(`${base}/api/channels/${general.id}/files`, {
          method: "POST",
          headers: { authorization: `Bearer ${tokens[handle]}` },
          body: form,
        }),
      );
      await post(handle, { text: `Photo ${i}`, fileIds: [file.id] });
    } else {
      await post(handle, {
        text: `Message ${i}: ${"the quick brown fox jumps over the lazy dog ".repeat(1 + (i % 4))}:tada:`,
      });
    }
  }

  // ---------- the app ----------
  const clip = join(dir, "camera.y4m");
  cameraClip(clip);
  const port = await freePort();
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env;
  app = spawn(
    electronPath(),
    [
      DESKTOP,
      `--remote-debugging-port=${port}`,
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${clip}`,
      // Measured as a window in front of the person: whether another window
      // happens to cover it during the run must not change what it holds.
      "--disable-features=CalculateNativeWinOcclusion",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      ...params.extraArgs,
    ],
    {
      env: {
        ...inherited,
        OWNBASE_USER_DATA_DIR: join(dir, "profile"),
        OWNBASE_SYSTEM_MICROPHONE: "0",
      },
      stdio: "ignore",
    },
  );
  const appPid = app.pid!;
  let pageUrl: string | undefined;
  for (let i = 0; !pageUrl; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        url: string;
        webSocketDebuggerUrl: string;
      }[];
      pageUrl = targets.find(
        (t) => t.type === "page" && !t.url.startsWith("devtools"),
      )?.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    if (!pageUrl) {
      if (i > 120) throw new Error("the app opened no window");
      await sleep(500);
    }
  }
  const pageCdp = await Cdp.open(pageUrl);
  sockets.push(pageCdp);
  const page = new AppPage(pageCdp);
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
    webSocketDebuggerUrl: string;
  };
  const browserCdp = await Cdp.open(version.webSocketDebuggerUrl);
  sockets.push(browserCdp);

  const shot = async (name: string) => {
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    await page.shot(join(shots, `${name.replace(/[^a-z0-9]+/gi, "-")}.png`)).catch(() => {});
  };

  const read = async (stage: string) => {
    await sleep(params.settleSeconds * 1000);
    await pageCdp.send("HeapProfiler.collectGarbage");
    await sleep(1000);
    const heap = await pageCdp.send<{ usedSize: number; totalSize: number }>(
      "Runtime.getHeapUsage",
    );
    const nodes = await page.evaluate<number>(`return document.querySelectorAll("*").length;`);
    const list = processes(appPid);
    const byKind: StageReading["byKind"] = {};
    for (const p of list) {
      const kind = (byKind[p.kind] ??= { privateWorkingSetMiB: 0, privateBytesMiB: 0, count: 0 });
      kind.privateWorkingSetMiB = +(kind.privateWorkingSetMiB + p.privateWorkingSetMiB).toFixed(1);
      kind.privateBytesMiB = +(kind.privateBytesMiB + p.privateBytesMiB).toFixed(1);
      kind.count++;
    }
    const reading: StageReading = {
      stage,
      totalPrivateWorkingSetMiB: +list.reduce((s, p) => s + p.privateWorkingSetMiB, 0).toFixed(1),
      totalPrivateBytesMiB: +list.reduce((s, p) => s + p.privateBytesMiB, 0).toFixed(1),
      byKind,
      page: {
        heapUsedMiB: +(heap.usedSize / MiB).toFixed(1),
        heapTotalMiB: +(heap.totalSize / MiB).toFixed(1),
        nodes,
      },
    };
    if (params.infra) reading.infra = await infraDump(browserCdp);
    const heapFolder = value("heap");
    if (heapFolder) {
      mkdirSync(heapFolder, { recursive: true });
      writeFileSync(
        join(heapFolder, `${readings.length}-${stage.replace(/[^a-z0-9]+/gi, "-")}.json`),
        JSON.stringify(await heapSummary(pageCdp)),
      );
    }
    readings.push(reading);
    await shot(stage);
    const kinds = Object.entries(byKind)
      .map(([kind, m]) => `${kind} ${m.privateWorkingSetMiB}`)
      .join(", ");
    say(
      `${stage}: ${reading.totalPrivateWorkingSetMiB} MiB private working set ` +
        `(${reading.totalPrivateBytesMiB} committed); ${kinds}; heap ${reading.page.heapUsedMiB}, ` +
        `${reading.page.nodes} nodes`,
    );
  };

  const HUDDLE_BUTTON = "/^(Start a huddle|Join the huddle with .*)$/";
  const DEVICES = "Choose your microphone and camera";
  const joinHuddle = async () => {
    await page.click("button", HUDDLE_BUTTON);
    await page.until(
      "the huddle starting",
      `within(${JSON.stringify(DEVICES)}) || all("button", "Leave", null).length`,
    );
    if (await page.hasDialog(DEVICES))
      await page.click("button", "Join huddle", { scope: DEVICES });
    await page.waitFor("button", "Leave");
  };
  const leaveHuddle = async () => {
    await page.click("button", "Leave");
    await page.waitFor("button", HUDDLE_BUTTON);
  };

  /**
   * Everyone's picture is moving on everyone's screen: the figures of a call
   * whose cameras came on but whose pictures never arrived would look fine.
   */
  const MOVING = `
    const videos = () => [...document.querySelectorAll("video")];
    const frames = (video) => video.getVideoPlaybackQuality().totalVideoFrames;
    const before = new Map(videos().map((video) => [video, frames(video)]));
    await new Promise((done) => setTimeout(done, 1500));
    return videos().filter((video) => video.videoWidth > 0 && frames(video) > (before.get(video) ?? 0)).length;`;
  const everyoneSeen = async (peers: Page[]) => {
    const end = Date.now() + 30_000;
    for (;;) {
      const moving = [
        await page.evaluate<number>(MOVING),
        ...(await Promise.all(
          peers.map((peer) => peer.evaluate<number>(`(async () => { ${MOVING} })()`)),
        )),
      ];
      if (moving.every((count) => count >= peers.length + 1)) return;
      if (Date.now() > end)
        throw new Error(
          `not every camera is showing everywhere: pictures moving on each screen ${moving.join(", ")}`,
        );
    }
  };

  try {
    await page.until(
      "the welcome screen",
      `[...document.querySelectorAll("h1, h2, p, span")].some((el) => el.textContent.trim() === "Find your workspace")`,
    );
    await read("welcome");

    await page.fill("Server address", `127.0.0.1:${server.port}`);
    await page.press("Enter");
    await page.until("the sign-in form", `field("Username", null)`);
    if (await page.has('[role="tab"]', "Sign in")) await page.click('[role="tab"]', "Sign in");
    await page.fill("Username", "maya");
    await page.fill("Password", PASSWORD);
    await page.click("button", "Sign in", { last: true });
    await page.until("the workspace opening", `field("Message #general", null)`);
    await sleep(1000);
    if (await page.hasDialog("Invite your people"))
      await page.click("button", "Done", { scope: "Invite your people" });
    await read("workspace, just opened");

    // A while of ordinary use: every conversation opened, the history read
    // back to its start and down again.
    const rows = await page.evaluate<number>(
      `return document.querySelectorAll("[data-conversation]").length;`,
    );
    for (let i = 0; i < rows; i++) {
      await page.evaluate(
        `const row = document.querySelectorAll("[data-conversation]")[${i}]; (row?.querySelector("button, a") ?? row)?.click();`,
      );
      await sleep(500);
    }
    await page.evaluate(
      `const row = [...document.querySelectorAll("[data-conversation]")].find((r) => /general/.test(r.textContent)); (row?.querySelector("button, a") ?? row)?.click();`,
    );
    await page.until("#general opening again", `field("Message #general", null)`);
    await sleep(1000);
    // Scrolled from the page, not by the wheel: a wheel sent over CDP waits
    // for a frame, which never comes while another window covers this one.
    const scroll = (by: number) =>
      page.evaluate(`document.querySelector('[aria-label="Message history"]').scrollBy(0, ${by});`);
    for (let i = 0; i < 60; i++) {
      await scroll(-3000);
      await sleep(200);
    }
    await sleep(1500);
    for (let i = 0; i < 80; i++) {
      await scroll(6000);
      await sleep(100);
    }
    await read("workspace, used a while");

    if (hold) {
      writeFileSync(hold, JSON.stringify({ port, pid: appPid, base }));
      say(`holding; CDP on port ${port}; delete ${hold} to finish`);
      while (existsSync(hold)) await sleep(1000);
    } else if (params.huddle) {
      await joinHuddle();
      await read("huddle, alone");

      peersBrowser = await chromium.launch({
        channel: "chromium",
        args: [
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
          `--use-file-for-fake-video-capture=${clip}`,
          "--autoplay-policy=no-user-gesture-required",
        ],
      });
      const peers: Page[] = [];
      for (const handle of ["sam", "priya", "alex"]) {
        const context = await peersBrowser.newContext({
          viewport: { width: 1280, height: 800 },
          permissions: ["microphone", "camera"],
        });
        await context.addInitScript(() => {
          localStorage.setItem(
            "ownbase:call-preferences",
            JSON.stringify({ joinMuted: false, noiseFilter: false, devicesChecked: true }),
          );
        });
        const peer = await context.newPage();
        peer.setDefaultTimeout(60_000);
        await peer.goto(base);
        await peer.getByLabel("Username", { exact: true }).waitFor();
        const tab = peer.getByRole("tab", { name: "Sign in", exact: true }).first();
        if (await tab.isVisible().catch(() => false)) await tab.click();
        await peer.getByLabel("Username", { exact: true }).fill(handle);
        await peer.getByLabel("Password", { exact: true }).fill(PASSWORD);
        await peer.getByRole("button", { name: "Sign in", exact: true }).last().click();
        await peer.getByRole("textbox", { name: "Message #general", exact: true }).waitFor();
        await peer
          .getByRole("button", { name: /^Join the huddle with / })
          .first()
          .click();
        const check = peer.getByRole("dialog", { name: DEVICES });
        const leave = peer.getByRole("button", { name: "Leave", exact: true }).first();
        await Promise.race([check.waitFor(), leave.waitFor()]);
        if (await check.isVisible().catch(() => false))
          await check.getByRole("button", { name: "Join huddle", exact: true }).click();
        await leave.waitFor();
        peers.push(peer);
      }
      await read("huddle of 4, sound only");

      // With --soak=<seconds>: the same call left alone, read every 30 s, to
      // see whether it grows with time by itself.
      const soak = number("soak", 0);
      for (let waited = 30; waited <= soak; waited += 30) {
        await sleep(Math.max(0, 30 - params.settleSeconds - 2) * 1000);
        await read(`huddle of 4, sound only, +${waited} s`);
      }

      for (const peer of peers)
        await peer.getByRole("button", { name: "Camera", exact: true, pressed: false }).click();
      await read("huddle of 4, their 3 cameras");

      await page.click('button[aria-pressed="false"]', "Camera");
      await everyoneSeen(peers);
      await read("huddle of 4, all 4 cameras");

      await page.click('button[aria-pressed="true"]', "Camera");
      for (const peer of peers)
        await peer.getByRole("button", { name: "Camera", exact: true, pressed: true }).click();
      await read("huddle of 4, cameras off again");

      // With --camera-rounds=<n>: everyone's camera on and off again that many
      // more times in the same call, where memory kept per switch would show.
      for (let round = 1; round <= number("camera-rounds", 0); round++) {
        for (const peer of peers)
          await peer.getByRole("button", { name: "Camera", exact: true, pressed: false }).click();
        await read(`huddle of 4, their cameras on, round ${round}`);
        await page.click('button[aria-pressed="false"]', "Camera");
        await everyoneSeen(peers);
        await read(`huddle of 4, cameras on, round ${round}`);
        await page.click('button[aria-pressed="true"]', "Camera");
        await read(`huddle of 4, own camera off, round ${round}`);
        for (const peer of peers)
          await peer.getByRole("button", { name: "Camera", exact: true, pressed: true }).click();
        await read(`huddle of 4, cameras off, round ${round}`);
      }

      await leaveHuddle();
      await read("after leaving");

      for (let round = 0; round < params.rounds; round++) {
        await joinHuddle();
        await page.click('button[aria-pressed="false"]', "Camera");
        await sleep(4000);
        await leaveHuddle();
        await sleep(1000);
      }
      if (params.rounds) await read(`after ${params.rounds} more huddles`);
    }
  } catch (error) {
    await shot("failed");
    throw error;
  }

  const report = {
    cpu: cpus()[0]?.model,
    memoryGiB: +(totalmem() / 2 ** 30).toFixed(1),
    params,
    readings,
  };
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  else console.log(JSON.stringify(report, null, 2));
} finally {
  for (const socket of sockets) socket.close();
  await peersBrowser?.close().catch(() => {});
  if (app?.pid) {
    // The whole tree: a plain kill leaves the window's processes behind.
    try {
      execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Already gone.
    }
  }
  await server?.stop().catch(() => {});
  await sleep(500);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
