import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceClient } from "@ownbase/client-core";
import type { Channel, User } from "@ownbase/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { Composer } from "../src/components/Composer.js";
import { DraftPersistence } from "../src/components/DraftPersistence.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { sharedDevice } from "./sharedDevice.js";

const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam",
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
function client(user = sam) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: user,
    users: { [user.id]: user },
    channels: { [design.id]: design },
    status: "online",
  });
  return client;
}
function closeDevice() {
  const device = sharedDevice();
  const platform = device.window();
  const capture = new Set<() => void | Promise<void>>();
  const persist = new Set<() => void | Promise<void>>();
  platform.onPrepareClose = (phase, callback) => {
    const owners = phase === "capture" ? capture : persist;
    owners.add(callback);
    return () => void owners.delete(callback);
  };
  const prepare = async () => {
    for (const callback of capture) await callback();
    await Promise.all([...persist].map((callback) => callback()));
  };
  return { ...device, platform, capture, persist, prepare };
}
function mount(client: WorkspaceClient, platform: Platform) {
  return render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <DraftPersistence platform={platform} />
        <Composer channelId={design.id} placeholder="Message #design" />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
}
function held() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const draftsKey = (client: WorkspaceClient) => `drafts:${client.baseUrl}:${client.state.self!.id}`;
beforeEach(() => localStorage.clear());

describe("ordinary desktop close with the visible composer", () => {
  it("captures the last edit before its debounce and waits for a delayed draft merge", async () => {
    const device = closeDevice();
    const current = client();
    mount(current, device.platform);
    await act(async () => {
      await device.prepare();
    });
    const storageMerge = device.platform.storage.mergeDrafts!;
    const write = held();
    let writing = false;
    device.platform.storage.mergeDrafts = async (...args) => {
      writing = true;
      await write.promise;
      return storageMerge(...args);
    };
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "the final visible keystroke" },
    });
    expect(current.state.drafts[design.id]).toBeUndefined();
    let completed = false;
    let preparation!: Promise<void>;
    act(() => {
      preparation = device.prepare().then(() => {
        completed = true;
      });
    });
    await waitFor(() => expect(writing).toBe(true));
    expect(current.state.drafts[design.id]).toBe("the final visible keystroke");
    expect(completed).toBe(false);
    await act(async () => {
      write.resolve();
      await preparation;
    });
    expect(device.values.get(draftsKey(current))).toEqual({
      [design.id]: "the final visible keystroke",
    });
    expect(completed).toBe(true);
  });

  it("keeps the draft and refuses close after failed writes, then saves it on retry", async () => {
    const device = closeDevice();
    const current = client();
    mount(current, device.platform);
    await act(async () => {
      await device.prepare();
    });
    const storageMerge = device.platform.storage.mergeDrafts!;
    let failing = true;
    device.platform.storage.mergeDrafts = async (...args) => {
      if (failing) throw new Error("disk full");
      return storageMerge(...args);
    };
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "copy these words before leaving" },
    });
    await act(async () => {
      await expect(device.prepare()).rejects.toThrow("Local work could not be saved");
    });
    expect(screen.getByRole("textbox")).toHaveValue("copy these words before leaving");
    expect(current.state.drafts[design.id]).toBe("copy these words before leaving");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not save drafts and queued messages",
    );
    failing = false;
    await act(async () => {
      await device.prepare();
    });
    expect(device.values.get(draftsKey(current))).toEqual({
      [design.id]: "copy these words before leaving",
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("waits for a pending restore and keeps typing made before it completes", async () => {
    const device = closeDevice();
    const current = client();
    const read = held();
    const get = device.platform.storage.get;
    device.platform.storage.get = async <T,>(...args: Parameters<typeof get>) => {
      await read.promise;
      return get<T>(...args);
    };
    mount(current, device.platform);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "typed while restoring" } });
    let completed = false;
    let preparation!: Promise<void>;
    act(() => {
      preparation = device.prepare().then(() => {
        completed = true;
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(completed).toBe(false);
    await act(async () => {
      read.resolve();
      await preparation;
    });
    expect(device.values.get(draftsKey(current))).toEqual({ [design.id]: "typed while restoring" });
  });

  it("unregisters the previous account before preparing another account", async () => {
    const device = closeDevice();
    const old = client();
    const first = mount(old, device.platform);
    await act(async () => {
      await device.prepare();
    });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Sam's private draft" } });
    first.unmount();
    expect(device.capture.size).toBe(0);
    expect(device.persist.size).toBe(0);
    const next = client({ ...sam, id: "U_ANN", handle: "ann" });
    mount(next, device.platform);
    await act(async () => {
      await device.prepare();
    });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ann's separate draft" } });
    await act(async () => {
      await device.prepare();
    });
    expect(device.values.get(draftsKey(old))).toEqual({ [design.id]: "Sam's private draft" });
    expect(device.values.get(draftsKey(next))).toEqual({ [design.id]: "Ann's separate draft" });
  });
});
