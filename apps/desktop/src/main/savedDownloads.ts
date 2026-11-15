import { basename } from "node:path";
import type { SavedDownload } from "@ownbase/protocol/desktop";

/** The parts of Electron's DownloadItem this needs. */
export interface DownloadLike {
  getSavePath(): string;
  once(event: "done", listener: (event: unknown, state: string) => void): unknown;
}

/**
 * Files this run of the app saved, so the window can say where one went and
 * offer to show it. The window names a file only by the id it was told, so it
 * can never have the app reveal a path of its choosing.
 */
export class SavedDownloads {
  private readonly paths = new Map<number, string>();
  private last = 0;

  constructor(private readonly reveal: (path: string) => void) {}

  /** Tells the window once `item` is saved; a cancelled or broken-off one says nothing. */
  track(item: DownloadLike, tell: (file: SavedDownload) => void): void {
    item.once("done", (_event, state) => {
      if (state !== "completed") return;
      const path = item.getSavePath();
      if (!path) return;
      const id = ++this.last;
      this.paths.set(id, path);
      tell({ id, name: basename(path) });
    });
  }

  /** Opens the folder of a file this run saved, with the file selected. */
  show(id: unknown): void {
    const path = typeof id === "number" ? this.paths.get(id) : undefined;
    if (path === undefined) throw new Error("That download is not one OwnBase saved.");
    this.reveal(path);
  }
}
