import { describe, expect, it, vi } from "vitest";
import {
  ScreenChoice,
  SourceList,
  blank,
  findSource,
  type CapturedSource,
} from "../src/main/screenShare.js";

/**
 * The desktop app's own screen picker (CALL-01). The window lists what can be
 * shared, with a picture of each, and names its choice; the getDisplayMedia
 * request after it shares that one and nothing else.
 */
type Picture = CapturedSource["thumbnail"];

/** A square picture `width` wide, every pixel the colour given, or one pixel lit. */
function picture(
  width: number,
  fill = 0x80,
  options: { empty?: boolean; lit?: number } = {},
): Picture {
  const bitmap = new Uint8Array(width * width * 4).fill(fill);
  if (options.lit !== undefined) bitmap[options.lit * 4 + 1] = 1;
  return {
    isEmpty: () => options.empty === true,
    getSize: () => ({ width, height: width }),
    resize: ({ width: to }) => picture(to, fill),
    toBitmap: () => bitmap,
    toDataURL: () => `data:image/png;base64,icon-${width}`,
    toJPEG: () => new TextEncoder().encode(`jpeg-${width}`),
  };
}

const source = (
  id: string,
  name: string,
  parts: Partial<Pick<CapturedSource, "thumbnail" | "appIcon">> = {},
): CapturedSource => ({
  id,
  name,
  thumbnail: parts.thumbnail ?? picture(48),
  appIcon: parts.appIcon ?? null,
});

describe("telling a window that shows nothing", () => {
  it("counts no picture, or black to the last pixel, as nothing", () => {
    expect(blank(picture(0, 0, { empty: true }))).toBe(true);
    expect(blank(picture(48, 0))).toBe(true);
  });

  it("counts any pixel that is not black, even the last one, as something", () => {
    expect(blank(picture(48))).toBe(false);
    expect(blank(picture(48, 0, { lit: 48 * 48 - 1 }))).toBe(false);
  });

  it("does not count transparency as showing something", () => {
    const clear = picture(4, 0);
    // Only alpha set: a see-through overlay with nothing drawn on it.
    for (let i = 3; i < clear.toBitmap().length; i += 4) clear.toBitmap()[i] = 255;
    expect(blank(clear)).toBe(true);
  });
});

describe("listing what can be shared", () => {
  it("lists screens before windows, each with its picture and its app's icon", async () => {
    const list = new SourceList(async () => [
      source("window:1:0", "Notes", { appIcon: picture(32) }),
      source("screen:0:0", "Entire Screen"),
      source("window:2:0", "Editor", { appIcon: picture(256) }),
    ]);
    const listed = await list.full();
    expect(listed.map(({ id, name, kind }) => ({ id, name, kind }))).toEqual([
      { id: "screen:0:0", name: "Entire screen", kind: "screen" },
      { id: "window:1:0", name: "Notes", kind: "window" },
      { id: "window:2:0", name: "Editor", kind: "window" },
    ]);
    expect(listed[1]!.thumbnail).toBe(
      `data:image/jpeg;base64,${Buffer.from("jpeg-48").toString("base64")}`,
    );
    // A small icon is kept as it is; a big one is made small, to keep the list small.
    expect(listed[1]!.icon).toBe("data:image/png;base64,icon-32");
    expect(listed[2]!.icon).toBe("data:image/png;base64,icon-64");
    expect(listed[0]!.icon).toBe("");
  });

  it("leaves out windows that show nothing, such as those apps keep hidden in the tray", async () => {
    const list = new SourceList(async () => [
      source("screen:0:0", "Entire Screen"),
      source("window:1:0", "Editor"),
      source("window:2:0", "Raycast", { thumbnail: picture(48, 0), appIcon: picture(32) }),
      source("window:3:0", "RaycastUIAccessHelperWindow", {
        thumbnail: picture(0, 0, { empty: true }),
      }),
      source("window:4:0", "NVIDIA GeForce Overlay", { thumbnail: picture(48, 0) }),
    ]);
    expect((await list.full()).map((s) => s.name)).toEqual(["Entire screen", "Editor"]);
  });

  it("keeps a screen even when its picture is black", async () => {
    const list = new SourceList(async () => [
      source("screen:0:0", "Screen 1", { thumbnail: picture(48, 0) }),
    ]);
    expect((await list.full()).map((s) => s.name)).toEqual(["Screen 1"]);
  });

  it("answers a second ask with the list being made, rather than making another", async () => {
    let finish!: (sources: CapturedSource[]) => void;
    const capture = vi.fn(() => new Promise<CapturedSource[]>((resolve) => (finish = resolve)));
    const list = new SourceList(capture);
    const first = list.full();
    const second = list.full();
    finish([source("window:1:0", "Editor")]);
    expect(await second).toEqual(await first);
    expect(capture).toHaveBeenCalledOnce();
    // Once made, the next ask makes a new one.
    const third = list.full();
    finish([]);
    expect(await third).toEqual([]);
    expect(capture).toHaveBeenCalledTimes(2);
  });
});

