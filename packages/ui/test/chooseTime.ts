import { fireEvent, within } from "@testing-library/react";

/**
 * Fills Choose a date and time with `date` ("YYYY-MM-DD") and `time` ("HH:MM",
 * 24-hour), on whichever clock the reader's locale uses. Returns the date
 * field, which carries the form's problem.
 */
export async function chooseTime(
  date: string,
  time: string,
  { name = "Choose a date and time", inside = document.body } = {},
): Promise<HTMLElement> {
  const group = await within(inside).findByRole("group", { name });
  const dateField = within(group).getByLabelText("Date");
  fireEvent.change(dateField, { target: { value: date } });
  const [hour = "", minute] = time.split(":");
  const h = Number(hour);
  // On a 12-hour clock, the hour as it is written there and its AM or PM.
  const period = within(group).queryByRole("button", { name: /, switch to / });
  fireEvent.change(within(group).getByRole("spinbutton", { name: "Hour" }), {
    target: { value: period ? String(h % 12 || 12) : hour },
  });
  if (period && period.textContent?.toUpperCase() !== (h < 12 ? "AM" : "PM"))
    fireEvent.click(period);
  fireEvent.change(within(group).getByRole("spinbutton", { name: "Minute" }), {
    target: { value: minute },
  });
  return dateField;
}
