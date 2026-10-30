import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createWorkspaceServer, type WorkspaceServer } from "../src/server.js";

type Callback = { type: string; trigger_id?: string; response_url?: string; view?: { id: string } };
let server: WorkspaceServer;
let stub: Server;
let base: string;
let token: string;
let channel: string;
let app: { app: { id: string }; token: string };
let callbacks: Callback[];
let handler: (payload: Callback, response: ServerResponse) => void;
const held = new Set<ServerResponse>();

function answer(response: ServerResponse, body: unknown = "") {
  response.setHeader("content-type", "application/json");
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function api(method: string, path: string, body?: unknown, auth = token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${auth}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

beforeEach(async () => {
  callbacks = [];
  handler = (_payload, response) => answer(response);
  stub = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (raw.startsWith("{")) return answer(response, { challenge: JSON.parse(raw).challenge });
      const payload = JSON.parse(new URLSearchParams(raw).get("payload")!) as Callback;
      callbacks.push(payload);
      held.add(response);
      response.once("close", () => held.delete(response));
      handler(payload, response);
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    allowPrivateHooks: true,
  });
  base = `http://127.0.0.1:${server.port}`;
  token = (
    await api("POST", "/api/auth/register", {
      handle: "owner",
      displayName: "Owner",
      password: "password123",
    })
  ).body.token;
  channel = server.store.getChannelByName("general")!.id;
  app = (await api("POST", "/api/apps", { name: "Meeting App" })).body;
  expect(
    (
      await api("PUT", `/api/apps/${app.app.id}/interactivity`, {
        url: `http://127.0.0.1:${(stub.address() as { port: number }).port}/interactive`,
      })
    ).status,
  ).toBe(200);
});

afterEach(async () => {
  for (const response of held) if (!response.writableEnded) response.end("");
  await server?.stop();
  stub?.closeAllConnections();
  await new Promise<void>((resolve) => stub?.close(() => resolve()));
  held.clear();
});

async function button() {
  const result = await api(
    "POST",
    "/api/chat.postMessage",
    {
      channel,
      text: "Please confirm attendance.",
      blocks: [
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "rsvp",
              text: { type: "plain_text", text: "Attend" },
              value: "attending",
            },
          ],
        },
      ],
    },
    app.token,
  );
  expect(result.body.ok).toBe(true);
  return result.body.ts as string;
}

async function view(auth = token) {
  const message = await button();
  expect(
    (await api("POST", `/api/messages/${message}/actions`, { actionId: "rsvp" }, auth)).body.ok,
  ).toBe(true);
  const trigger = callbacks.at(-1)!.trigger_id;
  const result = await api(
    "POST",
    "/api/views.open",
    {
      trigger_id: trigger,
      view: {
        title: "RSVP",
        blocks: [
          {
            type: "input",
            block_id: "b",
            label: "Your answer",
            element: { type: "plain_text_input", action_id: "a" },
          },
        ],
      },
    },
    app.token,
  );
  expect(result.body.ok).toBe(true);
  return result.body.view.id as string;
}

const submit = (id: string, text = "Attending", auth = token) =>
  api("POST", `/api/views/${id}/submit`, { values: { b: { a: text } } }, auth);
const submissions = () => callbacks.filter((payload) => payload.type === "view_submission");
const messages = () => server.store.listMessages({ channelId: channel, limit: 50 });

describe("one submission per app view (N08)", () => {
  it("refuses another submission during its callback, while another person's view still proceeds", async () => {
    const first = await view();
    // A person has one form open at a time (E18b), so the other view is someone else's.
    const someone = (
      await api("POST", "/api/auth/register", {
        handle: "someone",
        displayName: "Someone",
        password: "password123",
      })
    ).body.token as string;
    const second = await view(someone);
    const responses: ServerResponse[] = [];
    handler = (_payload, response) => responses.push(response);
    const sendingFirst = submit(first);
    await expect.poll(() => responses.length).toBe(1);
    const repeated = await submit(first, "Changed answer");
    expect(repeated).toMatchObject({ status: 409, body: { error: "view_submitting" } });
    expect(submissions()).toHaveLength(1);
    const sendingSecond = submit(second, "Attending", someone);
    await expect.poll(() => responses.length).toBe(2);
    answer(responses[0]!, {
      response_action: "errors",
      errors: { b: "Please correct your answer." },
    });
    answer(responses[1]!);
    expect((await sendingFirst).body).toEqual({
      ok: false,
      errors: { b: "Please correct your answer." },
    });
    expect((await sendingSecond).body.ok).toBe(true);
    handler = (_payload, response) => answer(response);
    expect((await submit(first, "Corrected answer")).body.ok).toBe(true);
    expect(submissions().map((payload) => payload.view!.id)).toEqual([first, second, first]);
    expect((await submit(first)).status).toBe(404);
    expect((await submit(second, "Attending", someone)).status).toBe(404);
  });

  it("releases the claim after an uncertain transport failure so an explicit retry can proceed", async () => {
    const id = await view();
    handler = (_payload, response) => response.destroy();
    const failed = await submit(id);
    expect(failed.body).toMatchObject({
      ok: false,
      message: expect.stringContaining("did not answer"),
    });
    handler = (_payload, response) => answer(response);
    expect((await submit(id)).body.ok).toBe(true);
    expect(submissions().map((payload) => payload.view!.id)).toEqual([id, id]);
  });

  it("does not consume the owner's view when another account requests it", async () => {
    const id = await view();
    const other = await api("POST", "/api/auth/register", {
      handle: "other",
      displayName: "Other",
      password: "password123",
    });
    expect(
      (
        await api(
          "POST",
          `/api/views/${id}/submit`,
          { values: { b: { a: "Attending" } } },
          other.body.token,
        )
      ).status,
    ).toBe(404);
    expect((await submit(id)).body.ok).toBe(true);
    expect(submissions()).toHaveLength(1);
  });
});

