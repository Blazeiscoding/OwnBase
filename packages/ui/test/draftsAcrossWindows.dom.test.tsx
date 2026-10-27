import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, readStoredDrafts } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.js";
import { DraftPersistence } from "../src/components/DraftPersistence.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import { webPlatform, type Platform } from "../src/platform.js";
import { sharedDevice } from "./sharedDevice.js";

/**
 * Drafts in several windows open on one account (RECHECK-04). Each window
 * writes only the drafts it changed, so a draft typed in one conversation is
 * not lost to another window's write about a different one; a draft cleared
 * or sent in one window is not put back by another that still showed it; and
 * a window takes on what the others stored, unless it has its own change to
 * that draft not yet written.
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

/** Past the pause a draft waits before it is written. */
const pause = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 700)));
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const draftsKey = (client: WorkspaceClient) => `drafts:${client.baseUrl}:${sam.id}`;

afterEach(() => vi.restoreAllMocks());
beforeEach(() => localStorage.clear());

describe("drafts in two windows of the desktop app", () => {
  it("keep a draft typed in each, in different conversations", async () => {
    const device = sharedDevice();
    const first = signedIn();
    const second = signedIn();
    mount(first, device.window());
    mount(second, device.window());
    await waitFor(() => expect(device.values.has(draftsKey(first))).toBe(true));
    await settle();

    act(() => first.setDraft(design.id, "for design, from the first"));
    act(() => second.setDraft(launch.id, "for launch, from the second"));
    await pause();
    expect(readStoredDrafts(device.values.get(draftsKey(first)))).toEqual({
      [design.id]: "for design, from the first",
      [launch.id]: "for launch, from the second",
    });
    // And each window has heard of the other's.
    expect(first.state.drafts[launch.id]).toBe("for launch, from the second");
    expect(second.state.drafts[design.id]).toBe("for design, from the first");

    // A window opened afterwards, as after a restart, brings back both.
    const later = signedIn();
    mount(later, device.window());
    await waitFor(() =>
      expect(later.state.drafts).toEqual({
        [design.id]: "for design, from the first",
        [launch.id]: "for launch, from the second",
      }),
    );
  });

  it("never put back a draft one window sent when another, still showing it, is hidden", async () => {
    const device = sharedDevice({ "drafts:http://127.0.0.1:9:U_SAM": { [design.id]: "ready" } });
    const first = signedIn();
    const second = signedIn();
    mount(first, device.window());
    const { unmount } = mount(second, device.window());
    await waitFor(() => expect(first.state.drafts[design.id]).toBe("ready"));
    await waitFor(() => expect(second.state.drafts[design.id]).toBe("ready"));

    // Sent from the first window: its draft empties.
    act(() => first.setDraft(design.id, ""));
    await pause();
    expect(readStoredDrafts(device.values.get(draftsKey(first)))).toEqual({});
    // The second writes everything it would on the way out; the draft stays gone.
    act(() => void window.dispatchEvent(new Event("pagehide")));
    unmount();
    await settle();
    expect(readStoredDrafts(device.values.get(draftsKey(first)))).toEqual({});
  });

  it("make the later edit of one conversation's draft the draft, in both", async () => {
    const device = sharedDevice();
    const first = signedIn();
    const second = signedIn();
    mount(first, device.window());
    mount(second, device.window());
    await waitFor(() => expect(device.values.has(draftsKey(first))).toBe(true));
    await settle();

    act(() => first.setDraft(design.id, "the first window's"));
    await pause();
    expect(second.state.drafts[design.id]).toBe("the first window's");
    act(() => second.setDraft(design.id, "the second window's, later"));
    await pause();
    expect(readStoredDrafts(device.values.get(draftsKey(first)))).toEqual({
      [design.id]: "the second window's, later",
    });
    expect(first.state.drafts[design.id]).toBe("the second window's, later");
  });

  it("keep both windows' changes to the same draft when both change it at once (GL-03)", async () => {
    const device = sharedDevice();
    const first = signedIn();
    const second = signedIn();
    mount(first, device.window());
    mount(second, device.window());
    await waitFor(() => expect(device.values.has(draftsKey(first))).toBe(true));
    await settle();

    const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    act(() => first.setDraft(design.id, "typed in the first"));
    await wait(300);
    act(() => second.setDraft(design.id, "typed in the second, later"));
    // The first's write lands while the second's change still waits for its pause.
    await wait(400);
    expect(readStoredDrafts(device.values.get(draftsKey(first)))?.[design.id]).toBe(
      "typed in the first",
    );
    expect(second.state.drafts[design.id]).toBe("typed in the second, later");
    // Then the second's is written beside the first's, which neither window
    // had seen when it typed, and the first takes both on.
    await pause();
    const both = "typed in the second, later\n\ntyped in the first";
    expect(readStoredDrafts(device.values.get(draftsKey(first)))?.[design.id]).toBe(both);
    expect(first.state.drafts[design.id]).toBe(both);
    expect(second.state.drafts[design.id]).toBe(both);
  });

  it("says when a draft could not be written, and writes it on Retry", async () => {
    const device = sharedDevice();
    const platform = device.window();
    const merge = platform.storage.mergeDrafts!;
    let full = false;
    platform.storage.mergeDrafts = (...args) =>
      full ? Promise.reject(new Error("QuotaExceededError")) : merge(...args);
    const client = signedIn();
    const view = mount(client, platform);
    await waitFor(() => expect(device.values.has(draftsKey(client))).toBe(true));
    await settle();

    full = true;
    act(() => client.setDraft(design.id, "kept through a full disk"));
    await pause();
    await waitFor(() => expect(view.getByRole("alert").textContent).toMatch(/Could not save/));
    expect(readStoredDrafts(device.values.get(draftsKey(client)))).toEqual({});

    full = false;
    act(() => view.getByRole("button", { name: "Retry" }).click());
    await waitFor(() =>
      expect(readStoredDrafts(device.values.get(draftsKey(client)))).toEqual({
        [design.id]: "kept through a full disk",
      }),
    );
    expect(view.queryByRole("alert")).toBeNull();
  });

  it("keep each account's drafts apart", async () => {
    const device = sharedDevice();
    const first = signedIn();
    const other = signedIn();
    other.store.setState({ self: { ...sam, id: "U_ALEX", handle: "alex" } });
    mount(first, device.window());
    mount(other, device.window());
    await waitFor(() => expect(device.values.has(draftsKey(first))).toBe(true));
    await settle();

    act(() => first.setDraft(design.id, "sam's"));
    act(() => other.setDraft(design.id, "alex's"));
    await pause();
    expect(readStoredDrafts(device.values.get(draftsKey(first)))).toEqual({ [design.id]: "sam's" });
    expect(readStoredDrafts(device.values.get(`drafts:${other.baseUrl}:U_ALEX`))).toEqual({
      [design.id]: "alex's",
    });
    expect(first.state.drafts[design.id]).toBe("sam's");
  });
});

