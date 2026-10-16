import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CI_SECRET,
  WEBHOOK_EXAMPLE,
  ciExample,
  commandExample,
  commandName,
  curlExample,
  suggestedAppName,
} from "../src/lib/appTemplates.js";

/**
 * The examples Apps and integrations gives to copy (UX-63). The slash command
 * service is run as it would be pasted, against a request signed the way the
 * server signs one, because an example that does not work is worse than none.
 */
const SECRET = "test-signing-secret-not-a-credential";

let service: ChildProcess | undefined;
let folder = "";
afterEach(() => {
  service?.kill();
  service = undefined;
  if (folder) rmSync(folder, { recursive: true, force: true });
  folder = "";
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise((done) => probe.close(done));
  return port;
}

/** Signs a body as the server does (`signatureHeaders` in the server package). */
function signed(body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const signature =
    "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": signature,
  };
}

/** Starts the example as someone would after pasting it into a file. */
async function startExample(code: string): Promise<string> {
  folder = mkdtempSync(join(tmpdir(), "tandem-command-example-"));
  const file = join(folder, "deploy.mjs");
  writeFileSync(file, code);
  const port = await freePort();
  service = spawn(process.execPath, [file], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
    windowsHide: true,
  });
  const url = `http://127.0.0.1:${port}/`;
  for (let tries = 0; tries < 100; tries++) {
    try {
      await fetch(url, { method: "POST", body: "" });
      return url;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("the example never started listening");
}

describe("the slash command example", () => {
  it("answers a signed command privately, and refuses anything unsigned or stale", async () => {
    const url = await startExample(commandExample("deploy", SECRET));
    const form = new URLSearchParams({
      command: "/deploy",
      text: "test",
      user_name: "alice",
    }).toString();

    const answer = await fetch(url, { method: "POST", headers: signed(form), body: form });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ text: "Got /deploy test from @alice" });

    const unsigned = await fetch(url, { method: "POST", body: form });
    expect(unsigned.status).toBe(401);
    const otherSecret = await fetch(url, {
      method: "POST",
      headers: signed(form, "another-secret-not-a-credential"),
      body: form,
    });
    expect(otherSecret.status).toBe(401);
    const stale = await fetch(url, {
      method: "POST",
      headers: signed(form, SECRET, Math.floor(Date.now() / 1000) - 600),
      body: form,
    });
    expect(stale.status).toBe(401);
  });

  it("names the command and the file, and says where the secret goes until there is one", () => {
    const code = commandExample("standup", null);
    expect(code).toContain("Answers /standup for Tandem");
    expect(code).toContain("node standup.mjs");
    expect(code).toContain(`const signingSecret = "paste the app's signing secret here";`);
    // With no command typed yet, it still reads as a whole example.
    expect(commandExample("", SECRET)).toContain("Answers /deploy");
  });

  it("is named the way the server stores commands", () => {
    expect(commandName(" /Deploy ")).toBe("deploy");
    expect(commandName("standup")).toBe("standup");
    expect(suggestedAppName("command", "deploy")).toBe("Deploy Bot");
    expect(suggestedAppName("command", "")).toBe("Command Bot");
    expect(suggestedAppName("ci", "deploy")).toBe("CI");
  });
});

describe("the webhook examples", () => {
  it("posts the same message Send test message does, to the URL given", () => {
    const code = curlExample("http://127.0.0.1:8543/hooks/abc");
    expect(code).toContain("curl -X POST 'http://127.0.0.1:8543/hooks/abc'");
    const body = /-d '(.*)'$/m.exec(code)?.[1];
    expect(JSON.parse(body!)).toEqual(WEBHOOK_EXAMPLE);
  });

  it("keeps the CI step's URL in a repository secret, and builds the JSON with jq", () => {
    const step = ciExample();
    expect(step).toContain(`${CI_SECRET}: \${{ secrets.${CI_SECRET} }}`);
    expect(step).not.toContain("/hooks/");
    expect(step).toContain("if: always()");
    expect(step).toContain(`jq -n --arg text "$TEXT" '{text: $text}'`);
    expect(step).toContain(`curl -fsS -X POST "$${CI_SECRET}"`);
  });
});
