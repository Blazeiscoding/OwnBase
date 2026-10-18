import {
  test,
  expect,
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

/**
 * For a server a scenario starts and never reads from. A pipe nobody reads
 * fills up, and on Linux the server then stops at its next log line: the
 * Back and Forward scenario hung that way while its server was stopping.
 */
const UNREAD = { windowsHide: true, stdio: "ignore" } as const;

/** A real PNG of the given size, so the server reads its dimensions as it would a photo's. */
function solidPng(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x5a);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
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
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise((done) => probe.close(done));
  return port;
}

/**
 * Every scenario has a workspace of its own: the built server on a free port
 * with fresh data, so each runs the same alone, in any order, and after
 * another failed, rather than building on the accounts and state an earlier
 * scenario left (REV-08). Alice, who owns it, and Bobby are registered before
 * a scenario starts, as if they had signed up; a scenario tagged `@unowned`
 * starts with nobody, to see the workspace before anyone claims it.
 */
let server: ChildProcess | undefined;
let data = "";
let claimCode = "";
let base = "";
test.beforeEach(async ({}, testInfo) => {
  data = mkdtempSync(join(tmpdir(), "slackoss-e2e-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  claimCode = "";
  server = spawn(
    process.execPath,
    [
      "apps/server-cli/dist/slackoss-server.js",
      "--data",
      data,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-mdns",
      "--name",
      "Product Test",
      "--allow-private-hooks",
      // These scenarios seed history by posting hundreds of messages in a
      // loop, which is the bulk import the limits are meant to refuse. What
      // is under test here is the browser, and rationing has its own suite.
      "--no-rate-limits",
    ],
    { windowsHide: true, stdio: "pipe" },
  );
  let startupOutput = "";
  server.stdout!.on("data", (chunk) => {
    startupOutput += String(chunk);
    claimCode = startupOutput.match(/Claim code: (\S+)/)?.[1] ?? "";
  });
  await expect
    .poll(async () => {
      try {
        return (await fetch(base + "/api/health")).status;
      } catch {
        return 0;
      }
    })
    .toBe(200);
  if (testInfo.tags.includes("@unowned")) return;
  // From this machine and with no browser's Origin, so no claim code is
  // asked for; the first to register owns the workspace.
  for (const handle of ["alice", "bobby"]) {
    const registered = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
    });
    expect(registered.status, `registering ${handle}`).toBe(201);
  }
});
test.afterEach(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server!.once("exit", r));
    server.kill();
    await exited;
  }
  server = undefined;
  if (data) rmSync(data, { recursive: true, force: true });
});

/**
 * Opens the join screen at the workspace's own address. A browser served by a
 * workspace goes straight to its sign-in card, so the address field is only
 * there when the app has to ask which workspace is meant.
 */
async function openAuthCard(page: Page) {
  const address = page.getByPlaceholder("192.168.1.42:8543 or chat.yourteam.dev");
  const username = page.getByLabel("Username", { exact: true });
  // Whichever the join screen settles on: a served browser skips the list.
  await expect(address.or(username).first()).toBeVisible();
  if (await address.isVisible().catch(() => false)) {
    await address.fill(base);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
  }
  await expect(username).toBeVisible();
}

/** The same, from a cold load. */
async function reachAuthCard(page: Page) {
  await page.goto(base);
  await openAuthCard(page);
}

async function register(page: Page, handle: string, claim?: string) {
  await reachAuthCard(page);
  const create = page.getByRole("tab", { name: "Create account", exact: true });
  if (await create.isVisible()) await create.click();
  await page.getByLabel("Username", { exact: true }).fill(handle);
  await page.getByLabel("Display name", { exact: true }).fill(handle);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  if (claim) {
    await page.getByLabel("Workspace claim code", { exact: true }).fill("incorrect-code");
    await page.getByRole("button", { name: "Join workspace", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("not accepted");
    await expect(page.getByLabel("Username", { exact: true })).toHaveValue(handle);
    await page.getByLabel("Workspace claim code", { exact: true }).fill(claim);
  }
  await page.getByRole("button", { name: "Join workspace", exact: true }).click();
  await expect(page.locator("textarea")).toBeVisible();
  // The claim makes this account the workspace's first, its owner.
  if (claim) await dismissWelcome(page);
}

/**
 * The account that founds a workspace lands on inviting people (UX-42): a
 * link ready to copy, then Done for the workspace behind it.
 */
async function dismissWelcome(page: Page) {
  const welcome = page.getByRole("dialog", { name: "Invite your people", exact: true });
  await expect(welcome.locator("code").filter({ hasText: "/#/join/" })).toBeVisible();
  await welcome.getByRole("button", { name: "Done", exact: true }).click();
  await expect(welcome).toHaveCount(0);
}

/** Signs an existing account in, rather than creating one. */
async function signIn(page: Page, handle: string) {
  await reachAuthCard(page);
  const signInTab = page.getByRole("tab", { name: "Sign in", exact: true }).first();
  if (await signInTab.isVisible().catch(() => false)) await signInTab.click();
  await page.getByLabel("Username", { exact: true }).fill(handle);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
  await expect(page.locator("textarea")).toBeVisible();
}

/**
 * Saves that this browser was already asked which microphone and camera to
 * use: Chromium's fake devices are two microphones, so a first huddle would
 * otherwise ask before joining.
 */
async function skipDeviceCheck(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "slackoss:call-preferences",
      JSON.stringify({ joinMuted: false, devicesChecked: true }),
    );
  });
}

/**
 * Waits for what is moving to stop, such as a sheet rising or a panel
 * stepping in, so a place is measured where it comes to rest. Loops, such as
 * a spinner, never stop and are not waited for.
 */
async function atRest(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.timeline === document.timeline &&
            animation.effect?.getComputedTiming().endTime !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

async function expectInsideViewport(page: Page, element: Locator) {
  await atRest(page);
  const box = await element.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
}

/**
 * What a side panel or the phone's drawer covers is out of reach, but the main
 * landmark around it stays, so the page always has one (axe's
 * `landmark-one-main`).
 */
async function expectMainCovered(page: Page, where?: string) {
  await expect(page.locator("main > [inert]"), where).toHaveCount(1);
  await expect(page.getByRole("main"), where).toHaveCount(1);
  expect(
    await page.locator("main").evaluate((main) => main.closest("[inert]") === null),
    where,
  ).toBe(true);
}

async function expectTooltipInsideViewport(page: Page, trigger: Locator, text: string) {
  await trigger.focus();
  const tooltip = page.getByRole("tooltip").filter({ hasText: text });
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute("data-side", "bottom");
  await expectInsideViewport(page, tooltip);
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
}

/** The notice that carries `text`, for its geometry and its own buttons. */
function notice(page: Page, text: string) {
  return page.locator("[data-toast]").filter({ hasText: text });
}

/** Fails when `a` and `b` overlap on screen. */
async function expectApart(a: Locator, b: Locator) {
  const [one, two] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  expect(one).not.toBeNull();
  expect(two).not.toBeNull();
  const overlapX = Math.min(one!.x + one!.width, two!.x + two!.width) - Math.max(one!.x, two!.x);
  const overlapY = Math.min(one!.y + one!.height, two!.y + two!.height) - Math.max(one!.y, two!.y);
  expect(overlapX <= 0 || overlapY <= 0).toBe(true);
}

/** Whether the modal layer has made `element` or anything around it inert. */
/**
 * What the web client keeps on this device, by key: in IndexedDB where the
 * browser has it (F01), and what is left in localStorage. Read without
 * creating the database, which the client would then not set up.
 */
async function deviceValues(page: Page) {
  return page.evaluate(async () => {
    const legacy: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)!;
      if (name.startsWith("slackoss:")) legacy[name.slice(9)] = localStorage.getItem(name)!;
    }
    const indexed = await new Promise<Record<string, string> | null>((resolve) => {
      const open = indexedDB.open("tandem-device");
      open.onupgradeneeded = () => open.transaction!.abort();
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("values");
        const keys = tx.objectStore("values").getAllKeys();
        const raws = tx.objectStore("values").getAll();
        tx.oncomplete = () => {
          db.close();
          resolve(
            Object.fromEntries((keys.result as string[]).map((key, i) => [key, raws.result[i]])),
          );
        };
        tx.onerror = () => {
          db.close();
          resolve(null);
        };
      };
    });
    return { indexed, legacy };
  });
}

/** The value the web client keeps under `key` on this device, or null. */
async function deviceValue<T>(page: Page, key: string): Promise<T | null> {
  const { indexed, legacy } = await deviceValues(page);
  const raw = indexed?.[key] ?? legacy[key];
  return raw === undefined ? null : (JSON.parse(raw) as T);
}

/** The token of the first workspace this browser is signed in to. */
async function savedToken(page: Page) {
  return (await deviceValue<{ token: string }[]>(page, "servers"))![0]!.token;
}

function isInert(element: Locator) {
  return element.evaluate((el) => el.closest("[inert]") !== null);
}

test(
  "a browser served by a workspace offers that workspace without being asked",
  { tag: "@unowned" },
  async ({ page }) => {
    await page.goto(base);
    // The page came from the workspace, so there is nothing to look up: it goes
    // straight to signing in, named, with no address to type.
    await expect(page.getByRole("heading", { name: "Product Test" })).toBeVisible();
    await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("192.168.1.42:8543 or chat.yourteam.dev")).toHaveCount(0);

    // The way back to the full list is still there for a second workspace.
    await page.getByRole("button", { name: "All workspaces", exact: true }).click();
    await expect(page.getByPlaceholder("192.168.1.42:8543 or chat.yourteam.dev")).toBeVisible();
    await expect(page.getByText("serving this page")).toBeVisible();
  },
);

test(
  "two people register, chat, become friends, reconnect, and exchange real WebRTC media",
  { tag: "@unowned" },
  async ({ browser }, info) => {
    const a = await browser.newContext({
      permissions: ["microphone", "camera"],
      viewport: { width: 1280, height: 820 },
    });
    const b = await browser.newContext({
      permissions: ["microphone", "camera"],
      viewport: { width: 1280, height: 820 },
    });
    const alice = await a.newPage();
    const bob = await b.newPage();
    const errors: string[] = [];
    for (const page of [alice, bob]) {
      page.on("pageerror", (err) => errors.push(err.message));
      // A blocked resource is reported to the console rather than thrown, so it
      // would slip past the page-error check above on its own.
      page.on("console", (m) => {
        if (m.text().includes("Content Security Policy")) errors.push(m.text());
      });
      await page.addInitScript(() => {
        const Original = window.RTCPeerConnection;
        (window as any).peers = [];
        window.RTCPeerConnection = class extends Original {
          constructor(config?: RTCConfiguration) {
            super(config);
            (window as any).peers.push(this);
          }
        };
        // The fake microphone plays a tone, not speech, and strong noise
        // suppression takes a tone out as noise. The browser's own leaves it
        // for the level meter to report. Taken in once, as a saved choice.
        localStorage.setItem(
          "slackoss:call-preferences",
          JSON.stringify({ joinMuted: false, noiseFilter: false, devicesChecked: true }),
        );
      });
    }
    try {
      // A reverse proxy removes the localhost claim bypass. The owner can still
      // complete setup in the browser, including correcting an invalid code.
      await expect.poll(() => claimCode.length).toBeGreaterThan(0);
      await alice.route("**/api/**", (route) =>
        route.continue({
          headers: { ...route.request().headers(), "x-forwarded-for": "192.0.2.10" },
        }),
      );
      await register(alice, "alice", claimCode);
      await alice.unroute("**/api/**");
      await register(bob, "bobby");
      await alice.locator("textarea").fill("Hello from Alice — live delivery");
      await alice.locator("textarea").press("Enter");
      await expect(
        bob.getByText("Hello from Alice — live delivery", { exact: true }),
      ).toBeVisible();
      // A screen reader hears a message as it arrives in the open conversation.
      const bobHears = bob.getByRole("log", { name: "New messages", exact: true });
      await expect(bobHears).toHaveText("alice: Hello from Alice — live delivery");
      await alice.getByRole("button", { name: "Friends", exact: true }).click();
      await alice.getByRole("tab", { name: "Add friends", exact: true }).click();
      await alice.getByRole("button", { name: "Add friend", exact: true }).click();
      await bob.getByRole("button", { name: "Friends, 1 new" }).click();
      await bob.getByRole("tab", { name: "Requests (1)", exact: true }).click();
      await bob.getByRole("button", { name: "Accept", exact: true }).click();
      await alice.getByRole("tab", { name: "Friends", exact: true }).click();
      await expect(alice.getByRole("button", { name: "Remove friend" })).toBeVisible();
      await alice.keyboard.press("Escape");
      await bob.keyboard.press("Escape");
      await b.setOffline(true);
      await alice.locator("textarea").fill("Message while Bob is offline");
      await alice.locator("textarea").press("Enter");
      await b.setOffline(false);
      await expect(bob.getByText("Message while Bob is offline", { exact: true })).toBeVisible();
      await alice.getByRole("button", { name: "Start a huddle", exact: true }).click();
      await expect(alice.getByText("Huddle in #general", { exact: true })).toBeVisible();
      await bob.getByRole("button", { name: "Join the huddle with alice", exact: true }).click();
      for (const page of [alice, bob]) {
        await expect
          .poll(() =>
            page.evaluate(() =>
              (window as any).peers.some(
                (p: RTCPeerConnection) => p.connectionState === "connected",
              ),
            ),
          )
          .toBe(true);
        await expect
          .poll(() =>
            page.evaluate(async () => {
              let bytes = 0;
              for (const pc of (window as any).peers as RTCPeerConnection[])
                (await pc.getStats()).forEach((r) => {
                  if (r.type === "inbound-rtp" && r.kind === "audio") bytes += r.bytesReceived;
                });
              return bytes;
            }),
          )
          .toBeGreaterThan(0);
      }
      // The fake capture device plays a tone, so the level meter has something
      // real to report: each side should see the other light up as talking.
      for (const page of [alice, bob]) {
        await expect
          .poll(() => page.locator(".ring-online").count(), { timeout: 15_000 })
          .toBeGreaterThan(0);
      }
      await alice.getByRole("button", { name: "Camera", exact: true, pressed: false }).click();
      await expect
        .poll(() =>
          bob
            .locator("video")
            .evaluateAll((videos) => videos.some((v) => (v as HTMLVideoElement).videoWidth > 0)),
        )
        .toBe(true);
      // The video gets a stage of its own above the chat, with Alice named on it.
      const bobStage = bob.getByRole("region", { name: "Huddle video" });
      await expect(bobStage.getByRole("group", { name: "alice", exact: true })).toBeVisible();
      await alice.getByRole("button", { name: "Mute microphone", pressed: false }).click();
      await expect(
        alice.getByRole("button", { name: "Mute microphone", pressed: true }),
      ).toBeVisible();
      // Muting is signalled, not guessed: Bob's copy of Alice says so.
      await expect(bob.getByTitle("alice (muted)")).toBeVisible();
      await expect(
        bobStage.getByRole("group", { name: "alice, muted", exact: true }),
      ).toBeVisible();
      await alice.screenshot({ path: info.outputPath("workspace.png") });
      await alice.getByRole("button", { name: "Leave", exact: true }).click();
      await bob.getByRole("button", { name: "Leave", exact: true }).click();
      await expect
        .poll(() =>
          alice.evaluate(() =>
            (window as any).peers.every((p: RTCPeerConnection) => p.connectionState === "closed"),
          ),
        )
        .toBe(true);
      expect(errors).toEqual([]);
    } finally {
      for (const [name, page] of [
        ["alice", alice],
        ["bob", bob],
      ] as const) {
        const diagnostics = await page
          .evaluate(async () =>
            Promise.all(
              ((window as any).peers ?? []).map(async (pc: RTCPeerConnection) => ({
                connection: pc.connectionState,
                senders: pc.getSenders().map((s) => ({
                  kind: s.track?.kind,
                  enabled: s.track?.enabled,
                  state: s.track?.readyState,
                })),
                stats: [...(await pc.getStats()).values()].filter((r) =>
                  ["inbound-rtp", "outbound-rtp", "media-source"].includes(r.type),
                ),
              })),
            ),
          )
          .catch(() => null);
        await info.attach(`${name}-rtc`, {
          body: JSON.stringify(diagnostics, null, 2),
          contentType: "application/json",
        });
      }
      await a.close().catch(() => {});
      await b.close().catch(() => {});
    }
  },
);