describe("replacement keeps the origin's lifetime (N09)", () => {
  it.each(["replace_original", "delete_original"])(
    "a held %s answer to a removed origin creates no new message",
    async (directive) => {
      const original = await button();
      let response: ServerResponse | undefined;
      handler = (_payload, pending) => {
        response = pending;
      };
      const action = api("POST", `/api/messages/${original}/actions`, { actionId: "rsvp" });
      await expect.poll(() => response !== undefined).toBe(true);
      expect((await api("DELETE", `/api/messages/${original}`)).status).toBe(200);
      answer(response!, { [directive]: true, response_type: "in_channel", text: "RSVP recorded." });
      expect((await action).body.ok).toBe(true);
      expect(server.store.getMessage(original)).toBeNull();
      expect(messages()).toEqual([]);
    },
  );

  it("a delayed response URL cannot recreate an origin that was removed", async () => {
    const original = await button();
    await api("POST", `/api/messages/${original}/actions`, { actionId: "rsvp" });
    const responseUrl = callbacks.at(-1)!.response_url!;
    await api("DELETE", `/api/messages/${original}`);
    expect(
      (
        await api("POST", new URL(responseUrl).pathname, {
          replace_original: true,
          response_type: "in_channel",
          text: "RSVP recorded.",
        })
      ).body.ok,
    ).toBe(true);
    expect(messages()).toEqual([]);
  });

  it("preserves newer changes from an independently issued reply and permits an app's own update chain", async () => {
    const original = await button();
    const path = `/api/messages/${original}/actions`;
    handler = (_payload, response) => answer(response);
    await api("POST", path, { actionId: "rsvp" });
    const staleUrl = callbacks.at(-1)!.response_url!;
    handler = (_payload, response) =>
      answer(response, { replace_original: true, text: "RSVP recorded." });
    await api("POST", path, { actionId: "rsvp" });
    const currentUrl = callbacks.at(-1)!.response_url!;
    const late = (url: string, body: unknown) => api("POST", new URL(url).pathname, body);
    expect((await late(staleUrl, { replace_original: true, text: "Stale answer" })).body.ok).toBe(
      true,
    );
    expect((await late(staleUrl, { delete_original: true })).body.ok).toBe(true);
    expect(server.store.getMessage(original)?.text).toBe("RSVP recorded.");
    expect(
      (await late(currentUrl, { replace_original: true, text: "Agenda updated." })).body.ok,
    ).toBe(true);
    expect(
      (await late(currentUrl, { replace_original: true, text: "Agenda confirmed." })).body.ok,
    ).toBe(true);
    expect(server.store.getMessage(original)).toMatchObject({
      text: "Agenda confirmed.",
      actions: [],
    });
    expect(messages()).toHaveLength(1);
  });

  it("ordinary app answers still post after the clicked origin was removed", async () => {
    const original = await button();
    let response: ServerResponse | undefined;
    handler = (_payload, pending) => {
      response = pending;
    };
    const action = api("POST", `/api/messages/${original}/actions`, { actionId: "rsvp" });
    await expect.poll(() => response !== undefined).toBe(true);
    await api("DELETE", `/api/messages/${original}`);
    answer(response!, { response_type: "in_channel", text: "A separate meeting notice." });
    expect((await action).body.ok).toBe(true);
    expect(messages().map((m) => m.text)).toEqual(["A separate meeting notice."]);
  });
});
