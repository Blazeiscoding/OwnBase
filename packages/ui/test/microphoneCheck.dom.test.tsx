import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { accessibilityProblems } from "./accessibility.js";

const opened = vi.hoisted(() => ({
  onLevel: null as ((level: number) => void) | null,
  stop: vi.fn(),
  /** What opening it gives instead of the usual microphone. */
  result: null as { label: string; metered: boolean } | null,
  /** What opening it throws instead, as the browser would. */
  refusal: null as unknown,
}));

vi.mock("@ownbase/client-core", async (original) => ({
  ...(await original<typeof import("@ownbase/client-core")>()),
  testMicrophone: vi.fn(async (onLevel: (level: number) => void) => {
    if (opened.refusal) throw opened.refusal;
    opened.onLevel = onLevel;
    return { label: "USB Headset", metered: true, stop: opened.stop, ...(opened.result ?? {}) };
  }),
}));

const { MicrophoneCheck } = await import("../src/components/MicrophoneCheck.js");

/**
 * Checking the microphone from Calls before a huddle (CALL-01): which one
 * opened, a meter that moves, and why it could not open, with nothing sent.
 */
// Before, not after: testing-library unmounts the last test's check after
// its own hooks, and that unmount closes its microphone.
beforeEach(() => {
  opened.onLevel = null;
  opened.result = null;
  opened.refusal = null;
  opened.stop.mockReset();
});

/** As in Account settings, inside the page's landmarks. */
const check = () => (
  <main>
    <MicrophoneCheck />
  </main>
);

describe("testing the microphone", () => {
  it("names the microphone and shows its level, then closes it on Stop test", async () => {
    const user = userEvent.setup();
    render(check());
    await user.click(screen.getByRole("button", { name: "Test microphone" }));
    expect(await screen.findByText("USB Headset")).toBeVisible();
    const meter = screen.getByRole("meter", { name: "Microphone level" });
    expect(meter).toHaveAttribute("aria-valuenow", "0");
    act(() => opened.onLevel!(0.25));
    expect(meter).toHaveAttribute("aria-valuenow", "50");
    act(() => opened.onLevel!(0.9));
    expect(meter).toHaveAttribute("aria-valuenow", "100");
    expect(await accessibilityProblems(document.body)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Stop test" }));
    expect(opened.stop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByRole("button", { name: "Test microphone" })).toBeVisible();
  });

  it("says where to allow a blocked microphone", async () => {
    const user = userEvent.setup();
    opened.refusal = new DOMException("Permission denied", "NotAllowedError");
    render(check());
    await user.click(screen.getByRole("button", { name: "Test microphone" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /access to it is blocked\. Allow it in your browser or system settings/,
    );
    expect(screen.getByRole("button", { name: "Test microphone" })).toBeEnabled();
  });

  it("says when the browser cannot show a level, rather than a meter that never moves", async () => {
    const user = userEvent.setup();
    opened.result = { label: "", metered: false };
    render(check());
    await user.click(screen.getByRole("button", { name: "Test microphone" }));
    expect(
      await screen.findByText(/your default microphone\. It opened, but this browser cannot show/),
    ).toBeVisible();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("closes the microphone when the settings close mid-test", async () => {
    const user = userEvent.setup();
    const { unmount } = render(check());
    await user.click(screen.getByRole("button", { name: "Test microphone" }));
    await screen.findByRole("meter");
    unmount();
    expect(opened.stop).toHaveBeenCalledOnce();
  });
});
