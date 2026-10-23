import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import { recoverAccount } from "../src/recover.js";
import { codeFor, stepAt } from "../src/twoStep.js";

/**
 * Two-step sign-in (E11): set up with the password and a first code, asked
 * for after the password at every sign-in, each code once, recovery codes
 * once each, turned off with the password, and reset by an admin or the host.
 */
let server: WorkspaceServer | undefined;
let dataDir: string;
let base: string;
let owner: { token: string; id: string };
let member: { token: string; id: string };

/** The clock the codes are read against, moved by the tests; the network keeps its own. */
let now = Date.UTC(2026, 9, 23, 12, 0, 5);

/** Rate limits are off unless given; `{}` is the defaults. */
async function start(
  rateLimits: false | Record<string, { burst: number; perMinute: number }> = false,
) {
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits,
    logger: false,
    workspaceName: "Rocket Team",
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function call(path: string, token: string | null, body?: unknown, method = "POST") {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as any };
}

async function register(handle: string) {
  const made = await call("/api/auth/register", null, {
    handle,
    displayName: handle,
    password: "password123",
  });
  return { token: made.data.token as string, id: made.data.user.id as string };
}

/** Turns two-step sign-in on for an account; its key and recovery codes. */
async function setUp(token: string) {
  const started = await call("/api/me/two-step", token, { password: "password123" });
  expect(started.status).toBe(200);
  const secret = started.data.secret as string;
  const enabled = await call("/api/me/two-step/enable", token, {
    code: codeFor(secret, stepAt(now)),
  });
  expect(enabled.status).toBe(200);
  return { secret, recoveryCodes: enabled.data.recoveryCodes as string[] };
}

/** The first step: the password, from a client that can answer the second. */
const password = (handle: string, password = "password123") =>
  call("/api/auth/login", null, { handle, password, twoStep: true });
const second = (challenge: string, answer: { code: string } | { recoveryCode: string }) =>
  call("/api/auth/two-step", null, { challenge, ...answer });
/** Moves the clock on by whole time steps. */
const later = (steps: number) => {
  now += steps * 30_000;
  vi.setSystemTime(now);
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now });
  dataDir = mkdtempSync(join(tmpdir(), "slackoss-two-step-"));
  await start();
  owner = await register("owner");
  member = await register("maya");
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("setting two-step sign-in up", () => {
  it("takes the password, then a code from the new key, and gives ten recovery codes once", async () => {
    expect((await call("/api/me/two-step", member.token, undefined, "GET")).data).toEqual({
      enabled: false,
      recoveryCodesLeft: 0,
    });
    expect((await call("/api/me/two-step", member.token, { password: "wrong-one" })).status).toBe(
      403,
    );
    const started = await call("/api/me/two-step", member.token, { password: "password123" });
    expect(started.data.uri).toMatch(
      /^otpauth:\/\/totp\/Rocket%20Team%20on%20Tandem%3Amaya\?secret=[A-Z2-7]{32}&issuer=Rocket%20Team%20on%20Tandem/,
    );
    const secret = started.data.secret as string;

    const wrong = await call("/api/me/two-step/enable", member.token, { code: "000000" });
    expect(wrong).toMatchObject({ status: 400, data: { error: "invalid_two_step_code" } });
    expect((await call("/api/me/two-step", member.token, undefined, "GET")).data.enabled).toBe(
      false,
    );

    const other = await password("maya");
    const enabled = await call("/api/me/two-step/enable", member.token, {
      code: codeFor(secret, stepAt(now)),
    });
    expect(enabled.status).toBe(200);
    expect(enabled.data.recoveryCodes).toHaveLength(10);
    expect((await call("/api/me/two-step", member.token, undefined, "GET")).data).toEqual({
      enabled: true,
      recoveryCodesLeft: 10,
    });
    // Once on, it cannot be set up over itself.
    expect(
      (await call("/api/me/two-step", member.token, { password: "password123" })).data.error,
    ).toBe("two_step_on");
    // Devices already signed in stay signed in.
    expect((await call("/api/me", member.token, undefined, "GET")).status).toBe(200);
    expect(other.data.token).toEqual(expect.any(String));
    expect((await call("/api/me", other.data.token, undefined, "GET")).status).toBe(200);
  });

  it("waits only so long for the first code", async () => {
    const started = await call("/api/me/two-step", member.token, { password: "password123" });
    later(21);
    const enabled = await call("/api/me/two-step/enable", member.token, {
      code: codeFor(started.data.secret, stepAt(now)),
    });
    expect(enabled.data.error).toBe("two_step_setup_expired");
  });
});

