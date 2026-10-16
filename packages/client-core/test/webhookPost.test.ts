import { afterEach, describe, expect, it, vi } from "vitest";
import { Api, ApiError } from "../src/index.js";

/**
 * Send test message in Apps and integrations posts to the webhook URL itself
 * (UX-63), so the test goes the way a tool's post will: no session token, and
 * Slack's plain-text "ok" read as success.
 */
const HOOK = "http://127.0.0.1:9/hooks/test-webhook-not-a-credential";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("posting to a webhook", () => {
  it("sends the message as JSON with no session token, and takes a plain ok", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    const api = new Api("http://127.0.0.1:9", "test-session-not-a-credential");

    await api.postToWebhook(HOOK, { text: "Hello from a webhook" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(HOOK);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ text: "Hello from a webhook" });
  });

  it("names the refusal, as the server's error code or the status alone", async () => {
    const api = new Api("http://127.0.0.1:9");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: "invalid_webhook" }), { status: 404 }),
      ),
    );
    const named = await api.postToWebhook(HOOK, { text: "x" }).catch((err: unknown) => err);
    expect(named).toBeInstanceOf(ApiError);
    expect(named).toMatchObject({ status: 404, code: "invalid_webhook" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Bad Gateway", { status: 502 })),
    );
    const bare = await api.postToWebhook(HOOK, { text: "x" }).catch((err: unknown) => err);
    expect(bare).toMatchObject({ status: 502, code: "http_error" });
  });
});
