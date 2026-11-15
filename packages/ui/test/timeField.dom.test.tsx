import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { WorkspaceClient } from "@ownbase/client-core";
import { ClientContext } from "../src/context.js";
import { TimePopover } from "../src/components/TimePopover.js";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";
import { setReaderLocale } from "../src/lib/readerLocale.js";

/**
 * Choosing a time for Send later and reminders, written as the reader writes
 * times: `<input type="time">` followed Chromium's language, so a device set
 * to 24-hour times was still asked for AM or PM.
 */
const clients: WorkspaceClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.destroy();
  setReaderLocale(undefined);
});

function Picker({ onPick }: { onPick: (at: Date) => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor}>Send later</button>
      <TimePopover
        anchor={anchor}
        onClose={() => {}}
        onPick={onPick}
        label="Send later"
        presets={[]}
        submitLabel={(at) => (at ? `Schedule for ${at.toString()}` : "Schedule message")}
      />
    </>
  );
}

function open(locale: string) {
  setReaderLocale(locale);
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  clients.push(client);
  const onPick = vi.fn();
  render(
    <ToastProvider>
      <ConfirmProvider>
        <ClientContext.Provider value={client}>
          <Picker onPick={onPick} />
        </ClientContext.Provider>
      </ConfirmProvider>
    </ToastProvider>,
  );
  const choose = screen.getByRole("group", { name: "Choose a date and time" });
  return { choose, onPick, user: userEvent.setup() };
}

describe("the time field", () => {
  it("asks for hours 0 to 23 and no AM or PM where the reader writes 24-hour times", async () => {
    const { choose, onPick, user } = open("en-GB");
    fireEvent.change(within(choose).getByLabelText("Date"), { target: { value: "2099-01-05" } });
    const time = within(choose).getByRole("group", { name: "Time" });
    expect(within(time).queryByRole("button")).toBeNull();
    const hour = within(time).getByRole("spinbutton", { name: "Hour" });
    expect(hour).toHaveAttribute("aria-valuemax", "23");
    await user.type(hour, "1430");
    // The hour moves on to the minutes by itself.
    expect(within(time).getByRole("spinbutton", { name: "Minute" })).toHaveValue("30");
    await user.click(screen.getByRole("button", { name: /^Schedule for / }));
    expect(onPick).toHaveBeenCalledWith(new Date(2099, 0, 5, 14, 30));
  });

  it("asks for AM or PM where the reader writes 12-hour times", async () => {
    const { choose, onPick, user } = open("en-US");
    fireEvent.change(within(choose).getByLabelText("Date"), { target: { value: "2099-01-05" } });
    const time = within(choose).getByRole("group", { name: "Time" });
    const hour = within(time).getByRole("spinbutton", { name: "Hour" });
    expect(hour).toHaveAttribute("aria-valuemax", "12");
    await user.type(hour, "2");
    await user.type(within(time).getByRole("spinbutton", { name: "Minute" }), "05");
    await user.click(within(time).getByRole("button", { name: "AM, switch to PM" }));
    await user.click(screen.getByRole("button", { name: /^Schedule for / }));
    expect(onPick).toHaveBeenCalledWith(new Date(2099, 0, 5, 14, 5));
  });

  it("steps each part with the arrow keys, around the clock", async () => {
    const { choose, user } = open("en-GB");
    const time = within(choose).getByRole("group", { name: "Time" });
    const hour = within(time).getByRole("spinbutton", { name: "Hour" });
    const minute = within(time).getByRole("spinbutton", { name: "Minute" });
    hour.focus();
    await user.keyboard("{ArrowUp}");
    expect(hour).toHaveValue("00");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(hour).toHaveValue("22");
    minute.focus();
    await user.keyboard("{ArrowDown}");
    expect(minute).toHaveValue("59");
  });

  it("asks for what is missing, at the field that is missing it", async () => {
    const { choose, onPick, user } = open("en-GB");
    await user.click(screen.getByRole("button", { name: "Schedule message" }));
    const date = within(choose).getByLabelText("Date");
    expect(date).toHaveFocus();
    expect(date).toHaveAccessibleDescription("Choose a date and time.");
    fireEvent.change(date, { target: { value: "2099-01-05" } });
    await user.click(screen.getByRole("button", { name: "Schedule message" }));
    expect(within(choose).getByRole("spinbutton", { name: "Hour" })).toHaveFocus();
    expect(onPick).not.toHaveBeenCalled();
  });
});