test("a call says which route it connected on, and one that cannot connect says why", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const a = await browser.newContext({ permissions: ["microphone"] });
  const b = await browser.newContext({ permissions: ["microphone"] });
  try {
    const alice = await a.newPage();
    const bob = await b.newPage();
    for (const page of [alice, bob]) await skipDeviceCheck(page);
    await signIn(alice, "alice");
    await signIn(bob, "bobby");
    const bar = (page: Page) => page.getByRole("region", { name: "Active huddle", exact: true });
    /** The report in the Diagnostics dialog, opened from the account menu. */
    const diagnostics = async (page: Page) => {
      await page.getByRole("button", { name: /, your account$/ }).click();
      await page.getByRole("menuitem", { name: "Diagnostics", exact: true }).click();
      return page.getByLabel("Diagnostics report", { exact: true });
    };

    // A call on this machine connects straight away, on routes of its own network.
    await alice.getByRole("button", { name: "Start a huddle", exact: true }).click();
    await bob.getByRole("button", { name: "Join the huddle with alice", exact: true }).click();
    await expect(bar(alice).getByRole("status")).toHaveText("With bobby");
    await expect(bar(bob).getByRole("status")).toHaveText("With alice");
    const aliceReport = await diagnostics(alice);
    await expect(aliceReport).toContainText("Call log on this device (times in UTC)");
    await expect(aliceReport).toContainText("[@bobby] Sent the call setup.");
    await expect(aliceReport).toContainText(
      /\[@bobby\] Connected after \d+\.\d s: host here, host there, over udp/,
    );
    // Alice owns the workspace, so she also sees the server's side of it.
    await expect(aliceReport).toContainText("Calls on this server (times in UTC)");
    await expect(aliceReport).toContainText("#general: @bobby joined");
    await expect(aliceReport).toContainText(/#general: @bobby connected to @alice after/);
    // The call logs name kinds of route, never an address.
    const logs = (await aliceReport.textContent())!.split("Call log on this device")[1]!;
    expect(logs).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    await alice.keyboard.press("Escape");
    for (const page of [bob, alice])
      await bar(page).getByRole("button", { name: "Leave", exact: true }).click();

    // Bob's browser now finds no route at all, as behind a network that lets
    // nothing through: it is held to relays, and there is none.
    await bob.evaluate(() => {
      const Original = window.RTCPeerConnection;
      const relayOnly = (config?: RTCConfiguration): RTCConfiguration => ({
        ...config,
        iceTransportPolicy: "relay",
      });
      window.RTCPeerConnection = class extends Original {
        constructor(config?: RTCConfiguration) {
          super(relayOnly(config));
        }
        setConfiguration(config?: RTCConfiguration) {
          super.setConfiguration(relayOnly(config));
        }
      };
    });
    await alice.getByRole("button", { name: "Start a huddle", exact: true }).click();
    await bob.getByRole("button", { name: "Join the huddle with alice", exact: true }).click();
    await expect(bar(bob).getByRole("status")).toHaveText("With alice · Connecting…");
    // After long enough, it says so rather than spinning, and offers why.
    await expect(bar(bob).getByRole("status")).toHaveText("Can't connect to alice · Trying again", {
      timeout: 25_000,
    });
    await bob.screenshot({ path: test.info().outputPath("call-cannot-connect.png") });
    await bar(bob).getByRole("button", { name: "Why? See the call log", exact: true }).click();
    const bobReport = bob.getByLabel("Diagnostics report", { exact: true });
    await expect(bobReport).toContainText("Call settings: 0 STUN and 0 TURN servers");
    await expect(bobReport).toContainText("[@alice] Received their call setup.");
    await expect(bobReport).toContainText(
      /\[@alice\] Still not connected after 15 s \(routes here: none; from them: \d+ host\)\. This device was given no STUN or TURN server/,
    );
    // Each kind of route is named once, however many of it there are.
    expect(
      ((await bobReport.textContent())!.match(/Route from them: host over udp\./g) ?? []).length,
    ).toBe(1);
    await expect(bobReport).toContainText("[@alice] Read the call settings again");
    await expect(bobReport).toContainText("[@alice] Waiting for them to try again");
    await bob.screenshot({ path: test.info().outputPath("call-log.png") });
    // The host sees Bob's account of it without needing Bob's screen.
    await expect
      .poll(async () => {
        const report = await diagnostics(alice);
        const text = (await report.textContent()) ?? "";
        await alice.keyboard.press("Escape");
        return text;
      })
      .toMatch(/#general: @bobby still not connected to @alice after 15 s\. routes here none;/);
  } finally {
    await a.close().catch(() => {});
    await b.close().catch(() => {});
  }
});

test("the microphone and speaker can be changed in a call, from the call and from settings", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const a = await browser.newContext({ permissions: ["microphone", "camera"] });
  const b = await browser.newContext({ permissions: ["microphone", "camera"] });
  try {
    const alice = await a.newPage();
    const bob = await b.newPage();
    const errors: string[] = [];
    for (const page of [alice, bob]) {
      page.on("pageerror", (err) => errors.push(err.message));
      await page.addInitScript(() => {
        const Original = window.RTCPeerConnection;
        (window as any).peers = [];
        window.RTCPeerConnection = class extends Original {
          constructor(config?: RTCConfiguration) {
            super(config);
            (window as any).peers.push(this);
          }
        };
        // Strong noise suppression sends the filter's output, which has no
        // device name, so every microphone opened is kept to be named from.
        const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        (window as any).microphones = [];
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await open(constraints);
          (window as any).microphones.push(...stream.getAudioTracks());
          return stream;
        };
      });
    }
    await skipDeviceCheck(bob);
    await signIn(alice, "alice");
    await signIn(bob, "bobby");
    const bar = (page: Page) => page.getByRole("region", { name: "Active huddle", exact: true });
    /**
     * What Alice sends from her microphone: the name of each device she has
     * open, and whether the track her call sends is live.
     */
    const aliceSends = () =>
      alice.evaluate(() => ({
        open: ((window as any).microphones as MediaStreamTrack[])
          .filter((track) => track.readyState === "live")
          .map((track) => `${track.label} live`),
        sent: ((window as any).peers as RTCPeerConnection[])
          .flatMap((pc) => pc.getSenders())
          .filter((s) => s.track?.kind === "audio")
          .map((s) => s.track!.readyState),
      }));
    /** Only `microphone` open, and live sound going out from it. */
    const sending = (microphone: string) => ({ open: [`${microphone} live`], sent: ["live"] });
    /** Alice's call log, in the Diagnostics dialog from the account menu. */
    const aliceLog = async () => {
      await alice.getByRole("button", { name: /, your account$/ }).click();
      await alice.getByRole("menuitem", { name: "Diagnostics", exact: true }).click();
      return alice.getByLabel("Diagnostics report", { exact: true });
    };
    const bobHearsBytes = () =>
      bob.evaluate(async () => {
        let bytes = 0;
        for (const pc of (window as any).peers as RTCPeerConnection[])
          (await pc.getStats()).forEach((r) => {
            if (r.type === "inbound-rtp" && r.kind === "audio") bytes += r.bytesReceived;
          });
        return bytes;
      });

    // Chromium's fake devices are two microphones, so her first huddle asks
    // which to use first, listening to it and showing her camera.
    await alice.getByRole("button", { name: "Start a huddle", exact: true }).click();
    const check = alice.getByRole("dialog", {
      name: "Choose your microphone and camera",
      exact: true,
    });
    await expect(check.getByText(/^Listening to/)).toContainText("Fake Default Audio Input");
    await expect
      .poll(() => check.locator("video").evaluate((v) => (v as HTMLVideoElement).videoWidth))
      .toBeGreaterThan(0);
    await alice.screenshot({ path: test.info().outputPath("device-check.png") });
    // Nothing starts until she answers.
    await expect(bar(alice)).toHaveCount(0);
    await check.getByRole("button", { name: "Join huddle", exact: true }).click();
    await expect(check).toHaveCount(0);
    await bob.getByRole("button", { name: "Join the huddle with alice", exact: true }).click();
    await expect(bar(alice).getByRole("status")).toHaveText("With bobby");
    await expect(bar(bob).getByRole("status")).toHaveText("With alice");
    await expect.poll(bobHearsBytes).toBeGreaterThan(0);
    // The check let go of what it opened, and the call has only her microphone.
    await expect.poll(aliceSends).toEqual(sending("Fake Default Audio Input"));
    // Her microphone goes through strong noise suppression unless she chose otherwise.
    await expect(await aliceLog()).toContainText("Noise suppression: strong.");
    await alice.keyboard.press("Escape");

    // From the call: the arrow beside Mute lists the microphones and speakers.
    await bar(alice).getByRole("button", { name: "Microphone and speaker", exact: true }).click();
    const menu = alice.getByRole("menu", { name: "Microphone and speaker", exact: true });
    await expect(
      menu.getByRole("menuitemradio", { name: "System default (Fake Default Audio Input)" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(menu.getByRole("menuitemradio", { name: "Fake Audio Output 1" })).toBeVisible();
    await alice.screenshot({ path: test.info().outputPath("huddle-device-menu.png") });
    await menu.getByRole("menuitemradio", { name: "Fake Audio Input 2", exact: true }).click();

    // Bob now hears the other microphone, on the same connection.
    await expect.poll(aliceSends).toEqual(sending("Fake Audio Input 2"));
    const before = await bobHearsBytes();
    await expect.poll(bobHearsBytes).toBeGreaterThan(before);
    expect(
      await alice.evaluate(() =>
        ((window as any).peers as RTCPeerConnection[]).map((pc) => pc.connectionState),
      ),
    ).toEqual(["connected"]);

    // From settings, which the same menu leads to: the choice is already there.
    await bar(alice).getByRole("button", { name: "Microphone and speaker", exact: true }).click();
    await alice.getByRole("menuitem", { name: "Voice & video settings", exact: true }).click();
    const panel = alice.getByRole("tabpanel", { name: "Voice & video", exact: true });
    const microphone = panel.getByRole("combobox", { name: "Microphone", exact: true });
    await expect(microphone.locator("option:checked")).toHaveText("Fake Audio Input 2");
    // Noise suppression is one of three, strong until chosen otherwise.
    const noise = (level: string) =>
      panel
        .getByRole("group", { name: "Noise suppression", exact: true })
        .getByRole("radio", { name: new RegExp(`^${level}\\b`) });
    await expect(noise("Strong")).toBeChecked();
    await expect(noise("Standard")).not.toBeChecked();
    await expect(noise("Off")).not.toBeChecked();
    await alice.screenshot({ path: test.info().outputPath("voice-video-settings-top.png") });
    await panel
      .getByRole("combobox", { name: "Speaker", exact: true })
      .selectOption({ label: "Fake Audio Output 1" });
    // The call's sound moves to that speaker.
    await expect
      .poll(() =>
        alice
          .locator("audio")
          .evaluateAll((all) =>
            all.map((el) => (el as HTMLAudioElement & { sinkId: string }).sinkId),
          ),
      )
      .toContain(await panel.getByRole("combobox", { name: "Speaker", exact: true }).inputValue());
    await microphone.selectOption({ label: "Fake Audio Input 1" });
    await expect.poll(aliceSends).toEqual(sending("Fake Audio Input 1"));

    // The microphone test hears the chosen one through strong noise
    // suppression, and names the microphone rather than the filter.
    await panel.getByRole("button", { name: "Test microphone", exact: true }).click();
    await expect(panel.locator("strong")).toHaveText("Fake Audio Input 1");
    await expect(panel.getByText(/could not start here/)).toHaveCount(0);
    // The fake device's tone is noise to strong suppression; on the browser's
    // own it moves the meter. The test opens again on the new choice, and the
    // radio shows it once the call's microphone has opened again too.
    await noise("Standard").click();
    await expect(noise("Standard")).toBeChecked();
    await expect(panel.locator("strong")).toHaveText("Fake Audio Input 1");
    await expect
      .poll(async () =>
        Number(
          await panel
            .getByRole("meter", { name: "Microphone level", exact: true })
            .getAttribute("aria-valuenow"),
        ),
      )
      .toBeGreaterThan(0);
    await panel.getByRole("button", { name: "Preview camera", exact: true }).click();
    await expect
      .poll(() => panel.locator("video").evaluate((v) => (v as HTMLVideoElement).videoWidth))
      .toBeGreaterThan(0);
    await alice.screenshot({ path: test.info().outputPath("voice-video-settings.png") });
    await alice.keyboard.press("Escape");
    // Leaving settings closes the test microphone and the preview, and the call carries on.
    await expect.poll(aliceSends).toEqual(sending("Fake Audio Input 1"));
    await expect(bar(alice).getByRole("status")).toHaveText("With bobby");
    // Now with the browser's own suppression, and Bob still hears her.
    await expect(await aliceLog()).toContainText("Noise suppression: the browser's own.");
    await alice.keyboard.press("Escape");
    const standard = await bobHearsBytes();
    await expect.poll(bobHearsBytes).toBeGreaterThan(standard);

    // The next call opens the saved choice, not the system's default, which
    // Chromium opens for a device asked for any way but exactly.
    await bar(alice).getByRole("button", { name: "Leave", exact: true }).click();
    await expect.poll(async () => (await aliceSends()).open).toEqual([]);
    await alice.evaluate(() => {
      (window as any).peers = [];
      (window as any).microphones = [];
    });
    // Asked once: the next call does not ask again.
    await alice.getByRole("button", { name: "Join the huddle with bobby", exact: true }).click();
    await expect(bar(alice).getByRole("status")).toHaveText("With bobby");
    await expect(check).toHaveCount(0);
    await expect.poll(aliceSends).toEqual(sending("Fake Audio Input 1"));
    expect(errors).toEqual([]);
  } finally {
    await a.close().catch(() => {});
    await b.close().catch(() => {});
  }
});

test("each person's volume is yours alone: turned down, up past as sent, or muted for you", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const a = await browser.newContext({ permissions: ["microphone", "camera"] });
  const b = await browser.newContext({ permissions: ["microphone", "camera"] });
  try {
    const alice = await a.newPage();
    const bob = await b.newPage();
    const errors: string[] = [];
    for (const page of [alice, bob]) {
      page.on("pageerror", (err) => errors.push(err.message));
      await page.addInitScript(() => {
        // The fake microphone plays a tone, which strong noise suppression
        // takes out as noise; on the browser's own it is there to measure.
        localStorage.setItem(
          "slackoss:call-preferences",
          JSON.stringify({ joinMuted: false, noiseFilter: false, devicesChecked: true }),
        );
      });
    }
    await signIn(alice, "alice");
    await signIn(bob, "bobby");
    const bar = (page: Page) => page.getByRole("region", { name: "Active huddle", exact: true });
    await alice.getByRole("button", { name: "Start a huddle", exact: true }).click();
    await bob.getByRole("button", { name: "Join the huddle with alice", exact: true }).click();
    await expect(bar(alice).getByRole("status")).toHaveText("With bobby");
    await expect(bar(bob).getByRole("status")).toHaveText("With alice");

    /**
     * How `page` plays the other person: the element's volume, whether a
     * muted element holds their stream for a boost, and the loudest moment of
     * what the element plays, over long enough to catch the tone's beep.
     */
    const plays = (page: Page) =>
      page.evaluate(async () => {
        const audios = [...document.querySelectorAll("audio")].filter((el) => el.srcObject);
        const heard = audios.find((el) => !el.muted)!;
        const context = new AudioContext();
        await context.resume();
        const analyser = context.createAnalyser();
        context.createMediaStreamSource(heard.srcObject as MediaStream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        let loudest = 0;
        for (let i = 0; i < 30; i++) {
          analyser.getFloatTimeDomainData(samples);
          for (const v of samples) loudest = Math.max(loudest, Math.abs(v));
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await context.close();
        return {
          volume: heard.volume,
          held: audios.some((el) => el.muted),
          loudest,
        };
      });

    // The list of who is there sets how loud each of the others is.
    await bar(bob).getByRole("button", { name: "Everyone in the huddle (2)", exact: true }).click();
    const list = bob.getByRole("list", { name: "In the huddle", exact: true });
    const volume = list.getByRole("slider", { name: "alice's volume", exact: true });
    await expect(volume).toHaveValue("100");
    await expect.poll(async () => (await plays(bob)).loudest).toBeGreaterThan(0);
    const asSent = await plays(bob);
    expect(asSent).toMatchObject({ volume: 1, held: false });

    await volume.fill("50");
    await expect.poll(async () => (await plays(bob)).volume).toBe(0.5);

    // Past as sent, through a gain: a muted element holds her stream, without
    // which Chromium would give the gain silence, and she is louder.
    await volume.fill("200");
    await expect.poll(async () => (await plays(bob)).held).toBe(true);
    const boosted = await plays(bob);
    expect(boosted.volume).toBe(1);
    expect(boosted.loudest).toBeGreaterThan(asSent.loudest * 1.4);

    await list.getByRole("button", { name: "Mute alice for you", exact: true }).click();
    await expect(list.getByRole("listitem", { name: "alice, muted for you" })).toBeVisible();
    await expect.poll(async () => (await plays(bob)).volume).toBe(0);
    await bob.keyboard.press("Escape");

    // Bob's choice is Bob's: Alice still hears him as he is sent, and she is
    // still in the call as far as anyone else is concerned.
    expect(await plays(alice)).toMatchObject({ volume: 1, held: false });
    await expect(bar(alice).getByRole("status")).toHaveText("With bobby");
    // Kept on his device for the calls after this one.
    await expect
      .poll(async () => Object.values((await deviceValue<object>(bob, "call-volumes")) ?? {}))
      .toEqual([{ volume: 200, muted: true }]);
    expect(errors).toEqual([]);
  } finally {
    await a.close().catch(() => {});
    await b.close().catch(() => {});
  }
});

test("scrolls back through a long channel without unbounded growth or losing its place", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  // A blocked resource is reported to the console rather than thrown, so it
  // would slip past the page-error check above on its own.
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) errors.push(m.text());
  });
  try {
    await register(page, "carol");
    // Far more history than the client keeps in memory, posted as the same user.
    const token = await savedToken(page);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const channels = await (await fetch(`${base}/api/channels`, { headers: auth })).json();
    const general = channels.channels.find((c: { name: string }) => c.name === "general");
    for (let i = 0; i < 500; i++) {
      await fetch(`${base}/api/channels/${general.id}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text: `history ${i}` }),
      });
    }
    await page.reload();
    // The timeline scroller, not the sidebar's: the one holding message rows.
    const scroller = page
      .locator("div.overflow-y-auto")
      .filter({ has: page.locator("[data-mid]") })
      .first();
    await expect(page.getByText("history 499", { exact: true })).toBeVisible();

    // Scroll to the top repeatedly; each pass pages in another 50 messages.
    // Six passes overfill the 300-message window while leaving history behind.
    for (let pass = 0; pass < 6; pass++) {
      await scroller.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.waitForTimeout(250);
    }
    const rows = await page.locator("[data-mid]").count();
    expect(rows).toBeGreaterThan(100);
    // The window is capped at 300 messages, so the DOM cannot grow past it.
    expect(rows).toBeLessThanOrEqual(300);

    // The message under the reader stays under the reader across a page load.
    // Park just inside the paging threshold and read the anchor synchronously,
    // before the fetch it triggers can come back.
    const before = await scroller.evaluate((el) => {
      el.scrollTop = 350;
      const rows = [...el.querySelectorAll<HTMLElement>("[data-mid]")];
      const row = rows.find((r) => r.offsetTop + r.offsetHeight > el.scrollTop)!;
      return {
        id: row.dataset.mid!,
        top: row.getBoundingClientRect().top,
        firstId: rows[0]!.dataset.mid!,
      };
    });
    // At the cap a page swaps messages in and out without changing the count,
    // so wait on the oldest loaded message changing instead.
    await expect
      .poll(() =>
        scroller.evaluate((el) => el.querySelector<HTMLElement>("[data-mid]")!.dataset.mid),
      )
      .not.toBe(before.firstId);
    await page.waitForTimeout(200);
    const after = await page
      .locator(`[data-mid="${before.id}"]`)
      .evaluate((el) => el.getBoundingClientRect().top);
    // Older messages arrived above it and trimmed ones left below it; it holds still.
    expect(Math.abs(after - before.top)).toBeLessThan(8);
    expect(errors).toEqual([]);
  } finally {
    await context.close().catch(() => {});
  }
});

test("Tandem keeps a capped live timeline pinned and supports keyboard and narrow-window chat", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A blocked resource is reported to the console rather than thrown, so it
  // would slip past the page-error check above on its own.
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) errors.push(m.text());
  });
  await page.goto(base);
  await expect(page).toHaveTitle("Tandem");
  await page.screenshot({ path: info.outputPath("tandem-welcome.png") });
  await register(page, "smoothness");
  const token = await savedToken(page);
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const response = await fetch(`${base}/api/channels`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ type: "public", name: "design-studio" }),
  });
  expect(response.ok).toBe(true);
  const { channel } = await response.json();
  await page.getByRole("navigation").getByRole("button", { name: "design-studio" }).click();
  // Other scenarios share the server, so the count is compared, not known.
  const membersToggle = page.getByRole("button", { name: /^Members \(\d+\)$/ });
  const memberCount = async () =>
    Number((await membersToggle.getAttribute("aria-label"))?.match(/\d+/)?.[0]);
  await expect(membersToggle).toBeVisible();
  const membersBefore = await memberCount();
  for (const name of ["announcements", "engineering", "game-night"]) {
    expect(
      (
        await fetch(`${base}/api/channels`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ type: "public", name }),
        })
      ).ok,
    ).toBe(true);
  }
  const teammate = await (
    await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "maya", displayName: "Maya Chen", password: "password123" }),
    })
  ).json();
  expect(teammate.token).toBeTruthy();
  expect(
    (
      await fetch(`${base}/api/channels/${channel.id}/join`, {
        method: "POST",
        headers: { authorization: `Bearer ${teammate.token}` },
      })
    ).ok,
  ).toBe(true);
  const messages = [
    {
      token,
      text: "Welcome to #design-studio 👋\nA little space for big ideas. Share what you’re working on, ask for feedback, and make yourself at home.",
    },
    {
      token: teammate.token,
      text: "The new direction is ready for a first look.\n• Clearer navigation\n• More room for the conversation\n• A calmer palette that feels good all day",
    },
    {
      token,
      text: "Love where this is heading. Let’s jump into a huddle after lunch and walk through it together. 🎧",
    },
  ];
  for (const message of messages) {
    expect(
      (
        await fetch(`${base}/api/channels/${channel.id}/messages`, {
          method: "POST",
          headers: { ...auth, authorization: `Bearer ${message.token}` },
          body: JSON.stringify({ text: message.text }),
        })
      ).ok,
    ).toBe(true);
  }
  await expect(page.getByText(messages[2]!.text, { exact: true })).toBeVisible();
  // The header counts Maya, who joined after it opened, without a reload (UX-23).
  await expect.poll(memberCount).toBeGreaterThan(membersBefore);
  // Its last control sits at the window's edge, and its hint stays inside.
  const options = page.getByRole("button", { name: "Conversation options", exact: true });
  await expectTooltipInsideViewport(page, options, "More");
  await membersToggle.focus();
  const membersTooltip = page.getByRole("tooltip").filter({ hasText: "Members" });
  await expect(membersTooltip).toBeVisible();
  const membersCenterDifference = async () => {
    const [buttonBox, tooltipBox] = await Promise.all([
      membersToggle.boundingBox(),
      membersTooltip.boundingBox(),
    ]);
    if (!buttonBox || !tooltipBox) return Infinity;
    return Math.abs(buttonBox.x + buttonBox.width / 2 - (tooltipBox.x + tooltipBox.width / 2));
  };
  // A same-sized trigger can move without notifying ResizeObserver. The open
  // hint still follows its live geometry.
  await membersToggle.evaluate((element) => {
    (element as HTMLElement).style.transform = "translateX(-24px)";
  });
  await expect.poll(membersCenterDifference).toBeLessThan(2);
  await membersToggle.evaluate((element) => {
    (element as HTMLElement).style.transform = "";
  });
  await expect.poll(membersCenterDifference).toBeLessThan(2);
  await page.keyboard.press("Enter");
  await expect(membersToggle).toHaveAttribute("aria-pressed", "true");
  // Opening the side panel shrinks the main column without resizing the
  // window. The open tooltip must follow the focused button across that reflow.
  await expect.poll(membersCenterDifference).toBeLessThan(2);
  await page.keyboard.press("Escape");
  await expect(membersTooltip).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(membersToggle).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({ path: info.outputPath("tandem-conversation.png") });
  const latestArticle = page.getByRole("article").last();
  await latestArticle.hover();
  const reply = page.getByRole("button", { name: "Reply in thread", exact: true }).last();
  await expect(reply).toBeVisible();
  await reply.hover();
  const hoveredTooltip = page.getByRole("tooltip").filter({ hasText: "Reply in thread" });
  await expect(hoveredTooltip).toBeVisible();
  const hoveredBox = await hoveredTooltip.boundingBox();
  expect(hoveredBox).not.toBeNull();
  await page.mouse.move(
    hoveredBox!.x + hoveredBox!.width / 2,
    hoveredBox!.y + hoveredBox!.height / 2,
    { steps: 5 },
  );
  await page.waitForTimeout(350);
  await expect(hoveredTooltip).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(hoveredTooltip).toHaveCount(0);

  await latestArticle.focus();
  await expect(reply).toBeVisible();
  await reply.focus();
  await expect(page.getByRole("tooltip").filter({ hasText: "Reply in thread" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  // A refused pin comes back undone, and the notice is the only thing that
  // says so. It stays in the window and above a dialog, outside the page the
  // modal layer makes inert, and its action works with the dialog still open.
  let refusePins = true;
  await page.route("**/api/messages/*/pin", (route) =>
    refusePins ? route.abort("connectionfailed") : route.fallback(),
  );
  await latestArticle.hover();
  await latestArticle.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Pin to channel", exact: true }).click();
  const refusedPin = notice(page, "Could not pin that message.");
  await expect(refusedPin).toBeVisible();
  await expectInsideViewport(page, refusedPin);
  // A failure stays until it is dealt with, so it must not sit on the
  // composer someone is about to type in.
  const composerField = page.getByRole("textbox", { name: "Message #design-studio", exact: true });
  await expectApart(refusedPin, composerField);
  await expect(latestArticle.getByText("Pinned to this channel", { exact: true })).toHaveCount(0);
  // The shortcut sheet is bundled with the app, so opening it here leaves the
  // first opening of search, further on, to prove that download.
  await page.keyboard.press("Control+/");
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await expect(shortcuts).toBeVisible();
  await expect(refusedPin).toBeVisible();
  expect(await isInert(refusedPin)).toBe(false);
  await page.screenshot({ path: info.outputPath("notice-over-dialog.png") });
  refusePins = false;
  await refusedPin.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(refusedPin).toHaveCount(0);
  // Pressing the notice is not a press outside the dialog.
  await expect(shortcuts).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(shortcuts).toHaveCount(0);
  await expect(latestArticle.getByText("Pinned to this channel", { exact: true })).toBeVisible();
  await page.unroute("**/api/messages/*/pin");
  // The pin shows under the header as a slim line that opens the list (UX-23).
  const pinnedLine = page.getByRole("button", { name: /^1 pinned: Love where this is heading/ });
  await expect(pinnedLine).toBeVisible();
  await pinnedLine.click();
  const pinnedPanel = page.getByRole("complementary", { name: "Pinned", exact: true });
  await expect(pinnedPanel.getByText(/Love where this is heading/)).toBeVisible();
  await expect(pinnedLine).toHaveAttribute("aria-pressed", "true");
  await pinnedLine.click();
  await expect(pinnedPanel).toHaveCount(0);

  await page.getByRole("textbox", { name: "Message #design-studio", exact: true }).focus();
  for (let i = 0; i < 315; i++) {
    const posted = await fetch(`${base}/api/channels/${channel.id}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: `Live update ${i} — keeping everyone on the same page.` }),
    });
    expect(posted.ok).toBe(true);
  }
  await expect(page.locator("[data-mid]")).toHaveCount(300);
  const history = page.getByLabel("Message history", { exact: true });
  await expect
    .poll(() => history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(4);
  await expect(
    page.getByText("Live update 314 — keeping everyone on the same page.", { exact: true }),
  ).toBeInViewport();

  // A side panel narrows the timeline and rewraps what is in it. Someone
  // reading the newest message should still see it, not find it under the
  // composer.
  const longUpdate = Array(6)
    .fill("a longer note that wraps onto more lines once the timeline narrows")
    .join(", ");
  expect(
    (
      await fetch(`${base}/api/channels/${channel.id}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text: longUpdate }),
      })
    ).ok,
  ).toBe(true);
  await expect(page.getByText(longUpdate, { exact: true })).toBeInViewport();
  // People read with the pointer resting on a message. Showing a compact
  // row's time on hover must not make that row taller: a time that wrapped to
  // two lines did, and the timeline then lost its place at the bottom when
  // the side panel below narrowed it. The pointer stays there until then.
  const restingRow = page.locator("[data-mid]").filter({ hasText: "Live update 300 —" });
  const unhovered = await restingRow.boundingBox();
  await restingRow.hover();
  await expect(restingRow.getByText(/\d:\d\d/)).toBeVisible();
  const hovered = await restingRow.boundingBox();
  expect(unhovered).not.toBeNull();
  expect(hovered).not.toBeNull();
  expect(Math.abs(hovered!.height - unhovered!.height)).toBeLessThan(0.5);
  await page.getByRole("button", { name: "Saved", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Saved", exact: true })).toBeVisible();
  await expect
    .poll(() => history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(4);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Saved", exact: true })).toHaveCount(0);

  // Observe input-to-next-frame timing in the built production client. Report
  // timings rather than imposing a machine-dependent "60 fps" CI promise.
  await page.evaluate(() => {
    (window as any).inputFrames = [];
    document.querySelector("textarea")!.addEventListener("input", () => {
      const start = performance.now();
      requestAnimationFrame(() => (window as any).inputFrames.push(performance.now() - start));
    });
  });
  const composer = page.getByRole("textbox", { name: "Message #design-studio", exact: true });
  await composer.pressSequentially("A calmer space for our next big idea.", { delay: 12 });
  // Allow the debounced draft write, then verify a dialog round trip keeps it.
  await expect
    .poll(async () =>
      Object.entries((await deviceValues(page)).indexed ?? {}).some(
        ([key, raw]) =>
          key.startsWith("local:v1:") && key.endsWith(":drafts") && raw.includes("calmer space"),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Saved", exact: true }).click();
  const savedPanel = page.getByRole("complementary", { name: "Saved", exact: true });
  await expect(savedPanel).toBeVisible();
  await composer.focus();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Jump to", exact: true });
  await expect(dialog).toBeVisible();
  // Workspace shortcuts must not replace a foreground form, and Escape must
  // leave the background side panel open when it dismisses that form.
  await page.keyboard.press("Control+f");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Search messages" })).toHaveCount(0);
  // The box is the last thing to Tab to; the matches are chosen with the arrow keys.
  await dialog.getByRole("combobox", { name: "Channel or person" }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(composer).toBeFocused();
  await expect(savedPanel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(savedPanel).toHaveCount(0);
  await expect(composer).toHaveValue("A calmer space for our next big idea.");
  await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(composer).toHaveValue("A calmer space for our next big idea.");

  // Search, scheduled messages and channel details are downloaded the first
  // time they open, so each has to arrive, past the content security policy,
  // and work.
  // Chosen from the conversation's menu, search opens on this conversation,
  // ready to type in, and follows the typing with no Enter.
  await options.click();
  await page.getByRole("menuitem", { name: "Search in #design-studio", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Search messages", exact: true });
  const searchBox = search.getByRole("textbox", { name: "Search messages", exact: true });
  await expect(searchBox).toBeFocused();
  // The conversation is a filter like any other, one click to take away (UX-51).
  await expect(
    search.getByRole("button", { name: "Remove filter: In #design-studio", exact: true }),
  ).toBeVisible();
  await searchBox.pressSequentially("zebracrossingquartz");
  // A search that finds nothing says so where the dialog says what it is
  // doing, and says what to try instead.
  await expect(search.getByRole("status").filter({ hasText: "Nothing matched" })).toHaveText(
    "Nothing matched. Try different words.",
  );
  // It follows further typing without being asked again, a word found from
  // its start.
  await searchBox.fill("welc");
  await expect(search.getByRole("status").filter({ hasText: "Newest first" })).toContainText(
    "“welc”",
  );
  await expect(search.getByText(/A little space for big ideas/)).toBeVisible();
  // A modifier typed in the field becomes a chip once a space follows it, and
  // what it finds starts close under the field, not under a panel of filters.
  await searchBox.fill("");
  await searchBox.pressSequentially("from:@maya direction");
  const fromMaya = search.getByRole("button", {
    name: "Remove filter: From Maya Chen",
    exact: true,
  });
  await expect(fromMaya).toBeVisible();
  await expect(searchBox).toHaveValue("direction");
  const found = search.getByRole("listitem").filter({ hasText: "The new direction is ready" });
  await expect(found).toBeVisible();
  const fieldBox = (await searchBox.boundingBox())!;
  const foundBox = (await found.boundingBox())!;
  expect(foundBox.y - (fieldBox.y + fieldBox.height)).toBeLessThan(150);
  await fromMaya.click();
  await expect(fromMaya).toHaveCount(0);
  await expect(searchBox).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
  // Scheduled messages are yours, so they are in the menu on your name. Chosen
  // there, the panel takes focus, and closing it hands focus back to the menu.
  const accountMenu = page.getByRole("button", { name: /, your account$/ });
  await accountMenu.click();
  await page.getByRole("menuitem", { name: "Scheduled messages", exact: true }).click();
  const scheduled = page.getByRole("complementary", { name: "Scheduled messages", exact: true });
  const scheduledHeading = scheduled.getByRole("heading", { name: "Scheduled", exact: true });
  await expect(scheduledHeading).toBeVisible();
  await expect(scheduledHeading).toBeFocused();
  await scheduled.getByRole("button", { name: "Close scheduled messages", exact: true }).click();
  await expect(scheduled).toHaveCount(0);
  await expect(accountMenu).toBeFocused();
  await page.getByRole("heading", { name: "#design-studio", exact: true }).click();
  const details = page.getByRole("dialog", { name: "#design-studio", exact: true });
  await expect(details).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(composer).toHaveValue("A calmer space for our next big idea.");

  // Completing a mention rewrites the field, and typing straight after has
  // to carry on from where the completion left off.
  await composer.fill("");
  await composer.pressSequentially("Hi @may", { delay: 10 });
  await page.keyboard.press("Tab");
  const completed = await composer.inputValue();
  expect(completed).toBe("Hi @Maya Chen ");
  await composer.pressSequentially("ready?", { delay: 5 });
  expect(await composer.inputValue()).toBe(`${completed}ready?`);

  // Formatting is where the caret has to land in the middle rather than at the
  // end: bolding a word should leave the word selected, ready to keep typing
  // over, not drop the caret past the closing marker.
  await composer.fill("hello world");
  await composer.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(0, 5));
  await page.keyboard.press("Control+b");
  await expect(composer).toHaveValue("*hello* world");
  const selection = await composer.evaluate((el) => {
    const box = el as HTMLTextAreaElement;
    return [box.selectionStart, box.selectionEnd];
  });
  expect(selection).toEqual([1, 6]);
  await composer.fill("A calmer space for our next big idea.");

  // The switcher takes Enter too, and an input method's Enter is not a
  // request to go anywhere.
  await page.keyboard.press("Control+k");
  const switcher = page.getByRole("dialog", { name: "Jump to", exact: true });
  await expect(switcher).toBeVisible();
  await switcher
    .getByRole("combobox")
    .dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(switcher).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(composer).toBeFocused();

  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(composer).toBeEmpty();
  await expect(
    page.getByText("A calmer space for our next big idea.", { exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: info.outputPath("tandem-workspace.png") });
  const timings = await page.evaluate(() =>
    ((window as any).inputFrames as number[]).sort((a, b) => a - b),
  );
  expect(timings.length).toBeGreaterThan(20);
  await info.attach("input-to-frame-ms", {
    body: JSON.stringify(
      {
        samples: timings.length,
        p50: timings[Math.floor(timings.length * 0.5)],
        p95: timings[Math.floor(timings.length * 0.95)],
        max: timings.at(-1),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  // A phone's header keeps the same controls, with one face beside the count.
  await expectTooltipInsideViewport(page, options, "More");
  const extraFaces = await membersToggle.locator(".header-secondary").all();
  expect(extraFaces.length).toBeGreaterThan(0);
  for (const face of extraFaces) await expect(face).toBeHidden();
  // At phone width a notice still fits the window.
  await page.route("**/api/messages/*/save", (route) => route.abort("connectionfailed"));
  const newest = page.getByRole("article").last();
  await newest.hover();
  await newest.getByRole("button", { name: "Save for later", exact: true }).click();
  const refusedSave = notice(page, "Could not save that for later.");
  await expect(refusedSave).toBeVisible();
  await expectInsideViewport(page, refusedSave);
  await expectApart(refusedSave, composerField);
  await page.screenshot({ path: info.outputPath("notice-phone.png") });
  await refusedSave.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(refusedSave).toHaveCount(0);
  await page.unroute("**/api/messages/*/save");
  const drawerNav = page.getByRole("navigation", { name: "Workspace navigation" });
  await expect(drawerNav).not.toBeVisible();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(drawerNav).toBeVisible();
  await expectMainCovered(page);
  // Opening the drawer puts focus on Jump to…, and the drawer lands under the
  // pointer that opened it, on the rail of workspaces, whose hint shows. The
  // Escape is still the drawer's: it closes, and the hint goes with it.
  const jumpTo = drawerNav.getByRole("button", { name: /^Jump to…/ });
  await expect(jumpTo).toBeFocused();
  await drawerNav.getByRole("group", { name: "Workspaces" }).getByRole("button").first().hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await expect(jumpTo).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawerNav).not.toBeVisible();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeFocused();
  // The drawer is a step in history, not a place: a phone's Back closes it,
  // and the address stays as it was.
  const conversation = page.url();
  expect(conversation).toMatch(/#\/c\/[^/]+$/);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
  expect(page.url()).toBe(conversation);
  await page.goBack();
  await expect(page.getByRole("navigation", { name: "Workspace navigation" })).not.toBeVisible();
  await expect(page).toHaveURL(conversation);
  // Going somewhere from the drawer takes the drawer's step, so Back returns
  // to the conversation as it was, not to the open drawer.
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).click();
  await expect(page).toHaveURL(`${conversation}/p/saved`);
  await page.goBack();
  await expect(page).toHaveURL(conversation);
  await expect(page.getByRole("navigation", { name: "Workspace navigation" })).not.toBeVisible();
  await expect(page.getByRole("complementary", { name: "Saved", exact: true })).toHaveCount(0);
  // On a phone the formatting buttons fold behind one, leaving the row to the message.
  const bold = page.getByRole("button", { name: "Bold", exact: true });
  const formatting = page.getByRole("button", { name: "Formatting", exact: true });
  await expect(bold).toBeHidden();
  await formatting.click();
  await expect(bold).toBeVisible();
  await expect(formatting).toHaveAttribute("aria-expanded", "true");
  await formatting.click();
  await expect(bold).toBeHidden();
  // A panel covers the conversation there, so it takes focus even from its
  // toggle, and what it covers is out of reach until it closes.
  await membersToggle.click();
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeFocused();
  await expectMainCovered(page);
  await page.getByRole("button", { name: "Close Members", exact: true }).click();
  await expect(page.locator("main [inert]")).toHaveCount(0);
  await expect(membersToggle).toBeFocused();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Workspace navigation" })).not.toBeVisible();
  // Opened from the navigation rather than a toggle, the panel takes focus.
  await expect(page.getByRole("heading", { name: "Saved", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  // The drawer that opened it is closed by now, so focus goes to the button
  // that opens the drawer rather than dropping to the page.
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeFocused();
  await composer.fill("Sent from a small window");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  // The composer keeps the words until the device has the send (GL-02), so
  // look for the message itself, then for the composer to let them go.
  await expect(
    page.getByRole("article").filter({ hasText: "Sent from a small window" }),
  ).toBeInViewport();
  await expect(composer).toHaveValue("");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // An image wider than a phone's column scales down instead of running off it.
  const upload = new FormData();
  // Copied into a plain Uint8Array: a Buffer may sit on shared memory, which a Blob does not take.
  const png = new Uint8Array(solidPng(640, 360));
  upload.append("file", new Blob([png], { type: "image/png" }), "wide-mock.png");
  const uploaded = await (
    await fetch(`${base}/api/channels/${channel.id}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: upload,
    })
  ).json();
  expect(
    (
      await fetch(`${base}/api/channels/${channel.id}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text: "The wide mock", fileIds: [uploaded.file.id] }),
      })
    ).ok,
  ).toBe(true);
  const preview = page.getByRole("button", { name: "Open image wide-mock.png", exact: true });
  await expect(preview).toBeInViewport();
  const previewBox = await preview.boundingBox();
  expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(390);
  expect(await history.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("tandem-narrow.png") });

  // A phone on its side is wide enough for the sidebar but too short for it:
  // it becomes the same drawer, and the header gives some height back.
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByRole("navigation")).not.toBeVisible();
  expect((await page.locator(".channel-header").boundingBox())!.height).toBeLessThanOrEqual(53);
  await expect(composerField).toBeInViewport();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
  await page.screenshot({ path: info.outputPath("tandem-short-landscape.png") });
  // The drawer scrolls as one column, so its channels come into view with it.
  const channelRow = page
    .getByRole("navigation")
    .getByRole("button", { name: /^#\s*design-studio\b/ });
  // By however far the row sits below the window: what comes before it in the
  // drawer, such as an owner's first steps, varies with who is signed in.
  await channelRow.evaluate((row) =>
    row.closest("nav")!.scrollBy(0, row.getBoundingClientRect().bottom - innerHeight + 40),
  );
  await expect(channelRow).toBeInViewport();
  await page.screenshot({ path: info.outputPath("tandem-short-landscape-scrolled.png") });
  await channelRow.click();
  await expect(page.getByRole("navigation")).not.toBeVisible();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  // Grown out of that, the drawer closes and the sidebar sits beside the chat again.
  await page.setViewportSize({ width: 1280, height: 820 });
  await expect(page.getByRole("button", { name: "Close navigation", exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeHidden();
  expect(errors).toEqual([]);
});

/**
 * A browser this test starts and may kill outright, as a crash or a power
 * cut would, on a profile kept on disk so the next launch finds what the
 * last one stored. Playwright's own browsers cannot be killed that way.
 */
async function launchProfile(profile: string) {
  const executable =
    test.info().project.use.launchOptions?.executablePath ?? chromium.executablePath();
  const process_ = spawn(
    executable,
    [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      // The size every other journey runs at: a browser's own default can
      // be narrow enough to fold the sidebar away.
      "--window-size=1280,820",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise<string>((resolve, reject) => {
    let said = "";
    process_.stderr!.on("data", (chunk) => {
      said += String(chunk);
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(said);
      if (found) resolve(found[1]!);
    });
    process_.once("exit", (code) => reject(new Error(`The browser exited (${code}): ${said}`)));
  });
  const browser: Browser = await chromium.connectOverCDP(endpoint);
  const kill = async () => {
    const gone = new Promise((resolve) => process_.once("exit", resolve));
    process_.kill("SIGKILL");
    await gone;
  };
  const context = browser.contexts()[0]!;
  const open = async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 820 });
    return page;
  };
  return { browser, context, open, kill };
}

test("the composer shows mentions as names while typing, and sends them as ids", async ({
  page,
}) => {
  await signIn(page, "alice");
  const composer = page.getByRole("textbox", { name: "Message #general", exact: true });
  const login = (await (
    await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "bobby", password: "password123" }),
    })
  ).json()) as { token: string; user: { id: string } };
  const bobby = login.user.id;
  const { channels } = await (
    await fetch(`${base}/api/channels`, { headers: { authorization: `Bearer ${login.token}` } })
  ).json();
  const general = channels.find((c: { name: string }) => c.name === "general");
  /** What the server holds as the latest message in #general. */
  const latest = async () => {
    const { messages } = await (
      await fetch(`${base}/api/channels/${general.id}/messages`, {
        headers: { authorization: `Bearer ${login.token}` },
      })
    ).json();
    return (messages as { text: string; seq: number }[]).toSorted((a, b) => b.seq - a.seq)[0]?.text;
  };

  // Chosen from the list, @here reads as @here and is sent as <!here>, with
  // the caret after it.
  await composer.pressSequentially("Lunch @he", { delay: 10 });
  await page.keyboard.press("Tab");
  await expect(composer).toHaveValue("Lunch @here ");
  await composer.pressSequentially("now?", { delay: 10 });
  await expect(composer).toHaveValue("Lunch @here now?");
  await page.keyboard.press("Enter");
  await expect.poll(latest).toBe("Lunch <!here> now?");
  // The server can hold the message before this device has kept the send;
  // until it has, the box is read-only and would drop what is typed next.
  await expect(composer).toBeEditable();

  // The completion is the browser's own edit: Undo takes it back to what was
  // typed, and Redo brings back the mention, not the letters of its name.
  await composer.pressSequentially("ask @bo", { delay: 10 });
  await page.keyboard.press("Tab");
  await expect(composer).toHaveValue("ask @bobby ");
  await page.keyboard.press("Control+z");
  await expect(composer).toHaveValue("ask @bo");
  await page.keyboard.press("Control+Shift+z");
  await expect(composer).toHaveValue("ask @bobby ");
  expect(await composer.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(11);

  // An input method composes after the mention without disturbing it.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.imeSetComposition", { text: "にほん", selectionStart: 3, selectionEnd: 3 });
  await cdp.send("Input.insertText", { text: "日本" });
  await expect(composer).toHaveValue("ask @bobby 日本");
  await page.keyboard.press("Enter");
  await expect.poll(latest).toBe(`ask <@${bobby}> 日本`);
  await expect(composer).toBeEditable();

  // Backspace takes a whole mention, and bolding one keeps it a mention.
  await composer.pressSequentially("@bo", { delay: 10 });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(composer).toHaveValue("");
  await composer.pressSequentially("hey @bo", { delay: 10 });
  await page.keyboard.press("Tab");
  await composer.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(4, 10));
  await page.keyboard.press("Control+b");
  await expect(composer).toHaveValue("hey *@bobby* ");
  expect(
    await composer.evaluate((el) => {
      const box = el as HTMLTextAreaElement;
      return [box.selectionStart, box.selectionEnd];
    }),
  ).toEqual([5, 11]);
  await page.keyboard.press("Control+z");
  await expect(composer).toHaveValue("hey @bobby ");
  await page.keyboard.press("Control+Shift+z");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect.poll(latest).toBe(`hey *<@${bobby}>*`);

  // Editing the sent message shows the name, and saving keeps the id.
  // The toolbar of the message hovered, not of one that showed its own earlier.
  const sent = page.getByRole("article").filter({ hasText: "hey" }).last();
  await sent.hover();
  await sent.getByRole("button", { name: "Edit message", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Edit message", exact: true });
  await expect(editor).toHaveValue("hey *@bobby*");
  await editor.press("End");
  await editor.pressSequentially(" please", { delay: 10 });
  await editor.press("Enter");
  await expect.poll(latest).toBe(`hey *<@${bobby}>* please`);
});

test("a send the composer let go of, and the drafts saved, outlast the browser being killed (F01)", async () => {
  const profile = mkdtempSync(join(tmpdir(), "slackoss-profile-"));
  let running: Awaited<ReturnType<typeof launchProfile>> | null = null;
  try {
    running = await launchProfile(profile);
    const first = await running.open();
    await register(first, "crashed");
    const token = await savedToken(first);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const created = await fetch(`${base}/api/channels`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: "public", name: "later" }),
    });
    expect(created.status).toBe(201);
    const later = ((await created.json()) as { channel: { id: string } }).channel;
    const composer = (page: Page, channel: string) =>
      page.getByRole("textbox", { name: `Message #${channel}`, exact: true });

    // Two tabs change one draft at once; both texts are stored.
    const second = await running.open();
    await second.goto(base);
    await composer(first, "general").fill("Words from the first tab");
    await composer(second, "general").fill("Words from the second tab");
    const both = /Words from the (first|second) tab\n\nWords from the (first|second) tab/;
    await expect(composer(first, "general")).toHaveValue(both);
    await expect(composer(second, "general")).toHaveValue(both);

    // A send made with no connection: the composer lets go of its words only
    // once the device has stored the send.
    await second.close();
    await first
      .getByRole("navigation")
      .getByRole("button", { name: /^#\s*later\b/ })
      .click();
    await running.context.setOffline(true);
    await composer(first, "later").fill("Sent with no connection, then the browser died");
    await composer(first, "later").press("Enter");
    await expect(composer(first, "later")).toHaveValue("");
    // Killed at once: no page is told it is closing, and nothing else is written.
    await running.kill();
    await running.browser.close().catch(() => {});
    running = null;

    running = await launchProfile(profile);
    const reopened = await running.open();
    await reopened.goto(base);
    await reopened
      .getByRole("navigation")
      .getByRole("button", { name: /^#\s*general\b/ })
      .click();
    await expect(composer(reopened, "general")).toHaveValue(both);
    // The send goes out now that there is a connection, and only once.
    const sent = async () => {
      const response = await fetch(`${base}/api/channels/${later.id}/messages`, { headers: auth });
      const { messages } = (await response.json()) as { messages: { text: string }[] };
      return messages.filter((m) => m.text === "Sent with no connection, then the browser died")
        .length;
    };
    await expect.poll(sent, { timeout: 20_000 }).toBe(1);
    await reopened
      .getByRole("navigation")
      .getByRole("button", { name: /^#\s*later\b/ })
      .click();
    await expect(
      reopened
        .getByRole("article")
        .filter({ hasText: "Sent with no connection, then the browser died" }),
    ).toHaveCount(1);
    await reopened.waitForTimeout(1_500);
    expect(await sent()).toBe(1);
  } finally {
    await running?.kill().catch(() => {});
    await running?.browser.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
});

test("unsent words outlast two tabs typing at once, and a tab closed straight after typing (F01)", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  try {
    const composer = (page: Page) =>
      page.getByRole("textbox", { name: "Message #general", exact: true });
    const first = await context.newPage();
    await register(first, "twotabs");
    await expect(composer(first)).toBeVisible();
    // Kept in IndexedDB, which takes every tab's change in turn; nothing is
    // kept in localStorage but changes written down for a moment.
    await expect
      .poll(async () => Object.keys((await deviceValues(first)).indexed ?? {}))
      .toContain("servers");
    expect((await deviceValues(first)).legacy).toEqual({});

    const second = await context.newPage();
    await second.goto(base);
    await expect(composer(second)).toBeVisible();
    // Typed in both before either is saved: each change is made from the
    // empty draft, so neither tab's words may be lost to the other's.
    await composer(first).fill("Words from the first tab");
    await composer(second).fill("Words from the second tab");
    const both = /Words from the (first|second) tab\n\nWords from the (first|second) tab/;
    await expect(composer(first)).toHaveValue(both);
    await expect(composer(second)).toHaveValue(both);
    // The tab whose change was made second says so.
    const told = "Another window changed this draft too, so both versions are kept in it.";
    await expect
      .poll(
        async () => (await first.getByText(told).count()) + (await second.getByText(told).count()),
      )
      .toBe(1);
    await second.close();

    // Typed, and the tab closed at once, inside the pauses before the
    // composer hands its text on and before a draft is written.
    await composer(first).fill("Written as the tab closed");
    await first.close();

    const reopened = await context.newPage();
    await reopened.goto(base);
    await expect(composer(reopened)).toHaveValue("Written as the tab closed");
  } finally {
    await context.close();
  }
});

test("database failure keeps saved work private and retries without an empty fallback (N02)", async ({
  context,
  page,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(window, "BroadcastChannel", { value: undefined, configurable: true });
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name, version) => {
      if (sessionStorage.getItem("fixture-storage-refused") === "yes")
        throw new DOMException("Storage temporarily refused", "UnknownError");
      return open(name, version);
    };
  });
  await signIn(page, "alice");
  const composer = (tab: Page) =>
    tab.getByRole("textbox", { name: "Message #general", exact: true });
  const notifications = async (tab: Page) => {
    await tab.getByRole("button", { name: /, your account$/ }).click();
    await tab.getByRole("menuitem", { name: "Account settings" }).click();
    const settings = tab.getByRole("dialog", { name: "Account settings" });
    await settings.getByRole("tab", { name: "Notifications", exact: true }).click();
    return settings.getByRole("group", { name: "What notifications show" });
  };
  const firstChoices = await notifications(page);
  await firstChoices.getByRole("radio", { name: /^Nothing about it/ }).click();
  await expect(firstChoices.getByRole("radio", { name: /^Nothing about it/ })).toBeChecked();
  const second = await context.newPage();
  await second.goto(base);
  const secondChoices = await notifications(second);
  await expect(secondChoices.getByRole("radio", { name: /^Nothing about it/ })).toBeChecked();
  await firstChoices.getByRole("radio", { name: /^Only who sent it/ }).click();
  await expect(secondChoices.getByRole("radio", { name: /^Only who sent it/ })).toBeChecked();
  await secondChoices.getByRole("radio", { name: /^Nothing about it/ }).click();
  await expect(firstChoices.getByRole("radio", { name: /^Nothing about it/ })).toBeChecked();
  await page.keyboard.press("Escape");
  await second.keyboard.press("Escape");
  await composer(page).fill("First window's saved words");
  await composer(second).fill("Second window's saved words");
  const both =
    /(?:First window's saved words\n\nSecond window's saved words|Second window's saved words\n\nFirst window's saved words)/;
  await expect(composer(page)).toHaveValue(both);
  await expect(composer(second)).toHaveValue(both);
  const servers = await deviceValue<unknown>(page, "servers");
  const privateChoices = await deviceValue<unknown>(page, "notification-previews");
  await second.close();
  await page.evaluate((saved) => {
    // A legacy sign-in copy isolated the original privacy regression. It may
    // not authorize treating the unreadable canonical store as empty.
    localStorage.setItem("slackoss:servers", JSON.stringify(saved));
    sessionStorage.setItem("fixture-storage-refused", "yes");
  }, servers);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Saved sign-ins could not be opened" }),
  ).toBeVisible();
  await expect(composer(page)).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem("slackoss:notification-previews")),
  ).toBeNull();
  await page.evaluate(() => sessionStorage.removeItem("fixture-storage-refused"));
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(composer(page)).toHaveValue(both);
  const recoveredChoices = await notifications(page);
  await expect(recoveredChoices.getByRole("radio", { name: /^Nothing about it/ })).toBeChecked();
  expect(await deviceValue(page, "notification-previews")).toEqual(privateChoices);
  expect((await deviceValues(page)).legacy).toEqual({});
});

test("an app's button calls it back and rewrites the message it sits on", async ({
  browser,
}, info) => {
  // Stands in for the third-party app the button points at.
  let answer: (body: string) => string = () => "";
  const received: string[] = [];
  const stub: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(answer(body));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}/interactions`;

  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  // A blocked resource is reported to the console rather than thrown, so it
  // would slip past the page-error check above on its own.
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) errors.push(m.text());
  });
  try {
    // Alice owns this workspace, so she is the one who can create an app.
    const login = await (
      await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "alice", password: "password123" }),
      })
    ).json();
    const admin = { authorization: `Bearer ${login.token}`, "content-type": "application/json" };
    const created = await (
      await fetch(`${base}/api/apps`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ name: "Deploy Bot" }),
      })
    ).json();

    // The URL has to echo the verification challenge before it is accepted.
    answer = (body) => JSON.stringify({ challenge: JSON.parse(body).challenge });
    const set = await fetch(`${base}/api/apps/${created.app.id}/interactivity`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ url: stubUrl }),
    });
    expect(set.status).toBe(200);

    await register(page, "dave");
    const channels = await (await fetch(`${base}/api/channels`, { headers: admin })).json();
    const general = channels.channels.find((c: { name: string }) => c.name === "general");

    await fetch(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        channel: general.id,
        text: "Deploy 412 to production?",
        blocks: [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: "approve",
                style: "primary",
                value: "412",
                text: { type: "plain_text", text: "Approve" },
              },
            ],
          },
        ],
      }),
    });

    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve).toBeVisible();

    await page.screenshot({ path: info.outputPath("buttons.png") });

    received.length = 0;
    answer = () => JSON.stringify({ replace_original: true, text: "Approved. Shipping 412." });
    await approve.click();

    // The app was called with the click, and its reply replaced the message.
    await expect(page.getByText("Approved. Shipping 412.", { exact: true })).toBeVisible();
    await expect(approve).toHaveCount(0);
    const payload = JSON.parse(new URLSearchParams(received[0]!).get("payload")!);
    expect(payload.type).toBe("block_actions");
    expect(payload.actions[0].value).toBe("412");
    expect(errors).toEqual([]);
  } finally {
    await context.close().catch(() => {});
    await new Promise<void>((r) => stub.close(() => r()));
  }
});

test("a button opens the app's form, and what you type reaches the app", async ({
  browser,
}, info) => {
  // The app: verifies its URL, opens a modal when its button is pressed, and
  // records the submission.
  let botToken = "";
  const submissions: string[] = [];
  let refuseOnce = true;
  const stub: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.startsWith("{")) {
          // The url_verification handshake.
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ challenge: JSON.parse(raw).challenge }));
        }
        const payload = JSON.parse(new URLSearchParams(raw).get("payload")!);
        if (payload.type === "block_actions") {
          await fetch(`${base}/api/views.open`, {
            method: "POST",
            headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
            body: JSON.stringify({
              trigger_id: payload.trigger_id,
              view: {
                type: "modal",
                callback_id: "deploy_form",
                title: { type: "plain_text", text: "Deploy" },
                submit: { type: "plain_text", text: "Ship it" },
                blocks: [
                  { type: "section", text: { type: "mrkdwn", text: "Where is this going?" } },
                  {
                    type: "input",
                    block_id: "where",
                    label: { type: "plain_text", text: "Environment" },
                    element: {
                      type: "static_select",
                      action_id: "env",
                      options: [
                        { text: { type: "plain_text", text: "Staging" }, value: "staging" },
                        { text: { type: "plain_text", text: "Production" }, value: "production" },
                      ],
                    },
                  },
                  {
                    type: "input",
                    block_id: "why",
                    label: { type: "plain_text", text: "Reason" },
                    element: { type: "plain_text_input", action_id: "notes" },
                  },
                ],
              },
            }),
          });
          res.writeHead(200, { "content-type": "application/json" });
          return res.end("");
        }
        submissions.push(raw);
        res.writeHead(200, { "content-type": "application/json" });
        // Refuse the first answer, the way an app that validates would.
        if (refuseOnce) {
          refuseOnce = false;
          return res.end(
            JSON.stringify({
              response_action: "errors",
              errors: { where: "Not to production on a Friday." },
            }),
          );
        }
        res.end("");
      })();
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}/interactions`;

  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  // A blocked resource is reported to the console rather than thrown, so it
  // would slip past the page-error check above on its own.
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) errors.push(m.text());
  });
  try {
    const login = await (
      await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "alice", password: "password123" }),
      })
    ).json();
    const admin = { authorization: `Bearer ${login.token}`, "content-type": "application/json" };
    const created = await (
      await fetch(`${base}/api/apps`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ name: "Form Bot" }),
      })
    ).json();
    botToken = created.token;
    await fetch(`${base}/api/apps/${created.app.id}/interactivity`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ url: stubUrl }),
    });

    await register(page, "erin");
    const channels = await (await fetch(`${base}/api/channels`, { headers: admin })).json();
    const general = channels.channels.find((c: { name: string }) => c.name === "general");
    await fetch(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        channel: general.id,
        text: "Ready to deploy",
        blocks: [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: "open",
                style: "primary",
                text: { type: "plain_text", text: "Deploy…" },
              },
            ],
          },
        ],
      }),
    });

    // Pressing the button opens the app's form.
    await page.getByRole("button", { name: "Deploy…", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Deploy" });
    await expect(modal).toBeVisible();
    await expect(modal.getByText("Where is this going?")).toBeVisible();

    await modal.getByLabel("Environment").selectOption("production");
    await modal.getByLabel("Reason").fill("hotfix for the login bug");
    await page.screenshot({ path: info.outputPath("modal.png") });
    await modal.getByRole("button", { name: "Ship it", exact: true }).click();

    // The app refused it, so the form stays open with its reason attached.
    await expect(modal.getByText("Not to production on a Friday.")).toBeVisible();
    await expect(modal).toBeVisible();

    // Answering again is accepted, and the form closes.
    await modal.getByLabel("Environment").selectOption("staging");
    await modal.getByRole("button", { name: "Ship it", exact: true }).click();
    await expect(modal).toHaveCount(0);

    expect(submissions).toHaveLength(2);
    const last = JSON.parse(new URLSearchParams(submissions[1]!).get("payload")!);
    expect(last.type).toBe("view_submission");
    expect(last.view.callback_id).toBe("deploy_form");
    expect(last.view.state.values.where.env.selected_option.value).toBe("staging");
    expect(last.view.state.values.why.notes.value).toBe("hotfix for the login bug");
    expect(errors).toEqual([]);
  } finally {
    await context.close().catch(() => {});
    await new Promise<void>((r) => stub.close(() => r()));
  }
});

