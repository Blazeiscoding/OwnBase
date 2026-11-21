import { afterEach, describe, expect, it, vi } from "vitest";
import { ClosePreparation } from "../src/main/closePreparation.js";

function held() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("preparing an ordinary close", () => {
  it("waits for the owning renderer and then for native writes, sharing concurrent requests", async () => {
    const close = new ClosePreparation();
    const drain = held();
    const send = vi.fn();
    const write = vi.fn(() => drain.promise);
    const preparation = close.prepare(17, send, write);
    expect(close.prepare(17, send, write)).toBe(preparation);
    let finished = false;
    void preparation.then(() => {
      finished = true;
    });
    const id = send.mock.calls[0]![0];
    expect(close.acknowledge(18, id, true)).toBe(false);
    expect(close.acknowledge(17, id, "saved")).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(close.acknowledge(17, id, true)).toBe(true);
    expect(close.acknowledge(17, id, true)).toBe(false);
    await Promise.resolve();
    expect(write).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    drain.resolve();
    await preparation;
    expect(finished).toBe(true);
  });

  it("refuses a failed renderer save and permits a fresh retry", async () => {
    const close = new ClosePreparation();
    const send = vi.fn();
    const drain = vi.fn(async () => {});
    const first = close.prepare(17, send, drain);
    const failure = expect(first).rejects.toThrow("The window could not save its local work.");
    close.acknowledge(17, send.mock.calls[0]![0], false);
    await failure;
    expect(drain).not.toHaveBeenCalled();
    const retry = close.prepare(17, send, drain);
    expect(close.acknowledge(17, send.mock.calls[0]![0], true)).toBe(false);
    close.acknowledge(17, send.mock.calls[1]![0], true);
    await retry;
  });

  it("reports a settings failure, including when no renderer exists", async () => {
    const close = new ClosePreparation();
    await expect(
      close.prepare(
        null,
        () => {},
        async () => {
          throw new Error("disk full");
        },
      ),
    ).rejects.toThrow("The desktop settings could not finish saving.");
    await close.prepare(
      null,
      () => {},
      async () => {},
    );
  });

  it("bounds missing replies and slow writes at ten seconds without letting late work finish a newer attempt", async () => {
    vi.useFakeTimers();
    const close = new ClosePreparation();
    const send = vi.fn();
    const first = close.prepare(17, send, async () => {});
    let failed = false;
    const missing = expect(first)
      .rejects.toThrow("did not finish in time")
      .then(() => (failed = true));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(failed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await missing;
    const oldDrain = held();
    const second = close.prepare(17, send, () => oldDrain.promise);
    close.acknowledge(17, send.mock.calls[1]![0], true);
    const slow = expect(second).rejects.toThrow("did not finish in time");
    await vi.advanceTimersByTimeAsync(10_000);
    await slow;
    const currentDrain = held();
    const third = close.prepare(17, send, () => currentDrain.promise);
    let done = false;
    void third.then(() => {
      done = true;
    });
    oldDrain.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    close.acknowledge(17, send.mock.calls[2]![0], true);
    currentDrain.resolve();
    await third;
  });

  it("reports a window that cannot receive the request instead of draining and quitting", async () => {
    const close = new ClosePreparation();
    const drain = vi.fn(async () => {});
    await expect(
      close.prepare(
        17,
        () => {
          throw new Error("destroyed");
        },
        drain,
      ),
    ).rejects.toThrow("could not hand over");
    expect(drain).not.toHaveBeenCalled();
  });
});