describe("drafts in two browser tabs", () => {
  const name = (client: WorkspaceClient) => `ownbase:${draftsKey(client)}`;
  const stored = (client: WorkspaceClient) =>
    readStoredDrafts(JSON.parse(localStorage.getItem(name(client)) ?? "null"));

  it("keep a draft typed in each, in different conversations", async () => {
    const first = signedIn();
    const second = signedIn();
    mount(first, webPlatform());
    mount(second, webPlatform());
    await waitFor(() => expect(localStorage.getItem(name(first))).not.toBeNull());
    await settle();

    act(() => first.setDraft(design.id, "for design"));
    act(() => second.setDraft(launch.id, "for launch"));
    await pause();
    expect(stored(first)).toEqual({ [design.id]: "for design", [launch.id]: "for launch" });
  });

  it("take on a draft another tab changed, and one it cleared", async () => {
    localStorage.setItem(
      "ownbase:drafts:http://127.0.0.1:9:U_SAM",
      JSON.stringify({ [design.id]: "before", [launch.id]: "to be sent" }),
    );
    const client = signedIn();
    mount(client, webPlatform());
    await waitFor(() => expect(client.state.drafts[design.id]).toBe("before"));

    const newValue = JSON.stringify({ [design.id]: "changed in the other tab" });
    localStorage.setItem(name(client), newValue);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: name(client), newValue, storageArea: localStorage }),
      );
    });
    expect(client.state.drafts).toEqual({ [design.id]: "changed in the other tab" });
    await pause();
    // Nothing of this tab's own to write, so it writes nothing back.
    expect(stored(client)).toEqual({ [design.id]: "changed in the other tab" });
  });
});

describe("one conversation's composer open in two windows", () => {
  function window(client: WorkspaceClient, platform: Platform, label: string) {
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <DraftPersistence platform={platform} />
          <Composer channelId={design.id} placeholder={label} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    return screen.getByRole<HTMLTextAreaElement>("textbox", { name: label });
  }

  it("shows what the other typed while it has nothing unsaved, without trading drafts back and forth", async () => {
    const user = userEvent.setup();
    const device = sharedDevice();
    let merges = 0;
    const counted = () => {
      const platform = device.window();
      const merge = platform.storage.mergeDrafts!;
      platform.storage.mergeDrafts = (...args) => {
        merges++;
        return merge(...args);
      };
      return platform;
    };
    const first = window(signedIn(), counted(), "Message #design, first window");
    const second = window(signedIn(), counted(), "Message #design, second window");
    await waitFor(() => expect(first).toBeEnabled());
    await waitFor(() => expect(second).toBeEnabled());

    await user.type(first, "from the first");
    await waitFor(() => expect(second.value).toBe("from the first"), { timeout: 3000 });
    // Typed on in the second, which then saves it; the first had nothing unsaved.
    await user.type(second, ", and the second");
    await waitFor(() => expect(first.value).toBe("from the first, and the second"), {
      timeout: 3000,
    });

    // Both edited, and settled: neither writes its own back over the other's.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 1500)));
    const settled = merges;
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 2000)));
    expect(merges).toBe(settled);
    expect([first.value, second.value]).toEqual([
      "from the first, and the second",
      "from the first, and the second",
    ]);
  }, 15_000);
});