test("deactivating someone signs them out of the app they already have open", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const leaverContext = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const ownerPage = await ownerContext.newPage();
  const leaverPage = await leaverContext.newPage();
  try {
    // Alice registered first, so she owns this workspace.
    await signIn(ownerPage, "alice");
    await register(leaverPage, "frank");
    await expect(leaverPage.locator("textarea")).toBeVisible();

    await ownerPage.getByRole("button", { name: /, workspace menu$/ }).click();
    await ownerPage.getByRole("menuitem", { name: "People", exact: true }).click();
    const dialog = ownerPage.getByRole("dialog", { name: "People" });
    await expect(dialog).toBeVisible();

    // The owner's own row offers nothing: you cannot lock yourself out.
    const ownerRow = dialog.locator("li").filter({ hasText: "@alice" });
    await expect(ownerRow.getByRole("button")).toHaveCount(0);

    const leaverRow = dialog.locator("li").filter({ hasText: "@frank" });
    await leaverRow.getByRole("button", { name: "Actions for frank", exact: true }).click();
    await ownerPage.getByRole("menuitem", { name: "Deactivate", exact: true }).click();
    // Deactivated accounts drop out of the list, and are still reachable behind
    // a toggle, because reactivating is the other half of this.
    await expect(leaverRow).toHaveCount(0);
    await dialog.getByRole("button", { name: /Show 1 deactivated account/ }).click();
    await expect(
      dialog.locator("li").filter({ hasText: "@frank" }).getByText("Deactivated"),
    ).toBeVisible();

    // And the workspace remembers who did it.
    await dialog.getByRole("button", { name: "Show recent changes", exact: true }).click();
    await expect(
      dialog.getByRole("region", { name: "Recent changes" }).getByText("You deactivated frank"),
    ).toBeVisible();

    // Frank's open app does not keep working: it drops back to the join
    // screen, which may go straight to this workspace's sign-in.
    await expect(
      leaverPage
        .getByPlaceholder("192.168.1.42:8543 or chat.yourteam.dev")
        .or(leaverPage.getByLabel("Username", { exact: true }))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(leaverPage.locator("textarea")).toHaveCount(0);

    // And signing back in from that same screen is refused.
    await openAuthCard(leaverPage);
    await expect(leaverPage.getByLabel("Username", { exact: true })).toBeVisible();
    const signInTab = leaverPage.getByRole("tab", { name: "Sign in", exact: true }).first();
    if (await signInTab.isVisible().catch(() => false)) await signInTab.click();
    await leaverPage.getByLabel("Username", { exact: true }).fill("frank");
    await leaverPage.getByLabel("Password", { exact: true }).fill("password123");
    await leaverPage.getByRole("button", { name: "Sign in", exact: true }).last().click();
    await leaverPage.waitForTimeout(1000);
    await expect(leaverPage.locator("textarea")).toHaveCount(0);
    await expect(leaverPage.getByLabel("Username", { exact: true })).toBeVisible();
  } finally {
    await ownerContext.close().catch(() => {});
    await leaverContext.close().catch(() => {});
  }
});

