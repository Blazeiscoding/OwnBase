import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CredentialProtector } from "../src/main/credentials.js";
import { createSettingsStorage, ownSettings } from "../src/main/settings.js";

const protector: CredentialProtector = {
  isAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
};

/** The page's settings file and the main process's own, as an installed app keeps them. */
function files(page: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "ownbase-own-settings-"));
  const pagePath = join(dir, "settings.json");
  const ownPath = join(dir, "app-settings.json");
  writeFileSync(pagePath, JSON.stringify(page));
  const pageSettings = createSettingsStorage(pagePath, protector);
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return {
    page: pageSettings,
    own: () =>
      ownSettings(createSettingsStorage(ownPath, protector), pageSettings, [
        "hostedWorkspaces",
        "publicAddress",
      ]),
    pageFile: () => read(pagePath),
    ownFile: () => read(ownPath),
  };
}

describe("the main process's own settings", () => {
  it("takes its keys out of the page's file once, leaving the page's own there", async () => {
    const f = files({
      hostedWorkspaces: { version: 2, workspaces: [] },
      publicAddress: "https://chat.example.org",
      appearance: { theme: "dark" },
    });
    const own = f.own();
    expect(await own.get("publicAddress")).toBe("https://chat.example.org");
    expect(f.pageFile()).toEqual({ appearance: { theme: "dark" } });
    expect(f.ownFile()).toMatchObject({
      hostedWorkspaces: { version: 2, workspaces: [] },
      publicAddress: "https://chat.example.org",
    });
  });

  it("never reads what the page writes under its names afterwards", async () => {
    const f = files({ publicAddress: "https://chat.example.org" });
    await f.own().get("publicAddress");
    // The page, or anything running in it, writes a main-owned name.
    await f.page.set("publicAddress", "https://attacker.example");
    // A later launch moves nothing again.
    const later = f.own();
    expect(await later.get("publicAddress")).toBe("https://chat.example.org");
    expect(f.pageFile()).toEqual({ publicAddress: "https://attacker.example" });
  });

  it("keeps a value already in its own file over the page's", async () => {
    const f = files({ publicAddress: "https://old.example.org" });
    const own = f.own();
    await own.set("publicAddress", "https://new.example.org");
    expect(await own.get("publicAddress")).toBe("https://new.example.org");
    expect(f.pageFile()).toEqual({});
  });

  it("answers nothing while the page's file cannot be read, and moves once it can", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ownbase-own-settings-"));
    const pagePath = join(dir, "settings.json");
    writeFileSync(pagePath, "{ damaged");
    const own = ownSettings(
      createSettingsStorage(join(dir, "app-settings.json"), protector),
      createSettingsStorage(pagePath, protector),
      ["publicAddress"],
    );
    await expect(own.get("publicAddress")).rejects.toThrow(/damaged/);
    writeFileSync(pagePath, JSON.stringify({ publicAddress: "https://chat.example.org" }));
    expect(await own.get("publicAddress")).toBe("https://chat.example.org");
  });
});
