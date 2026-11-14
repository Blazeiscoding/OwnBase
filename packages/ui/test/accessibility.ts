import axe from "axe-core";

/**
 * What an automated accessibility check finds wrong inside `root`, one line per
 * rule, so a failing test says which rule and which elements.
 *
 * Colour contrast is left out: it needs real rendering, which jsdom does not do.
 * An empty result means no rule that can be judged here was broken, not that
 * the component is accessible; keyboard and screen-reader behaviour still need
 * their own tests.
 */
export async function accessibilityProblems(root: Element = document.body): Promise<string[]> {
  const results = await axe.run(root, {
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes
        .map((node) => node.target.join(" "))
        .join(", ")}`,
  );
}

/**
 * Words as a label-in-name check compares them (WCAG 2.5.3, axe's
 * label-content-name-mismatch): lower case, what is in brackets left out,
 * split at anything that is not a letter or a digit.
 */
function words(text: string): string[] {
  let rest = text.normalize("NFKD").toLowerCase();
  for (let before = ""; before !== rest;) {
    before = rest;
    rest = rest.replace(/\([^()]*\)/g, "");
  }
  return rest.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * What a control shows and what it is called, and whether the name holds
 * what it shows, word for word and in order, so someone using voice control
 * can say what they see. axe skips that rule in jsdom, where nothing is laid
 * out, so this does its part: the text nodes joined as written (two elements
 * with nothing between them make one word, as axe reads them), leaving out
 * text for screen readers alone (`.sr-only`). Text drawn by CSS
 * (`data-drawn-text`) is not in the page, so it is not shown text here
 * either. The name is the `aria-label`, which jsdom keeps as written. As
 * axe does, it leaves a single letter or "Aa", such as Bold's "B", to a
 * person to judge.
 */
export function labelInName(control: Element): { shows: string; name: string; holds: boolean } {
  let shows = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) shows += node.nodeValue ?? "";
    else if (!(node instanceof Element && node.classList.contains("sr-only")))
      node.childNodes.forEach(walk);
  };
  control.childNodes.forEach(walk);
  const name = control.getAttribute("aria-label") ?? "";
  const shown = words(shows);
  const named = words(name);
  const symbol = /^\D$/.test(shows.trim()) || ["aa", "abc"].includes(shows.trim().toLowerCase());
  const holds =
    shown.length === 0 ||
    symbol ||
    named.some((_, start) => shown.every((word, i) => named[start + i] === word));
  return { shows, name, holds };
}

/** The initials or count drawn by CSS in `element`, which jsdom does not count as its text. */
export function drawnText(element: Element): string {
  return [element, ...element.querySelectorAll("[data-drawn-text]")]
    .map((part) => part.getAttribute("data-drawn-text") ?? "")
    .join("");
}
