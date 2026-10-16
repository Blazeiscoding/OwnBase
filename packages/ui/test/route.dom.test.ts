import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderHook, waitFor } from "@testing-library/react";
import { useHistoryKeys } from "../src/lib/historyKeys.js";
import {
  currentRoute,
  parseRouteHash,
  rememberReadingPosition,
  rememberedReadingPosition,
  routeHash,
  writeRoute,
} from "../src/lib/route.js";

describe("reading a place in a workspace from the address", () => {
  it("reads a conversation, and a thread open beside it", () => {
    expect(parseRouteHash("#/c/C_DESIGN")).toEqual({ channelId: "C_DESIGN", threadRootId: null });
    expect(parseRouteHash("#/c/C_DESIGN/t/M_ROOT")).toEqual({
      channelId: "C_DESIGN",
      threadRootId: "M_ROOT",
    });
    expect(routeHash({ channelId: "C_DESIGN", threadRootId: "M_ROOT" })).toBe(
      "#/c/C_DESIGN/t/M_ROOT",
    );
  });

  it("reads a side panel open beside a conversation", () => {
    expect(parseRouteHash("#/c/C_DESIGN/p/saved")).toEqual({
      channelId: "C_DESIGN",
      threadRootId: null,
      view: "saved",
    });
    for (const view of ["pins", "saved", "threads", "scheduled", "activity", "dms"] as const) {
      const route = { channelId: "C_DESIGN", threadRootId: null, view };
      expect(parseRouteHash(routeHash(route))).toEqual(route);
    }
    // A thread is its own place; it never carries a panel with it.
    expect(routeHash({ channelId: "C_DESIGN", threadRootId: "M_ROOT", view: "saved" })).toBe(
      "#/c/C_DESIGN/t/M_ROOT",
    );
  });

  it("leaves links to a message, and anything else, alone", () => {
    for (const hash of [
      "",
      "#",
      "#/join/ABCD",
      "#/c/C_DESIGN/m/M_PLAN",
      "#/c/",
      "#/c/a%2Fb",
      "#/c/C_DESIGN/p/settings",
      "#/c/C_DESIGN/p/",
    ]) {
      expect(parseRouteHash(hash)).toBeNull();
    }
  });
});

describe("a dialog open over a place", () => {
  it("reads settings and lists after the conversation, thread or panel", () => {
    expect(parseRouteHash("#/c/C_DESIGN/d/account/security")).toEqual({
      channelId: "C_DESIGN",
      threadRootId: null,
      dialog: { name: "account", section: "security" },
    });
    expect(parseRouteHash("#/c/C_DESIGN/t/M_ROOT/d/people")).toEqual({
      channelId: "C_DESIGN",
      threadRootId: "M_ROOT",
      dialog: { name: "people" },
    });
    expect(parseRouteHash("#/c/C_DESIGN/p/saved/d/details")).toEqual({
      channelId: "C_DESIGN",
      threadRootId: null,
      view: "saved",
      dialog: { name: "details" },
    });
    for (const route of [
      { channelId: "C_DESIGN", threadRootId: null, dialog: { name: "account" as const } },
      {
        channelId: "C_DESIGN",
        threadRootId: "M_ROOT",
        dialog: { name: "account" as const, section: "devices" as const },
      },
      {
        channelId: "C_DESIGN",
        threadRootId: null,
        view: "pins" as const,
        dialog: { name: "invite" as const },
      },
    ]) {
      expect(parseRouteHash(routeHash(route))).toEqual(route);
    }
  });

  it("leaves out forms and search, and anything it does not know", () => {
    for (const hash of [
      "#/c/C_DESIGN/d/search",
      "#/c/C_DESIGN/d/new-channel",
      "#/c/C_DESIGN/d/",
      "#/c/C_DESIGN/d/account/billing",
      "#/c/C_DESIGN/d/people/security",
      "#/c/C_DESIGN/d/account/security/more",
      "#/c/C_DESIGN/d/people/t/M_ROOT",
    ]) {
      expect(parseRouteHash(hash)).toBeNull();
    }
  });

  it("is kept in a history entry, and one it does not know is dropped", () => {
    const server = "http://10.0.0.5:8543";
    const address = { hash: "", origin: location.origin };
    const entry = (dialog: unknown) => ({
      tandem: { server, channelId: "C_OPS", threadRootId: null, dialog },
    });
    expect(currentRoute(server, address, entry({ name: "account", section: "devices" }))).toEqual({
      channelId: "C_OPS",
      threadRootId: null,
      dialog: { name: "account", section: "devices" },
    });
    for (const dialog of [{ name: "search" }, { name: "apps", section: "profile" }, "people"]) {
      expect(currentRoute(server, address, entry(dialog))).not.toHaveProperty("dialog");
    }
  });

  it("is a step of its own to open, and a section change rewrites it", () => {
    const server = location.origin;
    writeRoute(server, { channelId: "C_GENERAL", threadRootId: null });
    const start = window.history.length;
    const account = (section?: "security") => ({
      channelId: "C_GENERAL",
      threadRootId: null,
      dialog: section ? { name: "account" as const, section } : { name: "account" as const },
    });
    expect(writeRoute(server, account())).toBe("push");
    expect(writeRoute(server, account("security"), "replace")).toBe("replace");
    expect(writeRoute(server, account("security"))).toBe("unchanged");
    expect(window.history.length).toBe(start + 1);
    expect(location.hash).toBe("#/c/C_GENERAL/d/account/security");
    window.history.replaceState(null, "", "/");
  });
});

