import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let launched: { app: ElectronApplication; data: string } | undefined;

test.afterEach(async ({}, info) => {
  if (!launched) return;
  const { app, data } = launched;
  launched = undefined;
  const passed = info.status === info.expectedStatus;
  if (passed) {
    await app.close();
  } else {
    // Stopped part-way, the app may still be hosting, and closing it would wait
    // on a quit confirmation nobody is there to answer, left open on the screen
    // of whoever ran the test. End it instead, and on Windows end the whole
    // tree: Playwright starts the app through cmd.exe and hands back that shell,
    // so killing only the process it returns leaves the app running.
    const pid = app.process().pid;
    if (process.platform === "win32" && pid)
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else app.process().kill("SIGKILL");
  }
  try {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    // A cleanup error must not hide the failure that brought us here.
    if (passed) throw error;
  }
});

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

test("packaged Windows app boots with sandbox, hosts a workspace, serves the web client, and keeps hosting only while asked to", async ({}, info) => {
  const data = mkdtempSync(join(tmpdir(), "slackoss-desktop-"));
  // A terminal inside an Electron-based tool can pass this down, and it turns
  // the app into plain Node: launch then fails with "bad option".
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env;
  const app = await electron.launch({
    executablePath: resolve("apps/desktop/release/win-unpacked/OwnBase.exe"),
    env: {
      ...inherited,
      SLACKOSS_TEST: "1",
      SLACKOSS_TEST_MEDIA: "1",
      SLACKOSS_USER_DATA_DIR: data,
    },
  });
  launched = { app, data };

  const page = await app.firstWindow();
  expect(await app.evaluate(({ app }) => app.getName())).toBe("OwnBase");
  expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(data);
  await expect(page).toHaveTitle("OwnBase");
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await expect(page.getByText("Find your workspace", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => typeof (window as any).slackoss.hostingStart)).toBe("function");
  // What the window was really created with. Electron has this method but
  // leaves it out of its types, so the one property read is named here.
  type CreatedWith = { getLastWebPreferences(): { sandbox?: boolean } };
  expect(
    await app.evaluate(
      ({ BrowserWindow }) =>
        (
          BrowserWindow.getAllWindows()[0]!.webContents as unknown as CreatedWith
        ).getLastWebPreferences().sandbox,
    ),
  ).toBe(true);
  // A test cannot click the tray, but its menu is rebuilt on every change, so
  // each menu it is given can be read as it is given, and the last one clicked.
  await app.evaluate(({ Tray }) => {
    const menus: { label: string; enabled: boolean }[][] = [];
    (globalThis as any).trayMenus = menus;
    const setContextMenu = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function (menu) {
      if (menu) {
        (globalThis as any).trayMenu = menu;
        menus.push(
          menu.items
            .filter((item) => item.type !== "separator")
            .map((item) => ({ label: item.label, enabled: item.enabled })),
        );
      }
      return setContextMenu.call(this, menu);
    };
  });
  const trayMenu = () => app.evaluate(() => (globalThis as any).trayMenus.at(-1));
  await page.getByRole("button", { name: "Host a workspace on this computer" }).click();
  await page.getByPlaceholder("Workspace name (e.g. Rocket Team)").fill("Desktop Test");
  await page.getByRole("button", { name: "Start hosting", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("desktopowner");
  await page.getByLabel("Display name", { exact: true }).fill("Desktop Owner");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Join workspace", exact: true }).click();
  await expect(page.locator("textarea")).toBeVisible();
  await dismissWelcome(page);
  const status = await page.evaluate(() => (window as any).slackoss.hostingStatus());
  // The app grants its own notifications, so it has nothing to ask about;
  // refused, every notification it tried to show failed without a word.
  expect(await page.evaluate(() => Notification.permission)).toBe("granted");
  await expect(page.getByRole("region", { name: "Notifications" })).toHaveCount(0);
  await expect.poll(trayMenu).toEqual([
    { label: "Open OwnBase", enabled: true },
    { label: `Hosting Desktop Test · port ${status.port} · 1 connected`, enabled: false },
    { label: "Stop hosting", enabled: true },
    { label: "Stop hosting and quit", enabled: true },
  ]);
  const web = await fetch(`http://127.0.0.1:${status.port}/`);
  expect(web.status).toBe(200);
  expect(await web.text()).toContain('<div id="root">');
  await page.getByRole("button", { name: "Start a huddle", exact: true }).click();
  // The fake devices are two microphones, so a first huddle asks which first.
  const check = page.getByRole("dialog", { name: "Choose your microphone and camera" });
  await expect(check.getByText(/^Listening to/)).toBeVisible();
  await check.getByRole("button", { name: "Join huddle", exact: true }).click();
  await expect(page.getByText("Huddle in #general", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await page.screenshot({ path: info.outputPath("desktop.png") });
  const metrics = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((m) => ({ type: m.type, workingSetKB: m.memory.workingSetSize })),
  );
  await info.attach("process-memory", {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
  });
  console.log("Desktop process memory (KiB):", metrics);

  // Manage hosting from inside the workspace being hosted.
  const manage = page.getByRole("button", { name: "Manage hosting", exact: true });
  await manage.click();
  const live = page.getByRole("dialog", { name: "Workspace is live" });
  // Its overview: the workspace, where teammates reach it, and a code for phones.
  await expect(live.getByText("Desktop Test", { exact: true })).toBeVisible();
  await expect(live.getByRole("img", { name: /^QR code for http:\/\// })).toBeVisible();
  // Already on screen, so there is nothing to open; inviting is what is next.
  await expect(live.getByRole("button", { name: "Open it", exact: true })).toHaveCount(0);
  await live.getByRole("button", { name: "Invite people", exact: true }).click();
  await expect(live).toBeHidden();
  const invite = page.getByRole("dialog", { name: "Invite people", exact: true });
  await expect(invite.locator("code").filter({ hasText: "/#/join/" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(invite).toBeHidden();

  await manage.click();
  await live.getByRole("tab", { name: "Advanced", exact: true }).click();
  await expect(live.getByText(String(status.port), { exact: true })).toBeVisible();

  // Back it up while it runs, into a folder chosen in the system's own dialog.
  const backups = mkdtempSync(join(tmpdir(), "slackoss-desktop-backup-"));
  try {
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [folder],
      })) as unknown as typeof dialog.showOpenDialog;
    }, backups);
    await live.getByRole("tab", { name: "Backups", exact: true }).click();
    await live.getByRole("button", { name: "Back up now", exact: true }).click();
    await expect(live.getByText(/^Backed up Desktop Test to /)).toBeVisible();
    const made = readdirSync(backups);
    expect(made).toEqual([expect.stringMatching(/^desktop-test-/)]);
    const manifest = JSON.parse(readFileSync(join(backups, made[0]!, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ format: 1, workspaceName: "Desktop Test" });
  } finally {
    rmSync(backups, { recursive: true, force: true });
  }
  await page.keyboard.press("Escape");
  await expect(live).toBeHidden();
  await expect(page.locator("textarea")).toBeVisible();

  // Closing the window while hosting keeps the app, and the workspace, running.
  // A window closes asynchronously, so give it long enough to have closed.
  const closedWhileHosting = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    return new Promise<boolean>((resolve) => {
      win.once("closed", () => resolve(true));
      setTimeout(() => resolve(false), 1_000);
      win.close();
    });
  });
  expect(closedWhileHosting).toBe(false);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect((await fetch(`http://127.0.0.1:${status.port}/api/health`)).status).toBe(200);

  // A teammate writes while the window is closed to the tray. The message
  // notifies, and clicking the notification brings the window back at it.
  // A test cannot click a system notification, so the renderer's is recorded.
  await page.evaluate(() => {
    const shown: Array<{ onclick: ((event: Event) => void) | null }> = [];
    (window as any).shownNotifications = shown;
    (window as any).Notification = class {
      static permission = "granted";
      onclick: ((event: Event) => void) | null = null;
      constructor() {
        shown.push(this);
      }
      close() {}
    };
  });
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const focus = win.focus.bind(win);
    (globalThis as any).reveals = 0;
    win.focus = () => {
      (globalThis as any).reveals++;
      focus();
    };
  });
  const hosted = `http://127.0.0.1:${status.port}`;
  const teammate = await (
    await fetch(`${hosted}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: "teammate",
        displayName: "Teammate",
        password: "password123",
      }),
    })
  ).json();
  const auth = { authorization: `Bearer ${teammate.token}`, "content-type": "application/json" };
  const { users } = await (await fetch(`${hosted}/api/users`, { headers: auth })).json();
  const owner = users.find((u: { handle: string }) => u.handle === "desktopowner");
  const dm = await (
    await fetch(`${hosted}/api/channels`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: "dm", memberIds: [owner.id] }),
    })
  ).json();
  const posted = await (
    await fetch(`${hosted}/api/channels/${dm.channel.id}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "desktop notification check" }),
    })
  ).json();
  await expect.poll(() => page.evaluate(() => (window as any).shownNotifications.length)).toBe(1);
  await page.evaluate(() => (window as any).shownNotifications[0].onclick(new Event("click")));
  await expect.poll(() => app.evaluate(() => (globalThis as any).reveals)).toBeGreaterThan(0);
  await expect(page.locator(`[data-mid="${posted.message.id}"]`)).toContainText(
    "desktop notification check",
  );

  // The tray's Stop hosting already says what it does, so it stops the server
  // without asking. The next test stops through Manage hosting's.
  await app.evaluate(({ dialog }) => {
    const shown: string[] = [];
    (globalThis as any).messageBoxes = shown;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      shown.push((args.at(-1) as { message: string }).message);
      return { response: 0, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  });
  await app.evaluate(() =>
    (globalThis as any).trayMenu.items
      .find((item: { label: string }) => item.label === "Stop hosting")
      .click(),
  );
  await expect(manage).toBeHidden();
  await expect
    .poll(() =>
      fetch(`http://127.0.0.1:${status.port}/api/health`).then(
        () => "up",
        () => "down",
      ),
    )
    .toBe("down");
  await expect.poll(trayMenu).toEqual([
    { label: "Open OwnBase", enabled: true },
    { label: "Not hosting", enabled: false },
    { label: "Stop hosting", enabled: false },
    { label: "Quit OwnBase", enabled: true },
  ]);
  expect(await app.evaluate(() => (globalThis as any).messageBoxes)).toEqual([]);
  expect(errors).toEqual([]);

  // With nothing hosted, closing the last window quits.
  const closed = app.waitForEvent("close");
  await app.evaluate(({ BrowserWindow }) => {
    setTimeout(() => BrowserWindow.getAllWindows()[0]!.close(), 0);
  });
  await closed;
});

