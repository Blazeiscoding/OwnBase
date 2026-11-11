import type { SendAnswer } from "@ownbase/client-core";

/** A send the outbox took, with nothing on the device to wait for. */
export const QUEUED: SendAnswer = { kind: "queued", nonce: "N_TEST", kept: null };