describe("the phone's drawer", () => {
  it("is a step in history that never reaches the address", () => {
    const server = location.origin;
    writeRoute(server, { channelId: "C_GENERAL", threadRootId: null });
    const start = window.history.length;
    expect(writeRoute(server, { channelId: "C_GENERAL", threadRootId: null, drawer: true })).toBe(
      "push",
    );
    expect(location.hash).toBe("#/c/C_GENERAL");
    expect(window.history.length).toBe(start + 1);
    expect(currentRoute(server)).toEqual({
      channelId: "C_GENERAL",
      threadRootId: null,
      drawer: true,
    });
    // Going somewhere from it rewrites its step.
    expect(writeRoute(server, { channelId: "C_DESIGN", threadRootId: null }, "replace")).toBe(
      "replace",
    );
    expect(window.history.length).toBe(start + 1);
    expect(currentRoute(server)).toEqual({ channelId: "C_DESIGN", threadRootId: null });
    window.history.replaceState(null, "", "/");
  });

  it("is open only when an entry says so plainly", () => {
    const server = "http://10.0.0.5:8543";
    const address = { hash: "", origin: location.origin };
    for (const drawer of ["yes", 1, null]) {
      const entry = { tandem: { server, channelId: "C_OPS", threadRootId: null, drawer } };
      expect(currentRoute(server, address, entry)).not.toHaveProperty("drawer");
    }
  });
});

describe("where a conversation was being read", () => {
  it("is noted on its own entry without a step or a new address, and read back", () => {
    const server = location.origin;
    writeRoute(server, { channelId: "C_GENERAL", threadRootId: null });
    const start = window.history.length;
    rememberReadingPosition(server, "C_GENERAL", { messageId: "M_MIDDLE", offset: -12 });
    expect(window.history.length).toBe(start);
    expect(location.hash).toBe("#/c/C_GENERAL");
    expect(rememberedReadingPosition(server, "C_GENERAL")).toEqual({
      messageId: "M_MIDDLE",
      offset: -12,
    });
    // The place itself is unchanged, so moving on is still a step.
    expect(currentRoute(server)).toEqual({ channelId: "C_GENERAL", threadRootId: null });
    rememberReadingPosition(server, "C_GENERAL", null);
    expect(rememberedReadingPosition(server, "C_GENERAL")).toBeNull();
    window.history.replaceState(null, "", "/");
  });

  it("never lands on the entry for another conversation or workspace", () => {
    const server = location.origin;
    writeRoute(server, { channelId: "C_DESIGN", threadRootId: null });
    rememberReadingPosition(server, "C_GENERAL", { messageId: "M_LATE", offset: 0 });
    rememberReadingPosition("http://10.0.0.9:8543", "C_DESIGN", { messageId: "M_LATE", offset: 0 });
    expect(rememberedReadingPosition(server, "C_DESIGN")).toBeNull();
    expect(rememberedReadingPosition(server, "C_GENERAL")).toBeNull();
    window.history.replaceState(null, "", "/");
  });

  it("ignores a position that is not plainly a message and a distance", () => {
    const server = location.origin;
    for (const scroll of [
      { messageId: "../M", offset: 0 },
      { messageId: "M_OK", offset: Number.NaN },
      { messageId: "M_OK" },
      "M_OK",
    ]) {
      window.history.replaceState(
        { tandem: { server, channelId: "C_GENERAL", threadRootId: null, scroll } },
        "",
        "/#/c/C_GENERAL",
      );
      expect(rememberedReadingPosition(server, "C_GENERAL")).toBeNull();
    }
    window.history.replaceState(null, "", "/");
  });
});

