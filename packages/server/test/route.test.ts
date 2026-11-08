import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { endpoint, json, type Role, type User } from "@ownbase/protocol";
import { createRouter } from "../src/route.js";

/**
 * Every REST route is registered from its declaration: who may call it, what
 * it reads, and what it answers come from there, and nowhere else.
 */

const declared = {
  guests: endpoint({
    method: "GET",
    path: "/api/test/guests",
    access: "guest",
    answer: json<{ id: string }>(),
  }),
  members: endpoint({
    method: "POST",
    path: "/api/test/members/:id",
    access: "member",
    body: z.object({ count: z.number().int() }),
    answer: json<{ id: string; count: number }>(),
  }),
  admins: endpoint({
    method: "GET",
    path: "/api/test/admins",
    access: "admin",
    answer: json<{ ok: true }>(),
  }),
  password: endpoint({
    method: "POST",
    path: "/api/test/password",
    access: "member",
    whileLocked: true,
    answer: json<{ ok: true }>(),
  }),
};

const person = (id: string, role: Role) => ({ id, role }) as User;
const people: Record<string, User> = {
  guest: person("G", "guest"),
  member: person("M", "member"),
  admin: person("A", "admin"),
  locked: person("L", "member"),
};

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function server() {
  const app = Fastify();
  apps.push(app);
  const { route } = createRouter({
    app,
    log: app.log,
    sessionUser: (req) => people[req.headers.authorization ?? ""] ?? null,
    mustChangePassword: (id) => id === "L",
    botCaller: () => null,
    sayScopes: () => {},
  });
  route(declared.guests, async ({ user }) => ({ id: user.id }));
  route(declared.members, async ({ user, body }) => ({ id: user.id, count: body.count }));
  route(declared.admins, async () => ({ ok: true }));
  route(declared.password, async () => ({ ok: true }));
  return app;
}

const call = async (
  app: ReturnType<typeof Fastify>,
  method: "GET" | "POST",
  url: string,
  who?: string,
  body?: unknown,
) => {
  const res = await app.inject({
    method,
    url,
    headers: who ? { authorization: who } : {},
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, data: res.json() as Record<string, unknown> };
};

describe("a declared route", () => {
  it("lets in whom it declares, and refuses everyone else in one shape", async () => {
    const app = server();
    expect(await call(app, "GET", "/api/test/guests")).toMatchObject({
      status: 401,
      data: { error: "unauthorized" },
    });
    expect((await call(app, "GET", "/api/test/guests", "guest")).data).toEqual({ id: "G" });
    expect(await call(app, "POST", "/api/test/members/1", "guest", { count: 1 })).toMatchObject({
      status: 403,
      data: { error: "guest_not_allowed" },
    });
    expect((await call(app, "POST", "/api/test/members/1", "member", { count: 2 })).data).toEqual({
      id: "M",
      count: 2,
    });
    expect((await call(app, "GET", "/api/test/admins", "member")).data.error).toBe("admin_only");
    expect((await call(app, "GET", "/api/test/admins", "admin")).status).toBe(200);
  });

  it("refuses an account that must choose a new password, but for what it declares open", async () => {
    const app = server();
    expect(await call(app, "GET", "/api/test/guests", "locked")).toMatchObject({
      status: 403,
      data: { error: "password_change_required" },
    });
    expect((await call(app, "POST", "/api/test/password", "locked")).status).toBe(200);
  });

  it("refuses a body its schema does not take, before the handler sees it", async () => {
    const app = server();
    for (const body of [{ count: "2" }, { count: 1.5 }, {}]) {
      expect(await call(app, "POST", "/api/test/members/1", "member", body)).toMatchObject({
        status: 400,
        data: { error: "invalid_request" },
      });
    }
  });
});

describe("a route registered without a declaration", () => {
  it("is refused when it is added", () => {
    const app = server();
    expect(() => app.get("/api/test/undeclared", async () => ({}))).toThrow(
      "GET /api/test/undeclared is not a declared endpoint",
    );
    expect(() => app.post("/hooks/undeclared", async () => ({}))).toThrow();
  });
});
