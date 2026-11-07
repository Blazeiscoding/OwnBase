import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { contextMenuItems, type ContextMenuParams } from "../src/main/contextMenu.js";

const noEdits = { canCut: false, canCopy: false, canPaste: false, canSelectAll: false };
const params = (over: Partial<ContextMenuParams> = {}): ContextMenuParams => ({
  x: 10,
  y: 20,
  isEditable: false,
  selectionText: "",
  misspelledWord: "",
  dictionarySuggestions: [],
  linkURL: "",
  mediaType: "none",
  hasImageContents: false,
  editFlags: noEdits,
  ...over,
});
const actions = () => ({
  replaceMisspelling: vi.fn(),
  addToDictionary: vi.fn(),
  openLink: vi.fn(),
  copyText: vi.fn(),
  copyImageAt: vi.fn(),
});
const labels = (items: MenuItemConstructorOptions[]) =>
  items.map((item) => (item.type === "separator" ? "---" : item.label));
const click = (items: MenuItemConstructorOptions[], label: string) =>
  (items.find((item) => item.label === label)!.click as () => void)();

describe("the right-click menu", () => {
  it("offers spelling fixes for a misspelled word, then the editing commands", () => {
    const act = actions();
    const items = contextMenuItems(
      params({
        isEditable: true,
        misspelledWord: "wrold",
        dictionarySuggestions: ["world", "wold", "word", "wrote", "would", "weld"],
        editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
      }),
      act,
    );
    expect(labels(items)).toEqual([
      "world",
      "wold",
      "word",
      "wrote",
      "would",
      "Add to dictionary",
      "---",
      "Cut",
      "Copy",
      "Paste",
      "Select all",
    ]);
    click(items, "world");
    expect(act.replaceMisspelling).toHaveBeenCalledWith("world");
    click(items, "Add to dictionary");
    expect(act.addToDictionary).toHaveBeenCalledWith("wrold");
    expect(items.find((item) => item.label === "Cut")).toMatchObject({
      role: "cut",
      enabled: false,
    });
    expect(items.find((item) => item.label === "Paste")).toMatchObject({
      role: "paste",
      enabled: true,
    });
  });

  it("says when a misspelled word has no suggestions", () => {
    const items = contextMenuItems(
      params({ isEditable: true, misspelledWord: "qzxv", editFlags: noEdits }),
      actions(),
    );
    expect(items[0]).toEqual({ label: "No spelling suggestions", enabled: false });
  });

  it("opens or copies a web link", () => {
    const act = actions();
    const items = contextMenuItems(params({ linkURL: "https://example.com/a b" }), act);
    expect(labels(items)).toEqual(["Open link in browser", "Copy link"]);
    click(items, "Open link in browser");
    expect(act.openLink).toHaveBeenCalledWith("https://example.com/a%20b");
    click(items, "Copy link");
    expect(act.copyText).toHaveBeenCalledWith("https://example.com/a%20b");
  });

  it("leaves out links that are not web pages, such as the app's own", () => {
    for (const linkURL of ["file:///C:/app/index.html#/c/1", "javascript:alert(1)", "not a url"])
      expect(contextMenuItems(params({ linkURL }), actions())).toEqual([]);
  });

  it("copies a picture where it was clicked", () => {
    const act = actions();
    const items = contextMenuItems(params({ mediaType: "image", hasImageContents: true }), act);
    expect(labels(items)).toEqual(["Copy image"]);
    click(items, "Copy image");
    expect(act.copyImageAt).toHaveBeenCalledWith(10, 20);
  });

  it("copies selected text, and shows nothing where there is nothing to do", () => {
    expect(labels(contextMenuItems(params({ selectionText: "Hello" }), actions()))).toEqual([
      "Copy",
    ]);
    expect(contextMenuItems(params({ selectionText: "  " }), actions())).toEqual([]);
    expect(contextMenuItems(params(), actions())).toEqual([]);
  });
});
