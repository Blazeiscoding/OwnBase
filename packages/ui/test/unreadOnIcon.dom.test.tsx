import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "./render.js";
import { PlatformContext } from "../src/context.js";
import { UnreadOnIconSetting } from "../src/components/UnreadOnIconSetting.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

function device(saved: Record<string, unknown> = {}) {
  const stored = { ...saved };
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(key: string) => (stored[key] ?? null) as T | null,
      set: async (key: string, value: unknown) => {
        stored[key] = value;
      },
    },
    notify: () => {},
  };
  return { platform, stored };
}

const show = (platform: Platform) =>
  render(
    <PlatformContext.Provider value={platform}>
      <UnreadOnIconSetting />
    </PlatformContext.Provider>,
  );

describe("showing unread on the app's icon", () => {
  it("is on by default, and turning it off is kept on this device", async () => {
    const { platform, stored } = device();
    const { unmount } = show(platform);
    const toggle = await screen.findByRole("switch", { name: "Show unread on the app's icon" });
    expect(toggle).toBeChecked();
    expect(await accessibilityProblems(document.body)).toEqual([]);

    await userEvent.setup().click(toggle);
    expect(toggle).not.toBeChecked();
    expect(stored["unread-on-icon"]).toBe(false);
    unmount();

    // Another page on this device reads the same choice.
    show(device({ "unread-on-icon": false }).platform);
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Show unread on the app's icon" }),
      ).not.toBeChecked(),
    );
  });
});
