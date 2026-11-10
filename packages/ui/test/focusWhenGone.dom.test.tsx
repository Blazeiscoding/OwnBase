import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { useFocusWhenGone } from "../src/lib/keys.js";

/**
 * A list whose rows go when their Remove is pressed: at once, or once
 * `answer` is called, as when the server has to agree first.
 */
function List(props: { waitForAnswer?: boolean; answers?: (() => void)[] }) {
  const [rows, setRows] = useState(["Ship list", "Venue contract"]);
  const [waiting, setWaiting] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusWhenGone = useFocusWhenGone();
  function remove(row: string, index: number) {
    const next = rows[index + 1];
    focusWhenGone(
      () =>
        (next ? screen.queryByRole("button", { name: `Open ${next}` }) : null) ?? heading.current,
    );
    const go = () => setRows((now) => now.filter((r) => r !== row));
    if (!props.waitForAnswer) return go();
    // Says it is waiting, a render with the row still there.
    setWaiting((n) => n + 1);
    props.answers!.push(go);
  }
  return (
    <section aria-busy={waiting > 0}>
      <h2 ref={heading} tabIndex={-1}>
        Saved
      </h2>
      {rows.map((row, index) => (
        <div key={row}>
          <button>Open {row}</button>
          <button onClick={() => remove(row, index)}>Remove {row}</button>
        </div>
      ))}
      <button>Elsewhere</button>
    </section>
  );
}

describe("focus near a control that goes", () => {
  it("moves to the next row, then to the heading when none is left", async () => {
    const user = userEvent.setup();
    render(<List />);
    screen.getByRole("button", { name: "Remove Ship list" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Open Venue contract" })).toHaveFocus();
    screen.getByRole("button", { name: "Remove Venue contract" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Saved" })).toHaveFocus();
  });

  it("waits for a removal that waits on an answer", async () => {
    const user = userEvent.setup();
    const answers: (() => void)[] = [];
    render(<List waitForAnswer answers={answers} />);
    const remove = screen.getByRole("button", { name: "Remove Ship list" });
    remove.focus();
    await user.keyboard("{Enter}");
    // Renders in between leave focus where it is while the row is still there.
    expect(remove).toHaveFocus();
    act(() => answers[0]!());
    expect(screen.getByRole("button", { name: "Open Venue contract" })).toHaveFocus();
  });

  it("leaves focus alone once it has moved on", async () => {
    const user = userEvent.setup();
    const answers: (() => void)[] = [];
    render(<List waitForAnswer answers={answers} />);
    screen.getByRole("button", { name: "Remove Ship list" }).focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    act(() => answers[0]!());
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  });
});
