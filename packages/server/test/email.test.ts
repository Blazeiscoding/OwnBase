import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";
import type { ServerExtension } from "../src/extensions.js";
import { codeFor, stepAt } from "../src/twoStep.js";
import { linkIn, startSmtpSink, type SmtpSink } from "./smtpSink.js";

/**
 * Email (G10): an address on an account, confirmed by a mailed link; a
 * mailed link to set a new password, once, for 30 minutes, that answers the
 * same for an address nobody uses; invites sent by email; and, with no SMTP
 * account given, none of it, as `serverInfo` says. Mail goes to a small SMTP
 * server inside the test.
 */
const PUBLIC_URL = "https://chat.example.test";
let server: WorkspaceServer | undefined;
let sink: SmtpSink;
let dataDir: string;
let base: string;
let now = Date.UTC(2026, 10, 20, 9, 0, 0);

async function start(
  options: {
    mail?: boolean;
    rateLimits?: false | Record<string, { burst: number; perMinute: number }>;
    extensions?: ServerExtension[];
  } = {},
) {
  server = await createWorkspaceServer({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    logger: false,
    rateLimits: options.rateLimits ?? false,
    workspaceName: "Rocket Team",
    publicUrl: PUBLIC_URL,
    extensions: options.extensions,
    ...(options.mail === false
      ? {}
      : {
          mail: {
            smtpUrl: `smtp://rocket:password123@127.0.0.1:${sink.port}`,
            from: "Rocket Team <chat@example.test>",
          },
        }),
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
    // With a public address, the first account needs the claim code from here too.
    ...(server!.claimCode ? { claimCode: server!.claimCode } : {}),
  });
  expect(made.status).toBe(201);
  return { token: made.data.token as string, id: made.data.user.id as string, handle };
}

const info = async () => (await call("/api/server-info", null, undefined, "GET")).data;
const tokenOf = (link: string) => link.slice(link.lastIndexOf("/") + 1);

/** Sets and confirms an address for an account, through the mail. */
async function confirmAddress(token: string, email: string) {
  const before = sink.mails.length;
  expect((await call("/api/me/email", token, { email, password: "password123" })).status).toBe(200);
  const mail = await sink.mail(before);
  const confirmed = await call("/api/auth/email/confirm", null, {
    token: tokenOf(linkIn(mail, PUBLIC_URL)),
  });
  expect(confirmed.status).toBe(200);
}

/** Asks for a link to set a new password, and the token it mails, if any. */
async function forgot(email: string) {
  const before = sink.mails.length;
  const answer = await call("/api/auth/password/forgot", null, { email });
  await server!.flushMail();
  const mail = sink.mails[before];
  return { answer, token: mail ? tokenOf(linkIn(mail, PUBLIC_URL)) : null, mail };
}

const signIn = (handle: string, password: string) =>
  call("/api/auth/login", null, { handle, password, twoStep: true });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now });
  dataDir = mkdtempSync(join(tmpdir(), "ownbase-email-"));
  sink = await startSmtpSink();
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await sink.stop();
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("with no SMTP account", () => {
  it("serverInfo says the server sends no email, and every email route refuses", async () => {
    await start({ mail: false });
    expect((await info()).email).toBe(false);
    const owner = await register("owner");
    const refusals = [
      await call("/api/auth/password/forgot", null, { email: "owner@example.test" }),
      await call("/api/auth/password/reset", null, { token: "abc", password: "password456" }),
      await call("/api/auth/email/confirm", null, { token: "abc" }),
      await call("/api/me/email", owner.token, undefined, "GET"),
      await call("/api/me/email", owner.token, {
        email: "owner@example.test",
        password: "password123",
      }),
    ];
    for (const refused of refusals) {
      expect(refused.status).toBe(403);
      expect(refused.data.error).toBe("email_off");
    }
    expect(sink.mails).toHaveLength(0);
  });

  it("will not start sending without --public-url, which the links lead to", async () => {
    await expect(
      createWorkspaceServer({
        dataDir,
        port: 0,
        mdns: false,
        logger: false,
        mail: { smtpUrl: `smtp://127.0.0.1:${sink.port}`, from: "chat@example.test" },
      }),
    ).rejects.toThrow(/--public-url/);
  });
});

