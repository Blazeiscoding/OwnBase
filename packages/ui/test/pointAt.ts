import { fireEvent, screen } from "@testing-library/react";

/**
 * Points at a message, as a person does before using its toolbar: a row makes
 * its toolbar only while the pointer is on it or focus is in it. The first
 * message on screen, or the one from `author`, or the row given.
 */
export function pointAtMessage(target?: string | HTMLElement): HTMLElement {
  const row =
    target instanceof HTMLElement
      ? target
      : target
        ? screen.getByRole("article", { name: `Message from ${target}` })
        : screen.getAllByRole("article")[0]!;
  fireEvent.pointerEnter(row);
  return row;
}
