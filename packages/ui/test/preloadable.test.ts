import { describe, expect, it, vi } from "vitest";
import { preloadAll, preloadable } from "../src/lib/preloadable.js";

describe("a part fetched as a workspace opens", () => {
  it("is fetched once, by the workspace or by whoever wants it first", async () => {
    const fetch = vi.fn(async () => "the palette");
    const part = preloadable(fetch);
    expect(part.loaded()).toBeNull();
    preloadAll();
    await expect(part.load()).resolves.toBe("the palette");
    expect(part.loaded()).toBe("the palette");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is fetched again after a failure, as after a dropped connection", async () => {
    const fetch = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("search");
    const part = preloadable(fetch);
    await expect(part.load()).rejects.toThrow("offline");
    expect(part.loaded()).toBeNull();
    await expect(part.load()).resolves.toBe("search");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
