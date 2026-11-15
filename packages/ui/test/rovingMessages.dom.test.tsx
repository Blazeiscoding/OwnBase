import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { useRovingMessages } from "../src/lib/useRovingMessages.js";

/** A message the way the timeline draws one: a Tab stop with controls inside. */
function Message(props: { from: string; editing?: boolean }) {
  return (
    <div role="article" aria-label={`Message from ${props.from}`} tabIndex={0}>
      <button>{props.from}</button>
      {props.editing ? (
        <textarea
          aria-label="Edit message"
          onKeyDown={(e) => {
            if (e.key === "Escape") e.preventDefault();
          }}
        />
      ) : (
        <div className="message-toolbar">
          <button aria-label="Reply in thread" />
        </div>
      )}
    </div>
  );
}

function List(props: { from: string[]; editing?: string }) {
  const list = useRef<HTMLDivElement>(null);
  const roving = useRovingMessages(list);
  return (
    <>
      <div role="presentation" ref={list} onFocus={roving.onFocus} onKeyDown={roving.onKeyDown}>
        {props.from.map((from) => (
          <Message key={from} from={from} editing={from === props.editing} />
        ))}
      </div>
      <textarea aria-label="Message #general" />
    </>
  );
}

const message = (from: string) => screen.getByRole("article", { name: `Message from ${from}` });
/** What Tab would stop on, in order. */
const tabStops = () =>
  [...document.querySelectorAll<HTMLElement>("button, textarea, [tabindex]")]
    .filter((element) => element.tabIndex >= 0)
    .map((element) => element.getAttribute("aria-label") ?? element.textContent);

describe("a list of messages", () => {
  it("is one Tab stop, the newest message, with only that message's controls", async () => {
    render(<List from={["Ana", "Ben", "Cy"]} />);
    expect(tabStops()).toEqual(["Message from Cy", "Cy", "Reply in thread", "Message #general"]);
    const user = userEvent.setup();
    await user.tab();
    expect(message("Cy")).toHaveFocus();
  });

  it("moves between messages with the arrow keys, Home and End, and follows the move", async () => {
    render(<List from={["Ana", "Ben", "Cy"]} />);
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{ArrowUp}");
    expect(message("Ben")).toHaveFocus();
    expect(tabStops()).toEqual(["Message from Ben", "Ben", "Reply in thread", "Message #general"]);
    await user.keyboard("{Home}");
    expect(message("Ana")).toHaveFocus();
    // Nothing above the first.
    await user.keyboard("{ArrowUp}");
    expect(message("Ana")).toHaveFocus();
    await user.keyboard("{End}");
    expect(message("Cy")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(message("Cy")).toHaveFocus();
  });

  it("goes into a message's actions with Enter, and back out with Escape", async () => {
    render(<List from={["Ana", "Ben"]} />);
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(within(message("Ben")).getByRole("button", { name: "Reply in thread" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(message("Ben")).toHaveFocus();
  });

  it("leaves Escape to a control that uses it, such as the editor", async () => {
    render(<List from={["Ana", "Ben"]} editing="Ben" />);
    const user = userEvent.setup();
    const editor = screen.getByRole("textbox", { name: "Edit message" });
    await user.click(editor);
    await user.keyboard("{Escape}");
    expect(editor).toHaveFocus();
  });

  it("makes a message current when somebody clicks into it", async () => {
    render(<List from={["Ana", "Ben", "Cy"]} />);
    await userEvent.setup().click(within(message("Ana")).getByRole("button", { name: "Ana" }));
    expect(tabStops()).toEqual(["Message from Ana", "Ana", "Reply in thread", "Message #general"]);
  });

  it("keeps its Tab stop on the newest message as messages arrive, until somebody moves", async () => {
    const { rerender } = render(<List from={["Ana", "Ben"]} />);
    rerender(<List from={["Ana", "Ben", "Cy"]} />);
    await act(async () => {});
    expect(tabStops()[0]).toBe("Message from Cy");

    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{ArrowUp}");
    rerender(<List from={["Ana", "Ben", "Cy", "Dee"]} />);
    await act(async () => {});
    // Somebody reading Ben's message is not moved on by a new one.
    expect(tabStops()).toEqual(["Message from Ben", "Ben", "Reply in thread", "Message #general"]);
  });
});
