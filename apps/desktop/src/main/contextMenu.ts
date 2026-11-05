import type { MenuItemConstructorOptions } from "electron";

/**
 * The right-click menu. Electron shows none unless the app builds one, so
 * without this a misspelled word was underlined with no way to fix it, and
 * there was no Cut, Copy or Paste, no way to copy a link and no way to copy
 * a picture. What it offers depends on what was clicked, as in a browser.
 */

/** The parts of Electron's context-menu params read here. */
export interface ContextMenuParams {
  x: number;
  y: number;
  isEditable: boolean;
  selectionText: string;
  misspelledWord: string;
  dictionarySuggestions: string[];
  linkURL: string;
  mediaType: string;
  hasImageContents: boolean;
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

export interface ContextMenuActions {
  replaceMisspelling(word: string): void;
  addToDictionary(word: string): void;
  openLink(url: string): void;
  copyText(text: string): void;
  copyImageAt(x: number, y: number): void;
}

/** At most this many spelling suggestions, as browsers show. */
const SUGGESTIONS = 5;

/** Links the browser opens, as clicking them does: web pages, never the app's own. */
function outsideLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

export function contextMenuItems(
  params: ContextMenuParams,
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = [];

  if (params.isEditable && params.misspelledWord) {
    const word = params.misspelledWord;
    const suggestions = params.dictionarySuggestions.slice(0, SUGGESTIONS);
    groups.push([
      ...(suggestions.length
        ? suggestions.map((suggestion) => ({
            label: suggestion,
            click: () => actions.replaceMisspelling(suggestion),
          }))
        : [{ label: "No spelling suggestions", enabled: false }]),
      { label: "Add to dictionary", click: () => actions.addToDictionary(word) },
    ]);
  }

  const link = outsideLink(params.linkURL);
  if (link) {
    groups.push([
      { label: "Open link in browser", click: () => actions.openLink(link) },
      { label: "Copy link", click: () => actions.copyText(link) },
    ]);
  }

  if (params.mediaType === "image" && params.hasImageContents)
    groups.push([{ label: "Copy image", click: () => actions.copyImageAt(params.x, params.y) }]);

  const flags = params.editFlags;
  if (params.isEditable)
    groups.push([
      { role: "cut", label: "Cut", enabled: flags.canCut },
      { role: "copy", label: "Copy", enabled: flags.canCopy },
      { role: "paste", label: "Paste", enabled: flags.canPaste },
      { role: "selectAll", label: "Select all", enabled: flags.canSelectAll },
    ]);
  else if (params.selectionText.trim()) groups.push([{ role: "copy", label: "Copy" }]);

  return groups.flatMap((group, index) =>
    index === 0 ? group : [{ type: "separator" as const }, ...group],
  );
}
