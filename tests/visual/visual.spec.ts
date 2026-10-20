import { test, expect, type Browser, type Page } from "@playwright/test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * The look of the main screens, in Onyx and White, on a desktop window and a
 * phone (UX-15): each screen is compared with a picture taken on Linux, and
 * axe, colour contrast included, finds nothing on it.
 *
 * The pictures are made by the "Visual baselines" workflow on GitHub's Linux
 * runners, which commits them to the branch it ran on. Elsewhere fonts are
 * drawn a little differently, so other systems run the same steps and axe but
 * compare nothing (see playwright.visual.config.ts).
 *
 * Each test seeds its own demo workspace (scripts/seed-demo.mjs) on a server
 * whose clock stands still and whose random bytes are the same every run
 * (frozen-server.mjs), so ids, avatar colours and times come out the same.
 * The browser's clock stands still two hours later, in UTC.
 */
const FROZEN_AT = Date.UTC(2026, 2, 14, 9, 0, 0);
const PASSWORD = "visual-check-not-a-secret";
const axeScript = createRequire(join(process.cwd(), "packages/ui/package.json")).resolve(
  "axe-core/axe.min.js",
);

/**
 * The sign-in card shows the workspace's address, so the port is the same
 * every run. One test runs at a time, and each stops its server.
 */
const PORT = 18690;

async function portFree(port: number): Promise<boolean> {
  const probe = createNetServer();
  return new Promise((done) => {
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

interface Demo {
  base: string;
  token: string;
  channels: Record<"general" | "design" | "engineering" | "dm", string>;
  mockup: string;
}

let server: ChildProcess | undefined;
let data = "";

/** A demo workspace on a frozen server of its own, and Maya's sign-in to it. */
async function demo(): Promise<Demo> {
  data = mkdtempSync(join(tmpdir(), "tandem-visual-"));
  const port = PORT;
  expect(await portFree(port), `port ${port} is taken; stop what holds it`).toBe(true);
  const base = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [
      "--import",
      "./tests/visual/frozen-server.mjs",
      "apps/server-cli/dist/slackoss-server.js",
      ...["--data", data, "--port", String(port), "--host", "127.0.0.1"],
      ...["--no-mdns", "--no-rate-limits", "--name", "Rocket Team"],
    ],
    {
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, TANDEM_FROZEN_AT: String(FROZEN_AT) },
    },
  );
  await expect
    .poll(async () => {
      try {
        return (await fetch(`${base}/api/health`)).status;
      } catch {
        return 0;
      }
    })
    .toBe(200);
  await promisify(execFile)(process.execPath, [
    "scripts/seed-demo.mjs",
    base,
    "--password",
    PASSWORD,
  ]);
  const signedIn = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "maya", password: PASSWORD }),
  });
  const { token } = (await signedIn.json()) as { token: string };
  const get = async <T>(path: string) =>
    (await (
      await fetch(base + path, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as T;
  const { channels } = await get<{ channels: { id: string; name: string; type: string }[] }>(
    "/api/channels",
  );
  const named = (name: string) => channels.find((c) => c.name === name)!.id;
  const design = named("design");
  const { messages } = await get<{ messages: { id: string; text: string }[] }>(
    `/api/channels/${design}/messages`,
  );
  return {
    base,
    token,
    channels: {
      general: named("general"),
      design,
      engineering: named("engineering"),
      dm: channels.find((c) => c.type === "dm")!.id,
    },
    mockup: messages.find((m) => m.text.startsWith("First pass at the new sign-in screen"))!.id,
  };
}

test.afterEach(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((done) => server!.once("exit", done));
    server.kill();
    await exited;
  }
  server = undefined;
  if (data) rmSync(data, { recursive: true, force: true });
});

type Theme = "onyx" | "white";
type Width = "desktop" | "phone";

async function open(browser: Browser, theme: Theme, width: Width): Promise<Page> {
  const context = await browser.newContext({
    colorScheme: theme === "onyx" ? "dark" : "light",
    timezoneId: "UTC",
    locale: "en-US",
    // axe is added to each page as a script, which the content security policy refuses.
    bypassCSP: true,
    ...(width === "phone"
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height: 820 } }),
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(FROZEN_AT + 2 * 60 * 60 * 1000);
  return page;
}

