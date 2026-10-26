/**
 * The client's side of the mixed baseline (IMP-07): what someone opening the
 * web client waits for, and what scrolling back through a picture-heavy
 * channel costs the page. Runs the built web client in headless Chromium
 * against a server in this process, on a workspace seeded from `--seed`.
 *
 *  - First usable conversation: from navigation to the composer being ready
 *    with the newest message on screen, in a fresh browser profile (cold: no
 *    HTTP cache) and on a reload (warm), with the bytes and requests it took.
 *  - Scrolling a picture channel from its newest message to its first: how
 *    long it took, the main thread's long tasks (over 50 ms), frames that took
 *    over 50 ms, and the JavaScript heap before and after.
 *
 * The fixture is checked before anything is timed (every picture is served,
 * the channel's first message is reachable) and errors are counted, never
 * timed. Desktop-main stalls and GPU memory need Electron and are left to a
 * local run (see the plan). Needs `pnpm --filter @slackoss/web build` first.
 *
 *   pnpm --filter @slackoss/server exec tsx ../../scripts/measure-client.mts \
 *     [--seed=1] [--history=400] [--pictures=60] [--rounds=5] [--out=client.json]
 *
 * Set CHROMIUM to a browser executable to use one other than Playwright's own.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve, sep } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createWorkspaceServer, type WorkspaceServer } from "../packages/server/src/index.js";
import { check } from "./build-identity.mjs";

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const params = {
  seed: arg("seed", 1),
  history: arg("history", 400),
  pictures: arg("pictures", 60),
  rounds: arg("rounds", 5),
  pictureWidth: 1024,
  pictureHeight: 768,
};
const out = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1];
const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "apps/web/dist");

/** A small seeded generator, so a seed always makes the same workspace. */
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
const random = generator(params.seed);
const WORDS =
  "the release plan design review ship friday numbers budget customer bug fix deploy staging meeting notes draft proposal roadmap sprint launch photo sketch mockup".split(
    " ",
  );
const sentence = (length: number) =>
  Array.from({ length }, () => WORDS[Math.floor(random() * WORDS.length)]!).join(" ");

/**
 * A photo-like PNG: a gradient with seeded grain, so it compresses about as
 * badly as a photo would and decodes to width × height × 4 bytes.
 */
