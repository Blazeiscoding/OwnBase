import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "./render.js";
import userEvent from "@testing-library/user-event";
import { QuickSwitcherLoading, type EarlyTyping } from "../src/components/QuickSwitcherLoading.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Jump to while its code is still on the way, as in the first moment after
 * signing in: Ctrl+K and a name are typed in one go, and none of it may be
 * lost. The palette taking it on is in quickSwitcher.dom.test.tsx, and the
 * one giving way to the other in a browser in the e2e suite.
 */
function loading(actions = false) {
  const kept: { now: EarlyTyping } = { now: { query: "", entered: false } };
  const onClose = vi.fn();
  function Holder() {
    const [typing, setTyping] = useState(kept.now);
    kept.now = typing;
    return (
      <QuickSwitcherLoading
        typing={typing}
        onTyping={setTyping}
        actions={actions}
        onClose={onClose}
      />
    );
  }
  render(<Holder />);
  const field = screen.getByRole("textbox", { name: "Channel or person" });
  return { kept, onClose, field, user: userEvent.setup() };
}

describe("Jump to before it has arrived", () => {
  it("takes typing at once, and says it is on its way", async () => {
    const { kept, field, user } = loading();
    const dialog = screen.getByRole("dialog", { name: "Jump to" });
    expect(field).toHaveFocus();
    expect(field).toHaveAccessibleDescription("Loading…");
    expect(await accessibilityProblems(dialog)).toEqual([]);
    await user.keyboard("desi");
    expect(field).toHaveValue("desi");
    expect(kept.now).toEqual({ query: "desi", entered: false });
  });

  it("keeps an Enter, and nothing typed after it", async () => {
    const { kept, field, user } = loading();
    await user.keyboard("design{Enter}xyz");
    expect(field).toHaveValue("design");
    expect(kept.now).toEqual({ query: "design", entered: true });
  });

  it("leaves an input method's Enter to the input method", () => {
    const { kept, field } = loading();
    fireEvent.change(field, { target: { value: "にほん" } });
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
    expect(kept.now).toEqual({ query: "にほん", entered: false });
  });

  it("closes with Escape or its close button", async () => {
    const { onClose, user } = loading();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("asks for what the palette offers", () => {
    loading(true);
    expect(screen.getByRole("textbox", { name: "Channel or person" })).toHaveAttribute(
      "placeholder",
      "Channel, person or action",
    );
  });
});
