import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServer, type WorkspaceServer } from "@ownbase/server";
import { Api, WorkspaceClient } from "../src/index.js";

interface AppPayload {
  type: string;
  trigger_id?: string;
  view?: { id: string; state: { values: Record<string, Record<string, { value: string }>> } };
}
let server: WorkspaceServer;
let hook: Server;
let client: WorkspaceClient;
let admin: Api;
let hookPort: number;
let channelId: string;
const received: { path: string; payload: AppPayload }[] = [];
const held: ServerResponse[] = [];
let holdPath: string | null = null;

beforeEach(async () => {
  received.length = 0;
  held.length = 0;
  holdPath = null;
  hook = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      response.setHeader("content-type", "application/json");
      if (body.startsWith("{")) {
        response.end(
          JSON.stringify({ challenge: (JSON.parse(body) as { challenge: string }).challenge }),
        );
        return;
      }
      const payload = JSON.parse(new URLSearchParams(body).get("payload")!) as AppPayload;
      const path = request.url ?? "";
      received.push({ path, payload });
      if (payload.type === "view_submission" && path === holdPath) held.push(response);
      else response.end("");
    });
  });
  await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
  hookPort = (hook.address() as { port: number }).port;
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    allowPrivateHooks: true,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const account = await new Api(base).register({
    handle: "modalowner",
    displayName: "Modal Owner",
    password: "password123",
  });
  admin = new Api(base, account.token);
  client = new WorkspaceClient(base, account.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find(
    (channel) => channel.name === "general",
  )!.id;
});

afterEach(async () => {
  for (const response of held.splice(0)) if (!response.writableEnded) response.end("");
  client?.destroy();
  await server?.stop();
  await new Promise<void>((resolve) => hook.close(() => resolve()));
  vi.restoreAllMocks();
});

async function post(path: string, token: string, body: unknown) {
  const response = await fetch(admin.baseUrl + path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function open(appName: string, hookPath: string) {
  const app = await admin.createApp({ name: appName });
  await admin.setInteractivityUrl(app.app.id, `http://127.0.0.1:${hookPort}${hookPath}`);
  const message = await post("/api/chat.postMessage", app.token, {
    channel: channelId,
    text: "Open a synthetic form",
    blocks: [
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "open", text: { type: "plain_text", text: "Open" } },
        ],
      },
    ],
  });
  await admin.runMessageAction(message.ts as string, "open");
  const action = [...received]
    .reverse()
    .find((entry) => entry.path === hookPath && entry.payload.type === "block_actions")!;
  const opened = await post("/api/views.open", app.token, {
    trigger_id: action.payload.trigger_id,
    view: {
      type: "modal",
      callback_id: appName,
      title: { type: "plain_text", text: appName },
      submit: { type: "plain_text", text: "Submit" },
      blocks: [
        {
          type: "input",
          block_id: "details",
          label: { type: "plain_text", text: "Details" },
          element: { type: "plain_text_input", action_id: "value" },
        },
      ],
    },
  });
  expect(opened.ok).toBe(true);
  const viewId = (opened.view as { id: string }).id;
  await expect.poll(() => client.state.modal?.id).toBe(viewId);
  return { appId: app.app.id, viewId };
}

describe("app form ownership across real socket pushes and callbacks (N05)", () => {
  it.each(["success", "refusal"])(
    "a delayed old %s cannot dismiss another app's form",
    async (outcome) => {
      const a = await open("App A", "/app-A");
      holdPath = "/app-A";
      const submitting = client.submitModal({ details: { value: "Words for A" } }, a.viewId);
      await expect.poll(() => held.length).toBe(1);
      client.dismissModal(a.viewId);
      const b = await open("App B", "/app-B");
      expect(a.appId).not.toBe(b.appId);
      held[0]!.end(
        outcome === "refusal"
          ? JSON.stringify({ response_action: "errors", errors: { details: "App A's error" } })
          : "",
      );
      expect((await submitting).ok).toBe(outcome === "success");
      expect(client.state.modal?.id).toBe(b.viewId);
      expect(await client.submitModal({ details: { value: "Words for B" } }, b.viewId)).toEqual({
        ok: true,
      });
      const delivered = received.find(
        (entry) => entry.path === "/app-B" && entry.payload.type === "view_submission",
      )!;
      expect(delivered.payload.view!.id).toBe(b.viewId);
      expect(delivered.payload.view!.state.values.details!.value!.value).toBe("Words for B");
      expect(client.state.modal).toBeNull();
    },
  );

  it("an event handler carrying the replaced view ID cannot submit or dismiss the new view", async () => {
    const a = await open("App A", "/app-A");
    const b = await open("App B", "/app-B");
    const submission = vi.spyOn(client.api, "submitView");
    expect(await client.submitModal({ details: { value: "Stale A answers" } }, a.viewId)).toEqual({
      ok: false,
      message: "This form is no longer available.",
    });
    expect(submission).not.toHaveBeenCalled();
    client.dismissModal(a.viewId);
    expect(client.state.modal?.id).toBe(b.viewId);
    expect(
      received.filter(
        (entry) => entry.path === "/app-B" && entry.payload.type === "view_submission",
      ),
    ).toHaveLength(0);
  });
});
