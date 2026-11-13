import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as layout from "../src/lib/layout.js";

const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
const mediaRules = [...css.matchAll(/^@media ([^{]+)\{/gm)].map(([, query]) => query!.trim());

describe("what scripts lay out and move by", () => {
  it("asks only what theme.css's own @media rules ask", () => {
    const queries = Object.entries(layout).filter(([name]) => name.endsWith("_QUERY"));
    expect(queries.length).toBeGreaterThan(0);
    for (const [name, query] of queries)
      for (const [part] of String(query).matchAll(/\([^)]+\)/g))
        expect(
          mediaRules.some((rule) => rule.includes(part)),
          `${name}: ${part}`,
        ).toBe(true);
  });

  it("moves as theme.css's tokens say", () => {
    expect(css).toContain(`--duration-fast: ${layout.DURATION_FAST_MS}ms;`);
    expect(css).toContain(`--ease-smooth: ${layout.EASE_SMOOTH};`);
  });
});
