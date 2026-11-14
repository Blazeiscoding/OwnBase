import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { User } from "@ownbase/protocol";
import { Avatar } from "../src/components/Avatar.js";
import { Badge } from "../src/components/Badge.js";
import { CountBadge } from "../src/components/Motion.js";
import { WorkspaceIcon } from "../src/components/WorkspaceIcon.js";
import { labelInName } from "./accessibility.js";

/**
 * Initials and counts that stand in for a picture are drawn by CSS, not
 * written, so a button they sit on is called only what it says (WCAG 2.5.3):
 * someone using voice control says "View Maya Chen's profile", not "MC".
 */
const maya: User = {
  id: "U_MAYA",
  handle: "maya",
  displayName: "Maya Chen",
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

describe("a picture's letters", () => {
  it("are drawn on an avatar, so its button is called by the name alone", () => {
    render(
      <button aria-label="View Maya Chen's profile">
        <Avatar user={maya} />
      </button>,
    );
    const button = screen.getByRole("button", { name: "View Maya Chen's profile" });
    expect(labelInName(button)).toMatchObject({ holds: true });
    expect(button.firstElementChild).toHaveAttribute("data-drawn-text", "MC");
  });

  it("are drawn on a workspace's square, so the rail's button is called by the workspace", () => {
    render(
      <button aria-label="Rocket Team">
        <WorkspaceIcon name="Rocket Team" size={48} letters={2} />
      </button>,
    );
    const button = screen.getByRole("button", { name: "Rocket Team" });
    expect(labelInName(button)).toMatchObject({ holds: true });
    expect(button.firstElementChild).toHaveAttribute("data-drawn-text", "RT");
  });
});

describe("a count", () => {
  it("is drawn on a badge, hidden or named in its place, so a tab is called what it says", () => {
    render(
      <>
        <button aria-label="DMs">
          <Badge count={3} />
          DMs
        </button>
        <button aria-label="Activity">
          <Badge count={120} max={99} label="120 mentions" />
          Activity
        </button>
      </>,
    );
    for (const [name, drawn] of [
      ["DMs", "3"],
      ["Activity", "99+"],
    ] as const) {
      const button = screen.getByRole("button", { name });
      expect(labelInName(button), name).toMatchObject({ holds: true });
      expect(button.querySelector("[data-drawn-text]")).toHaveAttribute("data-drawn-text", drawn);
    }
  });

  it("stays text where it is read as part of the name, as on a reaction", () => {
    render(
      <button>
        👍
        <CountBadge count={2} />
      </button>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("👍2");
    expect(screen.getByRole("button").querySelector("[data-drawn-text]")).toBeNull();
  });
});
