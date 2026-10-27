import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ApiError,
  OUTBOX_LIMIT,
  WorkspaceClient,
  outboxRevision,
  readStoredOutbox,
} from "@ownbase/client-core";
import { SEND_RETRY_WINDOW_MS, type Channel, type Message, type User } from "@ownbase/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftPersistence } from "../src/components/DraftPersistence.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import { webPlatform, type Platform } from "../src/platform.js";
import { sharedDevice } from "./sharedDevice.js";

/**
 * Unsent work on this device, through the storage it is written to: a restart
 * brings back every queued send, a refused one stays refused, and a write that
 * fails is said out loud.
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

const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id],
};

/**
 * One device's storage, kept across the clients a test starts on it. Passing
 * another device's values gives a second window onto the same storage.
 */
function device(values = new Map<string, unknown>()) {
  const platform: Platform = {
    kind: "desktop",
    storage: {
      get: async <T,>(name: string) => (values.get(name) ?? null) as T | null,
      set: async (name: string, value: unknown) => void values.set(name, value),
    },
    notify: () => {},
  };
  return { platform, values };
}

/** A signed-in client whose sends go nowhere until the test says otherwise. */
function signedIn() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: { [design.id]: design },
    status: "online",
  });
  const sendMessage = vi.spyOn(client.api, "sendMessage");
  return { client, sendMessage };
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

/** The sends in the stored outbox, in order. */
function storedEntries(values: Map<string, unknown>, key: string) {
  return readStoredOutbox(values.get(key) ?? null)?.entries ?? [];
}

/** The texts in the stored outbox, in order. */
function storedTexts(values: Map<string, unknown>, key: string) {
  return storedEntries(values, key).map((e) => e.text);
}

/**
 * Lets queued promise work finish: far less than the pause drafts wait for
 * before they are written, so anything stored by now was written at once.
 */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** What the server answers a send with, once it has the message. */
function sent(client: WorkspaceClient, nonce: string, text: string): Message {
  return {
    id: `M_${nonce}`,
    channelId: design.id,
    userId: client.state.self!.id,
    text,
    threadRootId: null,
    broadcast: false,
    seq: 1,
    createdAt: 0,
    editedAt: null,
    nonce,
    replyCount: 0,
    reactions: [],
    files: [],
    pinned: false,
    actions: [],
  };
}

afterEach(() => vi.restoreAllMocks());
// Not after each: unmounting a test's windows writes their outbox one last time.
beforeEach(() => localStorage.clear());

/** A send as an earlier version stored it: a plain list entry, with no revision. */
function queued(nonce: string, text: string) {
  return {
    nonce,
    channelId: design.id,
    threadRootId: null,
    text,
    userId: sam.id,
    // Queued just now: well inside the window a restored send goes out on its own.
    createdAt: Date.now(),
    attachments: [],
  };
}

const networkDown = () => Promise.reject(new TypeError("Failed to fetch"));
const never = () => new Promise<never>(() => {});

