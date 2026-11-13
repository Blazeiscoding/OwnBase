import { afterEach, describe, expect, it, vi } from "vitest";

describe("the schemas' zod", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("builds and runs schemas without eval in a browser, whose policy forbids it", async () => {
    vi.stubGlobal("document", {});
    const evaluated = vi.fn();
    vi.stubGlobal(
      "Function",
      new Proxy(Function, {
        construct(target, args) {
          evaluated(args);
          return Reflect.construct(target, args);
        },
      }),
    );
    const { loginBody } = await import("../src/rest.js");
    expect(loginBody.safeParse({}).success).toBe(false);
    expect(loginBody.safeParse({ handle: "alice", password: "password" }).success).toBe(true);
    expect(evaluated).not.toHaveBeenCalled();
  });
});
