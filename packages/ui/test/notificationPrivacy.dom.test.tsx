import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlatformContext } from "../src/context.js";
import { webPlatform, type Platform } from "../src/platform.js";
import {
  notificationContent,
  previewAccount,
  previewFor,
  useNotificationPreviews,
} from "../src/lib/notificationPreview.js";

/**
 * What notifications show must not fall back to the whole message when the
 * saved choice is damaged, nor when another window saves (F02). Each mounted
 * `webPlatform()` stands for one open window; the storage event is the one a
 * browser delivers to every other tab after a write.
 */
type Previews = ReturnType<typeof useNotificationPreviews>;
const views = new Map<string, Previews>();
const KEY = "ownbase:notification-previews";
const accountA = previewAccount("http://127.0.0.1:9", "U1");
const accountB = previewAccount("http://127.0.0.1:9", "U2");

function Reader({ label }: { label: string }) {
  views.set(label, useNotificationPreviews());
  return null;
}

async function open(label: string, platform: Platform = webPlatform()) {
  render(
    <PlatformContext.Provider value={platform}>
      <Reader label={label} />
    </PlatformContext.Provider>,
  );
  await waitFor(() => expect(views.get(label)?.loaded).toBe(true));
  return () => views.get(label)!;
}

/** What a browser tells every other tab once one has written. */
function otherTabsHear() {
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: KEY,
        newValue: localStorage.getItem(KEY),
        storageArea: localStorage,
      }),
    ),
  );
}

const shown = (previews: Previews, account: string) =>
  notificationContent(previewFor(previews, account), {
    from: "Sam",
    channelName: "private",
    body: "the private words",
  });

afterEach(() => {
  cleanup();
  views.clear();
  localStorage.clear();
});

describe("notification privacy when storage is damaged (F02)", () => {
  it.each([
    ["malformed JSON", "{malformed"],
    ["a list", JSON.stringify(["full"])],
    ["a number", "7"],
  ])("shows nothing and says why when the saved choices are %s", async (_, raw) => {
    localStorage.setItem(KEY, raw);
    const view = await open("damaged");
    expect(previewFor(view(), accountA)).toBe("none");
    expect(view().unreadable).toBe(true);
    expect(view().error).toMatch(/could not read your choice/i);
    expect(JSON.stringify(shown(view(), accountA))).not.toMatch(/Sam|private/);
  });

  it("reads a choice that is not one of the three as the most private one", async () => {
    localStorage.setItem(KEY, JSON.stringify({ [accountA]: "everything", [accountB]: "sender" }));
    const view = await open("odd");
    expect(previewFor(view(), accountA)).toBe("none");
    expect(previewFor(view(), accountB)).toBe("sender");
    expect(view().error).toMatch(/could not read your choice/i);
  });

  it("keeps the others private when one account saves beside a damaged choice", async () => {
    const accountC = previewAccount("http://127.0.0.1:9", "U3");
    localStorage.setItem(KEY, JSON.stringify({ [accountA]: "none", [accountB]: 123 }));
    const view = await open("damaged-entry");
    expect(previewFor(view(), accountB)).toBe("none");
    await act(async () => view().setPreview(accountC, "sender"));
    const reopened = await open("after-damaged-entry");
    expect(previewFor(reopened(), accountA)).toBe("none");
    expect(previewFor(reopened(), accountB)).toBe("none");
    expect(previewFor(reopened(), accountC)).toBe("sender");
  });

  it("stays private for a storage read that is refused", async () => {
    const platform: Platform = {
      kind: "web",
      notify: () => {},
      storage: {
        get: async () => {
          throw new Error("storage refused");
        },
        set: async () => {},
      },
    };
    const view = await open("refused", platform);
    expect(previewFor(view(), accountA)).toBe("none");
    expect(view().error).toMatch(/could not read your choice/i);
  });

  it("keeps other accounts private after one chooses again over damaged storage", async () => {
    localStorage.setItem(KEY, "{malformed");
    const view = await open("repair");
    await act(async () => view().setPreview(accountA, "sender"));
    expect(previewFor(view(), accountA)).toBe("sender");
    expect(previewFor(view(), accountB)).toBe("none");
    expect(view().error).toBe(null);
    const reopened = await open("repaired");
    expect(previewFor(reopened(), accountB)).toBe("none");
  });
});

describe("notification choices across windows (F02)", () => {
  it.each([
    ["A then B", false],
    ["B then A", true],
  ])("keeps both accounts' choices when two windows save, %s", async (_, reversed) => {
    const first = await open("first");
    const second = await open("second");
    const saves: [() => Previews, string, "none" | "sender"][] = [
      [first, accountA, "none"],
      [second, accountB, "sender"],
    ];
    if (reversed) saves.reverse();
    for (const [view, account, preview] of saves) {
      await act(async () => view().setPreview(account, preview));
      otherTabsHear();
    }
    const reopened = await open("reopened");
    expect(previewFor(reopened(), accountA)).toBe("none");
    expect(previewFor(reopened(), accountB)).toBe("sender");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      [accountA]: "none",
      [accountB]: "sender",
    });
  });

  it("keeps the other account's choice even before a window hears of it", async () => {
    const first = await open("first");
    const second = await open("second");
    await act(async () => first().setPreview(accountA, "none"));
    // No storage event yet: the second window's copy is out of date.
    await act(async () => second().setPreview(accountB, "sender"));
    expect(previewFor(second(), accountA)).toBe("none");
    const reopened = await open("reopened");
    expect(previewFor(reopened(), accountA)).toBe("none");
  });

  it("takes a stricter choice made in another window before the next notification", async () => {
    const first = await open("first");
    const second = await open("second");
    expect(previewFor(second(), accountA)).toBe("full");
    await act(async () => first().setPreview(accountA, "none"));
    otherTabsHear();
    expect(previewFor(second(), accountA)).toBe("none");
    expect(JSON.stringify(shown(second(), accountA))).not.toMatch(/Sam|private/);
  });

  it("goes private when another window leaves damaged choices", async () => {
    const view = await open("watching");
    localStorage.setItem(KEY, "{malformed");
    otherTabsHear();
    expect(previewFor(view(), accountA)).toBe("none");
    expect(view().unreadable).toBe(true);
  });

  it("keeps the earlier choice when a save is refused, and saves on retry", async () => {
    const platform = webPlatform();
    let refuse = false;
    const merge = platform.storage.mergeRecord!;
    platform.storage.mergeRecord = async (key, changes) => {
      if (refuse) throw new Error("quota exceeded");
      return merge(key, changes);
    };
    const view = await open("refusing", platform);
    await act(async () => view().setPreview(accountA, "none"));
    refuse = true;
    await act(async () => view().setPreview(accountA, "full"));
    expect(previewFor(view(), accountA)).toBe("none");
    expect(view().error).toMatch(/could not save/i);
    refuse = false;
    await act(async () => view().setPreview(accountA, "sender"));
    expect(previewFor(view(), accountA)).toBe("sender");
    expect(view().error).toBe(null);
  });
});
