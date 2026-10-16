import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { AccountDialog, type AccountSection } from "../src/components/AccountDialog.js";
import { SECTION_LABELS, SETTINGS, findSettings } from "../src/lib/settingsSearch.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * Account settings as a page (UX-60): its own list of sections beside the
 * section, a search that goes to a setting, and a quiet "Saved" once a choice
 * that saves itself is kept.
 */
const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

// jsdom lays nothing out, so it has nothing to scroll into view.
Element.prototype.scrollIntoView ??= () => {};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function page(
  options: {
    section?: AccountSection;
    kind?: Platform["kind"];
    save?: () => Promise<void>;
  } = {},
) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
  vi.spyOn(client.api, "listSessions").mockResolvedValue({ sessions: [] });
  vi.spyOn(client.api, "storageUsage").mockResolvedValue({
    usedBytes: 0,
    limitBytes: null,
    availableBytes: null,
    maxFileBytes: 10_000_000,
  });
  const platform: Platform = {
    kind: options.kind ?? "web",
    storage: { get: async () => null, set: options.save ?? (async () => {}) },
    notify: () => {},
  };
  const onClose = vi.fn();
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <AccountDialog onClose={onClose} onSignedOut={() => {}} section={options.section} />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const settings = screen.getByRole("dialog", { name: "Account settings" });
  return {
    settings,
    onClose,
    search: within(settings).getByRole("searchbox", { name: "Search settings" }),
    user: userEvent.setup(),
  };
}