describe("queued messages kept on this device", () => {
  it("come back after a restart, every one, with a refusal still waiting for Retry", async () => {
    const { platform, values } = device();
    const first = signedIn();
    first.sendMessage.mockImplementation(async (_channel, body) => {
      if (body.text === "while archived") throw new ApiError(400, "channel_archived");
      throw new TypeError("Failed to fetch");
    });
    const view = mount(first.client, platform);
    await waitFor(() => expect(values.has(`outbox:${first.client.baseUrl}:${sam.id}`)).toBe(true));

    first.client.send(design.id, "while archived");
    for (let i = 1; i < OUTBOX_LIMIT; i++) first.client.send(design.id, `queued ${i}`);
    await waitFor(() =>
      expect(first.client.state.pending.filter((p) => p.failed)).toHaveLength(OUTBOX_LIMIT),
    );
    // Closing the app writes what is waiting.
    view.unmount();
    first.client.destroy();

    const second = signedIn();
    const delivered: string[] = [];
    second.sendMessage.mockImplementation(async (_channel, body) => {
      delivered.push(body.text!);
      throw new TypeError("Failed to fetch");
    });
    mount(second.client, platform);
    await waitFor(() => expect(second.client.state.pending).toHaveLength(OUTBOX_LIMIT));
    const refused = second.client.state.pending.find((p) => p.text === "while archived")!;
    expect(refused).toMatchObject({
      failed: true,
      failureReason: "This conversation is archived.",
    });
    await waitFor(() => expect(delivered).toHaveLength(OUTBOX_LIMIT - 1));
    expect(delivered).not.toContain("while archived");
  });

  it("says when they could not be written, and writes them on Retry", async () => {
    const { platform, values } = device();
    const { client, sendMessage } = signedIn();
    sendMessage.mockRejectedValue(new TypeError("Failed to fetch"));
    const write = platform.storage.set;
    let broken = false;
    platform.storage.set = async (name, value) => {
      if (broken) throw new Error("QuotaExceededError");
      return write(name, value);
    };
    mount(client, platform);
    const key = `outbox:${client.baseUrl}:${sam.id}`;
    await waitFor(() => expect(values.has(key)).toBe(true));

    broken = true;
    client.send(design.id, "kept in memory for now");
    expect(
      await screen.findByText(
        "Could not save drafts and queued messages on this device. Keep it open and retry.",
      ),
    ).toBeVisible();

    broken = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(storedTexts(values, key)).toEqual(["kept in memory for now"]));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("are written when the page is hidden, without waiting for the pause", async () => {
    const { platform, values } = device();
    const { client, sendMessage } = signedIn();
    sendMessage.mockRejectedValue(new TypeError("Failed to fetch"));
    mount(client, platform);
    const key = `outbox:${client.baseUrl}:${sam.id}`;
    await waitFor(() => expect(values.has(key)).toBe(true));

    client.send(design.id, "tab closing");
    act(() => void window.dispatchEvent(new Event("pagehide")));
    await waitFor(() => expect(storedTexts(values, key)).toEqual(["tab closing"]));
  });

  it("are written as soon as a send is accepted, and as soon as it is delivered", async () => {
    const { platform, values } = device();
    const { client, sendMessage } = signedIn();
    let deliver = () => {};
    sendMessage.mockImplementation(
      (_channel, body) =>
        new Promise((resolve) => {
          deliver = () => resolve({ message: sent(client, body.nonce!, body.text!) });
        }),
    );
    mount(client, platform);
    const key = `outbox:${client.baseUrl}:${sam.id}`;
    await waitFor(() => expect(values.has(key)).toBe(true));

    expect(client.send(design.id, "on its way")).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    // Closing the app now must not lose it, and nothing waits for a pause in typing.
    await settle();
    expect(storedTexts(values, key)).toEqual(["on its way"]);

    await act(async () => deliver());
    expect(client.state.pending).toEqual([]);
    await settle();
    expect(storedTexts(values, key)).toEqual([]);
  });

  it("keep a refusal as soon as the server gives it, so a restart does not send it again", async () => {
    const { platform, values } = device();
    const { client, sendMessage } = signedIn();
    let refuse = () => {};
    sendMessage.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          refuse = () => reject(new ApiError(400, "channel_archived"));
        }),
    );
    mount(client, platform);
    const key = `outbox:${client.baseUrl}:${sam.id}`;
    await waitFor(() => expect(values.has(key)).toBe(true));
    client.send(design.id, "into an archived channel");
    await waitFor(() => expect(storedTexts(values, key)).toEqual(["into an archived channel"]), {
      timeout: 1500,
    });

    await act(async () => refuse());
    expect(client.state.pending[0]).toMatchObject({ failed: true, refused: true });
    await settle();
    expect(storedEntries(values, key)[0]?.refusal).toBe("This conversation is archived.");
  });

  it("keep the sends of every window open on the account, not only the last to write", async () => {
    const { platform, values } = device();
    // A second window on the same storage, with its own client and its own writes.
    const other = device(values);
    const first = signedIn();
    const second = signedIn();
    first.sendMessage.mockRejectedValue(new TypeError("Failed to fetch"));
    second.sendMessage.mockRejectedValue(new TypeError("Failed to fetch"));
    mount(first.client, platform);
    mount(second.client, other.platform);
    const key = `outbox:${first.client.baseUrl}:${sam.id}`;
    await waitFor(() => expect(values.has(key)).toBe(true));

    first.client.send(design.id, "from the first window");
    await waitFor(() => expect(storedTexts(values, key)).toEqual(["from the first window"]), {
      timeout: 1500,
    });
    second.client.send(design.id, "from the second window");
    await waitFor(() => expect(storedTexts(values, key)).toContain("from the second window"), {
      timeout: 1500,
    });
    expect(storedTexts(values, key)).toEqual(["from the first window", "from the second window"]);

    // Both windows die without writing again; the next start sends both.
    const next = signedIn();
    const delivered: string[] = [];
    next.sendMessage.mockImplementation(async (_channel, body) => {
      delivered.push(body.text!);
      throw new TypeError("Failed to fetch");
    });
    mount(next.client, device(values).platform);
    await waitFor(() =>
      expect(delivered.sort()).toEqual(["from the first window", "from the second window"]),
    );
  });

  it("restore an outbox saved before this version, and keep it once another send is written", async () => {
    const { platform, values } = device();
    const { client, sendMessage } = signedIn();
    const key = `outbox:${client.baseUrl}:${sam.id}`;
    values.set(key, [
      {
        nonce: "saved-before-upgrade",
        channelId: design.id,
        threadRootId: null,
        text: "queued by the previous version",
        userId: sam.id,
        createdAt: Date.now(),
        attachments: [],
      },
    ]);
    const delivered: string[] = [];
    sendMessage.mockImplementation(async (_channel, body) => {
      delivered.push(body.text!);
      throw new TypeError("Failed to fetch");
    });
    mount(client, platform);
    await waitFor(() => expect(delivered).toEqual(["queued by the previous version"]));
    expect(sendMessage.mock.calls[0]![1].nonce).toBe("saved-before-upgrade");

    client.send(design.id, "queued by this one");
    await waitFor(() =>
      expect(storedTexts(values, key)).toEqual([
        "queued by the previous version",
        "queued by this one",
      ]),
    );
  });
});

