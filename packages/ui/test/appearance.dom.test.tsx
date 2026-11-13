import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { render } from "./render.js";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@ownbase/client-core";
import type { User } from "@ownbase/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { AccountDialog } from "../src/components/AccountDialog.js";
import { paletteCommands, useActionContext } from "../src/lib/actions.js";
import { renderPart } from "./workspaceParts.js";
import { FIRST_PAINT_KEY, useApplyAppearance } from "../src/lib/appearance.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  canInvite: true,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
  localStorage.removeItem(FIRST_PAINT_KEY);
  for (const bar of document.head.querySelectorAll('meta[name="theme-color"]')) bar.remove();
});

function Applied() {
  useApplyAppearance();
  return null;
}

/**
 * Appearance settings on a device whose storage holds `saved`, and may refuse
 * to save. With `held`, the storage answers only once `read` is called.
 */
function appearance(
  saved: unknown,
  options: { failSave?: boolean; held?: boolean; setWindowTheme?: Platform["setWindowTheme"] } = {},
) {
  const set = vi.fn(async (_name: string, _value: unknown) => {
    if (options.failSave) throw new Error("storage is full");
  });
  let read = () => {};
  const answered = options.held ? new Promise<void>((resolve) => (read = resolve)) : null;
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(name: string) => {
        await answered;
        return (name === "appearance" ? saved : null) as T | null;
      },
      set,
    },
    notify: () => {},
    ...(options.setWindowTheme ? { setWindowTheme: options.setWindowTheme } : {}),
  };
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
  vi.spyOn(client.api, "listSessions").mockResolvedValue({ sessions: [] });
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <Applied />
        <AccountDialog onClose={() => {}} section="appearance" />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const panel = screen.getByRole("tabpanel", { name: "Appearance" });
  return { panel, set, user: userEvent.setup(), read: () => act(read) };
}

const root = () => document.documentElement.dataset;
const kept = () => JSON.parse(localStorage.getItem(FIRST_PAINT_KEY) ?? "null") as unknown;

describe("how OwnBase looks on this device", () => {
  it("tells the desktop window's frame the theme once it is read, and each time it changes", async () => {
    const setWindowTheme = vi.fn();
    const { panel, user, read } = appearance({ theme: "light" }, { held: true, setWindowTheme });
    // The copy the page was first painted with is not the saved choice yet.
    expect(setWindowTheme).not.toHaveBeenCalled();
    read();
    await waitFor(() => expect(setWindowTheme).toHaveBeenLastCalledWith("light"));
    await user.click(within(panel).getByRole("radio", { name: /^Onyx/ }));
    await waitFor(() => expect(setWindowTheme).toHaveBeenLastCalledWith("dark"));
  });

  it("applies what was saved, and offers every theme and density", async () => {
    const { panel } = appearance({ theme: "light", density: "compact" });
    await waitFor(() => expect(root().theme).toBe("light"));
    expect(root().density).toBe("compact");
    const themes = within(panel).getByRole("group", { name: "Theme" });
    expect(
      within(themes)
        .getAllByRole("radio")
        .map((r) => r.nextElementSibling?.firstElementChild?.textContent),
    ).toEqual(["Match this device", "Onyx", "White"]);
    expect(within(themes).getByRole("radio", { name: /^White/ })).toBeChecked();
    expect(within(panel).getByRole("radio", { name: /Compact/ })).toBeChecked();
    expect(await accessibilityProblems(panel)).toEqual([]);
  });

  it("puts a device that chose the old high-contrast theme on Onyx", async () => {
    const { panel } = appearance({ theme: "contrast", density: "comfortable" });
    await waitFor(() => expect(root().theme).toBe("dark"));
    expect(within(panel).getByRole("radio", { name: /^Onyx/ })).toBeChecked();
  });

  it("follows the device, comfortably, when nothing, or nothing it knows, was saved", async () => {
    appearance({ theme: "sepia", density: 3 });
    await waitFor(() => expect(root().theme).toBe("system"));
    expect(root().density).toBe("comfortable");
  });

  it("changes at once when chosen, and keeps the choice", async () => {
    const { panel, set, user } = appearance(null);
    await waitFor(() => expect(within(panel).getByRole("radio", { name: /^Onyx/ })).toBeEnabled());
    await user.click(within(panel).getByRole("radio", { name: /^White/ }));
    expect(root().theme).toBe("light");
    expect(set).toHaveBeenLastCalledWith("appearance", { theme: "light", density: "comfortable" });
    await user.click(within(panel).getByRole("radio", { name: /^Compact/ }));
    expect(root().density).toBe("compact");
    expect(set).toHaveBeenLastCalledWith("appearance", { theme: "light", density: "compact" });
  });

  it("goes back and says so when the choice cannot be kept", async () => {
    const { panel, user } = appearance(
      { theme: "dark", density: "comfortable" },
      { failSave: true },
    );
    await waitFor(() => expect(within(panel).getByRole("radio", { name: /^Onyx/ })).toBeEnabled());
    await user.click(within(panel).getByRole("radio", { name: /^White/ }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "Could not save how OwnBase looks on this device.",
    );
    expect(root().theme).toBe("dark");
    expect(within(panel).getByRole("radio", { name: /^Onyx/ })).toBeChecked();
  });
});

describe("following the device", () => {
  /** What Ctrl+K offers for the theme. */
  function ThemeCommand() {
    const command = paletteCommands(useActionContext()).find((c) => c.id === "theme");
    return <p data-testid="theme-command">{command?.label}</p>;
  }

  /** A device whose only colour-scheme answer is `prefers`, or none at all. */
  function device(prefers: "light" | "dark" | null) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: prefers !== null && query === `(prefers-color-scheme: ${prefers})`,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const bar = document.createElement("meta");
    bar.name = "theme-color";
    document.head.append(bar);
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
    renderPart(
      client,
      <>
        <Applied />
        <ThemeCommand />
      </>,
    );
    return { bar, command: screen.getByTestId("theme-command") };
  }

  // theme.css paints "system" as Onyx unless the device asks for light.
  it("shows Onyx when the device states no preference, and Ctrl+K offers White", async () => {
    const { bar, command } = device(null);
    await waitFor(() => expect(root().theme).toBe("system"));
    expect(command).toHaveTextContent("Switch to the White theme");
    expect(bar.content).toBe("#111115");
  });

  it("shows White when the device asks for light, and Ctrl+K offers Onyx", async () => {
    const { bar, command } = device("light");
    await waitFor(() => expect(root().theme).toBe("system"));
    expect(command).toHaveTextContent("Switch to the Onyx theme");
    expect(bar.content).toBe("#e9e9ec");
  });

  it("shows Onyx when the device asks for dark, and Ctrl+K offers White", async () => {
    const { bar, command } = device("dark");
    await waitFor(() => expect(root().theme).toBe("system"));
    expect(command).toHaveTextContent("Switch to the White theme");
    expect(bar.content).toBe("#111115");
  });
});

