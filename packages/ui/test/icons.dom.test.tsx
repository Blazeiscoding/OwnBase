import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Icon, type IconName } from "../src/components/Icon.js";

const css = readFileSync(join(process.cwd(), "src/theme.css"), "utf8");

/** The one icon a rendering holds. */
function drawn(name: IconName): SVGSVGElement {
  return render(<Icon name={name} />).container.querySelector("svg")!;
}

describe("an icon drawn in parts", () => {
  it("names itself and each part, so the stylesheet can move one of them", () => {
    const smile = drawn("smile");
    expect(smile).toHaveAttribute("data-icon", "smile");
    expect([...smile.querySelectorAll("path")].map((path) => path.dataset.part)).toEqual([
      "face",
      "mouth",
      "eyes",
    ]);
  });

  it("gives every part a length of 1, which drawing it in as a dash relies on", () => {
    for (const path of drawn("thread").querySelectorAll("path"))
      expect(path).toHaveAttribute("pathLength", "1");
  });

  it("leaves an icon of one path as it was", () => {
    const pin = drawn("pin");
    expect(pin).not.toHaveAttribute("data-icon");
    expect(pin.querySelectorAll("path")).toHaveLength(1);
    expect(pin.querySelector("path")).not.toHaveAttribute("data-part");
  });
});

describe("the motion the stylesheet gives the icons", () => {
  // Every icon the stylesheet names, with the parts it names in it.
  const named = [...css.matchAll(/\[data-icon="([a-zA-Z]+)"\](?: \[data-part="([a-z]+)"\])?/g)];

  it("is for icons and parts that are drawn", () => {
    expect(named.length).toBeGreaterThan(0);
    const missing = named
      .filter(([, icon, part]) => {
        const svg = drawn(icon as IconName);
        if (svg.dataset.icon !== icon) return true;
        return part !== undefined && !svg.querySelector(`[data-part="${part}"]`);
      })
      .map(([selector]) => selector);
    expect(missing).toEqual([]);
  });

  it("reaches all six, by pointing or by keyboard", () => {
    const moved = new Set(
      [
        ...css.matchAll(/\.icon-live:is\(:hover, :focus-visible\) \[data-icon="([a-zA-Z]+)"\]/g),
      ].map(([, icon]) => icon),
    );
    expect([...moved].sort()).toEqual(["bookmark", "dots", "edit", "reply", "smile", "thread"]);
  });

  it("plays only where a pointer can hover and nobody has asked for less motion", () => {
    const opening = "@media (hover: hover) and (prefers-reduced-motion: no-preference) {";
    const start = css.indexOf(opening);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = start;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const outside = css.slice(0, start) + css.slice(end);
    expect(outside).not.toContain(".icon-live");
    expect(outside).not.toMatch(/animation:[^;]*\bicon-/);
  });
});