describe("answering at once from the last list", () => {
  it("has nothing to answer with before a full list", async () => {
    const capture = vi.fn(async () => [source("window:1:0", "Editor")]);
    expect(await new SourceList(capture).quick()).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it("gives the last pictures, less what has closed, with names as they are now", async () => {
    let open = [
      source("screen:0:0", "Entire Screen"),
      source("window:1:0", "Editor — a.ts"),
      source("window:2:0", "Notes"),
      source("window:3:0", "Raycast", { thumbnail: picture(48, 0) }),
    ];
    const capture = vi.fn(async (pictures: boolean) =>
      pictures ? open : open.map((s) => ({ ...s, thumbnail: picture(0, 0, { empty: true }) })),
    );
    const list = new SourceList(capture);
    const full = await list.full();

    open = [
      source("screen:0:0", "Entire Screen"),
      source("window:1:0", "Editor — b.ts"),
      source("window:3:0", "Raycast"),
      source("window:9:0", "Opened since"),
    ];
    const quick = await list.quick();
    expect(capture).toHaveBeenLastCalledWith(false);
    // Notes closed; Raycast still shows nothing; the window opened since waits for a full list.
    expect(quick!.map((s) => s.name)).toEqual(["Entire screen", "Editor — b.ts"]);
    expect(quick![1]!.thumbnail).toBe(full[1]!.thumbnail);
  });
});

describe("naming the one chosen", () => {
  const list = async () => [
    { id: "screen:0:0", name: "Entire Screen" },
    { id: "window:1:0", name: "Notes" },
  ];

  it("finds it in a fresh list", async () => {
    expect(await findSource("window:1:0", list)).toEqual({ id: "window:1:0", name: "Notes" });
    expect(await findSource("screen:0:0", list)).toEqual({
      id: "screen:0:0",
      name: "Entire screen",
    });
  });

  it("says a window has closed, or a screen is gone, since the picker drew it", async () => {
    await expect(findSource("window:9:0", list)).rejects.toThrow(
      "That window has closed. Choose another.",
    );
    await expect(findSource("screen:5:0", list)).rejects.toThrow(
      "That screen is no longer connected. Choose another.",
    );
  });

  it("refuses something that is not an id", async () => {
    await expect(findSource(42, list)).rejects.toThrow("Choose a screen or window to share.");
    await expect(findSource("", list)).rejects.toThrow("Choose a screen or window to share.");
  });
});

describe("holding the choice for the request it is made for", () => {
  const notes = { id: "window:1:0", name: "Notes" };

  it("gives it to the next request, and only that one", () => {
    const choice = new ScreenChoice();
    choice.hold(notes);
    expect(choice.take()).toEqual(notes);
    // A second request was not chosen for, so it shares nothing.
    expect(choice.take()).toBeNull();
  });

  it("shares nothing when no choice was made", () => {
    expect(new ScreenChoice().take()).toBeNull();
  });

  it("lets a choice go stale, so a later request does not share it", () => {
    let now = 1_000;
    const choice = new ScreenChoice(15_000, () => now);
    choice.hold(notes);
    now += 15_001;
    expect(choice.take()).toBeNull();
  });

  it("keeps only the newest choice", () => {
    const choice = new ScreenChoice();
    choice.hold(notes);
    choice.hold({ id: "screen:0:0", name: "Entire screen" });
    expect(choice.take()).toEqual({ id: "screen:0:0", name: "Entire screen" });
  });
});
