import { EventEmitter } from "node:events";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SavedDownloads, type DownloadLike } from "../src/main/savedDownloads.js";

/** A download as Electron reports it: a save path, and "done" with how it ended. */
function download(path: string) {
  const item = new EventEmitter() as EventEmitter & DownloadLike;
  item.getSavePath = () => path;
  return {
    item,
    finish: (state: "completed" | "cancelled" | "interrupted") => item.emit("done", {}, state),
  };
}

describe("downloads the window is told about", () => {
  it("tells the window the file's name when it is saved, and shows only that file", () => {
    const reveal = vi.fn();
    const saved = new SavedDownloads(reveal);
    const tell = vi.fn();
    const path = join("Downloads", "launch plan.pdf");
    const { item, finish } = download(path);
    saved.track(item, tell);
    expect(tell).not.toHaveBeenCalled();
    finish("completed");
    expect(tell).toHaveBeenCalledWith({ id: expect.any(Number), name: "launch plan.pdf" });

    const { id } = tell.mock.calls[0]![0] as { id: number };
    saved.show(id);
    expect(reveal).toHaveBeenCalledWith(path);
  });

  it("says nothing of a download cancelled or broken off", () => {
    const saved = new SavedDownloads(vi.fn());
    const tell = vi.fn();
    for (const state of ["cancelled", "interrupted"] as const) {
      const { item, finish } = download(join("Downloads", "notes.txt"));
      saved.track(item, tell);
      finish(state);
    }
    expect(tell).not.toHaveBeenCalled();
  });

  it("refuses to show anything it did not save itself in this run", () => {
    const reveal = vi.fn();
    const saved = new SavedDownloads(reveal);
    for (const asked of [1, "C:\\Windows\\System32", -1, 1.5, null, undefined, { id: 1 }])
      expect(() => saved.show(asked)).toThrow("That download is not one OwnBase saved.");
    expect(reveal).not.toHaveBeenCalled();
  });
});