describe("queued messages shared by every window open on the account", () => {
  /** The texts in a browser's stored outbox, in order. */
  function browserTexts(name: string) {
    const raw = localStorage.getItem(name);
    return readStoredOutbox(raw === null ? null : JSON.parse(raw))!.entries.map((e) => e.text);
  }

  /** Another tab's write, as this one hears of it. */
  function writtenByAnotherTab(name: string, value: unknown) {
    const newValue = JSON.stringify(value);
    localStorage.setItem(name, newValue);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: name, newValue, storageArea: localStorage }),
      );
    });
  }

  it("keep both of two sends accepted at the same moment in two tabs", async () => {
    // Two tabs of the same browser: two platforms over one localStorage.
    const first = signedIn();
    const second = signedIn();
    first.sendMessage.mockImplementation(networkDown);
    second.sendMessage.mockImplementation(networkDown);
    mount(first.client, webPlatform());
    mount(second.client, webPlatform());
    const name = `ownbase:outbox:${first.client.baseUrl}:${sam.id}`;
    await waitFor(() => expect(localStorage.getItem(name)).not.toBeNull());

    first.client.send(design.id, "from the first tab");
    second.client.send(design.id, "from the second tab");
    await settle();
    expect(browserTexts(name)).toEqual(["from the first tab", "from the second tab"]);

    const next = signedIn();
    const delivered: string[] = [];
    next.sendMessage.mockImplementation(async (_channel, body) => {
      delivered.push(body.text!);
      throw new TypeError("Failed to fetch");
    });
    mount(next.client, webPlatform());
    await waitFor(() =>
      expect(delivered.sort()).toEqual(["from the first tab", "from the second tab"]),
    );
  });

  it("put back a send when another tab's write, made without it, lands after it", async () => {
    const { client, sendMessage } = signedIn();
    sendMessage.mockImplementation(networkDown);
    mount(client, webPlatform());
    const name = `ownbase:outbox:${client.baseUrl}:${sam.id}`;
    await waitFor(() => expect(localStorage.getItem(name)).not.toBeNull());
    client.send(design.id, "from this tab");
    await settle();
    expect(browserTexts(name)).toEqual(["from this tab"]);

    // Each browser process keeps its own copy of localStorage. A tab whose copy
    // had not heard of that write yet stores its own send over it.
    writtenByAnotherTab(name, {
      outbox: 2,
      entries: [{ ...queued("from-elsewhere", "from another tab"), rev: 5 }],
      removed: [],
    });
    await waitFor(() => expect(browserTexts(name)).toEqual(["from another tab", "from this tab"]));
  });

  it("take on a refusal and a removal another tab wrote, and send neither again", async () => {
    const { client, sendMessage } = signedIn();
    sendMessage.mockImplementation(never);
    const name = `ownbase:outbox:${client.baseUrl}:${sam.id}`;
    localStorage.setItem(
      name,
      JSON.stringify([queued("refused", "to be refused"), queued("sent", "to be sent")]),
    );
    mount(client, webPlatform());
    await waitFor(() => expect(client.state.pending).toHaveLength(2));
    expect(sendMessage).toHaveBeenCalledTimes(2);

    // The other tab heard the server refuse one and deliver the other.
    writtenByAnotherTab(name, {
      outbox: 2,
      entries: [
        {
          ...queued("refused", "to be refused"),
          refusal: "This conversation is archived.",
          rev: 10,
        },
      ],
      removed: [{ nonce: "sent", rev: 11 }],
    });
    await waitFor(() =>
      expect(client.state.pending).toMatchObject([
        {
          nonce: "refused",
          failed: true,
          refused: true,
          failureReason: "This conversation is archived.",
        },
      ]),
    );
    await settle();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(readStoredOutbox(JSON.parse(localStorage.getItem(name)!))!.entries).toMatchObject([
      { nonce: "refused", refusal: "This conversation is archived." },
    ]);
  });

  it("never bring back a send one window discarded when another writes what it holds", async () => {
    const { platform, values } = device();
    const other = device(values);
    const first = signedIn();
    const second = signedIn();
    first.sendMessage.mockImplementation(networkDown);
    second.sendMessage.mockImplementation(networkDown);
    const key = `outbox:${first.client.baseUrl}:${sam.id}`;
    values.set(key, [queued("restored-twice", "restored in both windows")]);
    // Both windows restore it.
    mount(first.client, platform);
    mount(second.client, other.platform);
    await waitFor(() => expect(first.client.state.pending[0]?.failed).toBe(true));
    await waitFor(() => expect(second.client.state.pending[0]?.failed).toBe(true));

    first.client.discardSend("restored-twice");
    await waitFor(() => expect(storedTexts(values, key)).toEqual([]));
    second.client.send(design.id, "unrelated");
    await waitFor(() => expect(storedTexts(values, key)).toEqual(["unrelated"]));
    // Nor does flushing everything when the page is hidden.
    act(() => void window.dispatchEvent(new Event("pagehide")));
    await settle();
    expect(storedTexts(values, key)).toEqual(["unrelated"]);
    // The second window, seeing it stored as gone, lets go of it as well.
    expect(second.client.state.pending.map((p) => p.text)).toEqual(["unrelated"]);

    const next = signedIn();
    const delivered: string[] = [];
    next.sendMessage.mockImplementation(async (_channel, body) => {
      delivered.push(body.text!);
      throw new TypeError("Failed to fetch");
    });
    mount(next.client, device(values).platform);
    await waitFor(() => expect(delivered).toEqual(["unrelated"]));
  });

  describe("once tombstones have been let go", () => {
    /** A floor as a merge long after the retry window leaves it. */
    const oldFloor = () => outboxRevision(0, Date.now() - SEND_RETRY_WINDOW_MS - 24 * 3600_000);

    it("let go of a send taken out elsewhere since, and never write it back", async () => {
      const { client, sendMessage } = signedIn();
      sendMessage.mockImplementation(never);
      const name = `ownbase:outbox:${client.baseUrl}:${sam.id}`;
      localStorage.setItem(name, JSON.stringify([queued("long-gone", "delivered by another tab")]));
      mount(client, webPlatform());
      await waitFor(() => expect(client.state.pending).toHaveLength(1));

      // Unheard by this tab: another delivered it, and so long and so many
      // sends later that its tombstone was let go, leaving the floor above it.
      writtenByAnotherTab(name, {
        outbox: 2,
        entries: [],
        removed: [],
        compactedThrough: oldFloor(),
      });
      await waitFor(() => expect(client.state.pending).toHaveLength(0));
      // Writing everything it holds does not bring it back.
      client.send(design.id, "a new one");
      await settle();
      expect(browserTexts(name)).toEqual(["a new one"]);
    });

    it("put back a send another tab's write left out, even one waiting since before the floor", async () => {
      const { client, sendMessage } = signedIn();
      sendMessage.mockImplementation(never);
      const name = `ownbase:outbox:${client.baseUrl}:${sam.id}`;
      const floor = oldFloor();
      localStorage.setItem(
        name,
        JSON.stringify({
          outbox: 2,
          entries: [{ ...queued("waiting", "waiting a long time"), rev: 5 }],
          removed: [],
          compactedThrough: floor,
        }),
      );
      mount(client, webPlatform());
      await waitFor(() => expect(client.state.pending).toHaveLength(1));

      // A tab whose copy had not heard of it writes over it. The floor is as
      // it was: nothing was let go, so this is no removal.
      writtenByAnotherTab(name, { outbox: 2, entries: [], removed: [], compactedThrough: floor });
      await waitFor(() => expect(browserTexts(name)).toEqual(["waiting a long time"]));
      expect(client.state.pending.map((p) => p.nonce)).toEqual(["waiting"]);
    });

    it("write again, newer, a send of this tab's own that a floor refused before it was stored", async () => {
      const { client, sendMessage } = signedIn();
      sendMessage.mockImplementation(never);
      mount(client, webPlatform());
      const name = `ownbase:outbox:${client.baseUrl}:${sam.id}`;
      await waitFor(() => expect(localStorage.getItem(name)).not.toBeNull());

      // Unheard by this tab, another's write left a floor above the revision
      // this tab's next send will get.
      localStorage.setItem(
        name,
        JSON.stringify({
          outbox: 2,
          entries: [],
          removed: [],
          compactedThrough: outboxRevision(0, Date.now() + 60_000),
        }),
      );
      client.send(design.id, "sent just now");
      await waitFor(() => expect(browserTexts(name)).toEqual(["sent just now"]));
    });
  });

  it("keep a refusal one window stored, however stale another window's copy of that send", async () => {
    const { platform, values } = device();
    const other = device(values);
    const stale = signedIn();
    const current = signedIn();
    // The stale window's attempt is still waiting when the other hears the refusal.
    stale.sendMessage.mockImplementation(never);
    current.sendMessage.mockRejectedValue(new ApiError(400, "channel_archived"));
    const key = `outbox:${stale.client.baseUrl}:${sam.id}`;
    values.set(key, [queued("refused-once", "into an archived channel")]);
    mount(stale.client, platform);
    await waitFor(() => expect(stale.client.state.pending).toHaveLength(1));
    mount(current.client, other.platform);
    await waitFor(() =>
      expect(storedEntries(values, key)[0]?.refusal).toBe("This conversation is archived."),
    );

    // The stale window writes when it queues something else.
    stale.client.send(design.id, "something else");
    await waitFor(() => expect(storedTexts(values, key)).toContain("something else"));
    expect(storedEntries(values, key)[0]).toMatchObject({
      nonce: "refused-once",
      refusal: "This conversation is archived.",
    });
    // And stops sending it too, until its author chooses Retry.
    expect(stale.client.state.pending[0]).toMatchObject({ failed: true, refused: true });

    const next = signedIn();
    const delivered: string[] = [];
    next.sendMessage.mockImplementation(async (_channel, body) => {
      delivered.push(body.text!);
      throw new TypeError("Failed to fetch");
    });
    mount(next.client, device(values).platform);
    await waitFor(() => expect(delivered).toEqual(["something else"]));
    expect(next.client.state.pending.find((p) => p.nonce === "refused-once")).toMatchObject({
      failed: true,
      failureReason: "This conversation is archived.",
    });
  });
});