test("restarting offers to host the last workspace again instead of reconnecting", async () => {
  const data = mkdtempSync(join(tmpdir(), "slackoss-desktop-resume-"));
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env;
  const env = {
    ...inherited,
    SLACKOSS_TEST: "1",
    SLACKOSS_TEST_MEDIA: "1",
    SLACKOSS_USER_DATA_DIR: data,
  };
  const executablePath = resolve("apps/desktop/release/win-unpacked/OwnBase.exe");
  let app = await electron.launch({ executablePath, env });
  const killTree = () => {
    const pid = app.process().pid;
    if (process.platform === "win32" && pid)
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else app.process().kill("SIGKILL");
  };
  try {
    let page = await app.firstWindow();
    await expect(page.getByText("Find your workspace", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Host a workspace on this computer" }).click();
    await page.getByPlaceholder("Workspace name (e.g. Rocket Team)").fill("Resume Test");
    await page.getByRole("button", { name: "Start hosting", exact: true }).click();
    await page.getByLabel("Username", { exact: true }).fill("resumeowner");
    await page.getByLabel("Display name", { exact: true }).fill("Resume Owner");
    await page.getByLabel("Password", { exact: true }).fill("password123");
    await page.getByRole("button", { name: "Join workspace", exact: true }).click();
    await expect(page.locator("textarea")).toBeVisible();
    await dismissWelcome(page);

    // Stop hosting, which does not ask first, then quit with nothing hosted:
    // a plain window close quits.
    await page.getByRole("button", { name: "Manage hosting", exact: true }).click();
    const live = page.getByRole("dialog", { name: "Workspace is live" });
    await live.getByRole("button", { name: "Stop hosting", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Host a workspace" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Manage hosting", exact: true })).toBeHidden();
    const firstQuit = app.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => {
      setTimeout(() => BrowserWindow.getAllWindows()[0]!.close(), 0);
    });
    await firstQuit;

    // Relaunch with the same profile: no reconnecting to a stopped server.
    app = await electron.launch({ executablePath, env });
    page = await app.firstWindow();
    await expect(page.getByText("Find your workspace", { exact: true })).toBeVisible();
    const resume = page.getByRole("region", { name: "Hosted on this computer" });
    await expect(resume).toBeVisible();
    await resume.getByRole("button", { name: "Start hosting Resume Test" }).click();
    // The saved sign-in still works, so the workspace opens with no password asked.
    await expect(page.locator("textarea")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    const resumed = await page.evaluate(() => (window as any).slackoss.hostingStatus());
    expect(resumed).toMatchObject({ running: true });

    // A name that differs only by punctuation is a separate workspace. Earlier
    // versions put both in one folder and renamed the first.
    const named = async (port: number) =>
      (await (await fetch(`http://127.0.0.1:${port}/api/server-info`)).json()).workspaceName;
    // On a port of its own: on the one Resume Test just left, the window,
    // still reconnecting to Resume Test, could reach it, be refused, and sign
    // out, depending only on when its next try fell.
    const other = await page.evaluate(async () => {
      const bridge = (window as any).slackoss;
      await bridge.hostingStop();
      return bridge.hostingStart({ workspaceName: "Resume-Test", port: 0 });
    });
    expect(other.folder).not.toBe(resumed.folder);
    expect(other.port).not.toBe(resumed.port);
    expect(await named(other.port)).toBe("Resume-Test");

    // Back the new one up while it runs, through the system's folder dialog.
    const backups = mkdtempSync(join(tmpdir(), "slackoss-desktop-restore-"));
    const pick = (folder: string) =>
      app.evaluate(({ dialog }, chosen) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [chosen],
        })) as unknown as typeof dialog.showOpenDialog;
      }, folder);
    await pick(backups);
    const backedUp = await page.evaluate(
      (folder) => (window as any).slackoss.hostingBackup(folder),
      other.folder,
    );
    expect(backedUp.path).toContain("resume-test-");
    const listed = await page.evaluate(async () => {
      const bridge = (window as any).slackoss;
      await bridge.hostingStop();
      return bridge.hostingList();
    });
    expect(listed.workspaces.map((w: { name: string }) => w.name)).toEqual([
      "Resume-Test",
      "Resume Test",
    ]);
    const back = await page.evaluate(
      (folder) => (window as any).slackoss.hostingStart({ folder }),
      resumed.folder,
    );
    expect(back.port).toBe(resumed.port);
    expect(await named(back.port)).toBe("Resume Test");

    // Its folder lost, Resume-Test comes back from the backup into the same
    // place in the list, without starting.
    rmSync(join(data, "hosted", other.folder), { recursive: true, force: true });
    await pick(backedUp.path);
    expect(await page.evaluate(() => (window as any).slackoss.hostingRestore())).toEqual({
      folder: other.folder,
      name: "Resume-Test",
      // What the backup would set off once put back in use, for the host to see first.
      inventory: expect.objectContaining({ sessions: expect.any(Number) }),
    });
    const afterRestore = await page.evaluate(() => (window as any).slackoss.hostingList());
    expect(
      afterRestore.workspaces.find((w: { folder: string }) => w.folder === other.folder),
    ).toMatchObject({ missing: false, running: false, restored: true });
    rmSync(backups, { recursive: true, force: true });
    await expect(page.locator("textarea")).toBeVisible();

    // Renamed while stopped, the new name goes into its database and its
    // folder stays where it is.
    expect(
      await page.evaluate(
        (folder) => (window as any).slackoss.hostingRename(folder, " Resume Renamed "),
        other.folder,
      ),
    ).toEqual({ folder: other.folder, name: "Resume Renamed" });
    const afterRename = await page.evaluate(() => (window as any).slackoss.hostingList());
    expect(
      afterRename.workspaces.find((w: { folder: string }) => w.folder === other.folder),
    ).toMatchObject({ name: "Resume Renamed", missing: false });
    // Open folder shows the folder the list names, whatever the window asks.
    await app.evaluate(({ shell }) => {
      (globalThis as any).opened = [];
      shell.openPath = (async (path: string) => {
        (globalThis as any).opened.push(path);
        return "";
      }) as typeof shell.openPath;
    });
    await page.evaluate(
      (folder) => (window as any).slackoss.hostingOpenFolder(folder),
      other.folder,
    );
    await expect(
      page.evaluate(() => (window as any).slackoss.hostingOpenFolder("../..")),
    ).rejects.toThrow(/not in the list/);
    expect(await app.evaluate(() => (globalThis as any).opened)).toEqual([
      join(data, "hosted", other.folder),
    ]);

    // Renamed while it runs, from the host dialog: the open client and the
    // server both take the new name at once.
    await page.getByRole("button", { name: "Manage hosting", exact: true }).click();
    const renaming = page.getByRole("dialog", { name: "Workspace is live" });
    await renaming.getByRole("button", { name: "Rename Resume Test" }).click();
    const newName = renaming.getByRole("textbox", { name: "New name for Resume Test" });
    await newName.fill("Resume Live");
    await newName.press("Enter");
    await expect(renaming.getByText("Renamed Resume Test to Resume Live.")).toBeVisible();
    expect(await named(back.port)).toBe("Resume Live");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Resume Live");

    // Leave nothing hosted behind: stop, then a plain close quits.
    await page.getByRole("button", { name: "Manage hosting", exact: true }).click();
    const liveAgain = page.getByRole("dialog", { name: "Workspace is live" });
    await liveAgain.getByRole("button", { name: "Stop hosting", exact: true }).click();
    // Closed while still stopping, the window would go to the tray instead.
    await expect(page.getByRole("dialog", { name: "Host a workspace" })).toBeVisible();
    const secondQuit = app.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => {
      setTimeout(() => BrowserWindow.getAllWindows()[0]!.close(), 0);
    });
    await secondQuit;
  } finally {
    try {
      killTree();
    } catch {
      // Already quit: the directory removes below regardless.
    }
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("a workspace chosen to start with OwnBase starts when it opens, and at sign-in waits in the tray", async () => {
  const data = mkdtempSync(join(tmpdir(), "slackoss-desktop-launch-"));
  const scheduledBackups = mkdtempSync(join(tmpdir(), "slackoss-desktop-scheduled-"));
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env;
  const env = {
    ...inherited,
    SLACKOSS_TEST: "1",
    SLACKOSS_TEST_MEDIA: "1",
    SLACKOSS_USER_DATA_DIR: data,
  };
  const executablePath = resolve("apps/desktop/release/win-unpacked/OwnBase.exe");
  let app = await electron.launch({ executablePath, env });
  const killTree = () => {
    const pid = app.process().pid;
    if (process.platform === "win32" && pid)
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else app.process().kill("SIGKILL");
  };
  const named = async (port: number) =>
    (await (await fetch(`http://127.0.0.1:${port}/api/server-info`)).json()).workspaceName;
  /** Quits while hosting, answering the stop-hosting question as a person would. */
  const quitHosting = async () => {
    const closed = app.waitForEvent("close");
    await app.evaluate(({ app: electronApp, dialog }) => {
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false,
      })) as unknown as typeof dialog.showMessageBox;
      setTimeout(() => electronApp.quit(), 0);
    });
    await closed;
  };
  try {
    let page = await app.firstWindow();
    await expect(page.getByText("Find your workspace", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Host a workspace on this computer" }).click();
    await page.getByPlaceholder("Workspace name (e.g. Rocket Team)").fill("Launch Test");
    await page.getByRole("button", { name: "Start hosting", exact: true }).click();
    await page.getByLabel("Username", { exact: true }).fill("launchowner");
    await page.getByLabel("Display name", { exact: true }).fill("Launch Owner");
    await page.getByLabel("Password", { exact: true }).fill("password123");
    await page.getByRole("button", { name: "Join workspace", exact: true }).click();
    await expect(page.locator("textarea")).toBeVisible();
    await dismissWelcome(page);
    const hosted = await page.evaluate(() => (window as any).slackoss.hostingStatus());

    // Both choices, made in the host dialog.
    await page.getByRole("button", { name: "Manage hosting", exact: true }).click();
    const live = page.getByRole("dialog", { name: "Workspace is live" });
    // The owner's own window is connected to it.
    await expect(live).toContainText("Connected now: 1 person");
    await live.getByRole("tab", { name: "Advanced", exact: true }).click();
    const choices = live.getByRole("group", { name: "When this computer starts" });
    const withApp = choices.getByRole("checkbox", {
      name: "Start hosting Launch Test when OwnBase opens",
    });
    await withApp.check();
    await expect(withApp).toBeChecked();
    const atSignIn = choices.getByRole("checkbox", {
      name: "Open OwnBase when you sign in to this computer",
    });
    await atSignIn.check();
    await expect(atSignIn).toBeChecked();
    expect(await page.evaluate(() => (window as any).slackoss.hostingOpenAtLogin())).toBe(true);

    // Backed up by itself into a folder the system asked for: the first
    // backup is made at once.
    await app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [chosen],
      })) as unknown as typeof dialog.showOpenDialog;
    }, scheduledBackups);
    await live.getByRole("tab", { name: "Backups", exact: true }).click();
    const automatic = live.getByRole("group", { name: "Automatic backups" });
    await automatic.getByRole("button", { name: "Back up automatically…" }).click();
    await expect(
      live.getByText(`Launch Test will be backed up every day into ${scheduledBackups}.`),
    ).toBeVisible();
    await expect
      .poll(
        () =>
          readdirSync(scheduledBackups).filter((name) =>
            readdirSync(join(scheduledBackups, name)).includes("manifest.json"),
          ).length,
      )
      .toBe(1);
    // The manifest appears before verification finishes. Wait for the host to
    // record the completed scheduled backup, not merely its staged files.
    await expect
      .poll(() =>
        page.evaluate(async (folder) => {
          const listed = await (window as any).slackoss.hostingList();
          return listed.workspaces.find(
            (workspace: { folder: string }) => workspace.folder === folder,
          );
        }, hosted.folder),
      )
      .toMatchObject({
        lastBackupAt: expect.any(Number),
        autoBackup: { lastAt: expect.any(Number) },
        autoBackupError: null,
      });
    await expect(automatic).toContainText(
      "Launch Test is backed up every day, keeping the newest 7",
    );
    // Keep an enabled backup destination present until the app has quit;
    // verification, pruning and later launches may still need the folder.

    // Waking from sleep announces the workspace again, and it keeps answering
    // and can still be found on the network, here by this app's own browser.
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
    expect(await named(hosted.port)).toBe("Launch Test");
    await expect
      .poll(
        () =>
          page.evaluate(async () =>
            ((await (window as any).slackoss.lanSnapshot()) as { name: string }[]).some(
              (server) => server.name === "Launch Test",
            ),
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await quitHosting();

    // Opened by the OS at sign-in: hosting starts, and no window opens.
    app = await electron.launch({ executablePath, env, args: ["--hidden"] });
    await expect.poll(() => named(hosted.port).catch(() => null)).toBe("Launch Test");
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    await quitHosting();

    // Opened by a person: the window opens, and hosting starts with it.
    app = await electron.launch({ executablePath, env });
    page = await app.firstWindow();
    await expect.poll(() => named(hosted.port).catch(() => null)).toBe("Launch Test");
    await expect(page.locator("textarea")).toBeVisible();
    await page.evaluate(() => (window as any).slackoss.hostingSetStartOnLaunch(null));
    const list = await page.evaluate(() => (window as any).slackoss.hostingList());
    expect(list.workspaces[0]).toMatchObject({ name: "Launch Test", startsOnLaunch: false });
    await quitHosting();
  } finally {
    try {
      killTree();
    } catch {
      // Already quit: the directory removes below regardless.
    }
    for (const directory of [data, scheduledBackups]) {
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // A fixture still held open must not hide why the test failed.
      }
    }
  }
});

