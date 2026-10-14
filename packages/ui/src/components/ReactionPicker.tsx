import { useState, type RefObject } from "react";
import { Dialog } from "./Dialog.js";
import { EmojiPicker } from "./EmojiPicker.js";
import { Popover } from "./Popover.js";

/**
 * Any emoji as a reaction, not only the three the message toolbar offers.
 * With a pointer it hangs off the message it reacts to, as Slack's and
 * Discord's do, so the message stays in sight; on a touchscreen it is a dialog
 * of its own, and the search box waits to be tapped, so opening the picker
 * does not raise a keyboard over the emoji.
 */
export function ReactionPicker(props: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** The message it reacts to, for the picker to sit beside. */
  anchor?: RefObject<HTMLElement | null>;
}) {
  const [touch] = useState(() => window.matchMedia?.("(hover: none)").matches ?? false);
  function pick(emoji: string) {
    props.onClose();
    props.onPick(emoji);
  }
  if (props.anchor && !touch)
    return (
      <Popover label="Add a reaction" anchor={props.anchor} onClose={props.onClose} width={360}>
        <EmojiPicker onPick={pick} autoFocus />
      </Popover>
    );
  return (
    <Dialog title="Add a reaction" onClose={props.onClose} width={380}>
      <EmojiPicker onPick={pick} autoFocus={!touch} />
    </Dialog>
  );
}