describe("Account settings as a page", () => {
  it("fills the window with its own list of sections beside the section, not a box over the workspace", async () => {
    const { settings, onClose, user } = page();
    expect(settings.closest(".settings-page")).not.toBeNull();
    expect(settings.querySelector(".dialog-panel, .dialog-scroll")).toBeNull();
    expect(settings).not.toHaveClass("dialog-panel");
    // The section's name heads it, under the page's own.
    const panel = within(settings).getByRole("tabpanel", { name: "Profile" });
    expect(within(panel).getByRole("heading", { name: "Profile" })).toBeVisible();
    expect(within(settings).getByRole("heading", { name: "Account settings" })).toBeVisible();
    expect(settings).toHaveTextContent("Sam Rivera · @sam");
    expect(await accessibilityProblems(settings)).toEqual([]);

    // Close is in reach on a phone and beside the section elsewhere; Escape works too.
    const close = within(settings).getAllByRole("button", { name: "Close" });
    expect(close).toHaveLength(2);
    expect(settings).toHaveTextContent("Esc");
    await user.click(close[1]!);
    expect(onClose).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("starts under the desktop app's title bar", () => {
    const { settings } = page({ kind: "desktop" });
    expect(settings.closest(".settings-page")).toHaveClass("settings-page-under-titlebar");
  });

  it("starts at the top of a browser window", () => {
    const { settings } = page({ kind: "web" });
    expect(settings.closest(".settings-page")).not.toHaveClass("settings-page-under-titlebar");
  });
});

describe("searching settings", () => {
  it("finds a setting by what people call it, and goes to it in its section", async () => {
    const { settings, search, user } = page();
    await user.type(search, "dark");
    const found = within(settings).getByRole("list", { name: "Settings found" });
    expect(within(settings).queryByRole("tablist")).toBeNull();
    const theme = within(found).getByRole("button", { name: /^Theme/ });
    expect(theme).toHaveTextContent("ThemeAppearance");

    await user.click(theme);
    expect(within(settings).getByRole("tab", { name: "Appearance" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(search).toHaveValue("");
    expect(within(settings).getByRole("tablist")).toBeVisible();
    const group = within(settings).getByRole("group", { name: "Theme" });
    expect(group).toContainElement(document.activeElement as HTMLElement);
    expect(group).toHaveClass("setting-found");
  });

  it("goes to the first setting found on Enter, and Escape clears the search before it closes the page", async () => {
    const { settings, search, onClose, user } = page();
    await user.type(search, "pass{Enter}");
    expect(within(settings).getByRole("tab", { name: "Security" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(settings).getByLabelText("Current password")).toHaveFocus();

    await user.type(search, "zebra");
    expect(within(settings).getByRole("status")).toHaveTextContent("No settings match “zebra”.");
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(onClose).not.toHaveBeenCalled();
    expect(within(settings).getByRole("tablist")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("goes to every setting it can find, in the section that has it", async () => {
    // Speaker shows only where the browser can choose one, which jsdom cannot.
    const { settings, search, user } = page();
    for (const setting of SETTINGS.filter((s) => s.label !== "Speaker")) {
      await user.clear(search);
      await user.click(search);
      await user.paste(setting.label);
      const found = within(settings).getByRole("list", { name: "Settings found" });
      await user.click(
        within(found).getByRole("button", {
          name: `${setting.label}${SECTION_LABELS[setting.section]}`,
        }),
      );
      const panel = within(settings).getByRole("tabpanel", {
        name: SECTION_LABELS[setting.section],
      });
      // Focus lands in the section, at the setting, rather than staying on its tab.
      await waitFor(() => expect(panel).toContainElement(document.activeElement as HTMLElement));
      expect(panel.querySelector(".setting-found")).toHaveTextContent(
        new RegExp(setting.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      );
    }
  }, 20_000);
});

describe("saying Saved", () => {
  it("says Saved quietly once a theme is kept, and then lets it go", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { settings, user } = page({ section: "appearance" });
    const white = await within(settings).findByRole("radio", { name: /^White/ });
    await waitFor(() => expect(white).toBeEnabled());
    await user.click(white);
    expect(await within(settings).findByText("Saved")).toBeVisible();
    await act(async () => vi.advanceTimersByTime(2100));
    expect(within(settings).queryByText("Saved")).toBeNull();
  });

  it("says nothing of the kind when the choice could not be kept", async () => {
    const { settings, user } = page({
      section: "appearance",
      save: async () => {
        throw new Error("disk full");
      },
    });
    const white = await within(settings).findByRole("radio", { name: /^White/ });
    await waitFor(() => expect(white).toBeEnabled());
    await user.click(white);
    expect(await within(settings).findByRole("alert")).toHaveTextContent(
      "Could not save how Tandem looks on this device.",
    );
    expect(within(settings).queryByText("Saved")).toBeNull();
  });

  it("says Saved for what Enter does, and goes when another section is chosen", async () => {
    const { settings, user } = page({ section: "composing" });
    const enter = within(settings).getByLabelText("When I press Enter");
    await waitFor(() => expect(enter).toBeEnabled());
    await user.selectOptions(enter, "Start a new line");
    expect(await within(settings).findByText("Saved")).toBeVisible();
    await user.click(within(settings).getByRole("tab", { name: "Security" }));
    expect(within(settings).queryByText("Saved")).toBeNull();
  });
});

describe("the settings index", () => {
  it("finds by a word's start, in a setting's name, its other words or its section", () => {
    expect(findSettings("dark").map((s) => s.label)).toEqual(["Theme"]);
    expect(findSettings("pass").map((s) => s.label)).toEqual(["Change password"]);
    expect(findSettings("mic").map((s) => s.label)).toEqual([
      "Microphone",
      "Join huddles with my microphone off",
    ]);
    // A section's name finds what is in it, those named for it first.
    expect(findSettings("notif").map((s) => s.label)).toEqual([
      "Pause notifications",
      "What notifications show",
      "On this device",
    ]);
    expect(findSettings("   ")).toEqual([]);
    expect(findSettings("zebra")).toEqual([]);
  });

  it("names each setting once", () => {
    const names = SETTINGS.map((s) => `${s.section}:${s.label}`);
    expect(new Set(names).size).toBe(names.length);
  });
});