test("a window whose page crashes comes back by itself, and hosting carries on (REV-09)", async () => {
  const data = mkdtempSync(join(tmpdir(), "slackoss-desktop-crash-"));
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env;
  const app = await electron.launch({
    executablePath: resolve("apps/desktop/release/win-unpacked/OwnBase.exe"),
    env: {
      ...inherited,
      SLACKOSS_TEST: "1",
      SLACKOSS_TEST_MEDIA: "1",
      SLACKOSS_USER_DATA_DIR: data,
    },
  });
  launched = { app, data };
  const page = await app.firstWindow();
  await expect(page.getByText("Find your workspace", { exact: true })).toBeVisible();
  const hosted = await page.evaluate(() =>
    (window as any).slackoss.hostingStart({ workspaceName: "Crash-Test", port: 0 }),
  );
  expect(hosted.running).toBe(true);
  const health = () =>
    fetch(`http://127.0.0.1:${hosted.port}/api/health`).then(
      (response) => response.status,
      () => 0,
    );
  expect(await health()).toBe(200);

  // The page dies; the main process, and the workspace it hosts, do not.
  // What the main process saw is kept, to say what happened if this fails.
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    const seen = { gone: [] as string[], loads: 0 };
    (globalThis as any).crashTest = seen;
    contents.on("render-process-gone", (_event, details) => void seen.gone.push(details.reason));
    contents.on("did-finish-load", () => void seen.loads++);
  });
  const seen = () =>
    app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents;
      return { ...(globalThis as any).crashTest, url: contents?.getURL() };
    });
  const showsApp = (loads: number) =>
    app.evaluate(async ({ BrowserWindow }, loads) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents;
      if (!contents || (globalThis as any).crashTest.loads < loads) return false;
      return contents
        .executeJavaScript("!!document.querySelector('#root')?.childElementCount")
        .catch(() => false);
    }, loads);
  for (let crash = 1; crash <= 2; crash++) {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer(),
    );
    try {
      await expect.poll(() => showsApp(crash), { timeout: 20_000 }).toBe(true);
    } catch (error) {
      throw new Error(
        `after crash ${crash} the window did not come back: ${JSON.stringify(await seen())}`,
        {
          cause: error,
        },
      );
    }
    expect(await health()).toBe(200);
  }
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await app.evaluate(async ({ BrowserWindow }) => {
    // Stop hosting from the window, so the test's close is not asked to.
    await BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
      "window.slackoss.hostingStop()",
    );
  });
});