describe("an address on an account", () => {
  it("counts only once the mailed link is opened, and the link works once", async () => {
    await start();
    expect((await info()).email).toBe(true);
    const owner = await register("owner");
    const set = await call("/api/me/email", owner.token, {
      email: "Owner@Example.test",
      password: "password123",
    });
    expect(set.status).toBe(200);
    const mail = await sink.mail();
    // Mail servers take a domain in any case; nodemailer writes it lowercase.
    expect(mail.to.map((to) => to.toLowerCase())).toEqual(["owner@example.test"]);
    expect(mail.from).toBe("chat@example.test");
    expect(mail.user).toBe("rocket");
    expect(mail.subject).toBe("Confirm your email address for Rocket Team");
    expect(mail.text).toContain("@owner asked to use this address");
    expect(mail.raw).toMatch(/Content-Type: text\/html/i);
    const link = linkIn(mail, PUBLIC_URL);
    expect(link).toMatch(/^https:\/\/chat\.example\.test\/#\/verify-email\/[0-9a-f]{48}$/);

    expect((await call("/api/me/email", owner.token, undefined, "GET")).data).toEqual({
      email: null,
      verifiedAt: null,
      pending: "Owner@Example.test",
    });
    // Not confirmed yet: no link to set a password goes to it.
    expect((await forgot("owner@example.test")).token).toBeNull();

    const confirmed = await call("/api/auth/email/confirm", null, { token: tokenOf(link) });
    expect(confirmed).toEqual({ status: 200, data: { email: "Owner@Example.test" } });
    expect((await call("/api/me/email", owner.token, undefined, "GET")).data).toEqual({
      email: "Owner@Example.test",
      verifiedAt: now,
      pending: null,
    });
    const again = await call("/api/auth/email/confirm", null, { token: tokenOf(link) });
    expect(again.status).toBe(410);
    expect(again.data.error).toBe("email_link_gone");
  });

  it("needs the account's password", async () => {
    await start();
    const owner = await register("owner");
    const refused = await call("/api/me/email", owner.token, {
      email: "owner@example.test",
      password: "not-the-password",
    });
    expect(refused.status).toBe(403);
    expect(refused.data.error).toBe("invalid_credentials");
    await server!.flushMail();
    expect(sink.mails).toHaveLength(0);
  });

  it("belongs to one account: another asking for it is answered the same, and only the mailbox is told", async () => {
    await start();
    const owner = await register("owner");
    const maya = await register("maya");
    await confirmAddress(owner.token, "shared@example.test");

    const asked = await call("/api/me/email", maya.token, {
      email: "SHARED@example.test",
      password: "password123",
    });
    expect(asked).toEqual({ status: 200, data: { ok: true } });
    expect((await call("/api/me/email", maya.token, undefined, "GET")).data.pending).toBe(
      "SHARED@example.test",
    );
    const told = await sink.mail(1);
    expect(told.subject).toBe("Your email address in Rocket Team");
    expect(told.text).toContain("already belongs to another account");
    expect(told.text).not.toContain(PUBLIC_URL);
    expect((await call("/api/me/email", owner.token, undefined, "GET")).data.email).toBe(
      "shared@example.test",
    );
  });
});

describe("forgot password", () => {
  it("mails a link that sets a new password once, ends every session, and keeps the old one from working", async () => {
    await start();
    const owner = await register("owner");
    await confirmAddress(owner.token, "owner@example.test");

    const { answer, token, mail } = await forgot("OWNER@example.test");
    expect(answer).toEqual({ status: 200, data: { ok: true } });
    expect(mail!.to).toEqual(["owner@example.test"]);
    expect(mail!.subject).toBe("Set a new password for Rocket Team");
    expect(mail!.text).toContain("your account @owner in Rocket Team");
    expect(mail!.text).toContain("If this was not you");
    expect(linkIn(mail!, PUBLIC_URL)).toMatch(/\/#\/reset\/[0-9a-f]{48}$/);

    const reset = await call("/api/auth/password/reset", null, {
      token,
      password: "password456",
    });
    expect(reset).toEqual({ status: 200, data: { handle: "owner" } });
    expect((await call("/api/me", owner.token, undefined, "GET")).status).toBe(401);
    expect((await signIn("owner", "password123")).status).toBe(401);
    expect((await signIn("owner", "password456")).status).toBe(200);

    const twice = await call("/api/auth/password/reset", null, {
      token,
      password: "password789",
    });
    expect(twice.status).toBe(410);
    expect(twice.data.error).toBe("email_link_gone");
    expect((await signIn("owner", "password456")).status).toBe(200);
  });

  it("refuses a link more than 30 minutes old", async () => {
    await start();
    const owner = await register("owner");
    await confirmAddress(owner.token, "owner@example.test");
    const { token } = await forgot("owner@example.test");
    now += 31 * 60_000;
    vi.setSystemTime(now);
    const late = await call("/api/auth/password/reset", null, { token, password: "password456" });
    expect(late.status).toBe(410);
    expect((await signIn("owner", "password123")).status).toBe(200);
  });

  it("answers the same for an address nobody uses, and mails nothing", async () => {
    await start();
    const owner = await register("owner");
    await confirmAddress(owner.token, "owner@example.test");
    const sent = sink.mails.length;
    const known = await forgot("owner@example.test");
    const unknown = await forgot("nobody@example.test");
    expect(unknown.answer).toEqual(known.answer);
    expect(sink.mails).toHaveLength(sent + 1);
    expect(unknown.mail).toBeUndefined();
  });

  it("is rationed by address, the same for one nobody uses, and by client", async () => {
    await start({ rateLimits: {} });
    const owner = await register("owner");
    await confirmAddress(owner.token, "owner@example.test");
    // Long enough for what setting the address spent to come back.
    now += 5 * 60_000;
    vi.setSystemTime(now);
    for (const email of ["owner@example.test", "nobody@example.test"]) {
      const answers = [];
      for (let i = 0; i < 4; i++) answers.push((await forgot(email)).answer.status);
      expect(answers).toEqual([200, 200, 200, 429]);
    }
    // Ten from one client in all, whatever the address.
    const more = [];
    for (let i = 0; i < 4; i++) more.push((await forgot(`other${i}@example.test`)).answer.status);
    expect(more).toEqual([200, 200, 429, 429]);
  });

  it("still asks for two-step sign-in's code after a new password", async () => {
    await start();
    const owner = await register("owner");
    await confirmAddress(owner.token, "owner@example.test");
    const started = await call("/api/me/two-step", owner.token, { password: "password123" });
    const enabled = await call("/api/me/two-step/enable", owner.token, {
      code: codeFor(started.data.secret, stepAt(now)),
    });
    expect(enabled.status).toBe(200);

    const { token } = await forgot("owner@example.test");
    expect(
      (await call("/api/auth/password/reset", null, { token, password: "password456" })).status,
    ).toBe(200);
    const first = await signIn("owner", "password456");
    expect(first.status).toBe(200);
    expect(first.data.token).toBeUndefined();
    expect(first.data.twoStep.challenge).toEqual(expect.any(String));
  });

  it("stops a link working once the password is changed another way", async () => {
    await start();
    const owner = await register("owner");
    await confirmAddress(owner.token, "owner@example.test");
    const { token } = await forgot("owner@example.test");
    const changed = await call("/api/auth/password", owner.token, {
      currentPassword: "password123",
      newPassword: "password456",
    });
    expect(changed.status).toBe(200);
    const late = await call("/api/auth/password/reset", null, { token, password: "password789" });
    expect(late.status).toBe(410);
  });

  it("mails nobody but the owner while single sign-on is required", async () => {
    const required: ServerExtension = { name: "signer", requiresSingleSignOn: () => true };
    await start({ extensions: [required] });
    const owner = await register("owner");
    // Single sign-on makes the other accounts; one with a password is made here.
    const member = server!.store.people.create({
      handle: "maya",
      displayName: "Maya",
      passwordHash: "x",
      salt: "y",
      role: "member",
    });
    server!.store.email.confirm(member.id, "maya@example.test");
    await confirmAddress(owner.token, "owner@example.test");
    expect((await forgot("maya@example.test")).token).toBeNull();
    expect((await forgot("owner@example.test")).token).toEqual(expect.any(String));
  });

  it("mails nothing for a deactivated account", async () => {
    await start();
    const owner = await register("owner");
    const maya = await register("maya");
    await confirmAddress(maya.token, "maya@example.test");
    expect(
      (await call(`/api/admin/users/${maya.id}`, owner.token, { deactivated: true }, "PATCH"))
        .status,
    ).toBe(200);
    const { answer, token } = await forgot("maya@example.test");
    expect(answer.status).toBe(200);
    expect(token).toBeNull();
  });
});

describe("invites by email", () => {
  it("sends the invite's link, and only for one that still works", async () => {
    await start();
    const owner = await register("owner");
    const made = await call("/api/invites", owner.token, { maxUses: 1 });
    const code = made.data.invite.code as string;
    const sent = await call(`/api/invites/${code}/email`, owner.token, {
      email: "new.person@example.test",
    });
    expect(sent).toEqual({ status: 200, data: { ok: true } });
    const mail = await sink.mail();
    expect(mail.to).toEqual(["new.person@example.test"]);
    expect(mail.subject).toBe("owner invited you to Rocket Team");
    expect(linkIn(mail, PUBLIC_URL)).toBe(`${PUBLIC_URL}/#/join/${code}`);
    expect(mail.text).toContain("ask owner about it");

    await call(`/api/invites/${code}`, owner.token, undefined, "DELETE");
    const revoked = await call(`/api/invites/${code}/email`, owner.token, {
      email: "new.person@example.test",
    });
    expect(revoked.status).toBe(409);
    expect(revoked.data.error).toBe("invite_inactive");
  });

  it("says so when the mail server does not take it", async () => {
    await start();
    const owner = await register("owner");
    const code = (await call("/api/invites", owner.token, {})).data.invite.code as string;
    await sink.stop();
    const failed = await call(`/api/invites/${code}/email`, owner.token, {
      email: "new.person@example.test",
    });
    expect(failed.status).toBe(502);
    expect(failed.data.error).toBe("mail_failed");
    sink = await startSmtpSink();
  });
});