describe("the place a history entry remembers", () => {
  const here = () => location.origin;
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("belongs to one workspace, whatever the address says", () => {
    const state = {
      tandem: { server: "http://10.0.0.5:8543", channelId: "C_OPS", threadRootId: null },
    };
    const address = { hash: "#/c/C_DESIGN", origin: here() };
    expect(currentRoute("http://10.0.0.5:8543", address, state)).toEqual({
      channelId: "C_OPS",
      threadRootId: null,
    });
    // Another workspace's entry, in a desktop app with more than one.
    expect(currentRoute("http://10.0.0.9:8543", address, state)).toBeNull();
  });

  it("remembers a side panel, and ignores one it does not know", () => {
    const server = "http://10.0.0.5:8543";
    const address = { hash: "", origin: here() };
    const entry = (view: unknown, threadRootId: string | null = null) => ({
      tandem: { server, channelId: "C_OPS", threadRootId, view },
    });
    expect(currentRoute(server, address, entry("activity"))).toEqual({
      channelId: "C_OPS",
      threadRootId: null,
      view: "activity",
    });
    for (const state of [entry("settings"), entry("saved", "M_ROOT")]) {
      expect(currentRoute(server, address, state)).not.toHaveProperty("view");
    }
  });

  it("adds a step when a panel opens or closes, so Back closes it", () => {
    const server = here();
    writeRoute(server, { channelId: "C_GENERAL", threadRootId: null });
    const start = window.history.length;
    writeRoute(server, { channelId: "C_GENERAL", threadRootId: null, view: "saved" });
    expect(location.hash).toBe("#/c/C_GENERAL/p/saved");
    writeRoute(server, { channelId: "C_GENERAL", threadRootId: null });
    expect(window.history.length).toBe(start + 2);
  });

  it("reads a typed or shared address only on the page the workspace serves", () => {
    const address = { hash: "#/c/C_DESIGN/t/M_ROOT", origin: here() };
    expect(currentRoute(here(), address, null)).toEqual({
      channelId: "C_DESIGN",
      threadRootId: "M_ROOT",
    });
    expect(currentRoute("http://10.0.0.5:8543", address, null)).toBeNull();
  });

  it("replaces the entry it arrived on, then adds one for each move, and Back returns", async () => {
    const server = here();
    const start = window.history.length;
    writeRoute(server, { channelId: "C_GENERAL", threadRootId: null });
    expect(window.history.length).toBe(start);
    expect(location.hash).toBe("#/c/C_GENERAL");

    writeRoute(server, { channelId: "C_DESIGN", threadRootId: null });
    writeRoute(server, { channelId: "C_DESIGN", threadRootId: "M_ROOT" });
    // The same place again is not a move.
    writeRoute(server, { channelId: "C_DESIGN", threadRootId: "M_ROOT" });
    expect(window.history.length).toBe(start + 2);
    expect(location.hash).toBe("#/c/C_DESIGN/t/M_ROOT");

    window.history.back();
    await waitFor(() =>
      expect(currentRoute(server)).toEqual({ channelId: "C_DESIGN", threadRootId: null }),
    );
    expect(location.hash).toBe("#/c/C_DESIGN");
  });

  it("replaces rather than adds when the app moved on its own, or the entry is another workspace's", () => {
    const server = here();
    writeRoute("http://10.0.0.9:8543", { channelId: "C_OTHER", threadRootId: null });
    const start = window.history.length;
    writeRoute(server, { channelId: "C_GENERAL", threadRootId: null });
    writeRoute(server, { channelId: "C_GONE", threadRootId: null }, "replace");
    expect(window.history.length).toBe(start);
    expect(currentRoute(server)).toEqual({ channelId: "C_GONE", threadRootId: null });
  });
});

describe("Back and Forward in a window without a toolbar", () => {
  afterEach(() => vi.restoreAllMocks());

  it("follows Alt with the arrow keys, and the mouse's side buttons, only when switched on", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const forward = vi.spyOn(window.history, "forward").mockImplementation(() => {});
    const { rerender, unmount } = renderHook(({ on }) => useHistoryKeys(on), {
      initialProps: { on: false },
    });
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    expect(back).not.toHaveBeenCalled();

    rerender({ on: true });
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    fireEvent.mouseUp(window, { button: 3 });
    fireEvent.mouseUp(window, { button: 4 });
    // Word-by-word selection and other editing keys are left alone.
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft", ctrlKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(back).toHaveBeenCalledTimes(2);
    expect(forward).toHaveBeenCalledTimes(2);

    unmount();
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    expect(back).toHaveBeenCalledTimes(2);
  });
});