/** The packaged app, launched with fresh data of its own for one test. */
async function launchApp(prefix: string) {
  const data = mkdtempSync(join(tmpdir(), prefix));
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env;
  const env = {
    ...inherited,
    SLACKOSS_TEST: "1",
    SLACKOSS_TEST_MEDIA: "1",
    SLACKOSS_USER_DATA_DIR: data,
  };
  const app = await electron.launch({
    executablePath: resolve("apps/desktop/release/win-unpacked/OwnBase.exe"),
    env,
  });
  launched = { app, data };
  const page = await app.firstWindow();
  await expect(page.getByText("Find your workspace", { exact: true })).toBeVisible();
  return { app, page, data, env };
}

for (const closing of ["app quit", "tray quit", "stopped-hosting window close"] as const) {
  test(`the last visible composer edit survives ${closing} and profile restart (N03)`, async () => {
    const first = await launchApp("slackoss-desktop-final-draft-");
    let app = first.app;
    let page = first.page;
    // The tray's menu is rebuilt as hosting starts; the last one is kept to click.
    await app.evaluate(({ Tray }) => {
      const setContextMenu = Tray.prototype.setContextMenu;
      Tray.prototype.setContextMenu = function (menu) {
        (globalThis as any).trayMenu = menu;
        return setContextMenu.call(this, menu);
      };
    });
    await page.getByRole("button", { name: "Host a workspace on this computer" }).click();
    await page.getByPlaceholder("Workspace name (e.g. Rocket Team)").fill("Final Draft Test");
    await page.getByRole("button", { name: "Start hosting", exact: true }).click();
    await page.getByLabel("Username", { exact: true }).fill("draftowner");
    await page.getByLabel("Display name", { exact: true }).fill("Draft Owner");
    await page.getByLabel("Password", { exact: true }).fill("password123");
    await page.getByRole("button", { name: "Join workspace", exact: true }).click();
    await expect(page.locator("textarea")).toBeVisible();
    await dismissWelcome(page);
    // Only the hosting confirmation is accepted automatically. A saving failure
    // must keep the window open and make this ordinary-close regression fail.
    // The tray's quit already says it stops hosting: asking again is answered
    // Cancel, which keeps the app open and fails the test too.
    await app.evaluate(({ dialog }, closing) => {
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string };
        return {
          response:
            (options.title === "Stop hosting and quit?" && closing === "app quit") ||
            options.title === "Local work could not finish saving"
              ? 1
              : 0,
          checkboxChecked: false,
        };
      }) as unknown as typeof dialog.showMessageBox;
    }, closing);
    if (closing === "stopped-hosting window close")
      await page.evaluate(() => (window as any).slackoss.hostingStop());
    const marker = `the last keystroke before ${closing}`;
    // Neither the 250 ms composer debounce nor the 600 ms storage debounce is
    // awaited: the native close must capture and save the actual visible text.
    await page.locator("textarea").fill(marker);
    expect(readFileSync(join(first.data, "settings.json"), "utf8")).not.toContain(marker);
    const exited = app.waitForEvent("close");
    await app.evaluate(({ app, BrowserWindow }, closing) => {
      setTimeout(() => {
        if (closing === "app quit") app.quit();
        else if (closing === "tray quit")
          (globalThis as any).trayMenu.items
            .find((item: { label: string }) => item.label === "Stop hosting and quit")
            .click();
        else BrowserWindow.getAllWindows()[0]!.close();
      }, 0);
    }, closing);
    await exited;
    expect(
      JSON.stringify(JSON.parse(readFileSync(join(first.data, "settings.json"), "utf8"))),
    ).toContain(marker);

    app = await electron.launch({
      executablePath: resolve("apps/desktop/release/win-unpacked/OwnBase.exe"),
      env: first.env,
    });
    launched = { app, data: first.data };
    page = await app.firstWindow();
    await expect(page.getByText("Find your workspace", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start hosting Final Draft Test" }).click();
    await expect(page.locator("textarea")).toHaveValue(marker);
    await page.evaluate(() => (window as any).slackoss.hostingStop());
  });
}