describe("signing in with two-step sign-in", () => {
  it("asks for a code after the password, and opens no session until it is right", async () => {
    const { secret } = await setUp(member.token);
    // A client that cannot answer is told why, not let in.
    const old = await call("/api/auth/login", null, { handle: "maya", password: "password123" });
    expect(old).toMatchObject({ status: 401, data: { error: "two_step_required" } });

    const first = await password("maya");
    expect(first.status).toBe(200);
    expect(first.data.token).toBeUndefined();
    const { challenge, expiresAt } = first.data.twoStep;
    expect(expiresAt).toBe(now + 5 * 60_000);
    // A wrong password never reaches the second step.
    expect((await password("maya", "wrong-one")).data.error).toBe("invalid_credentials");

    expect((await second(challenge, { code: "000000" })).data.error).toBe("invalid_two_step_code");
    later(1);
    const signed = await second(challenge, { code: codeFor(secret, stepAt(now)) });
    expect(signed.status).toBe(200);
    expect(signed.data.user.handle).toBe("maya");
    expect(signed.data.recoveryCodesLeft).toBe(10);
    expect((await call("/api/me", signed.data.token, undefined, "GET")).status).toBe(200);
    // The key never leaves in an account's details.
    expect(JSON.stringify(signed.data)).not.toContain(secret);
    expect(
      JSON.stringify((await call("/api/admin/users", owner.token, undefined, "GET")).data),
    ).not.toContain(secret);
    // That challenge is spent.
    expect((await second(challenge, { code: codeFor(secret, stepAt(now)) })).data.error).toBe(
      "two_step_expired",
    );
  });

  it("takes each code once, even inside its window", async () => {
    const { secret } = await setUp(member.token);
    // The code that turned it on is spent already.
    const replayed = await second((await password("maya")).data.twoStep.challenge, {
      code: codeFor(secret, stepAt(now)),
    });
    expect(replayed.data.error).toBe("invalid_two_step_code");

    later(1);
    const code = codeFor(secret, stepAt(now));
    expect((await second((await password("maya")).data.twoStep.challenge, { code })).status).toBe(
      200,
    );
    const again = await second((await password("maya")).data.twoStep.challenge, { code });
    expect(again.data.error).toBe("invalid_two_step_code");
    // The step before is older than the one used: refused too, though still in the window.
    const before = await second((await password("maya")).data.twoStep.challenge, {
      code: codeFor(secret, stepAt(now) - 1),
    });
    expect(before.data.error).toBe("invalid_two_step_code");
    later(1);
    const next = await second((await password("maya")).data.twoStep.challenge, {
      code: codeFor(secret, stepAt(now)),
    });
    expect(next.status).toBe(200);
  });

  it("sends someone back to their password after five wrong codes, or five minutes", async () => {
    const { secret } = await setUp(member.token);
    later(1);
    const { challenge } = (await password("maya")).data.twoStep;
    for (let i = 0; i < 4; i++)
      expect((await second(challenge, { code: "000000" })).data.error).toBe(
        "invalid_two_step_code",
      );
    expect((await second(challenge, { code: "000000" })).data.error).toBe("two_step_expired");
    expect((await second(challenge, { code: codeFor(secret, stepAt(now)) })).data.error).toBe(
      "two_step_expired",
    );

    const slow = (await password("maya")).data.twoStep.challenge;
    later(11);
    expect((await second(slow, { code: codeFor(secret, stepAt(now)) })).data.error).toBe(
      "two_step_expired",
    );
  });

  it("counts wrong codes against the account, which a right password does not clear", async () => {
    const { secret } = await setUp(member.token);
    await server!.stop();
    await start({});
    later(1);
    // Five a minute for a handle: the password, three wrong codes, the
    // password again, and the next wrong code is one too many.
    const { challenge } = (await password("maya")).data.twoStep;
    for (let i = 0; i < 3; i++)
      expect((await second(challenge, { code: "000000" })).data.error).toBe(
        "invalid_two_step_code",
      );
    const again = (await password("maya")).data.twoStep.challenge;
    expect((await second(again, { code: "000000" })).status).toBe(429);
    expect((await second(again, { code: codeFor(secret, stepAt(now)) })).status).toBe(429);
  });

  it("rations the second step by address too, and the password asked before a change", async () => {
    const { secret } = await setUp(member.token);
    await server!.stop();
    // Three for an address, against the handle's five: the fourth is refused.
    await start({ authByAddress: { burst: 3, perMinute: 1 } });
    later(1);
    const { challenge } = (await password("maya")).data.twoStep;
    for (let i = 0; i < 2; i++)
      expect((await second(challenge, { code: "000000" })).data.error).toBe(
        "invalid_two_step_code",
      );
    expect((await second(challenge, { code: codeFor(secret, stepAt(now)) })).status).toBe(429);

    await server!.stop();
    await start({});
    for (let i = 0; i < 5; i++)
      expect(
        (await call("/api/me/two-step/recovery-codes", member.token, { password: "wrong-one" }))
          .status,
      ).toBe(403);
    expect(
      (await call("/api/me/two-step/recovery-codes", member.token, { password: "password123" }))
        .status,
    ).toBe(429);
  });

  it("refuses the second step to someone deactivated since the first", async () => {
    const { secret } = await setUp(member.token);
    later(1);
    const { challenge } = (await password("maya")).data.twoStep;
    await call(`/api/admin/users/${member.id}`, owner.token, { deactivated: true }, "PATCH");
    expect((await second(challenge, { code: codeFor(secret, stepAt(now)) })).data.error).toBe(
      "two_step_expired",
    );
  });

  it("lets the password alone through when an admin turned it off between the steps", async () => {
    await setUp(member.token);
    const { challenge } = (await password("maya")).data.twoStep;
    await call(`/api/admin/users/${member.id}/two-step/reset`, owner.token);
    const signed = await second(challenge, { code: "000000" });
    expect(signed.status).toBe(200);
    expect(signed.data.recoveryCodesLeft).toBe(0);
  });

  it("refuses the second step once the password has changed since the first", async () => {
    const { secret } = await setUp(member.token);
    later(1);
    const { challenge } = (await password("maya")).data.twoStep;
    expect((await call(`/api/admin/users/${member.id}/password`, owner.token)).status).toBe(200);
    expect((await second(challenge, { code: codeFor(secret, stepAt(now)) })).data.error).toBe(
      "two_step_expired",
    );
  });

  it("takes each recovery code once, and a new set in place of the old", async () => {
    const { recoveryCodes } = await setUp(member.token);
    const [first, secondCode] = recoveryCodes;
    // Typed as anyone might: capitals and no dash.
    const typed = first!.toUpperCase().replace("-", "");
    const signed = await second((await password("maya")).data.twoStep.challenge, {
      recoveryCode: typed,
    });
    expect(signed.status).toBe(200);
    expect(signed.data.recoveryCodesLeft).toBe(9);
    const again = await second((await password("maya")).data.twoStep.challenge, {
      recoveryCode: first!,
    });
    expect(again.data.error).toBe("invalid_two_step_code");

    const replaced = await call("/api/me/two-step/recovery-codes", member.token, {
      password: "password123",
    });
    expect(replaced.data.recoveryCodes).toHaveLength(10);
    expect(replaced.data.recoveryCodes).not.toContain(secondCode);
    const stale = await second((await password("maya")).data.twoStep.challenge, {
      recoveryCode: secondCode!,
    });
    expect(stale.data.error).toBe("invalid_two_step_code");
    const fresh = await second((await password("maya")).data.twoStep.challenge, {
      recoveryCode: replaced.data.recoveryCodes[0],
    });
    expect(fresh.data.recoveryCodesLeft).toBe(9);
  });

  it("turns off with the password, after which the password is enough", async () => {
    await setUp(member.token);
    expect(
      (await call("/api/me/two-step/disable", member.token, { password: "wrong-one" })).status,
    ).toBe(403);
    expect(
      (await call("/api/me/two-step/disable", member.token, { password: "password123" })).status,
    ).toBe(200);
    const plain = await call("/api/auth/login", null, { handle: "maya", password: "password123" });
    expect(plain.data.token).toEqual(expect.any(String));
    expect((await call("/api/me/two-step", member.token, undefined, "GET")).data).toEqual({
      enabled: false,
      recoveryCodesLeft: 0,
    });
  });
});

