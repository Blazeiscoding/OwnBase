import { useState, type RefObject } from "react";
import { Dialog } from "./Dialog.js";
import { EmojiPicker } from "./EmojiPicker.js";
import { Popover } from "./Popover.js";

/**
 * Any emoji as a reaction, not only the three the message toolbar offers.
 * With a pointer it hangs off the message it reacts to, as Slack's and
 * Discord's do, so the message stays in sight; on a touchscreen it is a dialog
 * of its own, and the search box waits to be tapped, so opening the picker
 * does not raise a keyboard over the emoji. A status's emoji is chosen with
 * it too, under a title of its own.
 */
export function ReactionPicker(props: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** The message it reacts to, for the picker to sit beside. */
  anchor?: RefObject<HTMLElement | null>;
  title?: string;
  /** Which edge of the anchor it lines up with; a message's end by default. */
  align?: "start" | "end";
}) {
  const [touch] = useState(() => window.matchMedia?.("(hover: none)").matches ?? false);
  const title = props.title ?? "Add a reaction";
  function pick(emoji: string) {
    props.onClose();
    props.onPick(emoji);
  }
  if (props.anchor && !touch)
    return (
      <Popover
        label={title}
        anchor={props.anchor}
        onClose={props.onClose}
        width={360}
        align={props.align}
      >
        <EmojiPicker onPick={pick} autoFocus />
      </Popover>
    );
  return (
    <Dialog title={title} onClose={props.onClose} width={380}>
      <EmojiPicker onPick={pick} autoFocus={!touch} />
    </Dialog>
  );
}