test("an admin who never copied a bot token can replace it, and the old one stops working", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  try {
    await signIn(page, "alice");
    await page.getByRole("button", { name: /, workspace menu$/ }).click();
    await page.getByRole("menuitem", { name: "Apps and integrations", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Apps and integrations" });
    await dialog.getByPlaceholder("App name, e.g. Deploy Bot").fill("Rotation Demo");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    const app = dialog.locator("li").filter({ hasText: "Rotation Demo" }).first();
    const tokenRow = app
      .locator("div")
      .filter({ hasText: /^Bot token · shown once/ })
      .first();
    const firstToken = (await tokenRow.locator("code").textContent())!;
    expect(firstToken.startsWith("xoxb-")).toBe(true);
    // An app's own forms work before anything is typed, and say what is missing.
    const events = app.getByRole("group", { name: "Event subscriptions" });
    await events.getByRole("button", { name: "Subscribe", exact: true }).click();
    const eventsUrl = events.getByLabel("Request URL", { exact: true });
    await expect(eventsUrl).toBeFocused();
    await expect(eventsUrl).toHaveAccessibleDescription("Give the address that receives events.");

    // Closing the dialog is how a token shown once gets lost.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: /, workspace menu$/ }).click();
    await page.getByRole("menuitem", { name: "Apps and integrations", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Apps and integrations" });
    const reopened = dialog.locator("li").filter({ hasText: "Rotation Demo" }).first();
    await expect(reopened.getByText(/Bot token · shown once/)).toHaveCount(0);

    await reopened.getByRole("button", { name: "New bot token", exact: true }).click();
    const replace = page.getByRole("dialog", {
      name: "Replace Rotation Demo's bot token?",
    });
    await expect(replace).toContainText("The current token stops working immediately.");
    await replace.getByRole("button", { name: "Replace", exact: true }).click();
    const newRow = reopened
      .locator("div")
      .filter({ hasText: /^Bot token · shown once/ })
      .first();
    await expect(newRow).toBeVisible();
    const secondToken = (await newRow.locator("code").textContent())!;
    expect(secondToken.startsWith("xoxb-")).toBe(true);
    expect(secondToken).not.toBe(firstToken);

    const tryToken = async (token: string) =>
      (
        await (
          await fetch(`${base}/api/chat.postMessage`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ channel: "nowhere", text: "hello" }),
          })
        ).json()
      ).error;
    expect(await tryToken(firstToken)).toBe("invalid_auth");
    // Past authentication: refused for the channel, not for who is asking.
    expect(await tryToken(secondToken)).not.toBe("invalid_auth");
  } finally {
    await context.close().catch(() => {});
  }
});