test("a window that loads the app's preload elsewhere is refused, and told nothing (REV-14, F09)", async () => {
  const { app, page } = await launchApp("slackoss-desktop-foreign-");
  // A second window with the app's own preload, showing another page: how a
  // stray or opened window would look to the main process.
  await app.evaluate(async ({ app, BrowserWindow }) => {
    const foreign = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: `${app.getAppPath()}/out/preload/index.cjs`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await foreign.loadURL("about:blank");
  });
  await expect.poll(() => app.windows().length).toBe(2);
  const foreign = app.windows().find((window) => window !== page)!;
  const refused = await foreign.evaluate(async () => {
    const outcome = (call: () => Promise<unknown>) =>
      call().then(
        () => "accepted",
        (error: Error) => error.message,
      );
    const bridge = (window as any).slackoss;
    return {
      read: await outcome(() => bridge.storageGet("servers")),
      write: await outcome(() => bridge.storageSet("foreign", "written")),
      hosting: await outcome(() => bridge.hostingStatus()),
    };
  });
  expect(refused).toEqual({
    read: expect.stringMatching(/did not come from the OwnBase window/),
    write: expect.stringMatching(/did not come from the OwnBase window/),
    hosting: expect.stringMatching(/did not come from the OwnBase window/),
  });

  // It listens for what the app's own window changes, and hears none of it.
  await foreign.evaluate(() => {
    const heard: unknown[] = [];
    (window as any).heard = heard;
    const bridge = (window as any).slackoss;
    bridge.onDraftsChanged((key: string, stored: unknown) => heard.push({ key, stored }));
    bridge.onOutboxChanged((key: string, stored: unknown) => heard.push({ key, stored }));
    bridge.onRecordChanged((key: string, stored: unknown) => heard.push({ key, stored }));
  });
  const stored = await page.evaluate(async () => {
    const bridge = (window as any).slackoss;
    const drafts = await bridge.storageMergeDrafts(
      "drafts:foreign-test",
      { put: { C1: "a private draft" }, remove: [] },
      false,
    );
    const outbox = await bridge.storageMergeOutbox(
      "outbox:foreign-test",
      {
        put: [
          {
            nonce: "foreign-test-nonce",
            channelId: "C1",
            threadRootId: null,
            text: "an unsent message",
            userId: "U1",
            createdAt: Date.now(),
            attachments: [],
            rev: 1,
          },
        ],
        remove: [],
      },
      false,
    );
    const record = await bridge.storageMergeRecord("notification-previews", { "U1 here": "none" });
    return { drafts, outbox: outbox.entries.length, record };
  });
  expect(stored).toEqual({
    drafts: { C1: "a private draft" },
    outbox: 1,
    record: { "U1 here": "none" },
  });
  await page.waitForTimeout(1_000);
  expect(await foreign.evaluate(() => (window as any).heard)).toEqual([]);
});

