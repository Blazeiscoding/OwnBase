import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { When } from "../src/components/When.js";
import { formatDay } from "../src/lib/format.js";
import { useToday } from "../src/lib/today.js";

/** What says "Today" or "Yesterday" moves on at midnight, in a window left open. */
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Local times, so the test reads the same in every zone.
const nineAm = new Date(2026, 2, 14, 9, 0).getTime();
const lateThatNight = new Date(2026, 2, 14, 23, 59, 30).getTime();

function Day({ at }: { at: number }) {
  useToday();
  return <span>{formatDay(at)}</span>;
}

describe("a day said relative to now", () => {
  it("turns from today into yesterday at midnight", async () => {
    vi.useFakeTimers({ now: lateThatNight });
    render(
      <p>
        <Day at={nineAm} /> · <When at={nineAm} />
      </p>,
    );
    const line = screen.getByText(/^Today/).parentElement!;
    // "AM" or "am", as the machine's locale writes it.
    expect(line.textContent).toMatch(/^Today · 9:00\sAM$/i);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(line.textContent).toMatch(/^Yesterday · Yesterday 9:00\sAM$/i);
  });

  it("catches up when the window comes back from a computer that slept through midnight", () => {
    vi.useFakeTimers({ now: lateThatNight, toFake: ["Date"] });
    render(<Day at={nineAm} />);
    expect(screen.getByText("Today")).toBeTruthy();
    // No timer ran while asleep: the clock jumps, and the window regains focus.
    vi.setSystemTime(new Date(2026, 2, 15, 8, 0).getTime());
    act(() => window.dispatchEvent(new Event("focus")));
    expect(screen.getByText("Yesterday")).toBeTruthy();
  });
});