function picture(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  const hue = Math.floor(random() * 255);
  for (let y = 0; y < height; y++) {
    const start = y * (width * 3 + 1);
    rows[start] = 0;
    for (let x = 0; x < width; x++) {
      const grain = Math.floor(random() * 24);
      rows[start + 1 + x * 3] = (hue + (x >> 3) + grain) & 255;
      rows[start + 2 + x * 3] = ((y >> 2) + grain) & 255;
      rows[start + 3 + x * 3] = (255 - hue + grain) & 255;
    }
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
    chunk("IDAT", deflateSync(rows, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Samples of one measure across rounds, and what failed while taking them. */
class Measure {
  readonly samples: number[] = [];
  errors = 0;
  readonly firstErrors: string[] = [];
  add(value: number) {
    this.samples.push(value);
  }
  fail(error: unknown) {
    this.errors++;
    if (this.firstErrors.length < 3)
      this.firstErrors.push(error instanceof Error ? error.message : String(error));
  }
  summary() {
    const all = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) =>
      all.length ? +all[Math.min(all.length - 1, Math.floor(q * all.length))]!.toFixed(1) : null;
    const mean = all.reduce((s, x) => s + x, 0) / Math.max(1, all.length);
    return {
      samples: all.length,
      p50: at(0.5),
      p95: at(0.95),
      min: all.length ? +all[0]!.toFixed(1) : null,
      max: all.length ? +all.at(-1)!.toFixed(1) : null,
      // Spread around the mean: how far one run can be trusted.
      spreadPct: all.length > 1 ? +(((all.at(-1)! - all[0]!) / mean) * 100).toFixed(1) : 0,
      errors: this.errors,
      ...(this.firstErrors.length ? { firstErrors: this.firstErrors } : {}),
    };
  }
}

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

/** Watches the page's main thread from its first script: long tasks and slow frames. */
const OBSERVE = () => {
  const w = window as unknown as { __probe: { longTasks: number[]; slowFrames: number[] } };
  w.__probe = { longTasks: [], slowFrames: [] };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) w.__probe.longTasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
  let last = performance.now();
  const frame = (now: number) => {
    if (now - last > 50) w.__probe.slowFrames.push(now - last);
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ownbase-client-")));
let server: WorkspaceServer | undefined;
let browser: Browser | undefined;
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
  const call = (path: string, token?: string, body?: unknown) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(succeeded);

  // Two people: one posts everything, the other opens the client.
  const owner = await call("/api/auth/register", undefined, {
    handle: "author",
    displayName: "Author",
    password: "password123",
  });
  const reader = await call("/api/auth/register", undefined, {
    handle: "reader",
    displayName: "Reader",
    password: "password123",
  });
  const general = server.store.getChannelByName("general")!.id;
  const gallery = (await call("/api/channels", owner.token, { type: "public", name: "gallery" }))
    .channel.id as string;
  await call(`/api/channels/${gallery}/join`, reader.token, {});

  const seeding = Date.now();
  for (let i = 0; i < params.history; i++)
    await call(`/api/channels/${general}/messages`, owner.token, { text: sentence(6 + (i % 20)) });
  const newest = `The newest message, number ${params.history}.`;
  await call(`/api/channels/${general}/messages`, owner.token, { text: newest });
  let pictureBytes = 0;
  const firstPicture = "The first picture in the gallery.";
  for (let i = 0; i < params.pictures; i++) {
    const png = picture(params.pictureWidth, params.pictureHeight);
    pictureBytes += png.length;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), `photo-${i}.png`);
    const uploaded = await succeeded(
      await fetch(`${base}/api/channels/${gallery}/files`, {
        method: "POST",
        headers: { authorization: `Bearer ${owner.token}` },
        body: form,
      }),
    );
    await call(`/api/channels/${gallery}/messages`, owner.token, {
      text: i === 0 ? firstPicture : sentence(8),
      fileIds: [uploaded.file.id],
    });
    await call(`/api/channels/${gallery}/messages`, owner.token, { text: sentence(12) });
  }
  const seededMs = Date.now() - seeding;

  // CHROMIUM names a browser other than the one Playwright installed.
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  // Sign the reader in once through the client, and start every measured
  // profile from what that left in storage.
  const setup = await browser.newContext();
  const setupPage = await setup.newPage();
  await setupPage.goto(base);
  const signInTab = setupPage.getByRole("tab", { name: "Sign in", exact: true }).first();
  await setupPage.getByLabel("Username", { exact: true }).waitFor();
  if (await signInTab.isVisible().catch(() => false)) await signInTab.click();
  await setupPage.getByLabel("Username", { exact: true }).fill("reader");
  await setupPage.getByLabel("Password", { exact: true }).fill("password123");
  await setupPage.getByRole("button", { name: "Sign in", exact: true }).last().click();
  await setupPage.locator("textarea").waitFor();
  const signedIn = await setup.storageState();
  await setup.close();

  const viewport = { width: 1280, height: 800 };
  const fresh = async () => {
    const context = await browser!.newContext({ storageState: signedIn, viewport });
    await context.addInitScript(OBSERVE);
    return context;
  };
  /** What the page fetched since it loaded: bytes over the wire and requests. */
  const transfer = (page: Page) =>
    page.evaluate(() => {
      const entries = [
        ...performance.getEntriesByType("navigation"),
        ...performance.getEntriesByType("resource"),
      ] as PerformanceResourceTiming[];
      return {
        bytes: entries.reduce((sum, e) => sum + (e.transferSize ?? 0), 0),
        requests: entries.length,
      };
    });
  const usable = async (page: Page, channel: string, newestText: string) => {
    await page.getByRole("textbox", { name: `Message #${channel}`, exact: true }).waitFor();
    await page.getByText(newestText, { exact: true }).waitFor();
  };

  const cold = new Measure();
  const warm = new Measure();
  const coldBytes = new Measure();
  const warmBytes = new Measure();
  const coldRequests = new Measure();
  for (let round = 0; round < params.rounds; round++) {
    const context = await fresh();
    const page = await context.newPage();
    try {
      let began = Date.now();
      await page.goto(`${base}/`);
      await usable(page, "general", newest);
      cold.add(Date.now() - began);
      const first = await transfer(page);
      coldBytes.add(first.bytes / 1024);
      coldRequests.add(first.requests);
      began = Date.now();
      await page.reload();
      await usable(page, "general", newest);
      warm.add(Date.now() - began);
      warmBytes.add((await transfer(page)).bytes / 1024);
    } catch (error) {
      cold.fail(error);
    } finally {
      await context.close();
    }
  }

  const scroll = new Measure();
  const longTaskCount = new Measure();
  const longTaskTotal = new Measure();
  const longTaskMax = new Measure();
  const slowFrames = new Measure();
  const heapBefore = new Measure();
  const heapAfter = new Measure();
  const picturesHeld = new Measure();
  for (let round = 0; round < params.rounds; round++) {
    const context = await fresh();
    const page = await context.newPage();
    try {
      await page.goto(`${base}/`);
      await usable(page, "general", newest);
      await page.getByRole("navigation").getByRole("button", { name: "gallery" }).click();
      await page.getByRole("textbox", { name: "Message #gallery", exact: true }).waitFor();
      const history = page.getByLabel("Message history");
      await history.locator("img").first().waitFor();
      const heap = () =>
        page.evaluate(
          () =>
            ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
              ?.usedJSHeapSize ?? 0) /
            (1024 * 1024),
        );
      await page.evaluate(() => {
        const w = window as unknown as { __probe: { longTasks: number[]; slowFrames: number[] } };
        w.__probe.longTasks.length = 0;
        w.__probe.slowFrames.length = 0;
      });
      heapBefore.add(await heap());
      const began = Date.now();
      // Scroll up a screen at a time, as someone reading back would, until
      // the channel's first picture is on screen.
      const top = page.getByText(firstPicture, { exact: true });
      for (let step = 0; step < 2000 && !(await top.isVisible().catch(() => false)); step++) {
        await history.evaluate((el) => el.scrollBy(0, -el.clientHeight * 0.9));
        await page.waitForTimeout(16);
      }
      if (!(await top.isVisible())) throw new Error("never reached the gallery's first picture");
      scroll.add(Date.now() - began);
      const probe = await page.evaluate(
        () =>
          (window as unknown as { __probe: { longTasks: number[]; slowFrames: number[] } }).__probe,
      );
      longTaskCount.add(probe.longTasks.length);
      longTaskTotal.add(probe.longTasks.reduce((s, x) => s + x, 0));
      longTaskMax.add(Math.max(0, ...probe.longTasks));
      slowFrames.add(probe.slowFrames.length);
      heapAfter.add(await heap());
      // The client lets go of pictures far off screen; this is how many it
      // still holds once at the top.
      picturesHeld.add(
        await history
          .locator("img")
          .evaluateAll(
            (images) =>
              (images as HTMLImageElement[]).filter((i) => i.complete && i.naturalWidth > 0).length,
          ),
      );
    } catch (error) {
      scroll.fail(error);
    } finally {
      await context.close();
    }
  }

  const result = {
    measured: "client",
    ...revision(),
    at: new Date().toISOString(),
    params,
    fixture: {
      seededMs,
      pictureMiB: +(pictureBytes / (1024 * 1024)).toFixed(1),
      decodedMiBPerPicture: +(
        (params.pictureWidth * params.pictureHeight * 4) /
        (1024 * 1024)
      ).toFixed(1),
    },
    machine: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memoryGiB: +(totalmem() / 2 ** 30).toFixed(1),
      node: process.version,
      chromium: browser.version(),
      viewport,
    },
    firstUsable: {
      coldMs: cold.summary(),
      warmMs: warm.summary(),
      coldKiB: coldBytes.summary(),
      warmKiB: warmBytes.summary(),
      coldRequests: coldRequests.summary(),
    },
    pictureScroll: {
      toFirstPictureMs: scroll.summary(),
      longTasks: longTaskCount.summary(),
      longTaskTotalMs: longTaskTotal.summary(),
      longestTaskMs: longTaskMax.summary(),
      framesOver50Ms: slowFrames.summary(),
      heapBeforeMiB: heapBefore.summary(),
      heapAfterMiB: heapAfter.summary(),
      picturesHeldAtEnd: picturesHeld.summary(),
    },
  };
  const text = JSON.stringify(result, null, 2) + "\n";
  if (out) writeFileSync(out, text);
  process.stdout.write(text);
} finally {
  await browser?.close();
  await server?.stop();
  if (dir.startsWith(realpathSync(tmpdir()) + sep) && existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
}
