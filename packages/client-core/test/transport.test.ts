import { afterEach, describe, expect, it, vi } from "vitest";
import { endpoints } from "@ownbase/protocol";
import { Api, ApiError } from "../src/index.js";

/** What each request asked for, answered by `answer`. */
function serve(answer: (url: string) => Response) {
  const asked: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      asked.push({ url, init });
      return answer(url);
    }),
  );
  return asked;
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the client's REST transport", () => {
  it("keeps every id in its own path segment, whatever it holds", async () => {
    const asked = serve(() => ok({ ok: true }));
    const api = new Api("http://host", "token");
    await api.addReaction("M/1", "#?");
    await api.removeChannelMember("C 1", "U%2F");
    await api.revokeInvite("a/b");
    expect(asked.map((a) => a.url)).toEqual([
      "http://host/api/messages/M%2F1/reactions/%23%3F",
      "http://host/api/channels/C%201/members/U%252F",
      "http://host/api/invites/a%2Fb",
    ]);
    expect(asked[0]!.init.headers).toEqual({ authorization: "Bearer token" });
  });

  it("gives up on a call after the time its endpoint allows", async () => {
    const allowed: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      allowed.push(ms);
      return AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    });
    serve(() => ok({}));
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      init?.signal?.throwIfAborted();
      return ok({});
    });
    const api = new Api("http://host", "token");
    await expect(api.sendMessage("C1", { text: "hi", nonce: "n1" })).rejects.toThrow("timed out");
    await expect(api.me()).rejects.toThrow("timed out");
    expect(allowed).toEqual([endpoints.sendMessage.timeoutMs, endpoints.me.timeoutMs]);
  });

  it("reads a refusal into its code, its words and how long to wait", async () => {
    serve(
      () =>
        new Response(JSON.stringify({ error: "too_many_requests", message: "Slow down." }), {
          status: 429,
          headers: { "retry-after": "3" },
        }),
    );
    const refused = await new Api("http://host").me().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({
      status: 429,
      code: "too_many_requests",
      message: "Slow down.",
      retryAfterMs: 3000,
    });
  });

  it("asks for nothing but a ticket before a download", async () => {
    const asked = serve(() => ok({ token: "a".repeat(64), expiresAt: 1 }));
    const url = await new Api("http://host", "token").downloadUrl("F/1");
    expect(asked.map((a) => `${a.init.method} ${a.url}`)).toEqual([
      "POST http://host/api/files/F%2F1/download-token",
    ]);
    expect(url).toBe(`http://host/api/files/F%2F1?download=${"a".repeat(64)}`);
  });
});
