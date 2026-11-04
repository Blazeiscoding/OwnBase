import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { BreakableAddress } from "../src/components/BreakableAddress.js";

/** The address as text, with `|` where a line may break. */
function breaks(text: string): string {
  const { container } = render(<BreakableAddress text={text} />);
  const span = container.firstElementChild!;
  return Array.from(span.childNodes)
    .map((node) => (node.nodeName === "WBR" ? "|" : node.textContent))
    .join("");
}

describe("an address that wraps", () => {
  it("may break after a slash and before a dot, never between the slashes", () => {
    expect(breaks("https://planes-ton-orlando-newfoundland.trycloudflare.com")).toBe(
      "https://|planes-ton-orlando-newfoundland|.trycloudflare|.com",
    );
    expect(breaks("http://192.168.1.20:4000/join")).toBe("http://|192|.168|.1|.20:4000/|join");
  });

  it("keeps an invite code whole in the links it makes", () => {
    expect(breaks("https://chat.example.org/#/join/KNNDYXF9")).toBe(
      "https://|chat|.example|.org/|#/|join/|KNNDYXF9",
    );
    expect(breaks("ownbase://join?host=https://chat.example.org&code=KNNDYXF9")).toBe(
      "ownbase://|join|?host=|https://|chat|.example|.org|&code=|KNNDYXF9",
    );
  });

  it("reads as the address it shows", () => {
    const { container } = render(<BreakableAddress text="https://chat.example.org" />);
    expect(container.textContent).toBe("https://chat.example.org");
  });
});