describe("the moment a send is kept", () => {
  /** Outbox writes wait until the test lets them finish, or fail. */
  function gatedOutbox(platform: Platform, key: string) {
    const write = platform.storage.set;
    const gate = { closed: false, held: false, open: () => {}, fail: () => {} };
    platform.storage.set = async (name, value) => {
      if (name === key && gate.closed) {
        gate.held = true;
        await new Promise<void>((resolve, reject) => {
          gate.open = resolve;
          gate.fail = () => reject(new Error("QuotaExceededError"));
        });
      }
      return write(name, value);
    };
    return gate;
  }

  const pause = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  it("is when its outbox write finishes; until then the saved draft keeps its words", async () => {
    const { platform, values } = device();
    const { client, sendMessage } = signedIn();
    sendMessage.mockImplementation(never);
    const key = `outbox:${client.baseUrl}:${sam.id}`;
    const draftKey = `drafts:${client.baseUrl}:${sam.id}`;
    const gate = gatedOutbox(platform, key);
    mount(client, platform);
    await waitFor(() => expect(values.has(key)).toBe(true));
    client.setDraft(design.id, "typed, then sent");
    await waitFor(() => expect(values.get(draftKey)).toEqual({ [design.id]: "typed, then sent" }), {
      timeout: 3000,
    });

    gate.closed = true;
    // What the composer does on Enter.
    client.send(design.id, "typed, then sent");
    client.setDraft(design.id, "");
    // Well past the pause drafts wait for: a process that died now would come
    // back with the words in the composer, since the send is not stored yet.
    await pause(900);
    expect(storedTexts(values, key)).toEqual([]);
    expect(values.get(draftKey)).toEqual({ [design.id]: "typed, then sent" });

    gate.closed = false;
    act(() => gate.open());
    await waitFor(() => expect(storedTexts(values, key)).toEqual(["typed, then sent"]));
    await waitFor(() => expect(values.get(draftKey)).toEqual({}));
  });

  it("keeps the words in the saved draft when the outbox write fails, and saves both on Retry", async () => {
    const { platform, values } = device();
    const { client, sendMessage } = signedIn();
    sendMessage.mockImplementation(never);
    const key = `outbox:${client.baseUrl}:${sam.id}`;
    const draftKey = `drafts:${client.baseUrl}:${sam.id}`;
    const gate = gatedOutbox(platform, key);
    mount(client, platform);
    await waitFor(() => expect(values.has(key)).toBe(true));
    client.setDraft(design.id, "not lost");
    await waitFor(() => expect(values.get(draftKey)).toEqual({ [design.id]: "not lost" }), {
      timeout: 3000,
    });

    gate.closed = true;
    client.send(design.id, "not lost");
    client.setDraft(design.id, "");
    await waitFor(() => expect(gate.held).toBe(true));
    act(() => gate.fail());
    expect(
      await screen.findByText(
        "Could not save drafts and queued messages on this device. Keep it open and retry.",
      ),
    ).toBeVisible();
    await pause(900);
    expect(values.get(draftKey)).toEqual({ [design.id]: "not lost" });

    gate.closed = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(storedTexts(values, key)).toEqual(["not lost"]));
    await waitFor(() => expect(values.get(draftKey)).toEqual({}));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("windows starting at the same moment", () => {
  it("keep a send one stored while the other was still reading an empty outbox", async () => {
    // The workspace's own key, which a first read sets up: an address key never did.
    const inWorkspace = () => {
      const window = signedIn();
      window.client.store.setState({ workspaceId: "W1" });
      window.sendMessage.mockImplementation(networkDown);
      return window;
    };
    const key = "local:v1:W1:U_SAM:outbox";
    const { values, window, pausedWindow } = sharedDevice();
    const stored = () =>
      readStoredOutbox(
        (values.get(key) as { value?: unknown } | undefined)?.value ?? null,
      )?.entries.map((e) => e.text);

    // B starts first, and is caught right after finding nothing stored.
    const b = inWorkspace();
    const paused = pausedWindow(key);
    mount(b.client, paused.platform);
    await act(() => paused.paused);

    // A starts, and a send it accepted is stored.
    const a = inWorkspace();
    const aView = mount(a.client, window());
    await waitFor(() => expect(values.has(key)).toBe(true));
    a.client.send(design.id, "accepted by A");
    await waitFor(() => expect(stored()).toEqual(["accepted by A"]));
    // A closes normally, its send acknowledged.
    aView.unmount();
    a.client.destroy();
    await settle();

    // B carries on with its startup and writes what it holds; it finds A's
    // send stored, as a window starting later would.
    await act(async () => paused.resume());
    await settle();
    await settle();
    expect(stored()).toEqual(["accepted by A"]);
    await waitFor(() =>
      expect(b.client.state.pending.map((p) => p.text)).toEqual(["accepted by A"]),
    );

    // And the next start sends it.
    const next = inWorkspace();
    const delivered: string[] = [];
    next.sendMessage.mockImplementation(async (_channel, body) => {
      delivered.push(body.text!);
      throw new TypeError("Failed to fetch");
    });
    mount(next.client, window());
    await waitFor(() => expect(delivered).toEqual(["accepted by A"]));
  });
});

describe("words sent before their draft was ever saved", () => {
  const outboxKey = (client: WorkspaceClient) => `outbox:${client.baseUrl}:${sam.id}`;
  const draftsKey = (client: WorkspaceClient) => `drafts:${client.baseUrl}:${sam.id}`;
  const unstoredKey = (client: WorkspaceClient) => `unstored-sends:${client.baseUrl}:${sam.id}`;

  /** A device whose outbox cannot be written until `mend` is called. */
  function brokenOutbox() {
    const { platform, values } = device();
    const write = platform.storage.set;
    let broken = false;
    platform.storage.set = async (name, value) => {
      if (broken && name.startsWith("outbox:")) throw new Error("QuotaExceededError");
      return write(name, value);
    };
    return {
      platform,
      values,
      breakOutbox: () => void (broken = true),
      mend: () => void (broken = false),
    };
  }

  /** What Composer does on Enter: the words go to a send and the draft empties. */
  function typeAndSend(client: WorkspaceClient, draftKey: string, text: string, rootId?: string) {
    client.setDraft(draftKey, text);
    expect(client.send(design.id, text, rootId ? { threadRootId: rootId } : {})).toBe(true);
    client.setDraft(draftKey, "");
  }

  async function restart(values: Map<string, unknown>) {
    const next = signedIn();
    next.sendMessage.mockImplementation(networkDown);
    mount(next.client, device(values).platform);
    await waitFor(() => expect(values.get(unstoredKey(next.client))).toEqual({}));
    return next;
  }

  it("come back in the composer after a restart when the outbox could not store them", async () => {
    const { platform, values, breakOutbox } = brokenOutbox();
    const { client, sendMessage } = signedIn();
    sendMessage.mockImplementation(never);
    mount(client, platform);
    await waitFor(() => expect(values.has(outboxKey(client))).toBe(true));
    breakOutbox();

    // Sent well inside the pause before a draft is saved.
    typeAndSend(client, design.id, "first words");
    expect(
      await screen.findByText(
        "Could not save drafts and queued messages on this device. Keep it open and retry.",
      ),
    ).toBeVisible();
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 750)));
    // Neither the draft nor the outbox holds them: only the key kept for this.
    expect(values.get(draftsKey(client)) ?? {}).toEqual({});
    expect(storedTexts(values, outboxKey(client))).toEqual([]);
    expect(Object.values(values.get(unstoredKey(client)) as object)).toEqual([
      { draftKey: design.id, text: "first words" },
    ]);

    // The process is gone. The next start has the words to act on, once.
    const next = await restart(values);
    expect(next.client.state.drafts[design.id]).toBe("first words");
    expect(next.client.state.pending).toEqual([]);
    expect(next.sendMessage).not.toHaveBeenCalled();
    await waitFor(
      () => expect(values.get(draftsKey(next.client))).toEqual({ [design.id]: "first words" }),
      {
        timeout: 3000,
      },
    );
  });

  it("are let go once a retry stores the send, so they come back as a send only", async () => {
    const { platform, values, breakOutbox, mend } = brokenOutbox();
    const { client, sendMessage } = signedIn();
    sendMessage.mockImplementation(never);
    mount(client, platform);
    await waitFor(() => expect(values.has(outboxKey(client))).toBe(true));
    breakOutbox();
    typeAndSend(client, design.id, "sent once");
    await waitFor(() => expect(Object.keys(values.get(unstoredKey(client)) ?? {})).toHaveLength(1));

    mend();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(storedTexts(values, outboxKey(client))).toEqual(["sent once"]));
    await waitFor(() => expect(values.get(unstoredKey(client))).toEqual({}));

    const next = signedIn();
    const delivered: string[] = [];
    next.sendMessage.mockImplementation(async (_channel, body) => {
      delivered.push(body.text!);
      throw new TypeError("Failed to fetch");
    });
    mount(next.client, device(values).platform);
    await waitFor(() => expect(delivered).toEqual(["sent once"]));
    expect(next.client.state.drafts[design.id]).toBeUndefined();
  });

  it("come back to the composer they were sent from, each of them", async () => {
    const { platform, values, breakOutbox } = brokenOutbox();
    const { client, sendMessage } = signedIn();
    sendMessage.mockImplementation(never);
    mount(client, platform);
    await waitFor(() => expect(values.has(outboxKey(client))).toBe(true));
    breakOutbox();
    typeAndSend(client, design.id, "one");
    typeAndSend(client, design.id, "two");
    typeAndSend(client, `${design.id}:M_ROOT`, "in a thread", "M_ROOT");
    await waitFor(() => expect(Object.keys(values.get(unstoredKey(client)) ?? {})).toHaveLength(3));

    const next = await restart(values);
    expect(next.client.state.drafts).toEqual({
      [design.id]: "one\n\ntwo",
      [`${design.id}:M_ROOT`]: "in a thread",
    });
  });
});