test("Apps starts from templates: a webhook posts a test message, and the copied command service answers (UX-63)", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const folder = mkdtempSync(join(tmpdir(), "tandem-command-example-"));
  let service: ChildProcess | undefined;
  try {
    await signIn(page, "alice");
    await page.getByRole("button", { name: /, workspace menu$/ }).click();
    await page.getByRole("menuitem", { name: "Apps and integrations", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Apps and integrations" });
    const notes = dialog.locator("details", { hasText: "How this differs from Slack" });
    const notesOpen = () => notes.evaluate((element) => (element as HTMLDetailsElement).open);

    // A test message in two clicks, with the notes on Slack never opened.
    const hooks = dialog.getByRole("tabpanel", { name: "Incoming webhook" });
    await hooks.getByRole("button", { name: "Create webhook", exact: true }).click();
    const curl = hooks.locator("pre code");
    await expect(curl).toContainText(`curl -X POST '${base}/hooks/`);
    await hooks.getByRole("button", { name: "Send test message", exact: true }).click();
    await expect(hooks.getByRole("status")).toHaveText("Posted to #general.");
    expect(await notesOpen()).toBe(false);
    // The URL in the example is one any other tool can post to.
    const hookUrl = /'(http\S+\/hooks\/\S+)'/.exec((await curl.textContent()) ?? "")?.[1];
    const fromTool = await fetch(hookUrl!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Posted with the copied URL" }),
    });
    expect(fromTool.status).toBe(200);

    // A slash command, answered by the example service copied from the dialog.
    await dialog.getByRole("tab", { name: "Slash command", exact: true }).click();
    const commands = dialog.getByRole("tabpanel", { name: "Slash command" });
    await commands.getByLabel("Post as", { exact: true }).selectOption({ label: "A new app" });
    await expect(commands.getByLabel("New app name", { exact: true })).toHaveValue("Deploy Bot");
    const port = await freePort();
    await commands.getByLabel("Request URL", { exact: true }).fill(`http://127.0.0.1:${port}/`);
    await commands.getByRole("button", { name: "Add command", exact: true }).click();
    const example = commands.locator("figure", { hasText: "Example service in Node.js" });
    // Once the app exists its signing secret is in the example: dotted out on
    // screen, and copied whole.
    await expect(example.locator("code")).toContainText('const signingSecret = "••••');
    await example.getByRole("button", { name: "Copy", exact: true }).click();
    const code = await page.evaluate(() => navigator.clipboard.readText());
    expect(code).toMatch(/const signingSecret = "[0-9a-f]{48}";/);
    const file = join(folder, "deploy.mjs");
    writeFileSync(file, code);
    service = spawn(process.execPath, [file], {
      ...UNREAD,
      env: { ...process.env, PORT: String(port) },
    });
    // Up, and refusing what the workspace did not sign.
    await expect
      .poll(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/`, { method: "POST" })).status;
        } catch {
          return 0;
        }
      })
      .toBe(401);

    await commands.getByRole("button", { name: "Send test command", exact: true }).click();
    await expect(commands.getByRole("status")).toHaveText(
      "Your service answered /deploy test. Its reply, if it sent one, is in #general.",
    );
    expect(await notesOpen()).toBe(false);

    // Both posts are in #general, and the service's private answer too.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Message #general", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Hello from a webhook", { exact: true })).toBeVisible();
    await expect(page.getByText("Posted with the copied URL", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Got \/deploy test from @?alice/)).toBeVisible();
  } finally {
    service?.kill();
    await context.close().catch(() => {});
    rmSync(folder, { recursive: true, force: true });
  }
});

test("an invite code that got out can be revoked from the dialog that made it", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  try {
    await signIn(page, "alice");

    await page.getByRole("button", { name: /, workspace menu$/ }).click();
    await page.getByRole("menuitem", { name: "Invite people", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Invite people" });
    // It opens with a link ready to copy (UX-43); the code is the link's last part.
    const link = dialog.locator("code").filter({ hasText: "/#/join/" });
    await expect(link).toBeVisible();
    const code = (await link.textContent())!.trim().split("/#/join/")[1]!;
    expect(code.length).toBeGreaterThan(4);

    // The new code is listed with the others, and usable.
    const codes = dialog.getByRole("list", { name: "Invite codes" });
    const row = codes.locator("li").filter({ hasText: code });
    await expect(row.getByText("Active", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: `Revoke invite ${code}`, exact: true }).click();
    const revoke = page.getByRole("dialog", { name: "Revoke this invite?" });
    await expect(revoke).toContainText(
      "Anyone who has not used it yet will not be able to join with it.",
    );
    await revoke.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(row.getByText("Revoked", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: `Revoke invite ${code}` })).toHaveCount(0);

    // And the server agrees, rather than only the list.
    const token = await savedToken(page);
    const { invites } = await (
      await fetch(`${base}/api/invites`, { headers: { authorization: `Bearer ${token}` } })
    ).json();
    expect(invites.find((i: { code: string }) => i.code === code).status).toBe("revoked");
  } finally {
    await context.close().catch(() => {});
  }
});

test("an invite link lets someone into an invite-only workspace from a browser, and a message link opens its message", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // A workspace of its own, invite-only, so the code the link carries is what
  // lets the new person in.
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const inviteData = mkdtempSync(join(tmpdir(), "slackoss-e2e-invite-"));
  const inviteServer = spawn(
    process.execPath,
    [
      "apps/server-cli/dist/slackoss-server.js",
      "--data",
      inviteData,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-mdns",
      "--name",
      "Rocket Team",
      "--invite-only",
      "--no-rate-limits",
    ],
    UNREAD,
  );
  const contexts: BrowserContext[] = [];
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(`${origin}/api/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);

    // The owner, created from this machine, which needs no claim code.
    const registered = await (
      await fetch(`${origin}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "hana", displayName: "Hana", password: "password123" }),
      })
    ).json();
    const auth = {
      authorization: `Bearer ${registered.token}`,
      "content-type": "application/json",
    };
    const { channels } = await (await fetch(`${origin}/api/channels`, { headers: auth })).json();
    const general = channels.find((c: { name: string }) => c.name === "general");
    const post = async (text: string) => {
      const response = await fetch(`${origin}/api/channels/${general.id}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text }),
      });
      expect(response.status).toBe(201);
      return (await response.json()).message as { id: string };
    };
    // A message far enough back that opening it means going to find it.
    const plan = await post("The launch plan lives in the design doc");
    for (let i = 0; i < 80; i++) await post(`standup note ${i}`);
    const latest = await post("Latest update before the invite");
    const messageLink = (id: string) => `${origin}/#/c/${general.id}/m/${id}`;

    const host = await browser.newContext({
      viewport: { width: 1280, height: 820 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    contexts.push(host);
    const hostPage = await host.newPage();
    await hostPage.goto(origin);
    await hostPage.evaluate(
      (server) => localStorage.setItem("slackoss:servers", JSON.stringify([server])),
      {
        url: origin,
        token: registered.token,
        workspaceName: "Rocket Team",
        handle: "hana",
        lastUsedAt: Date.now(),
      },
    );
    await hostPage.reload();
    await expect(
      hostPage.getByText("Latest update before the invite", { exact: true }),
    ).toBeVisible();

    // The link is a browser's, built on the address this browser uses. That
    // address is this computer's own, and the dialog says so.
    await hostPage.getByRole("button", { name: /, workspace menu$/ }).click();
    await hostPage.getByRole("menuitem", { name: "Invite people", exact: true }).click();
    const dialog = hostPage.getByRole("dialog", { name: "Invite people" });
    const link = dialog.locator("code").filter({ hasText: "/#/join/" });
    await expect(link).toBeVisible();
    const code = (await link.textContent())!.trim().split("/#/join/")[1]!;
    const inviteLink = `${origin}/#/join/${code}`;
    await expect(dialog.getByText(inviteLink, { exact: true })).toBeVisible();
    await expect(
      dialog.getByText(`tandem://join?host=127.0.0.1:${port}&code=${code}`, { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText(/reaches only this computer/)).toBeVisible();
    await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
    expect(await hostPage.evaluate(() => navigator.clipboard.readText())).toBe(inviteLink);

    // A browser gives no Clipboard API to a page served over plain http from
    // another computer, which is how a workspace on a network is usually
    // reached. Copying still works there, from inside the dialog too.
    await hostPage.evaluate(() => {
      const api = Object.getOwnPropertyDescriptor(Clipboard.prototype, "writeText")!;
      Object.defineProperty(Clipboard.prototype, "writeText", { ...api, value: undefined });
      (window as unknown as { restoreClipboard: () => void }).restoreClipboard = () =>
        Object.defineProperty(Clipboard.prototype, "writeText", api);
    });
    await dialog.getByRole("button", { name: "Copy desktop link", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    expect(await hostPage.evaluate(() => navigator.clipboard.readText())).toBe(
      `tandem://join?host=127.0.0.1:${port}&code=${code}`,
    );
    await hostPage.evaluate(() =>
      (window as unknown as { restoreClipboard: () => void }).restoreClipboard(),
    );
    await hostPage.keyboard.press("Escape");

    // Someone who has never been here opens it: the account form, code filled in.
    const guest = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    contexts.push(guest);
    const guestPage = await guest.newPage();
    await guestPage.goto(inviteLink);
    await expect(guestPage.getByRole("heading", { name: "Rocket Team" })).toBeVisible();
    await expect(guestPage.getByLabel("Invite code", { exact: true })).toHaveValue(code);
    // Read once, and gone from the address, so a reload or the history does not hold it.
    await expect(guestPage).toHaveURL(`${origin}/`);
    await guestPage.getByLabel("Username", { exact: true }).fill("ivy");
    await guestPage.getByLabel("Display name", { exact: true }).fill("Ivy");
    await guestPage.getByLabel("Password", { exact: true }).fill("password123");
    await guestPage.getByRole("button", { name: "Join workspace", exact: true }).click();
    await expect(guestPage.locator("textarea")).toBeVisible();
    await expect(
      guestPage.getByText("Latest update before the invite", { exact: true }),
    ).toBeVisible();

    // Copying a message's link gives the browser form of it.
    const latestRow = hostPage.locator(`[data-mid="${latest.id}"]`);
    await latestRow.hover();
    await latestRow.getByRole("button", { name: "More actions", exact: true }).click();
    await hostPage.getByRole("menuitem", { name: "Copy link to message", exact: true }).click();
    expect(await hostPage.evaluate(() => navigator.clipboard.readText())).toBe(
      messageLink(latest.id),
    );

    // Pasted into the address bar of the page already open, a message link
    // goes to the message, however far back it is.
    const planText = guestPage.getByText("The launch plan lives in the design doc", {
      exact: true,
    });
    await expect(planText).toHaveCount(0);
    await guestPage.goto(messageLink(plan.id));
    await expect(planText).toBeInViewport();
    // The link is taken out of the address, which names the conversation instead.
    await expect(guestPage).toHaveURL(`${origin}/#/c/${general.id}`);

    // Opened by someone signed out, it waits for them to sign in.
    const later = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    contexts.push(later);
    const laterPage = await later.newPage();
    await laterPage.goto(messageLink(plan.id));
    await laterPage.getByLabel("Username", { exact: true }).fill("ivy");
    await laterPage.getByLabel("Password", { exact: true }).fill("password123");
    await laterPage.getByLabel("Password", { exact: true }).press("Enter");
    await expect(
      laterPage.getByText("The launch plan lives in the design doc", { exact: true }),
    ).toBeInViewport();

    // A link to a message, sent in a message, opens it in place rather than
    // in another tab of the app.
    const planForHost = hostPage.getByText("The launch plan lives in the design doc", {
      exact: true,
    });
    await expect(planForHost).toHaveCount(0);
    await post(`${messageLink(plan.id)} is where the plan is`);
    const sent = hostPage.getByRole("link", { name: messageLink(plan.id), exact: true });
    await expect(sent).toBeInViewport({ ratio: 1 });
    const pagesBefore = host.pages().length;
    // At the start of the link: hovering the message raises its toolbar over
    // the far end of a line this long.
    await sent.click({ position: { x: 6, y: 6 } });
    await expect(planForHost).toBeInViewport();
    expect(host.pages()).toHaveLength(pagesBefore);
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    if (inviteServer.exitCode === null) {
      const exited = new Promise((resolve) => inviteServer.once("exit", resolve));
      inviteServer.kill();
      await exited;
    }
    rmSync(inviteData, { recursive: true, force: true });
  }
});

test("notifications are offered after sign-in, and one opens its message", async ({ browser }) => {
  const aliceCtx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  // A stand-in for the browser's Notification: permission starts undecided,
  // every showing is recorded, and clicks run like the real thing.
  await aliceCtx.addInitScript(() => {
    const instances: Array<{
      title: string;
      onclick: ((event: Event) => void) | null;
      close: () => void;
      closed: boolean;
    }> = [];
    let focusCalls = 0;
    const focus = window.focus.bind(window);
    window.focus = () => {
      focusCalls++;
      focus();
    };
    class FakeNotification {
      static permission = "default";
      static instances = instances;
      static focusCalls = () => focusCalls;
      static async requestPermission() {
        FakeNotification.permission = "granted";
        return "granted" as NotificationPermission;
      }
      onclick: ((event: Event) => void) | null = null;
      closed = false;
      title: string;
      constructor(title: string, options?: { body?: string }) {
        this.title = title;
        instances.push(this as unknown as (typeof instances)[number]);
        void options;
      }
      close() {
        this.closed = true;
      }
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
  });
  const bobCtx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  try {
    const alicePage = await aliceCtx.newPage();
    await signIn(alicePage, "alice");

    // The ask comes after signing in, not on the first click anywhere.
    const banner = alicePage.getByRole("region", { name: "Notifications" });
    await expect(banner).toBeVisible();
    await alicePage.getByRole("button", { name: "Turn on", exact: true }).click();
    await expect(banner).toHaveCount(0);

    // A DM from someone else notifies even while this page is in front:
    // nothing has to steal its focus first.
    const bobPage = await bobCtx.newPage();
    await signIn(bobPage, "bobby");
    const token = await savedToken(bobPage);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const { users } = await (await fetch(`${base}/api/users`, { headers: auth })).json();
    const alice = users.find((u: { handle: string }) => u.handle === "alice");
    const dm = await (
      await fetch(`${base}/api/channels`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ type: "dm", memberIds: [alice.id] }),
      })
    ).json();
    const posted = await (
      await fetch(`${base}/api/channels/${dm.channel.id}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text: "browser notification check" }),
      })
    ).json();
    const messageId = posted.message.id as string;
    await alicePage.waitForFunction(() => {
      const notes = (window.Notification as unknown as { instances: unknown[] }).instances;
      return notes.length > 0;
    });

    // Clicking it focuses the app and jumps to the message, highlighted.
    await alicePage.evaluate(() => {
      const notes = (
        window.Notification as unknown as {
          instances: Array<{ onclick: ((event: Event) => void) | null }>;
        }
      ).instances;
      notes[0]!.onclick!(new Event("click"));
    });
    await alicePage.waitForFunction(
      (id: string) => {
        const row = document.querySelector(`[data-mid="${CSS.escape(id)}"]`);
        if (!row) return false;
        for (const el of row.querySelectorAll("*")) {
          if (el.classList.contains("bg-copper/15")) return true;
        }
        return false;
      },
      messageId,
      { timeout: 10_000 },
    );
    const focusCalls = await alicePage.evaluate(() =>
      (window.Notification as unknown as { focusCalls: () => number }).focusCalls(),
    );
    expect(focusCalls).toBeGreaterThan(0);
  } finally {
    await aliceCtx.close().catch(() => {});
    await bobCtx.close().catch(() => {});
  }
});

test("the demo seed fills a new workspace with something to try, and leaves one in use alone", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  // A workspace of its own, invite-only and with the usual limits, so the seed
  // has to let its people in with a code and stay inside the rationing.
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const demoData = mkdtempSync(join(tmpdir(), "slackoss-e2e-demo-"));
  const demoServer = spawn(
    process.execPath,
    [
      "apps/server-cli/dist/slackoss-server.js",
      "--data",
      demoData,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-mdns",
      "--name",
      "Demo Team",
      "--invite-only",
    ],
    UNREAD,
  );
  const seed = () =>
    new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["scripts/seed-demo.mjs", origin, "--password", "password123"],
        { windowsHide: true, stdio: "pipe" },
      );
      let output = "";
      child.stdout!.on("data", (chunk) => (output += String(chunk)));
      child.stderr!.on("data", (chunk) => (output += String(chunk)));
      child.once("exit", (code) => resolve({ code, output }));
    });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(`${origin}/api/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);

    const first = await seed();
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain("They all use the password password123");
    // A second run would be adding strangers to a workspace people now use.
    const again = await seed();
    expect(again.code, again.output).toBe(1);
    expect(again.output).toContain("Demo Team already has 4 accounts");

    const page = await context.newPage();
    await page.goto(origin);
    await page.getByRole("tab", { name: "Sign in", exact: true }).click();
    await page.getByLabel("Username", { exact: true }).fill("maya");
    await page.getByLabel("Password", { exact: true }).fill("password123");
    await page.getByLabel("Password", { exact: true }).press("Enter");
    const sidebar = page.getByRole("navigation");
    await expect(page.getByText(/^Welcome to Tandem, everyone!/)).toBeVisible();
    // Read as who reacted, not only as an emoji and a number.
    await expect(page.getByRole("button", { name: /^🎉 3 reactions, from .+/ })).toBeVisible();

    // The image arrived whole, with its thread beside it.
    await sidebar.getByRole("button", { name: /^#\s*design\b/ }).click();
    const mockup = page.getByRole("img", { name: "sign-in-mockup.png", exact: true });
    await expect(mockup).toBeVisible();
    await expect
      .poll(() => mockup.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(640);
    await page.getByRole("button", { name: /^3 replies/ }).click();
    const thread = page.getByRole("complementary", { name: "Thread" });
    await expect(
      thread.getByText("Could the button be a little bigger?", { exact: false }),
    ).toBeVisible();

    // The checklist is pinned, and its code block is drawn as one.
    await sidebar.getByRole("button", { name: /^#\s*engineering\b/ }).click();
    await expect(page.getByText("Pinned to this channel", { exact: true })).toBeVisible();
    await expect(
      page.locator("code").filter({ hasText: "[ ] Smoke test on a clean machine" }),
    ).toBeVisible();
    await expect(page.getByText("@Maya Chen", { exact: true })).toBeVisible();

    // And a direct message is waiting for her.
    await sidebar.getByRole("button", { name: /Sam Rivera/ }).click();
    await expect(
      page.getByText("Morning! Could you look over the release checklist before Thursday?", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await context.close().catch(() => {});
    if (demoServer.exitCode === null) {
      const exited = new Promise((resolve) => demoServer.once("exit", resolve));
      demoServer.kill();
      await exited;
    }
    rmSync(demoData, { recursive: true, force: true });
  }
});

test("Back, Forward and a reload return to the conversation, thread and panel someone was in", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const port = 18546;
  const origin = `http://127.0.0.1:${port}`;
  const routeData = mkdtempSync(join(tmpdir(), "slackoss-e2e-routes-"));
  const routeServer = spawn(
    process.execPath,
    [
      "apps/server-cli/dist/slackoss-server.js",
      "--data",
      routeData,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-mdns",
      "--name",
      "Route Team",
      "--no-rate-limits",
    ],
    UNREAD,
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(`${origin}/api/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    const account = async (handle: string) =>
      (
        await (
          await fetch(`${origin}/api/auth/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
          })
        ).json()
      ).token as string;
    const as = (token: string) => ({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    });
    const owner = await account("hana");
    const other = await account("omar");
    const call = async (token: string, path: string, body: unknown) =>
      (
        await fetch(`${origin}${path}`, {
          method: "POST",
          headers: as(token),
          body: JSON.stringify(body),
        })
      ).json();
    const { channels } = await (
      await fetch(`${origin}/api/channels`, { headers: as(owner) })
    ).json();
    const general = channels.find((c: { name: string }) => c.name === "general");
    const { channel: design } = await call(owner, "/api/channels", {
      type: "public",
      name: "design",
    });
    // Private to omar, so hana has no way in.
    const { channel: leads } = await call(other, "/api/channels", {
      type: "private",
      name: "leads",
    });
    const { message: root } = await call(owner, `/api/channels/${design.id}/messages`, {
      text: "Which icon set are we using?",
    });
    await call(owner, `/api/channels/${design.id}/messages`, {
      text: "The line set, I think",
      threadRootId: root.id,
    });

    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(
      (server) => localStorage.setItem("slackoss:servers", JSON.stringify([server])),
      { url: origin, token: owner, workspaceName: "Route Team", handle: "hana", lastUsedAt: 1 },
    );
    await page.reload();
    await expect(page.locator("textarea")).toBeVisible();
    // Arriving names where the app landed, without adding a step to go Back through.
    await expect(page).toHaveURL(`${origin}/#/c/${general.id}`);

    // The owner gets a short list of first steps. #design and omar already
    // exist, so two are done; put away, it stays away after a reload.
    const gettingStarted = page.getByRole("region", { name: "Getting started" });
    await expect(gettingStarted).toContainText("2 of 4 left");
    await expect(gettingStarted.getByText("Create a channel", { exact: false })).toContainText(
      "done",
    );
    await gettingStarted.getByRole("button", { name: "Hide", exact: true }).click();
    await expect(gettingStarted).toHaveCount(0);
    await page.reload();
    await expect(page.locator("textarea")).toBeVisible();
    await expect(gettingStarted).toHaveCount(0);

    const nav = page.getByRole("navigation", { name: "Workspace navigation" });
    const thread = page.getByRole("complementary", { name: "Thread", exact: true });
    const reply = thread.getByRole("textbox", { name: "Reply…", exact: true });
    await nav.getByRole("button", { name: /^#\s*design\b/ }).click();
    await expect(page).toHaveURL(`${origin}/#/c/${design.id}`);
    const rootRow = page.locator(`[data-mid="${root.id}"]`);
    await rootRow.hover();
    await rootRow.getByRole("button", { name: "Reply in thread", exact: true }).click();
    await expect(thread).toBeVisible();
    await expect(page).toHaveURL(`${origin}/#/c/${design.id}/t/${root.id}`);
    await reply.fill("Half a reply, not sent yet");

    await nav.getByRole("button", { name: /^#\s*general\b/ }).click();
    await expect(thread).toHaveCount(0);
    await expect(page).toHaveURL(`${origin}/#/c/${general.id}`);

    // Back reopens the thread, with the unsent reply still in it.
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/#/c/${design.id}/t/${root.id}`);
    await expect(thread.getByText("The line set, I think", { exact: true })).toBeVisible();
    await expect(reply).toHaveValue("Half a reply, not sent yet");
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/#/c/${design.id}`);
    await expect(thread).toHaveCount(0);
    await expect(page.locator(".channel-header h2")).toHaveText("#design");
    await page.goForward();
    await expect(thread).toBeVisible();

    // A reload keeps the conversation, the thread and the draft.
    await page.reload();
    await expect(page.locator(".channel-header h2")).toHaveText("#design");
    await expect(thread.getByText("The line set, I think", { exact: true })).toBeVisible();
    await expect(reply).toHaveValue("Half a reply, not sent yet");

    // A side panel is a place too: Back closes it, and a reload keeps it open.
    const saved = page.getByRole("complementary", { name: "Saved", exact: true });
    await nav.getByRole("button", { name: "Saved", exact: true }).click();
    await expect(saved).toBeVisible();
    await expect(thread).toHaveCount(0);
    await expect(page).toHaveURL(`${origin}/#/c/${design.id}/p/saved`);
    await page.goBack();
    await expect(saved).toHaveCount(0);
    await expect(thread).toBeVisible();
    await page.goForward();
    await expect(saved).toBeVisible();
    await page.reload();
    await expect(saved).toBeVisible();
    await expect(page.locator(".channel-header h2")).toHaveText("#design");

    // A settings dialog is a place too. Opening it adds a step, moving
    // between its sections rewrites that step, and closing it goes Back
    // through it, so Back afterwards does not open it again.
    const here = `${origin}/#/c/${design.id}/p/saved`;
    await expect(page).toHaveURL(here);
    const steps = await page.evaluate(() => history.length);
    await page.getByRole("button", { name: /, your account$/ }).click();
    await page.getByRole("menuitem", { name: "Account settings" }).click();
    const settings = page.getByRole("dialog", { name: "Account settings" });
    await expect(settings).toBeVisible();
    await expect(page).toHaveURL(`${here}/d/account`);
    await settings.getByRole("tab", { name: "Security" }).click();
    await expect(page).toHaveURL(`${here}/d/account/security`);
    // A setting found by searching takes the address to its section the same way (UX-60).
    await settings.getByRole("searchbox", { name: "Search settings" }).fill("dark mode");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${here}/d/account/appearance`);
    await expect(settings.getByRole("radio", { name: /^Match this device/ })).toBeFocused();
    expect(await page.evaluate(() => history.length)).toBe(steps + 1);
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(page).toHaveURL(here);
    await expect(saved).toBeVisible();
    // Back from here leaves the Saved panel, as it did before the dialog.
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/#/c/${design.id}/t/${root.id}`);
    await page.goForward();
    await expect(page).toHaveURL(here);

    // An address can name a dialog and its section, and a reload keeps it.
    await page.goto(`${origin}/#/c/${design.id}/d/account/devices`);
    await expect(settings.getByRole("tab", { name: "Devices" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.reload();
    await expect(settings.getByRole("tab", { name: "Devices" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(settings.getByRole("region", { name: "Signed-in devices" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(page).toHaveURL(`${origin}/#/c/${design.id}`);

    // People is for administrators, whatever the address says.
    // A context of its own, so the owner's saved sign-in stays as it was.
    const memberContext = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const member = await memberContext.newPage();
    await member.goto(origin);
    await member.evaluate(
      (server) => localStorage.setItem("slackoss:servers", JSON.stringify([server])),
      { url: origin, token: other, workspaceName: "Route Team", handle: "omar", lastUsedAt: 2 },
    );
    await member.goto(`${origin}/#/c/${general.id}/d/people`);
    await member.reload();
    await expect(member.locator("textarea")).toBeVisible();
    await expect(member).toHaveURL(`${origin}/#/c/${general.id}`);
    await expect(member.getByRole("dialog", { name: "People" })).toHaveCount(0);
    await memberContext.close();

    // Opened again with nothing in the address, the app goes back to the
    // conversation this account last had open, not to #general.
    const again = await context.newPage();
    await again.goto(origin);
    await expect(again.locator(".channel-header h2")).toHaveText("#design");
    await expect(again).toHaveURL(`${origin}/#/c/${design.id}`);
    // Back leaves the app rather than stopping in #general on the way.
    await again.goBack();
    await expect(again).toHaveURL("about:blank");
    await again.close();
    // Once that conversation is archived, the next start lands in #general.
    await fetch(`${origin}/api/channels/${design.id}`, {
      method: "PATCH",
      headers: as(owner),
      body: JSON.stringify({ archived: true }),
    });
    const later = await context.newPage();
    await later.goto(origin);
    await expect(later.locator(".channel-header h2")).toHaveText("#general");
    await later.close();
    await fetch(`${origin}/api/channels/${design.id}`, {
      method: "PATCH",
      headers: as(owner),
      body: JSON.stringify({ archived: false }),
    });

    // An address for a conversation this account cannot see says so, lands in
    // #general, and does not leave that address in the history to go Back to.
    await page.goto(`${origin}/#/c/${leads.id}`);
    await expect(page.getByRole("alert")).toContainText("That conversation is not available");
    await expect(page).toHaveURL(`${origin}/#/c/${general.id}`);
    await expect(page.locator(".channel-header h2")).toHaveText("#general");
    // Back returns to where the dialog steps above left off.
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/#/c/${design.id}`);

    // A theme chosen in Account settings recolours the page at once, and a
    // reload keeps it.
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // Nothing chosen yet follows the device, which is light here: White's
    // page colour, then Onyx's graphite.
    expect(await background()).toBe("rgb(233, 234, 238)");
    await page.goto(`${origin}/#/c/${design.id}/d/account/appearance`);
    const appearance = page.getByRole("tabpanel", { name: "Appearance" });
    await appearance.getByRole("radio", { name: /^Onyx/ }).check();
    await expect.poll(background).toBe("rgb(18, 18, 20)");
    await page.reload();
    await expect(page.locator("textarea")).toBeVisible();
    await expect.poll(background).toBe("rgb(18, 18, 20)");
    await appearance.getByRole("radio", { name: /^White/ }).check();
    await expect.poll(background).toBe("rgb(233, 234, 238)");
    await appearance.getByRole("radio", { name: /^Match this device/ }).check();
    await expect.poll(background).toBe("rgb(233, 234, 238)");
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(`${origin}/#/c/${design.id}`);

    // Back, Forward and a reload return to where a conversation was being
    // read, not just to the conversation.
    for (let i = 1; i <= 80; i++) {
      await call(owner, `/api/channels/${general.id}/messages`, { text: `Line ${i} of the log` });
    }
    const timeline = page.locator('[aria-label="Message history"]');
    /** The message at the top of the view, and how far above the top its row starts. */
    const topOfView = () =>
      timeline.evaluate((el) => {
        for (const row of el.querySelectorAll<HTMLElement>("[data-mid]")) {
          if (row.offsetTop + row.offsetHeight > el.scrollTop)
            return { id: row.dataset.mid!, offset: Math.round(row.offsetTop - el.scrollTop) };
        }
        return null;
      });
    await nav.getByRole("button", { name: /^#\s*general\b/ }).click();
    await expect(page.getByText("Line 80 of the log", { exact: true })).toBeInViewport();
    await timeline.evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2;
    });
    await expect(page.getByText("Line 80 of the log", { exact: true })).not.toBeInViewport();
    const reading = await topOfView();
    expect(reading).not.toBeNull();
    // Noted as it scrolls, a moment later.
    await expect
      .poll(() => page.evaluate(() => history.state?.tandem?.scroll?.messageId))
      .toBe(reading!.id);

    await nav.getByRole("button", { name: /^#\s*design\b/ }).click();
    await expect(page.locator(".channel-header h2")).toHaveText("#design");
    await page.goBack();
    await expect(page.locator(".channel-header h2")).toHaveText("#general");
    await expect.poll(topOfView).toEqual(reading);
    await page.reload();
    await expect(page.locator(".channel-header h2")).toHaveText("#general");
    await expect.poll(topOfView).toEqual(reading);
    // Opening it afresh from the sidebar starts at the newest message.
    await nav.getByRole("button", { name: /^#\s*design\b/ }).click();
    await nav.getByRole("button", { name: /^#\s*general\b/ }).click();
    await expect(page.getByText("Line 80 of the log", { exact: true })).toBeInViewport();
  } finally {
    await context.close().catch(() => {});
    if (routeServer.exitCode === null) {
      const exited = new Promise((resolve) => routeServer.once("exit", resolve));
      routeServer.kill();
      await exited;
    }
    rmSync(routeData, { recursive: true, force: true });
  }
});

test("on a touchscreen each message offers its actions in a menu, and any emoji as a reaction", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const port = 18547;
  const origin = `http://127.0.0.1:${port}`;
  const touchData = mkdtempSync(join(tmpdir(), "slackoss-e2e-touch-"));
  const touchServer = spawn(
    process.execPath,
    [
      "apps/server-cli/dist/slackoss-server.js",
      "--data",
      touchData,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-mdns",
      "--name",
      "Touch Team",
      "--no-rate-limits",
    ],
    UNREAD,
  );
  // A phone: no hover, and taps rather than a pointer.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(`${origin}/api/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    const { token } = await (
      await fetch(`${origin}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "hana", displayName: "Hana", password: "password123" }),
      })
    ).json();
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const { channels } = await (await fetch(`${origin}/api/channels`, { headers: auth })).json();
    const general = channels.find((c: { name: string }) => c.name === "general");
    const { message } = await (
      await fetch(`${origin}/api/channels/${general.id}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text: "Launch is on Friday" }),
      })
    ).json();

    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(
      (server) => localStorage.setItem("slackoss:servers", JSON.stringify([server])),
      { url: origin, token, workspaceName: "Touch Team", handle: "hana", lastUsedAt: 1 },
    );
    await page.reload();
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    const row = page.locator(`[data-mid="${message.id}"]`);
    await expect(row).toBeVisible();

    // A tap on the message no longer raises the hover toolbar over the one above.
    await row.getByText("Launch is on Friday", { exact: true }).tap();
    await expect(row.getByRole("button", { name: "Reply in thread", exact: true })).toBeHidden();
    const more = row.getByRole("button", { name: "Actions for message from Hana", exact: true });
    await expect(more).toBeVisible();
    const box = (await more.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(36);
    expect(box.height).toBeGreaterThanOrEqual(36);
    // The text keeps clear of the button.
    const text = (await row.getByText("Launch is on Friday", { exact: true }).boundingBox())!;
    expect(text.x + text.width).toBeLessThanOrEqual(box.x);

    await more.tap();
    const menu = page.getByRole("menu", { name: "Actions for message from Hana" });
    await expect(menu).toBeVisible();
    await expectInsideViewport(page, menu);
    await page.screenshot({ path: test.info().outputPath("touch-menu.png") });
    await menu.getByRole("menuitem", { name: "Add a reaction…", exact: true }).tap();
    const picker = page.getByRole("dialog", { name: "Add a reaction" });
    await expect(picker).toBeVisible();
    // Opening the picker does not raise the keyboard over the emoji.
    await expect(picker.getByRole("combobox", { name: "Search emoji" })).not.toBeFocused();
    // 🎉 is in the first row, Frequently used, before anyone has picked anything.
    await picker.getByRole("option", { name: "Party Popper", exact: true }).first().tap();
    await expect(picker).toHaveCount(0);
    await expect(row.getByRole("button", { name: /🎉\s*1/ })).toBeVisible();

    // Holding the message opens the same actions as a sheet along the bottom,
    // with a row of reactions a thumb reaches in one more tap.
    await row.getByText("Launch is on Friday", { exact: true }).evaluate(async (text) => {
      const at = text.getBoundingClientRect();
      const touch = new Touch({
        identifier: 1,
        target: text,
        clientX: at.left + 4,
        clientY: at.top + 4,
      });
      text.dispatchEvent(
        new TouchEvent("touchstart", { bubbles: true, touches: [touch], changedTouches: [touch] }),
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      text.dispatchEvent(
        new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [touch] }),
      );
    });
    await expect(menu).toBeVisible();
    await expectInsideViewport(page, menu);
    const sheet = (await menu.boundingBox())!;
    expect(sheet.y + sheet.height).toBeGreaterThan(844 - 120);
    await page.getByRole("button", { name: "React with 👍", exact: true }).tap();
    await expect(menu).toHaveCount(0);
    await expect(row.getByRole("button", { name: /👍\s*1/ })).toBeVisible();

    await more.tap();
    await menu.getByRole("menuitem", { name: "Reply in thread", exact: true }).tap();
    await expect(page.getByRole("complementary", { name: "Thread", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await context.close().catch(() => {});
    if (touchServer.exitCode === null) {
      const exited = new Promise((resolve) => touchServer.once("exit", resolve));
      touchServer.kill();
      await exited;
    }
    rmSync(touchData, { recursive: true, force: true });
  }
});

test("on a phone the bottom bar reaches Activity and a DM without the drawer, below the composer (UX-70)", async ({
  browser,
}) => {
  const login = async (handle: string) =>
    (await (
      await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle, password: "password123" }),
      })
    ).json()) as { token: string; user: { id: string } };
  const alice = await login("alice");
  const bobby = await login("bobby");
  const call = async (token: string, path: string, body: unknown) =>
    (
      await fetch(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();
  const { channels } = await (
    await fetch(`${base}/api/channels`, { headers: { authorization: `Bearer ${alice.token}` } })
  ).json();
  const general = channels.find((c: { name: string }) => c.name === "general");
  const { channel: design } = await call(alice.token, "/api/channels", {
    type: "public",
    name: "design",
  });
  // While Alice reads #design, Bobby writes to her directly and names her in #general.
  const { channel: dm } = await call(bobby.token, "/api/channels", {
    type: "dm",
    memberIds: [alice.user.id],
  });
  await call(bobby.token, `/api/channels/${dm.id}/messages`, { text: "Lunch at one?" });
  await call(bobby.token, `/api/channels/${general.id}/messages`, {
    text: `Can you look at the venue <@${alice.user.id}>`,
  });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage();
    await page.goto(base);
    await page.evaluate(
      (server) => localStorage.setItem("slackoss:servers", JSON.stringify([server])),
      {
        url: base,
        token: alice.token,
        workspaceName: "Product Test",
        handle: "alice",
        lastUsedAt: 1,
      },
    );
    await page.goto(`${base}/#/c/${design.id}`);
    await page.reload();
    await expect(page.locator("textarea")).toBeVisible();

    const bar = page.getByRole("navigation", { name: "Main navigation" });
    const item = (name: string) => bar.getByRole("button", { name, exact: true });
    const drawer = page.getByRole("navigation", { name: "Workspace navigation" });
    await expect(bar).toBeVisible();
    await expect(drawer).toBeHidden();
    // What waits elsewhere is on the bar, in words too.
    await expect(item("Activity")).toHaveAccessibleDescription("1 mention");
    await expect(item("DMs")).toHaveAccessibleDescription("1 unread conversation");
    await expect(item("Home")).toHaveAttribute("aria-current", "page");

    // The bar is under the composer, never over it, and each place is a
    // thumb's size.
    await atRest(page);
    const barBox = (await bar.boundingBox())!;
    const composerBox = (await page.locator("main .composer-shell").boundingBox())!;
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(barBox.y + 1);
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(844 + 1);
    for (const button of await bar.getByRole("button").all()) {
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }

    // Activity, without opening the drawer.
    await item("Activity").tap();
    const activity = page.getByRole("complementary", { name: "Activity", exact: true });
    await expect(activity.getByText(/Can you look at the venue/)).toBeVisible();
    await expect(item("Activity")).toHaveAttribute("aria-current", "page");
    await expect(drawer).toBeHidden();
    // It covers the conversation and stops above the bar, which stays in reach.
    await atRest(page);
    const activityBox = (await activity.boundingBox())!;
    expect(activityBox.y + activityBox.height).toBeLessThanOrEqual(barBox.y + 1);

    // The DMs, and from them the conversation with Bobby.
    await item("DMs").tap();
    const dms = page.getByRole("complementary", { name: "Direct messages", exact: true });
    await expect(page).toHaveURL(`${base}/#/c/${design.id}/p/dms`);
    await dms.getByRole("button", { name: /bobby/ }).tap();
    await expect(page).toHaveURL(`${base}/#/c/${dm.id}`);
    await expect(dms).toHaveCount(0);
    await expect(drawer).toBeHidden();
    await expect(item("Home")).toHaveAttribute("aria-current", "page");
    const lunch = page.getByRole("article").filter({ hasText: "Lunch at one?" });
    await expect(lunch).toBeInViewport({ ratio: 1 });
    // Read now, so it no longer waits.
    await expect(item("DMs")).not.toHaveAccessibleDescription(/./);
    // The last message is above the composer, and the composer above the bar.
    await atRest(page);
    const lunchBox = (await lunch.boundingBox())!;
    const dmComposer = (await page.locator("main .composer-shell").boundingBox())!;
    expect(lunchBox.y + lunchBox.height).toBeLessThanOrEqual(dmComposer.y + 1);
    expect(dmComposer.y + dmComposer.height).toBeLessThanOrEqual(barBox.y + 1);
    // Back is the DMs again.
    await page.goBack();
    await expect(page).toHaveURL(`${base}/#/c/${design.id}/p/dms`);
    await expect(item("DMs")).toHaveAttribute("aria-current", "page");

    // Home goes back to the conversation; from there it opens the drawer,
    // with every channel.
    await item("Home").tap();
    await expect(dms).toHaveCount(0);
    await item("Home").tap();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: /^#\s*general\b/ })).toBeVisible();
    await expectMainCovered(page);
    // Opening it puts focus on Jump to…; Escape from there closes it and
    // gives focus back to Home.
    await expect(drawer.getByRole("button", { name: /^Jump to…/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(item("Home")).toBeFocused();

    // A swipe in from the left edge opens it too.
    await page.locator("main").evaluate(async (main) => {
      const at = (x: number) =>
        new Touch({ identifier: 1, target: main, clientX: x, clientY: 400 });
      const send = (type: string, touch: Touch | null, last: Touch) =>
        main.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            touches: touch ? [touch] : [],
            changedTouches: [last],
          }),
        );
      send("touchstart", at(14), at(14));
      send("touchmove", at(50), at(50));
      send("touchmove", at(110), at(110));
      send("touchend", null, at(110));
    });
    await expect(drawer).toBeVisible();
  } finally {
    await context.close().catch(() => {});
  }
});

/**
 * Presses a key until `target` has focus, as somebody without a pointer would.
 * Fails rather than looping forever when the target is not reachable that way.
 */
async function pressUntilFocused(page: Page, key: string, target: Locator, limit = 40) {
  for (let presses = 0; presses < limit; presses++) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false))
      return;
    await page.keyboard.press(key);
  }
  await expect(target, `${key} never reached it`).toBeFocused({ timeout: 1 });
}

test("somebody with only a keyboard signs in, switches channel, replies, reacts, searches and opens settings", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const port = 18548;
  const origin = `http://127.0.0.1:${port}`;
  const keyboardData = mkdtempSync(join(tmpdir(), "slackoss-e2e-keyboard-"));
  const keyboardServer = spawn(
    process.execPath,
    [
      "apps/server-cli/dist/slackoss-server.js",
      "--data",
      keyboardData,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-mdns",
      "--name",
      "Keys Team",
      "--no-rate-limits",
    ],
    UNREAD,
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(`${origin}/api/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    const register = async (handle: string) =>
      (
        await (
          await fetch(`${origin}/api/auth/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
          })
        ).json()
      ).token as string;
    const owner = await register("hana");
    await register("kai");
    const call = async (path: string, body: unknown) =>
      (
        await fetch(`${origin}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json();
    const { channel: design } = await call("/api/channels", { type: "public", name: "design" });
    await call(`/api/channels/${design.id}/messages`, { text: "Which icon set are we using?" });
    await call(`/api/channels/${design.id}/messages`, { text: "The review is on Friday." });

    const page = await context.newPage();
    await page.goto(origin);

    // Sign in. The card puts the cursor in the first field.
    const username = page.getByLabel("Username", { exact: true });
    await expect(username).toBeFocused();
    await page.keyboard.type("kai");
    await pressUntilFocused(page, "Tab", page.getByLabel("Password", { exact: true }));
    await page.keyboard.type("password123");
    await page.keyboard.press("Enter");
    const composer = page.getByRole("textbox", { name: /^Message #/ });
    await expect(composer).toBeFocused();

    // Switch channel from the switcher.
    await page.keyboard.press("Control+k");
    await page.keyboard.type("design");
    await page.keyboard.press("Enter");
    await expect(page.locator(".channel-header h2")).toHaveText("#design");
    await expect(page.getByRole("textbox", { name: "Message #design" })).toBeFocused();

    // Reply in a thread. The list of messages is one Tab stop, the newest
    // message; the arrow keys move between messages, and Enter goes into one's
    // actions.
    const question = page.getByRole("article").filter({ hasText: "Which icon set are we using?" });
    const review = page.getByRole("article").filter({ hasText: "The review is on Friday." });
    await pressUntilFocused(page, "Shift+Tab", review);
    await expect(question).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("ArrowUp");
    await expect(question).toBeFocused();
    await expect(review).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("Enter");
    await expect(question.locator(".message-toolbar button").first()).toBeFocused();
    const replyButton = question.getByRole("button", { name: "Reply in thread", exact: true });
    await pressUntilFocused(page, "Tab", replyButton);
    await page.keyboard.press("Enter");
    const thread = page.getByRole("complementary", { name: "Thread", exact: true });
    await expect(thread.getByRole("textbox", { name: "Reply…" })).toBeFocused();
    await page.keyboard.type("The line set");
    await page.keyboard.press("Enter");
    // The composer keeps the words until the device has the send (GL-02).
    const threadReply = thread.getByRole("article").filter({ hasText: "The line set" });
    await expect(threadReply).toBeVisible();
    await expect(thread.getByRole("textbox", { name: "Reply…" })).toHaveValue("");
    // A thread is one Tab stop too, its newest reply, with the arrow keys up to the root.
    const threadRoot = thread.getByRole("article").filter({ hasText: "Which icon set" });
    await expect(threadReply).toHaveAttribute("tabindex", "0");
    await expect(threadRoot).toHaveAttribute("tabindex", "-1");
    await pressUntilFocused(page, "Shift+Tab", threadReply);
    await page.keyboard.press("ArrowUp");
    await expect(threadRoot).toBeFocused();
    // Closing the thread hands focus back to where it was opened from.
    await pressUntilFocused(
      page,
      "Shift+Tab",
      thread.getByRole("button", { name: "Close thread" }),
    );
    await page.keyboard.press("Enter");
    await expect(thread).toHaveCount(0);
    await expect(question).toBeFocused();

    // React, choosing the emoji by name.
    const addReaction = question.getByRole("button", { name: "Add a reaction", exact: true });
    await pressUntilFocused(page, "Tab", addReaction);
    await page.keyboard.press("Enter");
    const picker = page.getByRole("dialog", { name: "Add a reaction" });
    await expect(picker.getByRole("combobox", { name: "Search emoji" })).toBeFocused();
    await page.keyboard.type("rocket");
    await page.keyboard.press("Enter");
    await expect(picker).toHaveCount(0);
    await expect(question.getByRole("button", { name: /^🚀 1 reaction, from you$/ })).toBeVisible();

    // Search.
    await page.keyboard.press("Control+f");
    const search = page.getByRole("dialog", { name: "Search messages", exact: true });
    await expect(search.getByRole("textbox", { name: "Search messages" })).toBeFocused();
    await page.keyboard.type("icon set");
    await page.keyboard.press("Enter");
    await expect(search.getByText("Which icon set are we using?")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).toHaveCount(0);

    // Settings, from the menu on your own name.
    const accountMenu = page.getByRole("button", { name: /, your account$/ });
    await pressUntilFocused(page, "Shift+Tab", accountMenu, 80);
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Your account" });
    await pressUntilFocused(
      page,
      "ArrowDown",
      menu.getByRole("menuitem", { name: "Account settings" }),
    );
    await page.keyboard.press("Enter");
    const settings = page.getByRole("dialog", { name: "Account settings" });
    await expect(settings).toBeVisible();
    // One dialog, a section at a time, opening on the profile.
    await expect(settings.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(settings.getByRole("form", { name: "Your profile" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(accountMenu).toBeFocused();

    // Help is in the same menu: diagnostics show versions and the connection,
    // taken from the real server, before anything is copied.
    await page.keyboard.press("Enter");
    await pressUntilFocused(page, "ArrowDown", menu.getByRole("menuitem", { name: "Diagnostics" }));
    await page.keyboard.press("Enter");
    const diagnostics = page.getByRole("dialog", { name: "Diagnostics" });
    const report = diagnostics.getByLabel("Diagnostics report");
    await expect(report).toContainText(/Server: v\S+, protocol 1/);
    await expect(report).toContainText("Connection: online");
    await page.keyboard.press("Escape");
    await expect(diagnostics).toHaveCount(0);
  } finally {
    await context.close().catch(() => {});
    if (keyboardServer.exitCode === null) {
      const exited = new Promise((resolve) => keyboardServer.once("exit", resolve));
      keyboardServer.kill();
      await exited;
    }
    rmSync(keyboardData, { recursive: true, force: true });
  }
});

test("the layout holds at phone, tablet, laptop and short-window sizes", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const port = 18549;
  const origin = `http://127.0.0.1:${port}`;
  const layoutData = mkdtempSync(join(tmpdir(), "slackoss-e2e-layout-"));
  const layoutServer = spawn(
    process.execPath,
    [
      "apps/server-cli/dist/slackoss-server.js",
      "--data",
      layoutData,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-mdns",
      "--name",
      "Layout Team",
      "--no-rate-limits",
    ],
    UNREAD,
  );
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(`${origin}/api/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    const { token } = await (
      await fetch(`${origin}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "hana", displayName: "Hana", password: "password123" }),
      })
    ).json();
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const { channels } = await (await fetch(`${origin}/api/channels`, { headers: auth })).json();
    const general = channels.find((c: { name: string }) => c.name === "general");
    let root = "";
    for (let i = 1; i <= 30; i++) {
      const { message } = await (
        await fetch(`${origin}/api/channels/${general.id}/messages`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            text:
              i === 30
                ? "The newest message, long enough to wrap on a phone: " +
                  "a-very-long-unbroken-address-that-must-not-push-the-page-sideways.example.com"
                : `Line ${i}`,
          }),
        })
      ).json();
      if (i === 29) root = message.id;
    }
    await fetch(`${origin}/api/channels/${general.id}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "A reply", threadRootId: root }),
    });

    // Pixel baselines would compare this browser's fonts with CI's, so the
    // layout is measured instead; screenshots are kept for a person to look at.
    for (const size of [
      { name: "phone", width: 390, height: 844 },
      { name: "tablet", width: 768, height: 1024 },
      { name: "small laptop", width: 900, height: 700 },
      { name: "laptop", width: 1024, height: 768 },
      { name: "short", width: 1280, height: 600 },
    ]) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
      });
      const page = await context.newPage();
      await page.goto(origin);
      await page.evaluate(
        (server) => localStorage.setItem("slackoss:servers", JSON.stringify([server])),
        { url: origin, token, workspaceName: "Layout Team", handle: "hana", lastUsedAt: 1 },
      );
      await page.goto(`${origin}/#/c/${general.id}`);
      await page.reload();
      const composer = page.locator("textarea");
      await expect(composer).toBeVisible();
      const newest = page.getByText("The newest message", { exact: false });
      await expect(newest).toBeInViewport();

      const box = async (locator: import("@playwright/test").Locator) => {
        await atRest(page);
        return (await locator.boundingBox())!;
      };
      const header = await box(page.locator(".channel-header"));
      const timeline = await box(page.locator('[aria-label="Message history"]'));
      const composerShell = await box(page.locator(".composer-shell"));
      const where = `${size.name} ${size.width}×${size.height}`;
      // Nothing makes the page scroll sideways, not even a long address.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        where,
      ).toBe(true);
      // Header, timeline and composer stack in order, inside the window.
      expect(header.y, where).toBeGreaterThanOrEqual(0);
      expect(header.y + header.height, where).toBeLessThanOrEqual(timeline.y + 1);
      expect(timeline.y + timeline.height, where).toBeLessThanOrEqual(composerShell.y + 1);
      expect(composerShell.y + composerShell.height, where).toBeLessThanOrEqual(size.height + 1);
      expect(timeline.height, where).toBeGreaterThan(size.height / 4);
      // The newest message sits above the composer, not under it.
      const newestBox = await box(newest);
      expect(newestBox.y + newestBox.height, where).toBeLessThanOrEqual(composerShell.y + 1);

      const navigation = page.getByRole("navigation", { name: "Workspace navigation" });
      const openNavigation = page.getByRole("button", { name: "Open navigation", exact: true });
      const drawer = size.width <= 760 || size.height <= 480;
      if (drawer) {
        await expect(navigation, where).toBeHidden();
        await expect(openNavigation, where).toBeVisible();
      } else {
        await expect(navigation, where).toBeVisible();
        await expect(openNavigation, where).toBeHidden();
        // Discord's rail of workspaces (72 px) beside the channels column (240 px).
        expect((await box(navigation)).width, where).toBe(312);
      }
      await page.screenshot({ path: info.outputPath(`layout-${size.name}.png`) });

      // A thread sits beside the conversation where there is room, and
      // covers it as a sheet on a phone.
      const rootRow = page.locator(`[data-mid="${root}"]`);
      await page.getByRole("button", { name: "1 reply", exact: true }).click();
      const thread = page.getByRole("complementary", { name: "Thread", exact: true });
      await expect(thread).toBeVisible();
      const threadBox = await box(thread);
      if (size.width <= 760) {
        expect(threadBox.width, where).toBe(size.width);
        await expectMainCovered(page, where);
      } else if (size.width < 1024) {
        // Between a phone and a laptop it is a sheet over the conversation,
        // which would otherwise be squeezed to a sliver beside it, set in from
        // the window's edge like the conversation's own card.
        expect(threadBox.x + threadBox.width, where).toBeCloseTo(size.width - 8, 0);
        expect(threadBox.width, where).toBe(420);
        await expectMainCovered(page, where);
      } else {
        expect(threadBox.x + threadBox.width, where).toBeLessThanOrEqual(size.width + 1);
        const narrowed = await box(page.locator('[aria-label="Message history"]'));
        expect(narrowed.x + narrowed.width, where).toBeLessThanOrEqual(threadBox.x + 1);
        expect(narrowed.width, where).toBeGreaterThan(280);
        await expect(rootRow, where).toBeVisible();
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        where,
      ).toBe(true);
      await page.screenshot({ path: info.outputPath(`layout-${size.name}-thread.png`) });
      await context.close();
    }
  } finally {
    if (layoutServer.exitCode === null) {
      const exited = new Promise((resolve) => layoutServer.once("exit", resolve));
      layoutServer.kill();
      await exited;
    }
    rmSync(layoutData, { recursive: true, force: true });
  }
});

test("a dialog keeps its name, its sections and its buttons in sight, and scrolls only what is read", async ({
  page,
}) => {
  // Enough people that choosing who to message is a list to scroll.
  for (let i = 1; i <= 12; i++) {
    const registered = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: `guest${i}`,
        displayName: `Person ${String(i).padStart(2, "0")}`,
        password: "password123",
      }),
    });
    expect(registered.status).toBe(201);
  }
  // A short window, where every section of the settings is longer than the dialog.
  await page.setViewportSize({ width: 1280, height: 620 });
  await signIn(page, "alice");
  const box = async (locator: Locator) => (await locator.boundingBox())!;
  /**
   * Loaded, and done arriving. A dialog says it is loading in a smaller one
   * first, and grows a little as it appears.
   */
  const settled = async (dialog: Locator, loaded: Locator) => {
    await expect(loaded).toBeVisible();
    await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  };
  const scrolled = (locator: Locator) => locator.evaluate((el) => el.scrollTop);

  await page.getByRole("button", { name: /, your account$/ }).click();
  await page.getByRole("menuitem", { name: "Account settings" }).click();
  const settings = page.getByRole("dialog", { name: "Account settings", exact: true });
  const voice = settings.getByRole("tab", { name: "Voice & video", exact: true });
  await settled(settings, voice);
  await voice.click();
  const section = settings.getByRole("tabpanel", { name: "Voice & video", exact: true });
  const name = settings.getByRole("heading", { name: "Account settings" });
  const sections = settings.getByRole("tablist");
  const before = {
    dialog: await box(settings),
    name: await box(name),
    sections: await box(sections),
  };
  expect(before.dialog.y + before.dialog.height).toBeLessThanOrEqual(620);

  // The wheel over the section scrolls the section. Nothing else moves.
  await section.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => scrolled(section)).toBeGreaterThan(200);
  expect(await scrolled(settings)).toBe(0);
  expect(await box(settings)).toEqual(before.dialog);
  expect(await box(name)).toEqual(before.name);
  expect(await box(sections)).toEqual(before.sections);
  await expect(settings.getByRole("button", { name: "Close" })).toBeInViewport();
  await expect(settings.getByRole("tab", { name: "Profile", exact: true })).toBeInViewport();

  // Page Down reaches the section from its tab, which is beside what scrolls.
  await section.evaluate((el) => (el.scrollTop = 0));
  await voice.focus();
  await page.keyboard.press("PageDown");
  await expect.poll(() => scrolled(section)).toBeGreaterThan(100);

  // Another section opens at its start, in a dialog that has not changed size.
  await settings.getByRole("tab", { name: "Notifications", exact: true }).click();
  const notifications = settings.getByRole("tabpanel", { name: "Notifications", exact: true });
  await expect(notifications.getByRole("heading", { name: "Pause notifications" })).toBeVisible();
  expect(await scrolled(notifications)).toBe(0);
  expect(await box(settings)).toEqual(before.dialog);
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  // Who a message is to stays above the people, and the button that starts it below them.
  await page.getByRole("button", { name: "New message", exact: true }).first().click();
  const message = page.getByRole("dialog", { name: "New message", exact: true });
  const to = message.getByLabel("To", { exact: true });
  await settled(message, to);
  const people = message.getByRole("list", { name: "People" });
  const list = message.locator(".dialog-scroll");
  expect(await list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
  const start = message.getByRole("button", { name: "Start conversation", exact: true });
  const fixed = { dialog: await box(message), to: await box(to), start: await box(start) };
  expect(fixed.start.y + fixed.start.height).toBeLessThanOrEqual(620);
  await people.hover();
  await page.mouse.wheel(0, 2000);
  await expect(message.getByText("Person 12", { exact: true })).toBeInViewport();
  expect(await box(message)).toEqual(fixed.dialog);
  expect(await box(to)).toEqual(fixed.to);
  expect(await box(start)).toEqual(fixed.start);
});

test("a visitor joins with only a name where guests are allowed, and can keep it as an account", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const guestData = mkdtempSync(join(tmpdir(), "slackoss-e2e-guest-"));
  const guestServer = spawn(
    process.execPath,
    [
      "apps/server-cli/dist/slackoss-server.js",
      "--data",
      guestData,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-mdns",
      "--name",
      "Guest Team",
      "--no-rate-limits",
      "--access-policy",
      "guest_allowed",
    ],
    UNREAD,
  );
  const context = await browser.newContext();
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(`${origin}/api/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    const owner = (await (
      await fetch(`${origin}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "olivia", displayName: "Olivia", password: "password123" }),
      })
    ).json()) as { token: string; user: { id: string } };
    const call = async (path: string, body?: unknown) =>
      (
        await fetch(`${origin}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${owner.token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      ).json();
    const { channels } = await call("/api/channels");
    const general = channels.find((c: { name: string }) => c.name === "general");
    await call("/api/channels", { type: "private", name: "leadership" });
    const messages = async () =>
      (
        (await call(`/api/channels/${general.id}/messages`)).messages as {
          text: string;
          userId: string;
        }[]
      ).map((m) => `${m.userId}:${m.text}`);

    const page = await context.newPage();
    // Anything the app asks for that a guest is refused: the app should not ask.
    const refused: string[] = [];
    page.on("response", async (response) => {
      if (response.status() !== 403) return;
      const body = await response.text().catch(() => "");
      if (body.includes("guest_not_allowed")) refused.push(response.url());
    });
    await page.goto(origin);

    // No username, password or invite: a display name, and Join as guest.
    const guestTab = page.getByRole("tab", { name: "Join as guest", exact: true });
    await expect(guestTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await page.getByLabel("Display name", { exact: true }).fill("Visiting Vic");
    await page.screenshot({ path: test.info().outputPath("guest-join.png") });
    await page.getByRole("button", { name: "Join as guest", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Message #general", exact: true });
    await expect(composer).toBeVisible();
    const nav = page.getByRole("navigation").first();
    await expect(nav.getByText("Guest", { exact: true })).toBeVisible();
    await expect(nav.getByRole("button", { name: "New channel", exact: true })).toHaveCount(0);
    await expect(nav.getByText("leadership")).toHaveCount(0);
    // Nothing asks a guest to stay before they have said anything (UX-44).
    const offer = nav.getByRole("region", { name: "You're a guest for a day", exact: true });
    await expect(offer).toHaveCount(0);
    const sidebarWidth = () => nav.evaluate((el) => el.getBoundingClientRect().width);
    const widthBefore = await sidebarWidth();

    await composer.fill("hello from a guest");
    await composer.press("Enter");
    await expect.poll(messages).toContainEqual(expect.stringMatching(/:hello from a guest$/));
    await expect(offer).toBeVisible();
    await expect(offer).toContainText("your name and your messages");
    await expect(composer).toBeFocused();
    // The sidebar is as wide as what it holds; the offer's words must not widen it.
    expect(await sidebarWidth()).toBe(widthBefore);
    // A phone on its side: the drawer scrolls as one column, with the offer
    // after the last channel and the account panel after the offer.
    const wide = page.viewportSize()!;
    await page.setViewportSize({ width: 844, height: 390 });
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await expect(offer).toBeAttached();
    const edges = (locator: Locator) =>
      locator.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      });
    const lastRow = await edges(nav.locator(".channel-item").last());
    const offerBox = await edges(offer);
    expect(offerBox.top).toBeGreaterThanOrEqual(lastRow.bottom);
    expect((await edges(nav.locator(".user-panel"))).top).toBeGreaterThanOrEqual(offerBox.bottom);
    await page.setViewportSize(wide);
    await expect(composer).toBeVisible();
    const [guestMessage] = (await messages()).filter((m) => m.endsWith(":hello from a guest"));
    const guest = guestMessage!.split(":")[0]!;
    // Everyone else sees who wrote it, marked as a guest.
    await expect(
      page
        .getByRole("article")
        .filter({ hasText: "hello from a guest" })
        .getByText("Guest", { exact: true }),
    ).toBeVisible();

    await page.screenshot({ path: test.info().outputPath("guest-workspace.png") });
    // A reload resumes the same guest, still offered to stay until they answer.
    await page.reload();
    await expect(composer).toBeVisible();
    await expect(nav.getByText("Guest", { exact: true })).toBeVisible();
    await expect(offer).toBeVisible();
    await offer.getByRole("button", { name: "Not now", exact: true }).click();
    await expect(offer).toHaveCount(0);
    // Put away for good: the guest's message is on screen again, and no offer.
    await page.reload();
    await expect(
      page.getByRole("article").filter({ hasText: "hello from a guest" }).first(),
    ).toBeVisible();
    await expect(offer).toHaveCount(0);

    // Keeping the identity as an account: same person, now a member.
    await nav.getByRole("button", { name: /, workspace menu$/ }).click();
    await page.getByRole("menuitem", { name: "Create an account", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create an account", exact: true });
    // The button works before anything is typed: sent empty, the form says
    // what is missing beside each field and puts the cursor in the first.
    await dialog.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(dialog.getByLabel("Username", { exact: true })).toBeFocused();
    await expect(dialog.getByLabel("Username", { exact: true })).toHaveAccessibleDescription(
      /^Choose a username\./,
    );
    await expect(dialog.getByLabel("Password", { exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await dialog.getByLabel("Username", { exact: true }).fill("vic");
    await dialog.getByLabel("Password", { exact: true }).fill("password123");
    await dialog.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(nav.getByRole("button", { name: "New channel", exact: true })).toBeVisible();
    await expect(nav.getByText("Guest", { exact: true })).toHaveCount(0);
    await composer.fill("now with an account");
    await composer.press("Enter");
    await expect.poll(messages).toContain(`${guest}:now with an account`);
    expect(refused).toEqual([]);
  } finally {
    await context.close().catch(() => {});
    if (guestServer.exitCode === null) {
      const exited = new Promise((resolve) => guestServer.once("exit", resolve));
      guestServer.kill();
      await exited;
    }
    rmSync(guestData, { recursive: true, force: true });
  }
});

test("reading a thread on a phone leaves an unseen mention in its channel unread", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const port = 18550;
  const origin = `http://127.0.0.1:${port}`;
  const readData = mkdtempSync(join(tmpdir(), "slackoss-e2e-thread-read-"));
  const readServer = spawn(
    process.execPath,
    [
      "apps/server-cli/dist/slackoss-server.js",
      "--data",
      readData,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-mdns",
      "--name",
      "Read Team",
      "--no-rate-limits",
    ],
    UNREAD,
  );
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(`${origin}/api/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    const account = async (handle: string) =>
      (await (
        await fetch(`${origin}/api/auth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
        })
      ).json()) as { token: string; user: { id: string } };
    const hana = await account("hana");
    const omar = await account("omar");
    const call = async (token: string, path: string, body: unknown, method = "POST") =>
      (
        await fetch(`${origin}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json();
    const { channels } = await (
      await fetch(`${origin}/api/channels`, {
        headers: { authorization: `Bearer ${hana.token}` },
      })
    ).json();
    const general = channels.find((c: { name: string }) => c.name === "general");
    const { channel: design } = await call(hana.token, "/api/channels", {
      type: "public",
      name: "design",
    });
    // Hana has read up to the root and follows its thread. Then, unseen by
    // her, a mention in the channel and a reply in the thread.
    const { message: root } = await call(omar.token, `/api/channels/${general.id}/messages`, {
      text: "Plans for Friday",
    });
    await call(hana.token, `/api/channels/${general.id}/read`, { seq: root.seq });
    await call(hana.token, `/api/messages/${root.id}/follow`, { following: true }, "PUT");
    await call(omar.token, `/api/channels/${general.id}/messages`, {
      text: `Can you check the venue <@${hana.user.id}>`,
    });
    await call(omar.token, `/api/channels/${general.id}/messages`, {
      text: "Friday works for me",
      threadRootId: root.id,
    });

    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(
      (server) => localStorage.setItem("slackoss:servers", JSON.stringify([server])),
      { url: origin, token: hana.token, workspaceName: "Read Team", handle: "hana", lastUsedAt: 1 },
    );
    await page.goto(`${origin}/#/c/${design.id}`);
    await page.reload();
    await expect(page.locator("textarea")).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Workspace navigation" });
    const openNavigation = page.getByRole("button", { name: "Open navigation", exact: true });
    const mention = nav.getByLabel("1 unread mention in general", { exact: true });
    await openNavigation.click();
    await expect(mention).toBeVisible();
    await expect(nav.getByLabel("Threads with unread replies", { exact: true })).toHaveText("1");
    await nav.getByRole("button", { name: /^Threads\b/ }).click();
    const threads = page.getByRole("complementary", { name: "Threads", exact: true });
    await threads.getByRole("button", { name: "Open thread", exact: true }).click();
    const thread = page.getByRole("complementary", { name: "Thread", exact: true });
    await expect(thread.getByText("Friday works for me", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${origin}/#/c/${general.id}/t/${root.id}`);

    // The thread is read; the channel's own mention is not.
    const unreadActivity = async () =>
      (
        (await (
          await fetch(`${origin}/api/activity?mode=unread`, {
            headers: { authorization: `Bearer ${hana.token}` },
          })
        ).json()) as { messages: { text: string }[] }
      ).messages.map((m) => m.text);
    await expect.poll(unreadActivity).toEqual([`Can you check the venue <@${hana.user.id}>`]);

    // Back returns to the Threads list over #design; closed, the mention is
    // still there.
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/#/c/${design.id}/p/threads`);
    await threads.getByRole("button", { name: "Close Threads", exact: true }).click();
    await openNavigation.click();
    await expect(mention).toBeVisible();
    await expect(nav.getByLabel("Threads with unread replies", { exact: true })).toHaveCount(0);

    await page.keyboard.press("Escape");

    // And after a reload, which connects again from nothing.
    await page.reload();
    await expect(page.locator("textarea")).toBeVisible();
    await openNavigation.click();
    await expect(mention).toBeVisible();
    expect(await unreadActivity()).toEqual([`Can you check the venue <@${hana.user.id}>`]);
  } finally {
    await context.close().catch(() => {});
    if (readServer.exitCode === null) {
      const exited = new Promise((resolve) => readServer.once("exit", resolve));
      readServer.kill();
      await exited;
    }
    rmSync(readData, { recursive: true, force: true });
  }
});

test("a browser refetches authenticated file bytes after access is revoked", async ({ page }) => {
  const registerAccount = async (handle: string) => {
    const response = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { token: string; user: { id: string } };
  };
  const owner = await registerAccount("cacheowner");
  const viewer = await registerAccount("cacheviewer");
  const outsider = await registerAccount("cacheoutsider");
  const roomResponse = await fetch(`${base}/api/channels`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${owner.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ type: "private", name: "cache-access", memberIds: [viewer.user.id] }),
  });
  expect(roomResponse.status).toBe(201);
  const { channel } = (await roomResponse.json()) as { channel: { id: string } };
  const upload = new FormData();
  upload.append("file", new Blob(["private document"], { type: "text/plain" }), "private.txt");
  const uploadResponse = await fetch(`${base}/api/channels/${channel.id}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner.token}` },
    body: upload,
  });
  expect(uploadResponse.status).toBe(201);
  const { file } = (await uploadResponse.json()) as { file: { id: string } };

  await page.goto(base);
  const fetchInBrowser = (token: string) =>
    page.evaluate(
      async ({ fileId, token }) => {
        const response = await fetch(`/api/files/${fileId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        return {
          status: response.status,
          cacheControl: response.headers.get("cache-control"),
          body: await response.text(),
        };
      },
      { fileId: file.id, token },
    );
  const first = await fetchInBrowser(viewer.token);
  expect(first.status).toBe(200);
  expect(first.body).toBe("private document");
  // Another account using the same browser must not inherit the first one's bytes.
  expect((await fetchInBrowser(outsider.token)).status).toBe(404);

  const removed = await fetch(`${base}/api/channels/${channel.id}/members/${viewer.user.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${owner.token}` },
  });
  expect(removed.status).toBe(200);
  // The server knows access is gone. A browser must not reuse its earlier bytes.
  const serverRefusal = await fetch(`${base}/api/files/${file.id}`, {
    headers: { authorization: `Bearer ${viewer.token}` },
  });
  expect(serverRefusal.status).toBe(404);
  expect((await fetchInBrowser(viewer.token)).status).toBe(404);
  expect(first.cacheControl).toBe("no-store");
});

test("a long thread left partway opens again where it was left, its newer replies unread", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const register = async (handle: string) =>
    (await (
      await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
      })
    ).json()) as { token: string; user: { id: string } };
  const reader = await register("placereader");
  const writer = await register("placewriter");
  const call = async (token: string, path: string, body: unknown, method = "POST") =>
    (
      await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();
  const { channel } = await call(reader.token, "/api/channels", {
    type: "public",
    name: "long-thread",
    memberIds: [writer.user.id],
  });
  const { message: root } = await call(reader.token, `/api/channels/${channel.id}/messages`, {
    text: "Notes from the offsite",
  });
  await call(reader.token, `/api/messages/${root.id}/follow`, { following: true }, "PUT");
  const replies: { id: string }[] = [];
  for (let n = 1; n <= 60; n++)
    replies.push(
      (
        await call(writer.token, `/api/channels/${channel.id}/messages`, {
          text: `Point ${n} from the offsite`,
          threadRootId: root.id,
        })
      ).message,
    );
  const unread = async () =>
    (
      (await (
        await fetch(`${base}/api/threads/followed`, {
          headers: { authorization: `Bearer ${reader.token}` },
        })
      ).json()) as { threads: { root: { id: string }; unreadCount: number }[] }
    ).threads.find((t) => t.root.id === root.id)?.unreadCount;

  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  try {
    const page = await context.newPage();
    await page.goto(base);
    await page.evaluate(
      (server) => localStorage.setItem("slackoss:servers", JSON.stringify([server])),
      {
        url: base,
        token: reader.token,
        workspaceName: "Product Test",
        handle: "placereader",
        lastUsedAt: 1,
      },
    );
    await page.goto(`${base}/#/c/${channel.id}/t/${root.id}`);
    await page.reload();
    const thread = page.getByRole("complementary", { name: "Thread", exact: true });
    await expect(thread.getByText("Point 60 from the offsite", { exact: true })).toBeVisible();
    // Opened at its newest reply, it is read.
    await expect.poll(unread).toBe(0);

    // Scrolled back so the twentieth point is at the top, then closed.
    const twentieth = thread.locator(`[data-reply="${replies[19]!.id}"]`);
    const offsetInPanel = () =>
      twentieth.evaluate((reply) => {
        const panel = reply.closest<HTMLElement>("[aria-busy]")!;
        return reply.getBoundingClientRect().top - panel.getBoundingClientRect().top;
      });
    await twentieth.evaluate((reply) => {
      const panel = reply.closest<HTMLElement>("[aria-busy]")!;
      panel.scrollTop += reply.getBoundingClientRect().top - panel.getBoundingClientRect().top;
    });
    await expect.poll(async () => Math.abs(await offsetInPanel())).toBeLessThan(2);
    await thread.getByRole("button", { name: "Close thread", exact: true }).click();
    await expect(thread).toHaveCount(0);

    // Three more points arrive while it is closed.
    for (let n = 61; n <= 63; n++)
      await call(writer.token, `/api/channels/${channel.id}/messages`, {
        text: `Point ${n} from the offsite`,
        threadRootId: root.id,
      });
    await expect.poll(unread).toBe(3);

    // Opened again, it is back at the twentieth point, and the new ones stay unread.
    const rootRow = page.locator(`[data-mid="${root.id}"]`);
    await rootRow.hover();
    await rootRow.getByRole("button", { name: "Reply in thread", exact: true }).click();
    await expect(twentieth).toBeVisible();
    await expect.poll(async () => Math.abs(await offsetInPanel())).toBeLessThan(2);
    await page.waitForTimeout(1_000);
    expect(await unread()).toBe(3);

    // Going to the newest reads them.
    await thread.getByRole("button", { name: "Jump to latest", exact: true }).click();
    await expect(thread.getByText("Point 63 from the offsite", { exact: true })).toBeVisible();
    await expect.poll(unread).toBe(0);
  } finally {
    await context.close().catch(() => {});
  }
});

test("the client arrives compressed, and a second visit reuses its hashed files", async ({
  page,
}) => {
  // What the browser itself saw: whether each response came over the network
  // or from its cache, and the headers it came with (REV-13).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  type Seen = { url: string; cached: boolean; status: number; headers: Record<string, string> };
  let seen: Seen[] = [];
  const servedFromCache = new Set<string>();
  cdp.on("Network.requestServedFromCache", ({ requestId }) => servedFromCache.add(requestId));
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    seen.push({
      url: response.url,
      cached: response.fromDiskCache || servedFromCache.has(requestId),
      status: response.status,
      headers: Object.fromEntries(
        Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value]),
      ),
    });
  });
  const entry = (visit: Seen[]) => visit.filter((r) => /\/assets\/index-[\w-]+\.js$/.test(r.url));
  const pageItself = (visit: Seen[]) => visit.filter((r) => r.url === `${base}/`);

  await page.goto(base);
  await page.waitForLoadState("networkidle");
  const first = seen;
  expect(entry(first)).toHaveLength(1);
  expect(entry(first)[0]).toMatchObject({
    cached: false,
    status: 200,
    headers: {
      "content-encoding": "br",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
  expect(entry(first)[0]!.headers.vary).toMatch(/accept-encoding/i);
  expect(pageItself(first)[0]!.headers["cache-control"]).toBe("no-cache");

  seen = [];
  servedFromCache.clear();
  await page.goto(base);
  await page.waitForLoadState("networkidle");
  // The page is asked about again; the script it names is not.
  expect(pageItself(seen).every((r) => !r.cached)).toBe(true);
  expect(entry(seen).length).toBeGreaterThan(0);
  expect(entry(seen).every((r) => r.cached)).toBe(true);
  await cdp.detach();
});

test("a message is answered in place or in its thread, as in Discord", async ({ page }) => {
  // Bobby asks, then the channel moves on far enough to scroll it out of view.
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "bobby", password: "password123" }),
  });
  const bobby = { authorization: `Bearer ${((await login.json()) as { token: string }).token}` };
  const json = { ...bobby, "content-type": "application/json" };
  const { channels } = (await (await fetch(`${base}/api/channels`, { headers: bobby })).json()) as {
    channels: { id: string; name: string }[];
  };
  const general = channels.find((c) => c.name === "general")!.id;
  const post = async (body: Record<string, unknown>) =>
    (
      (await (
        await fetch(`${base}/api/channels/${general}/messages`, {
          method: "POST",
          headers: json,
          body: JSON.stringify(body),
        })
      ).json()) as { message: { id: string; replyTo?: { id: string; ping: boolean } } }
    ).message;
  const question = await post({ text: "Is the release still on for Friday?" });
  for (let i = 0; i < 30; i++) await post({ text: `status line ${i}` });

  await signIn(page, "alice");
  const composer = page.getByRole("textbox", { name: "Message #general" });
  const asked = page.getByRole("article").filter({ hasText: "Is the release still on" }).first();
  await asked.hover();
  await asked.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(composer).toBeFocused();
  await expect(page.getByText("Replying to", { exact: false }).last()).toContainText(
    "Replying to bobby",
  );
  await expect(page.getByRole("button", { name: "Notify bobby" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await composer.fill("Yes, still Friday");
  await composer.press("Enter");

  // The answer lands in view under its quote, though the question was far up.
  const answer = page.getByRole("article").filter({ hasText: "Yes, still Friday" });
  const quote = answer.getByRole("button", { name: /Replying to @bobby Is the release still on/ });
  await expect(quote).toBeInViewport();
  await expect(page.getByRole("button", { name: "Cancel reply" })).toHaveCount(0);
  // Bobby was notified, as a mention does.
  const mentions = (await (
    await fetch(`${base}/api/activity?mode=mentions`, { headers: bobby })
  ).json()) as { messages: { text: string; replyTo?: { id: string; ping: boolean } }[] };
  expect(mentions.messages[0]).toMatchObject({
    text: "Yes, still Friday",
    replyTo: { id: question.id, ping: true },
  });

  // Its quote brings the question back into view.
  await quote.click();
  await expect(asked).toBeInViewport();
  await expect(asked).toHaveClass(/reply-flash/);

  // A thread answers in place too, from the thread's own box.
  await asked.hover();
  await asked.getByRole("button", { name: "Reply in thread", exact: true }).click();
  const thread = page.getByRole("complementary", { name: "Thread", exact: true });
  await expect(thread).toBeVisible();
  await post({ text: "Unless the migration slips", threadRootId: question.id });
  const caveat = thread.getByRole("article").filter({ hasText: "Unless the migration slips" });
  await caveat.hover();
  await caveat.getByRole("button", { name: "Reply", exact: true }).click();
  const threadBox = thread.getByRole("textbox", { name: "Reply…" });
  await expect(threadBox).toBeFocused();
  await expect(thread.getByText("Replying to", { exact: false }).last()).toContainText(
    "Replying to bobby",
  );
  // Escape lets go of the answer and leaves the thread open.
  await page.keyboard.press("Escape");
  await expect(thread.getByRole("button", { name: "Cancel reply" })).toHaveCount(0);
  await expect(thread).toBeVisible();
  await caveat.hover();
  await caveat.getByRole("button", { name: "Reply", exact: true }).click();
  await threadBox.fill("Then we ship Monday");
  await threadBox.press("Enter");
  await expect(
    thread
      .getByRole("article")
      .filter({ hasText: "Then we ship Monday" })
      .getByRole("button", { name: /Replying to @bobby Unless the migration slips/ }),
  ).toBeVisible();
});

test("a starred channel sits under Starred, stays there after a reload, and goes back when unstarred (UX-20)", async ({
  page,
}) => {
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "alice", password: "password123" }),
  });
  const alice = { authorization: `Bearer ${((await login.json()) as { token: string }).token}` };
  const created = await fetch(`${base}/api/channels`, {
    method: "POST",
    headers: { ...alice, "content-type": "application/json" },
    body: JSON.stringify({ name: "design", type: "public" }),
  });
  expect(created.status).toBe(201);
  const design = ((await created.json()) as { channel: { id: string } }).channel.id;

  await signIn(page, "alice");
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  /** The rows listed under a section's header. */
  const under = (section: string) =>
    nav.locator(`div:has(> [data-section-toggle="${section}"]) + ul`);
  const designRow = (within: Locator) => within.getByRole("button", { name: /^#\s*design$/ });
  const starred = nav.getByRole("button", { name: "Starred", exact: true });
  await expect(designRow(under("channels"))).toBeVisible();
  await expect(starred).toHaveCount(0);

  // From the row's own More menu, which shows while the row is pointed at.
  await designRow(nav).hover();
  await nav.getByRole("button", { name: "More options for design" }).click();
  await page.getByRole("menuitem", { name: "Star channel" }).click();
  await expect(starred).toHaveAttribute("aria-expanded", "true");
  await expect(designRow(under("starred"))).toBeVisible();
  await expect(designRow(under("channels"))).toHaveCount(0);
  // Kept by the workspace for this account: an empty change answers with what it has.
  const stored = async () =>
    (
      (await (
        await fetch(`${base}/api/channels/${design}/prefs`, {
          method: "PATCH",
          headers: { ...alice, "content-type": "application/json" },
          body: "{}",
        })
      ).json()) as { prefs: { starred?: boolean } }
    ).prefs.starred;
  await expect.poll(stored).toBe(true);

  await page.reload();
  await expect(page.locator("textarea")).toBeVisible();
  await expect(designRow(under("starred"))).toBeVisible();
  await expect(designRow(under("channels"))).toHaveCount(0);

  // Unstarred from the conversation's own menu, it goes back among the channels.
  await designRow(under("starred")).click();
  await expect(page.getByRole("textbox", { name: "Message #design" })).toBeVisible();
  await page.getByRole("button", { name: "Conversation options" }).click();
  await page.getByRole("menuitem", { name: "Unstar channel" }).click();
  await expect(starred).toHaveCount(0);
  await expect(designRow(under("channels"))).toBeVisible();
  await expect.poll(stored).toBe(false);
  await page.reload();
  await expect(page.locator("textarea")).toBeVisible();
  await expect(designRow(under("channels"))).toBeVisible();
  await expect(starred).toHaveCount(0);
});