test("a window that keeps crashing comes back where it was, Try again included (F08)", async () => {
  const { app, page } = await launchApp("slackoss-desktop-place-");
  await page.getByRole("button", { name: "Host a workspace on this computer" }).click();
  await page.getByPlaceholder("Workspace name (e.g. Rocket Team)").fill("Place Test");
  await page.getByRole("button", { name: "Start hosting", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("placeowner");
  await page.getByLabel("Display name", { exact: true }).fill("Place Owner");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Join workspace", exact: true }).click();
  await expect(page.locator("textarea")).toBeVisible();
  await dismissWelcome(page);
  const saved = page.getByRole("navigation").getByRole("button", { name: "Saved", exact: true });
  await saved.click();
  await expect(saved).toHaveAttribute("aria-current", "true");

  // The fourth crash in a minute asks; this answers Try again, and keeps count.
  await app.evaluate(({ dialog, BrowserWindow }) => {
    const seen = { asked: [] as string[][], loads: 0 };
    (globalThis as any).placeTest = seen;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      seen.asked.push((args.at(-1) as { buttons: string[] }).buttons);
      return { response: 0, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
    BrowserWindow.getAllWindows()[0]!.webContents.on("did-finish-load", () => void seen.loads++);
  });
  // The page reports where it is a moment after it gets there.
  await page.waitForTimeout(1_000);
  // Read through the main process: a crashed page's handle stays stale.
  const place = () =>
    app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents;
      return contents
        ?.executeJavaScript(
          `(() => {
            const saved = [...document.querySelectorAll("nav button")].find(
              (button) => button.textContent.trim() === "Saved",
            );
            return saved && document.querySelector("textarea") ? saved.getAttribute("aria-current") : null;
          })()`,
        )
        .catch(() => null);
    });
  const loads = () => app.evaluate(() => (globalThis as any).placeTest.loads as number);
  for (let crash = 1; crash <= 4; crash++) {
    const before = await loads();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer(),
    );
    await expect.poll(loads, { timeout: 20_000 }).toBeGreaterThan(before);
    await expect.poll(place, { timeout: 20_000 }).toBe("true");
  }
  // Three came back by themselves; the fourth asked, and Try again kept the place.
  expect(await app.evaluate(() => (globalThis as any).placeTest.asked)).toEqual([
    ["Try again", "Open from the start", "Quit OwnBase"],
  ]);
  await app.evaluate(async ({ BrowserWindow }) => {
    await BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
      "window.slackoss.hostingStop()",
    );
  });
});
