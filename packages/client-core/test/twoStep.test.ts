import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, ApiError, type LoginResult } from "../src/index.js";

/**
 * Two-step sign-in on the client (E11): signing in says it can answer a
 * second step, which then gives the session; setting it up, recovery codes,
 * turning it off, and an admin's reset.
 */
let server: WorkspaceServer;
let base: string;
let dataDir: string;
let owner: Api;

/** RFC 6238's code for a key and a time step, made here apart from the server's own. */
function totp(secret: string, step: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0"));
  const key = Buffer.from(
    bits
      .join("")
      .match(/.{8}/g)!
      .map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
const stepNow = () => Math.floor(Date.now() / 30_000);

/** A new account with two-step sign-in on; its key and recovery codes. */
async function withTwoStep(handle: string) {
  const made = await new Api(base).register({
    handle,
    displayName: handle,
    password: "password123",
  });
  const api = new Api(base, made.token);
  const { secret, uri } = await api.startTwoStep("password123");
  expect(uri).toContain(`secret=${secret}`);
  const { recoveryCodes } = await api.enableTwoStep(totp(secret, stepNow()));
  return { api, id: made.user.id, secret, recoveryCodes };
}

function challengeOf(result: LoginResult): string {
  if (!("twoStep" in result)) throw new Error("signed in without a second step");
  return result.twoStep.challenge;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-client-two-step-"));
  server = await createWorkspaceServer({ dataDir, port: 0, mdns: false, rateLimits: false });
  base = `http://127.0.0.1:${server.port}`;
  const made = await new Api(base).register({
    handle: "owner",
    displayName: "Owner",
    password: "password123",
  });
  owner = new Api(base, made.token);
});

afterAll(async () => {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("two-step sign-in on the client", () => {
  it("signs in with a code after the password, the second step giving the session", async () => {
    const { api, secret } = await withTwoStep("maya");
    expect(await api.twoStep()).toEqual({ enabled: true, recoveryCodesLeft: 10 });

    const first = await new Api(base).login({ handle: "maya", password: "password123" });
    expect("token" in first).toBe(false);
    // The step after the one that turned it on, which has been used.
    const signed = await new Api(base).signInSecondStep({
      challenge: challengeOf(first),
      code: totp(secret, stepNow() + 1),
    });
    expect(signed.user.handle).toBe("maya");
    expect(signed.recoveryCodesLeft).toBe(10);
    expect((await new Api(base, signed.token).me()).user.handle).toBe("maya");
  });

  it("takes a recovery code in place of one, makes new ones, and turns off", async () => {
    const { api, recoveryCodes } = await withTwoStep("sam");
    const signed = await new Api(base).signInSecondStep({
      challenge: challengeOf(await new Api(base).login({ handle: "sam", password: "password123" })),
      recoveryCode: recoveryCodes[0]!,
    });
    expect(signed.recoveryCodesLeft).toBe(9);

    const { recoveryCodes: fresh } = await api.newRecoveryCodes("password123");
    expect(fresh).toHaveLength(10);
    expect(await api.twoStep()).toEqual({ enabled: true, recoveryCodesLeft: 10 });

    await expect(api.disableTwoStep("wrong-one")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    await api.disableTwoStep("password123");
    const plain = await new Api(base).login({ handle: "sam", password: "password123" });
    expect("token" in plain).toBe(true);
  });

  it("is reset by an admin, whose list says who has it", async () => {
    const { id } = await withTwoStep("lee");
    const listed = async () => (await owner.listAllUsers()).users.find((u) => u.id === id)!.twoStep;
    expect(await listed()).toBe(true);
    await owner.resetTwoStep(id);
    expect(await listed()).toBe(false);
    const error = await owner.resetTwoStep(id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "two_step_off" });
  });
});
