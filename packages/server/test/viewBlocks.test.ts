import { describe, expect, it } from "vitest";
import { blocksToText, parseView } from "../src/blockKit.js";

const plain = (text: string) => ({ type: "plain_text", text });
const input = (blockId: string, element: Record<string, unknown>) => ({
  type: "input",
  block_id: blockId,
  label: plain(blockId),
  element,
});

describe("a form's blocks, in the app's order", () => {
  const blocks = [
    { type: "header", text: plain("Where it goes") },
    { type: "section", text: { type: "mrkdwn", text: "Build *412* passed." } },
    input("env", { type: "plain_text_input", action_id: "env" }),
    { type: "context", elements: [{ type: "mrkdwn", text: "Staging first," }, plain("always.")] },
    // A control this server cannot draw is dropped, and leaves no gap.
    input("logs", { type: "file_input", action_id: "files" }),
    { type: "divider" },
    { type: "image", image_url: "https://example.com/a.png", alt_text: "a chart" },
    {
      type: "section",
      text: { type: "mrkdwn", text: "Who to tell" },
      fields: [{ type: "mrkdwn", text: "*On call:* Sam" }],
    },
    // Words that say nothing are not a step of their own.
    { type: "section", text: { type: "mrkdwn", text: "   " } },
    input("notes", { type: "plain_text_input", action_id: "notes", multiline: true }),
  ];

  it("keeps words between the fields where the app put them", () => {
    const view = parseView({ type: "modal", blocks }, "V1");
    expect(view.fields.map((f) => f.blockId)).toEqual(["env", "notes"]);
    expect(view.droppedFields).toBe(1);
    expect(view.blocks).toEqual([
      { type: "header", text: "Where it goes" },
      { type: "section", text: "Build *412* passed." },
      { type: "field", field: 0 },
      { type: "context", text: "Staging first, always." },
      { type: "divider" },
      { type: "section", text: "Who to tell\n\n*On call:* Sam" },
      { type: "field", field: 1 },
    ]);
  });

  it("still sends every word as one text, for a client that draws them above the fields", () => {
    const view = parseView({ type: "modal", blocks }, "V1");
    expect(view.text).toBe(
      [
        "*Where it goes*",
        "Build *412* passed.",
        "Staging first, always.",
        "———",
        "Who to tell",
        "*On call:* Sam",
      ].join("\n\n"),
    );
    expect(view.text).toBe(blocksToText(blocks));
  });

  it("lists every field once, in the order of fields", () => {
    const view = parseView({ type: "modal", blocks }, "V1");
    const shown = view.blocks!.flatMap((b) => (b.type === "field" ? [b.field] : []));
    expect(shown).toEqual(view.fields.map((_, i) => i));
  });
});