describe("resetting someone's two-step sign-in", () => {
  it("is an admin's, by the password reset's rules, and recorded", async () => {
    await setUp(member.token);
    const listed = async () =>
      (await call("/api/admin/users", owner.token, undefined, "GET")).data.users.find(
        (u: { id: string }) => u.id === member.id,
      ).twoStep;
    expect(await listed()).toBe(true);
    // A member cannot, and nobody resets their own here.
    const other = await register("lee");
    expect(
      (await call(`/api/admin/users/${other.id}/two-step/reset`, member.token)).data.error,
    ).toBe("admin_only");
    expect(
      (await call(`/api/admin/users/${owner.id}/two-step/reset`, owner.token)).data.error,
    ).toBe("cannot_reset_self");

    expect((await call(`/api/admin/users/${member.id}/two-step/reset`, owner.token)).status).toBe(
      200,
    );
    expect(await listed()).toBe(false);
    expect(server!.store.listAudit({ limit: 5 })[0]).toMatchObject({
      action: "user.two_step_reset",
      actorId: owner.id,
      targetId: member.id,
    });
    // Their devices stay signed in, and their next sign-in takes the password alone.
    expect((await call("/api/me", member.token, undefined, "GET")).status).toBe(200);
    expect((await password("maya")).data.token).toEqual(expect.any(String));
    expect(
      (await call(`/api/admin/users/${member.id}/two-step/reset`, owner.token)).data.error,
    ).toBe("two_step_off");
  });

  it("is not for an admin to do to the owner", async () => {
    const admin = await register("admin");
    await call(`/api/admin/users/${admin.id}`, owner.token, { role: "admin" }, "PATCH");
    await setUp(owner.token);
    expect(
      (await call(`/api/admin/users/${owner.id}/two-step/reset`, admin.token)).data.error,
    ).toBe("owner_is_protected");
  });

  it("is done by the host recovering the account from the command line", async () => {
    await setUp(member.token);
    await server!.stop();
    server = undefined;
    const recovered = await recoverAccount({ dataDir, handle: "maya" });
    expect(recovered.twoStepCleared).toBe(true);
    await start();
    const signed = await call("/api/auth/login", null, {
      handle: "maya",
      password: recovered.temporaryPassword,
    });
    expect(signed.data).toMatchObject({ token: expect.any(String), mustChangePassword: true });
    expect(server!.store.listAudit({ limit: 5 })[0]).toMatchObject({
      action: "account.recovered",
      details: { twoStepCleared: true },
    });
  });
});

describe("two-step sign-in for a guest or an app", () => {
  it("is not to be had", async () => {
    server!.setAccessPolicy("guest_allowed");
    const guest = await call("/api/auth/guest", null, { displayName: "Visitor" });
    expect((await call("/api/me/two-step", guest.data.token, undefined, "GET")).status).toBe(403);
    const app = await call("/api/apps", owner.token, { name: "Deploy Bot" });
    // An app's token is no session, which these need.
    expect((await call("/api/me/two-step", app.data.token, undefined, "GET")).status).toBe(401);
  });

  it("has no recovery codes to replace while it is off", async () => {
    expect(
      (await call("/api/me/two-step/recovery-codes", member.token, { password: "password123" }))
        .data.error,
    ).toBe("two_step_off");
  });
});
