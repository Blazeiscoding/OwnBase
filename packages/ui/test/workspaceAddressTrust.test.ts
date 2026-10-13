import { describe, expect, it } from "vitest";
import {
  checkWorkspaceAddress,
  trustWorkspaceAddress,
  workspaceAddressTrustKey,
} from "../src/lib/workspaceAddressTrust.js";
import type { Platform } from "../src/platform.js";

/**
 * A device trusts the first address it uses for a workspace, and asks before
 * trusting another. "First" has to hold across windows: two that each found
 * no address recorded, each at a different one, must not both be let in
 * (Q02). Here the windows share one store, as tabs of a browser do, and their
 * reads can be held so that both see nothing before either writes.
 */
const ONE = "http://one.test:8543";
const TWO = "http://two.test:8543";
const key = workspaceAddressTrustKey("W1", "U1");

function device(options: { atomic?: boolean } = { atomic: true }) {
  const stored = new Map<string, unknown>();
  const held: (() => void)[] = [];
  const state = { holdReads: false };
  /** One window: its own queue of checks, the device's one store. */
  const openWindow = (): Platform => ({
    kind: "web",
    storage: {
      get: (async (name: string) => {
        // What was there when it was asked, answered whenever it is let go.
        const value = stored.get(name) ?? null;
        if (state.holdReads) await new Promise<void>((resolve) => held.push(resolve));
        return value;
      }) as Platform["storage"]["get"],
      set: async (name, value) => void stored.set(name, value),
      ...(options.atomic
        ? {
            initialize: async (name: string, value: unknown) => {
              if (!stored.has(name)) stored.set(name, value);
              return stored.get(name);
            },
          }
        : {}),
    },
    notify: () => {},
  });
  const release = () => {
    for (const resolve of held.splice(0)) resolve();
  };
  return { stored, state, held, openWindow, release };
}

describe("the first address a device uses for a workspace", () => {
  it("is one window's only, when two windows start at different addresses at once", async () => {
    const { stored, state, held, openWindow, release } = device();
    state.holdReads = true;
    const first = checkWorkspaceAddress(openWindow(), "W1", "U1", ONE);
    const second = checkWorkspaceAddress(openWindow(), "W1", "U1", TWO);
    // Both have read that nothing is recorded before either records anything.
    await expect.poll(() => held.length).toBe(2);
    release();

    const [a, b] = await Promise.all([first, second]);
    expect([a.allowed, b.allowed].sort()).toEqual([false, true]);
    const admitted = a.allowed ? a : b;
    const refused = a.allowed ? b : a;
    // The other is told whose address is trusted, and has to ask.
    expect(refused.addresses).toEqual([admitted.address]);
    expect(stored.get(key)).toEqual({ version: 1, addresses: [admitted.address] });
  });

  it("is trusted without asking when it is the only one", async () => {
    const { stored, openWindow } = device();
    await expect(checkWorkspaceAddress(openWindow(), "W1", "U1", `${ONE}/`)).resolves.toEqual({
      address: ONE,
      addresses: [ONE],
      allowed: true,
    });
    expect(stored.get(key)).toEqual({ version: 1, addresses: [ONE] });
  });

  it("keeps a second address out until someone approves it", async () => {
    const { openWindow } = device();
    const window = openWindow();
    await checkWorkspaceAddress(window, "W1", "U1", ONE);
    await expect(checkWorkspaceAddress(window, "W1", "U1", TWO)).resolves.toMatchObject({
      allowed: false,
      addresses: [ONE],
    });

    await trustWorkspaceAddress(window, "W1", "U1", TWO);
    await expect(checkWorkspaceAddress(openWindow(), "W1", "U1", TWO)).resolves.toMatchObject({
      allowed: true,
      addresses: [ONE, TWO],
    });
  });

  it("refuses a record it cannot read rather than writing a new one over it", async () => {
    const { stored, openWindow } = device();
    stored.set(key, { version: 2, addresses: [TWO] });
    await expect(checkWorkspaceAddress(openWindow(), "W1", "U1", ONE)).rejects.toThrow(
      /Could not read trusted workspace addresses/,
    );
    expect(stored.get(key)).toEqual({ version: 2, addresses: [TWO] });
  });

  it("is still recorded where storage has no single step for it", async () => {
    const { stored, openWindow } = device({ atomic: false });
    await expect(checkWorkspaceAddress(openWindow(), "W1", "U1", ONE)).resolves.toMatchObject({
      allowed: true,
    });
    expect(stored.get(key)).toEqual({ version: 1, addresses: [ONE] });
  });
});
