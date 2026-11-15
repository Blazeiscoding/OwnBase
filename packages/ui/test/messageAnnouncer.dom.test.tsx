import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeHeard,
  useMessageAnnouncer,
  type Heard,
} from "../src/components/MessageAnnouncer.js";
import { accessibilityProblems } from "./accessibility.js";

const said = (from: string, text: string, inThread = false): Heard => ({ from, text, inThread });

describe("what is read for new messages", () => {
  it("reads one message as who said what, and a reply as one", () => {
    expect(describeHeard([said("Priya Shah", "Launch is on Friday")])).toBe(
      "Priya Shah: Launch is on Friday",
    );
    expect(describeHeard([said("Sam Rivera", "Agreed", true)])).toBe(
      "Sam Rivera replied in the thread: Agreed",
    );
  });

  it("cuts a long message short", () => {
    const text = describeHeard([said("Priya Shah", "a".repeat(500))]);
    expect(text).toHaveLength("Priya Shah: ".length + 200);
    expect(text.endsWith("…")).toBe(true);
  });

  it("reads several as a count and who sent them, each named once", () => {
    expect(
      describeHeard([
        said("Priya Shah", "one"),
        said("Sam Rivera", "two"),
        said("Priya Shah", "3"),
      ]),
    ).toBe("3 new messages, from Priya Shah and Sam Rivera");
    // The list is joined the reader's way, with or without a comma before "and".
    expect(
      describeHeard(["Ana", "Ben", "Cy", "Dee", "Eve"].map((name) => said(name, "hi"))),
    ).toMatch(/^5 new messages, from Ana, Ben, Cy,? and 2 others$/);
  });
});

/** The hook's region, with the hook handed out so a test can feed it. */
function Harness(props: { onReady: (a: ReturnType<typeof useMessageAnnouncer>) => void }) {
  const announcer = useMessageAnnouncer(3000);
  props.onReady(announcer);
  return announcer.region;
}

it("keeps the log out of sight, and passes an accessibility check with a line in it", async () => {
  let announcer!: ReturnType<typeof useMessageAnnouncer>;
  render(<Harness onReady={(a) => (announcer = a)} />);
  act(() => announcer.hear(said("Priya Shah", "Launch is on Friday")));
  const log = screen.getByRole("log", { name: "New messages" });
  expect(log).toHaveTextContent("Priya Shah: Launch is on Friday");
  expect(log).toHaveClass("sr-only");
  expect(await accessibilityProblems(log.parentElement!)).toEqual([]);
});

describe("the new-message log", () => {
  let announcer!: ReturnType<typeof useMessageAnnouncer>;
  const lines = () =>
    [...screen.getByRole("log", { name: "New messages" }).querySelectorAll("p")].map(
      (p) => p.textContent,
    );

  beforeEach(() => {
    vi.useFakeTimers();
    render(<Harness onReady={(a) => (announcer = a)} />);
  });
  afterEach(() => vi.useRealTimers());

  it("reads the first message at once, then waits and reads the rest together", () => {
    act(() => announcer.hear(said("Priya Shah", "Launch is on Friday")));
    expect(lines()).toEqual(["Priya Shah: Launch is on Friday"]);

    act(() => {
      announcer.hear(said("Sam Rivera", "Great"));
      announcer.hear(said("Priya Shah", "Bring snacks"));
    });
    expect(lines()).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(2999));
    expect(lines()).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1));
    expect(lines()).toEqual([
      "Priya Shah: Launch is on Friday",
      "2 new messages, from Sam Rivera and Priya Shah",
    ]);

    // Once it has been quiet long enough, the next is read as it arrives.
    act(() => void vi.advanceTimersByTime(3000));
    act(() => announcer.hear(said("Sam Rivera", "On it")));
    expect(lines().at(-1)).toBe("Sam Rivera: On it");
    // Only the last few stay for anyone reading back.
    expect(lines()).toHaveLength(3);
  });

  it("drops what was waiting when somebody moves to another conversation", () => {
    act(() => {
      announcer.hear(said("Priya Shah", "one"));
      announcer.hear(said("Sam Rivera", "two"));
    });
    act(() => announcer.forget());
    expect(lines()).toEqual([]);
    act(() => void vi.advanceTimersByTime(5000));
    expect(lines()).toEqual([]);
  });
});
