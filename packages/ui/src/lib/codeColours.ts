import { useEffect, useState } from "react";
import type { highlight } from "./highlighter.js";

/**
 * The words a code block's opening fence may carry, as Markdown's do: each
 * language's name as the highlighter knows it, then the other words for it.
 * Only these: a word not here is the code's first line. One string, since
 * every visit downloads it.
 */
const WORDS =
  "javascript js jsx|typescript ts tsx|json|markup html xml|css|python py|go golang|rust rs|java|c h|cpp c++|csharp cs c#|bash sh shell|sql|yaml yml|docker dockerfile|diff patch|markdown md|ruby rb|php";

/**
 * A block's language and its code, when its first line is one known language
 * word and nothing else. Code that starts on the fence line, as messages
 * written before this did, stays code.
 */
export function codeLanguage(block: string): { language: string; code: string } | null {
  const end = block.indexOf("\n");
  const word = block.slice(0, end).trimEnd().toLowerCase();
  const names = end > 0 && WORDS.split("|").find((group) => group.split(" ").includes(word));
  return names ? { language: names.split(" ")[0]!, code: block.slice(end + 1) } : null;
}

type Highlight = typeof highlight;

let loaded: Highlight | undefined;
let loading: Promise<Highlight> | undefined;

/**
 * The highlighter, loaded once for the whole app on the first block that asks
 * for it, so a visit that shows no code block downloads none of it. If it
 * fails to load, blocks stay plain until the app is opened again.
 */
export function loadHighlighter(): Promise<Highlight> {
  return (loading ??= import("./highlighter.js").then((module) => (loaded = module.highlight)));
}

/** The highlighter once it has loaded, asking for it when `wanted`. */
export function useHighlighter(wanted: boolean): Highlight | undefined {
  const [current, setCurrent] = useState(() => loaded);
  useEffect(() => {
    // Wrapped, since state set to a function would call it.
    if (wanted && !current)
      loadHighlighter().then(
        (highlight) => setCurrent(() => highlight),
        () => {},
      );
  }, [wanted, current]);
  return current;
}