/** Signs Maya in on this page's device, then opens `hash`. */
async function signIn(page: Page, demo: Demo, hash: string) {
  await page.evaluate(
    (server) => localStorage.setItem("slackoss:servers", JSON.stringify([server])),
    {
      url: demo.base,
      token: demo.token,
      workspaceName: "Rocket Team",
      handle: "maya",
      lastUsedAt: 1,
    },
  );
  await page.evaluate((to) => (location.hash = to), hash);
  await page.reload();
  await expect(page.locator("textarea")).toBeVisible();
}

/** Goes to `hash` within the app, as a link would. */
async function go(page: Page, hash: string) {
  await page.evaluate((to) => (location.hash = to), hash);
}

/**
 * Compares the screen with its picture and has axe check it. Waits for the
 * fonts and every picture first; the comparison itself waits until two shots
 * in a row agree, with finite animations finished and endless ones stopped.
 */
async function look(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete && image.naturalWidth > 0),
  );
  await expect(page).toHaveScreenshot(`${name}.png`, { animations: "disabled", caret: "hide" });
  // Animations stop only while the picture is taken, and play again after it.
  // axe would then judge text that is still fading in, so it waits for those
  // that end by themselves: not endless ones, nor a scroll-driven edge fade.
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
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: axeScript });
  const problems = await page.evaluate(async () => {
    const { violations } = await (
      window as unknown as {
        axe: {
          run: (
            context: Document,
            options: object,
          ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      }
    ).axe.run(document, { resultTypes: ["violations"] });
    return violations.map(
      ({ id, nodes }) => `${id}: ${nodes.map((node) => node.target.join(" ")).join(", ")}`,
    );
  });
  expect(problems, `axe on ${name}`).toEqual([]);
}

for (const theme of ["onyx", "white"] as const) {
  test(`the desktop window in ${theme}`, async ({ browser }) => {
    const workspace = await demo();
    const page = await open(browser, theme, "desktop");
    const shot = (screen: string) => look(page, `desktop-${theme}-${screen}`);

    await page.goto(workspace.base);
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await shot("sign-in");

    await signIn(page, workspace, `#/c/${workspace.channels.general}`);
    await expect(page.getByText("Welcome to Tandem, everyone!")).toBeVisible();
    await shot("general");

    // Unread, with a mention of Maya below the New line.
    await go(page, `#/c/${workspace.channels.engineering}`);
    // The pinned bar above repeats it; the message comes after.
    await expect(page.getByText("Release checklist for 0.2:").last()).toBeVisible();
    await shot("engineering");

    await go(page, `#/c/${workspace.channels.design}/t/${workspace.mockup}`);
    await expect(page.getByText("Good call, I'll try it 20% larger")).toBeVisible();
    await shot("thread");

    await go(page, `#/c/${workspace.channels.dm}`);
    await expect(
      page.getByText("Morning! Could you look over the release checklist"),
    ).toBeVisible();
    await shot("direct-message");

    await go(page, `#/c/${workspace.channels.engineering}/p/activity`);
    // What is unread elsewhere; #engineering was read on the way here.
    await expect(page.getByText("Anyone up for lunch on Friday?")).toBeVisible();
    await shot("activity");

    await go(page, `#/c/${workspace.channels.general}/d/people`);
    await expect(page.getByRole("dialog", { name: "People", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog").getByText("Priya Natarajan")).toBeVisible();
    await shot("people");

    await go(page, `#/c/${workspace.channels.general}/d/account/appearance`);
    await expect(page.getByRole("tabpanel", { name: "Appearance" })).toBeVisible();
    await shot("appearance");
  });

  test(`the phone in ${theme}`, async ({ browser }) => {
    const workspace = await demo();
    const page = await open(browser, theme, "phone");
    const shot = (screen: string) => look(page, `phone-${theme}-${screen}`);

    await page.goto(workspace.base);
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await shot("sign-in");

    await signIn(page, workspace, `#/c/${workspace.channels.engineering}`);
    // The pinned bar above repeats it; the message comes after.
    await expect(page.getByText("Release checklist for 0.2:").last()).toBeVisible();
    await shot("engineering");

    // Home, from a conversation, opens the drawer.
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Home", exact: true })
      .tap();
    const drawer = page.getByRole("navigation", { name: "Workspace navigation" });
    await expect(drawer).toBeVisible();
    await shot("drawer");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    await go(page, `#/c/${workspace.channels.design}/t/${workspace.mockup}`);
    await expect(page.getByText("Good call, I'll try it 20% larger")).toBeVisible();
    await shot("thread");
  });
}
