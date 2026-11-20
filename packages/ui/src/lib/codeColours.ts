import { useEffect, useSyncExternalStore } from "react";
import type { CodeRun } from "./highlighter.js";

export type { CodeRun, SyntaxKind } from "./highlighter.js";

/**
 * The words a code block's opening fence may carry, as Markdown's do, and the
 * language each names. Only these: a word not here is the code's first line.
 */
const LANGUAGES: Record<string, string> = {
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  ts: "typescript",
  typescript: "typescript",
  tsx: "typescript",
  json: "json",
  html: "markup",
  xml: "markup",
  svg: "markup",
  css: "css",
  py: "python",
  python: "python",
  go: "go",
  golang: "go",
  rs: "rust",
  rust: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  csharp: "csharp",
  "c#": "csharp",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  dockerfile: "docker",
  docker: "docker",
  diff: "diff",
  patch: "diff",
  md: "markdown",
  markdown: "markdown",
  rb: "ruby",
  ruby: "ruby",
  php: "php",
};

/**
 * A block's language and its code, when its first line is one known language
 * word and nothing else. Code that starts on the fence line, as messages
 * written before this did, stays code.
 */
export function codeLanguage(block: string): { language: string; code: string } | null {
  const end = block.indexOf("\n");
  if (end === -1) return null;
  const word = block.slice(0, end).trimEnd().toLowerCase();
  if (!Object.hasOwn(LANGUAGES, word)) return null;
  return { language: LANGUAGES[word]!, code: block.slice(end + 1) };
}

/** Past this, a block is drawn plain: colouring it would hold up the timeline. */
export const MAX_COLOURED_CHARACTERS = 50_000;
export const MAX_COLOURED_LINES = 1_000;

export function colourable(code: string): boolean {
  if (code.length > MAX_COLOURED_CHARACTERS) return false;
  let lines = 1;
  for (let i = code.indexOf("\n"); i !== -1; i = code.indexOf("\n", i + 1))
    if (++lines > MAX_COLOURED_LINES) return false;
  return true;
}

type Highlight = (code: string, language: string) => CodeRun[];

let loaded: Highlight | null = null;
let loading: Promise<Highlight> | null = null;
const listeners = new Set<() => void>();

/**
 * The highlighter, loaded once for the whole app on the first block that asks
 * for it, so a visit that shows no code block downloads none of it. A failed
 * load (the app went offline) leaves blocks plain, and the next block to draw
 * tries again.
 */
export function loadHighlighter(): Promise<Highlight> {
  loading ??= import("./highlighter.js").then(
    (module) => {
      loaded = module.highlight;
      for (const listener of listeners) listener();
      return module.highlight;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The highlighter once it has loaded, asking for it when `wanted`; null until then. */
export function useHighlighter(wanted: boolean): Highlight | null {
  const current = useSyncExternalStore(
    subscribe,
    () => loaded,
    () => null,
  );
  useEffect(() => {
    if (wanted && !loaded) loadHighlighter().catch(() => {});
  }, [wanted]);
  return wanted ? current : null;
}
