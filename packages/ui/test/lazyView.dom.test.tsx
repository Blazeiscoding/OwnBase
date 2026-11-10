import { afterEach, describe, expect, it, vi } from "vitest";
import { lazy, type ComponentType } from "react";
import { act, screen } from "@testing-library/react";
import { render } from "./render.js";
import userEvent from "@testing-library/user-event";
import { LazyDialog, LazyPanel } from "../src/components/LazyView.js";

/** A view whose download the test finishes, or fails, when it chooses. */
function download() {
  let finish!: (view: ComponentType) => void;
  let fail!: (error: Error) => void;
  const loaded = new Promise<{ default: ComponentType }>((resolve, reject) => {
    finish = (view) => resolve({ default: view });
    fail = reject;
  });
  return { View: lazy(() => loaded), finish, fail };
}

afterEach(() => vi.restoreAllMocks());

describe("a panel loaded on first use", () => {
  it("says it is loading, can be closed meanwhile, and then shows the panel", async () => {
    const user = userEvent.setup();
    const { View, finish } = download();
    const onClose = vi.fn();
    render(
      <LazyPanel name="Scheduled messages" onClose={onClose}>
        <View />
      </LazyPanel>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading scheduled messages…");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => finish(() => <aside aria-label="Scheduled">Nothing queued</aside>));
    expect(screen.getByRole("complementary", { name: "Scheduled" })).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers a way out, not a broken workspace, when the panel cannot download", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    const { View, fail } = download();
    const onClose = vi.fn();
    render(
      <LazyPanel name="Scheduled messages" onClose={onClose}>
        <View />
      </LazyPanel>,
    );
    await act(async () => fail(new Error("Failed to fetch dynamically imported module")));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Scheduled messages could not load. Close it to keep chatting, or reload the app to try again.",
    );
    expect(screen.getByRole("button", { name: "Reload app" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close scheduled messages" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("a dialog loaded on first use", () => {
  it("opens as a named dialog that says it is loading, then becomes the dialog", async () => {
    const user = userEvent.setup();
    const { View, finish } = download();
    const onClose = vi.fn();
    render(
      <LazyDialog loading="Loading search" onClose={onClose}>
        <View />
      </LazyDialog>,
    );
    const loading = screen.getByRole("dialog", { name: "Loading search" });
    expect(loading).toHaveTextContent("Opening this view…");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => finish(() => <p>Search results</p>));
    expect(screen.getByText("Search results")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Loading search" })).toBeNull();
  });

  it("says the view could not load, and still closes, when its download fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    const { View, fail } = download();
    const onClose = vi.fn();
    render(
      <LazyDialog loading="Loading channel details" onClose={onClose}>
        <View />
      </LazyDialog>,
    );
    await act(async () => fail(new Error("Failed to fetch dynamically imported module")));
    expect(screen.getByRole("dialog", { name: "This view could not load" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload app" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
