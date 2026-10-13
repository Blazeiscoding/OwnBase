import { describe, expect, it } from "vitest";
import {
  notificationPreviews,
  previewAccount,
  previewFor,
} from "../src/lib/notificationPreview.js";
import type { Platform } from "../src/platform.js";

/**
 * What another window stores, and what this window is answered, can arrive in
 * either order. An older answer shown after a newer change put a window back
 * to showing everything once another had chosen to show nothing (Q03). Here
 * each read and save is answered when the test says, and another window's
 * change is delivered between asking and answering.
 */
const mine = previewAccount("http://a:1", "U1");
const other = previewAccount("http://a:1", "U2");

type Held = { resolve: (value: unknown) => void; reject: (error: Error) => void };

function device() {
  const reads: Held[] = [];
  const saves: (Held & { changes: Record<string, string | null> })[] = [];
  let heard: (stored: unknown) => void = () => {};
  const held = <T>(list: T[], extra: object = {}) =>
    new Promise<unknown>((resolve, reject) => list.push({ resolve, reject, ...extra } as T));
  const platform: Platform = {
    kind: "web",
    storage: {
      get: (() => held(reads)) as Platform["storage"]["get"],
      set: async () => {},
      mergeRecord: ((_key: string, changes: Record<string, string | null>) =>
        held(saves, { changes })) as Platform["storage"]["mergeRecord"],
      watchRecord: (_key, cb) => {
        heard = cb;
        return () => {};
      },
    },
    notify: () => {},
  };
  const store = notificationPreviews(platform);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    store,
    reads,
    saves,
    /** Another window stored this. */
    elsewhere: (stored: unknown) => heard(stored),
    settle,
    shown: (account = mine) => previewFor(store.getState(), account),
  };
}

describe("a first read crossed by another window's choice", () => {
  it("shows what is stored now, not the older answer", async () => {
    const { reads, elsewhere, settle, shown, store } = device();
    // Asked for before the other window chose to show nothing; answered after.
    elsewhere({ [mine]: "none" });
    reads[0]!.resolve({ [mine]: "full" });
    await settle();

    // Neither is taken: nothing is shown until storage has been read again.
    expect(store.getState().loaded).toBe(false);
    expect(shown()).toBe("none");
    expect(reads).toHaveLength(2);

    reads[1]!.resolve({ [mine]: "none" });
    await settle();
    expect(store.getState().loaded).toBe(true);
    expect(shown()).toBe("none");
  });

  it("reads again for as long as changes keep crossing its answers", async () => {
    const { reads, elsewhere, settle, shown } = device();
    elsewhere({ [mine]: "sender" });
    reads[0]!.resolve({});
    await settle();
    elsewhere({ [mine]: "none" });
    reads[1]!.resolve({ [mine]: "sender" });
    await settle();
    expect(reads).toHaveLength(3);

    reads[2]!.resolve({ [mine]: "none" });
    await settle();
    expect(shown()).toBe("none");
  });

  it("shows an answer nothing crossed as it is, asking once", async () => {
    const { reads, settle, shown } = device();
    reads[0]!.resolve({ [mine]: "sender" });
    await settle();
    expect(shown()).toBe("sender");
    expect(reads).toHaveLength(1);
  });
});

describe("a save crossed by another window's choice", () => {
  async function loaded(saved: Record<string, string>) {
    const made = device();
    made.reads[0]!.resolve(saved);
    await made.settle();
    return made;
  }

  it("shows what is stored now, not the save's older answer", async () => {
    const { store, reads, saves, elsewhere, settle, shown } = await loaded({ [mine]: "full" });
    const saving = store.getState().setPreview(other, "sender");
    expect(saves[0]!.changes).toEqual({ [other]: "sender" });

    // Another window hides everything for this account after this save was
    // stored, and its change is heard before the save is answered.
    elsewhere({ [mine]: "none", [other]: "sender" });
    saves[0]!.resolve({ [mine]: "full", [other]: "sender" });
    await settle();
    expect(reads).toHaveLength(2);
    expect(store.getState().saving).toBe(true);

    reads[1]!.resolve({ [mine]: "none", [other]: "sender" });
    await saving;
    expect(shown()).toBe("none");
    expect(shown(other)).toBe("sender");
    expect(store.getState()).toMatchObject({ saving: false, error: null });
  });

  it("shows the save's answer when nothing crossed it, asking nothing more", async () => {
    const { store, reads, saves, shown } = await loaded({ [mine]: "full" });
    const saving = store.getState().setPreview(mine, "sender");
    saves[0]!.resolve({ [mine]: "sender" });
    await saving;
    expect(shown()).toBe("sender");
    expect(reads).toHaveLength(1);
  });

  it("says a save failed, and still shows what another window stored meanwhile", async () => {
    const { store, reads, saves, elsewhere, shown } = await loaded({ [mine]: "full" });
    const saving = store.getState().setPreview(mine, "sender");
    elsewhere({ [mine]: "none" });
    saves[0]!.reject(new Error("quota"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    reads[1]!.resolve({ [mine]: "none" });
    await saving;

    expect(shown()).toBe("none");
    expect(store.getState().error).toBe("Could not save this choice. Please try again.");
    expect(store.getState().saving).toBe(false);
  });

  it("takes another window's choice at once while nothing of its own is out", async () => {
    const { reads, elsewhere, shown } = await loaded({ [mine]: "full" });
    elsewhere({ [mine]: "none" });
    expect(shown()).toBe("none");
    expect(reads).toHaveLength(1);
  });
});
