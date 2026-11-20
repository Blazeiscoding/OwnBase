import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Mrkdwn } from "../src/components/Mrkdwn.js";
import { loadHighlighter } from "../src/lib/codeColours.js";
import {
  MAX_COLOURED_CHARACTERS,
  MAX_COLOURED_LINES,
  MAX_COLOURED_WORD,
  highlight,
} from "../src/lib/highlighter.js";

const SOURCE = "const x: number = 1; // the answer\nfunction f() {\n  return 'a';\n}";

/** A message's text drawn as the timeline draws it, and its first code block. */
async function draw(text: string, codeColours = true) {
  const view = render(<Mrkdwn text={text} users={{}} channels={{}} codeColours={codeColours} />);
  // The chunk loads on the first block that asks; wait for it, then for React.
  await act(async () => {
    await loadHighlighter();
  });
  return { ...view, code: view.container.querySelector("code")! };
}

describe("colours in code blocks (J15)", () => {
  it("colours a block with a language once the highlighter loads", async () => {
    const { code } = await draw("```ts\n" + SOURCE + "\n```");
    const kinds = [...code.querySelectorAll("span")].map((span) => [
      span.textContent,
      span.className,
    ]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ["const", "text-syntax-keyword"],
        ["// the answer", "text-syntax-comment italic"],
        ["'a'", "text-syntax-string"],
        ["1", "text-syntax-number"],
        ["f", "text-syntax-name"],
      ]),
    );
  });

  it("keeps the block's text exactly the source, so copying and reading are unchanged", async () => {
    const { code } = await draw("```ts\n" + SOURCE + "\n```");
    expect(code.textContent).toBe(SOURCE);
  });

  it("colours a diff's added and removed lines", async () => {
    const { code } = await draw("```diff\n-old\n+new\n```");
    expect(code.querySelector(".text-syntax-removed")?.textContent).toBe("-old\n");
    expect(code.querySelector(".text-syntax-added")?.textContent).toBe("+new");
  });

  it("leaves a block without a language plain", async () => {
    const { code } = await draw("```\n" + SOURCE + "\n```");
    expect(code.querySelector("span")).toBeNull();
    expect(code.textContent).toBe(SOURCE);
  });

  it("leaves blocks plain where colours were not asked for, as in search results", async () => {
    const { code } = await draw("```ts\n" + SOURCE + "\n```", false);
    expect(code.querySelector("span")).toBeNull();
    expect(code.textContent).toBe(SOURCE);
  });

  it("leaves a group token or an emoji name inside a coloured block as written", async () => {
    const { code } = await draw("```ts\nconst who = '<!subteam^G1|@design> :party-parrot:';\n```");
    expect(code.textContent).toBe("const who = '<!subteam^G1|@design> :party-parrot:';");
    expect(code.querySelector("button, img")).toBeNull();
  });

  it("draws a block over the size limit plain", async () => {
    const long = Array.from({ length: MAX_COLOURED_LINES + 1 }, (_, i) => `x${i};`).join("\n");
    const { code } = await draw("```ts\n" + long + "\n```");
    expect(code.querySelector("span")).toBeNull();
    expect(code.textContent).toBe(long);
  });
});

describe("the size limit (J15)", () => {
  const lines = (count: number) => Array.from({ length: count }, () => "x").join("\n");

  it("colours up to 1,000 lines and no more", () => {
    expect(MAX_COLOURED_LINES).toBe(1_000);
    expect(highlight(lines(1_000), "typescript")).not.toBeNull();
    expect(highlight(lines(1_001), "typescript")).toBeNull();
  });

  it("colours up to 50 kB and no more", () => {
    expect(MAX_COLOURED_CHARACTERS).toBe(50_000);
    expect(highlight("x ".repeat(25_000), "typescript")).not.toBeNull();
    expect(highlight("x ".repeat(25_000) + "x", "typescript")).toBeNull();
  });

  it("colours no block holding a run of more than 500 characters without a space", () => {
    // Prism takes time that grows with the square of such a run: 48 kB of
    // base64 in one string took over 3 s, where 410 lines of code take 20 ms.
    expect(MAX_COLOURED_WORD).toBe(500);
    // The run is the quotes, the letters and the semicolon.
    const run = (length: number) => `const key = '${"a".repeat(length - 3)}';\n`;
    expect(highlight(run(500), "typescript")).not.toBeNull();
    expect(highlight(run(501), "typescript")).toBeNull();
  });
});
