import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, readStoredDrafts } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.js";
import { DraftPersistence } from "../src/components/DraftPersistence.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import { JOURNAL_PREFIX } from "../src/lib/deviceStore.js";
import { webPlatform, type Platform } from "../src/platform.js";

/**
 * Unsent work in a browser that keeps it in IndexedDB (F01). Its writes
 * finish in a later turn, which a closing page may not get, so what a page
 * hidden or closing asks for must be written down before it lets go, and
 * must not wait for the writes before it to come back.
 */
const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const channel = (id: string, name: string): Channel => ({
  id,
  type: "public",
  name,
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id],
});
const design = channel("C_DESIGN", "design");
const launch = channel("C_LAUNCH", "launch");
const draftsKey = `drafts:http://127.0.0.1:9:${sam.id}`;

function signedIn() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: { [design.id]: design, [launch.id]: launch },
    status: "online",
  });
  vi.spyOn(client.api, "sendMessage").mockImplementation(() => new Promise(() => {}));
  return client;
}

function mount(client: WorkspaceClient, platform: Platform) {
  return render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <DraftPersistence platform={platform} />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
}

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
/** Past the pause a draft waits before it is written. */
const pause = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 700)));

/** Once the page has read what was stored, and written what it holds. */
async function restored(platform: Platform) {
  await waitFor(async () => expect(await platform.storage.get(draftsKey)).not.toBeNull());
  await settle();
  // Kept in IndexedDB, not where localStorage would keep it.
  expect(localStorage.getItem(`ownbase:${draftsKey}`)).toBeNull();
}

const journal = () =>
  Object.keys(localStorage)
    .filter((name) => name.startsWith(JOURNAL_PREFIX))
    .map((name) => [name, localStorage.getItem(name)!] as const);

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("unsent work kept in IndexedDB (F01)", () => {
  it("writes down a send and the words typed after it before a closing page lets go", async () => {
    const platform = webPlatform();
    const client = signedIn();
    const { unmount } = mount(client, platform);
    await restored(platform);

    // Two sends, the second asked for while the first's write is still out,
    // and both still out when the page closes.
    act(() => client.send(design.id, "sent just before"));
    act(() => client.send(design.id, "sent as the tab closed"));
    act(() => client.setDraft(launch.id, "typed as the tab closed"));
    let left: (readonly [string, string])[] = [];
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
      // All this page gets: nothing after this turn is ever run.
      left = journal();
    });
    expect(left.some(([, entry]) => entry.includes("typed as the tab closed"))).toBe(true);
    expect(left.some(([, entry]) => entry.includes("sent as the tab closed"))).toBe(true);

    // The page is gone, and none of what it asked for was made.
    unmount();
    await settle();
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    for (const [name, entry] of left) localStorage.setItem(name, entry);

    const next = signedIn();
    mount(next, webPlatform());
    await waitFor(() => expect(next.state.drafts[launch.id]).toBe("typed as the tab closed"));
    await waitFor(() =>
      expect(next.outboxSnapshot().map((send) => send.text)).toEqual([
        "sent just before",
        "sent as the tab closed",
      ]),
    );
  });

  it("writes down the last keystrokes, still in the composer, when the page closes", async () => {
    const user = userEvent.setup();
    const platform = webPlatform();
    const client = signedIn();
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <DraftPersistence platform={platform} />
          <Composer channelId={design.id} placeholder="Message #design" />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const composer = screen.getByRole("textbox", { name: "Message #design" });
    await waitFor(() => expect(composer).toBeEnabled());
    await restored(platform);

    await user.type(composer, "typed just now");
    let left: (readonly [string, string])[] = [];
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
      left = journal();
    });
    expect(left.some(([, entry]) => entry.includes("typed just now"))).toBe(true);
  });

  it("makes an edit at close from what the write before it stores, without doubling the draft", async () => {
    const platform = webPlatform();
    // Drafts writes are made at once and answered only when let go, as a
    // slow disk's would be.
    const merge = platform.storage.mergeDrafts!;
    let letGo!: () => void;
    const slow = new Promise<void>((resolve) => (letGo = resolve));
    let slowing = false;
    platform.storage.mergeDrafts = (key, changes, enveloped) => {
      const made = merge(key, changes, enveloped);
      return slowing ? slow.then(() => made) : made;
    };
    const client = signedIn();
    mount(client, platform);
    await restored(platform);

    slowing = true;
    act(() => client.setDraft(design.id, "hello there"));
    await pause();
    // That write is out; a word is taken back and the page hidden.
    act(() => client.setDraft(design.id, "hello"));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    letGo();
    await settle();

    expect(readStoredDrafts(await platform.storage.get(draftsKey))).toEqual({
      [design.id]: "hello",
    });
    expect(client.state.drafts[design.id]).toBe("hello");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps a sent draft's words while the outbox cannot store the send, even on close", async () => {
    const platform = webPlatform();
    const merge = platform.storage.mergeOutbox!;
    let full = false;
    platform.storage.mergeOutbox = async (key, changes, enveloped) => {
      if (full) throw new Error("quota exceeded");
      return merge(key, changes, enveloped);
    };
    const client = signedIn();
    mount(client, platform);
    await restored(platform);
    act(() => client.setDraft(design.id, "the only copy"));
    await pause();
    full = true;

    // Sent as the composer sends: the send queued, its draft emptied.
    act(() => {
      client.send(design.id, "the only copy");
      client.setDraft(design.id, "");
    });
    act(() => client.setDraft(launch.id, "typed meanwhile"));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    await settle();

    // The other draft is written; the sent one stays until the send is stored.
    expect(readStoredDrafts(await platform.storage.get(draftsKey))).toEqual({
      [design.id]: "the only copy",
      [launch.id]: "typed meanwhile",
    });
  });

  it("keeps both tabs' texts when two change one draft at once", async () => {
    const first = signedIn();
    const second = signedIn();
    const firstTab = webPlatform();
    const secondTab = webPlatform();
    mount(first, firstTab);
    mount(second, secondTab);
    await restored(firstTab);
    await restored(secondTab);

    act(() => first.setDraft(design.id, "from the first tab"));
    act(() => second.setDraft(design.id, "from the second tab"));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    await settle();

    const stored = readStoredDrafts(await firstTab.storage.get(draftsKey))!;
    expect(stored[design.id]).toContain("from the first tab");
    expect(stored[design.id]).toContain("from the second tab");
  });
});