describe("the copy the next page is first painted with", () => {
  it("is kept once the choice is read, and follows each change", async () => {
    const { panel, user } = appearance({ theme: "light", density: "compact" });
    await waitFor(() => expect(kept()).toEqual({ theme: "light", density: "compact" }));
    await user.click(within(panel).getByRole("radio", { name: /^Onyx/ }));
    expect(kept()).toEqual({ theme: "dark", density: "compact" });
  });

  it("is what the app starts from, so it does not change the page before the choice is read", async () => {
    localStorage.setItem(FIRST_PAINT_KEY, JSON.stringify({ theme: "light", density: "compact" }));
    const { read } = appearance({ theme: "dark", density: "comfortable" }, { held: true });
    // Not "system" while the storage is still being read: the page stays as first painted.
    expect(root().theme).toBe("light");
    expect(root().density).toBe("compact");
    expect(kept()).toEqual({ theme: "light", density: "compact" });
    await read();
    await waitFor(() => expect(root().theme).toBe("dark"));
    expect(kept()).toEqual({ theme: "dark", density: "comfortable" });
  });

  it("goes back with a choice that could not be kept", async () => {
    const { panel, user } = appearance(
      { theme: "dark", density: "comfortable" },
      { failSave: true },
    );
    await waitFor(() => expect(kept()).toEqual({ theme: "dark", density: "comfortable" }));
    await user.click(within(panel).getByRole("radio", { name: /^White/ }));
    await within(panel).findByRole("alert");
    expect(kept()).toEqual({ theme: "dark", density: "comfortable" });
  });

  it("colours the browser's own bars in the chosen theme", async () => {
    const bar = document.createElement("meta");
    bar.name = "theme-color";
    bar.content = "#111115";
    document.head.append(bar);
    const { panel, user } = appearance({ theme: "dark", density: "comfortable" });
    await waitFor(() => expect(within(panel).getByRole("radio", { name: /^Onyx/ })).toBeChecked());
    expect(bar.content).toBe("#111115");
    await user.click(within(panel).getByRole("radio", { name: /^White/ }));
    expect(bar.content).toBe("#e9e9ec");
  });
});