test("Activity, Threads and Scheduled keep themselves current while open (UX-08)", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const port = 18551;
  const origin = `http://127.0.0.1:${port}`;
  const liveData = mkdtempSync(join(tmpdir(), "slackoss-e2e-live-panels-"));
  const liveServer = spawn(
    process.execPath,
    [
      "apps/server-cli/dist/slackoss-server.js",
      "--data",
      liveData,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-mdns",
      "--name",
      "Live Team",
      "--no-rate-limits",
    ],
    UNREAD,
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(`${origin}/api/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    const account = async (handle: string) =>
      (await (
        await fetch(`${origin}/api/auth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handle, displayName: handle, password: "password123" }),
        })
      ).json()) as { token: string; user: { id: string } };
    const hana = await account("hana");
    const omar = await account("omar");
    const call = async (token: string, path: string, body?: unknown, method = "POST") =>
      (
        await fetch(`${origin}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      ).json();
    const { channels } = await call(hana.token, "/api/channels", undefined, "GET");
    const general = channels.find((c: { name: string }) => c.name === "general");
    const { channel: design } = await call(hana.token, "/api/channels", {
      type: "public",
      name: "design",
    });
    // Hana starts a thread and follows it.
    const { message: root } = await call(hana.token, `/api/channels/${general.id}/messages`, {
      text: "Where do we ship from?",
    });
    await call(hana.token, `/api/messages/${root.id}/follow`, { following: true }, "PUT");

    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(
      (server) => localStorage.setItem("slackoss:servers", JSON.stringify([server])),
      { url: origin, token: hana.token, workspaceName: "Live Team", handle: "hana", lastUsedAt: 1 },
    );
    // Hana reads #design, so what arrives in #general stays unread.
    await page.goto(`${origin}/#/c/${design.id}`);
    await page.reload();
    await expect(page.locator("textarea")).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Workspace navigation" });

    // Activity: a plain message and a mention from Omar arrive while it is open.
    await nav.getByRole("button", { name: /^Activity\b/ }).click();
    const activity = page.getByRole("complementary", { name: "Activity", exact: true });
    await expect(activity.getByText("You're caught up.")).toBeVisible();
    await expect(activity.getByRole("button", { name: "Refresh" })).toHaveCount(0);
    await call(omar.token, `/api/channels/${general.id}/messages`, { text: "Build is green" });
    await expect(activity.getByText("Build is green", { exact: true })).toBeVisible();
    await call(omar.token, `/api/channels/${general.id}/messages`, {
      text: `Can you check the venue <@${hana.user.id}>`,
    });
    await expect(activity.getByText(/Can you check the venue/)).toBeVisible();
    // Under one heading for their conversation, and read at once (UX-52).
    await expect(
      activity.getByRole("region", { name: "#general, 2 new", exact: true }),
    ).toBeVisible();
    await activity.getByRole("button", { name: "Mark all read", exact: true }).click();
    await expect(activity.getByText("You're caught up.")).toBeVisible();
    await expect(activity.getByRole("button", { name: "Mark all read" })).toHaveCount(0);
    await activity.getByRole("button", { name: "Close activity", exact: true }).click();

    // Threads: Omar answers the thread Hana follows.
    await nav.getByRole("button", { name: /^Threads\b/ }).click();
    const threads = page.getByRole("complementary", { name: "Threads", exact: true });
    await expect(threads.getByText("Where do we ship from?", { exact: true })).toBeVisible();
    await expect(threads.getByText(/new repl/)).toHaveCount(0);
    await call(omar.token, `/api/channels/${general.id}/messages`, {
      text: "From the north dock",
      threadRootId: root.id,
    });
    await expect(threads.getByText("1 new reply", { exact: true })).toBeVisible();
    await threads.getByRole("button", { name: "Close Threads", exact: true }).click();

    // Scheduled: Hana queues a message on another device, and cancels it there.
    await page.getByRole("button", { name: /, your account$/ }).click();
    await page.getByRole("menuitem", { name: "Scheduled messages", exact: true }).click();
    const scheduled = page.getByRole("complementary", { name: "Scheduled messages", exact: true });
    await expect(scheduled.getByText(/Nothing queued/)).toBeVisible();
    const { scheduled: queued } = await call(hana.token, `/api/channels/${general.id}/scheduled`, {
      text: "Reminder from the phone",
      sendAt: Date.now() + 3_600_000,
    });
    await expect(scheduled.getByText("Reminder from the phone", { exact: true })).toBeVisible();
    await call(hana.token, `/api/scheduled/${queued.id}`, undefined, "DELETE");
    await expect(scheduled.getByText(/Nothing queued/)).toBeVisible();
  } finally {
    await context.close().catch(() => {});
    if (liveServer.exitCode === null) {
      const exited = new Promise((resolve) => liveServer.once("exit", resolve));
      liveServer.kill();
      await exited;
    }
    rmSync(liveData, { recursive: true, force: true });
  }
});
