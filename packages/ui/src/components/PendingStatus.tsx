import type { PendingMessage } from "@ownbase/client-core";
import { useClient } from "../context.js";
import { useConnectionDown } from "../lib/online.js";

/**
 * Where a message on its way is, in the same words in a conversation and in
 * a thread: sending, uploading with a way to stop, or why it did not go with
 * Retry and Discard.
 */
export function PendingStatus({ pending }: { pending: PendingMessage }) {
  const client = useClient();
  const down = useConnectionDown();
  // Lost on the way while the connection is down: it goes by itself once it
  // is back, so it waits quietly rather than as an error.
  if (pending.failed && !pending.refused && down)
    return (
      <span className="ml-2 text-[12px] text-ink-faint">
        Waiting for the connection… ·{" "}
        <button
          className="underline hover:text-ink"
          onClick={() => client.discardSend(pending.nonce)}
        >
          Discard
        </button>
      </span>
    );
  if (pending.failed)
    return (
      <span className="ml-2 text-[12px] text-alert">
        {pending.failureReason ?? "Not sent."}{" "}
        <button className="underline" onClick={() => client.retrySend(pending.nonce)}>
          Retry
        </button>{" "}
        ·{" "}
        <button className="underline" onClick={() => client.discardSend(pending.nonce)}>
          Discard
        </button>
      </span>
    );
  const uploading =
    pending.attachments.length > 0 && pending.uploadProgress !== null && pending.uploadProgress < 1;
  if (uploading)
    return (
      <span className="ml-2 text-[12px] text-ink-faint">
        Uploading… ·{" "}
        <button
          className="underline hover:text-ink"
          onClick={() => client.discardSend(pending.nonce)}
          aria-label="Cancel sending this message"
        >
          Cancel
        </button>
      </span>
    );
  return <span className="ml-2 text-[12px] text-ink-faint">Sending…</span>;
}
