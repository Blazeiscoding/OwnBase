import type { WorkspaceClient } from "@ownbase/client-core";

/**
 * Whether a message just sent is kept on this device (F01, GL-02): in the
 * stored outbox, or with its words saved for a restart, or already delivered.
 * The composer keeps the words until then, rather than holding them only in
 * memory, where a closed or crashed window would lose them.
 */
export type LocalOutcome = "stored" | "unsaved";

interface Ledger {
  /** How many persistence owners keep this client's work on the device now. */
  keepers: number;
  waiting: Map<string, Set<(outcome: LocalOutcome) => void>>;
}

const ledgers = new WeakMap<WorkspaceClient, Ledger>();

function ledger(client: WorkspaceClient): Ledger {
  let found = ledgers.get(client);
  if (!found) ledgers.set(client, (found = { keepers: 0, waiting: new Map() }));
  return found;
}

/** Called by the component that writes this client's outbox while it can. */
export function keepLocalWork(client: WorkspaceClient): () => void {
  const book = ledger(client);
  book.keepers++;
  return () => {
    book.keepers--;
    // Nobody is left to say, so nobody waits for it.
    if (book.keepers === 0)
      for (const nonce of [...book.waiting.keys()]) settle(client, nonce, "unsaved");
  };
}

/** Says what became of a send's words on this device. */
export function settleLocalWork(
  client: WorkspaceClient,
  nonce: string,
  outcome: LocalOutcome,
): void {
  settle(client, nonce, outcome);
}

function settle(client: WorkspaceClient, nonce: string, outcome: LocalOutcome): void {
  const book = ledger(client);
  const listeners = book.waiting.get(nonce);
  if (!listeners) return;
  book.waiting.delete(nonce);
  for (const listener of listeners) listener(outcome);
}

/** The sends still waiting to be said kept. */
export function waitingLocalWork(client: WorkspaceClient): string[] {
  return [...ledger(client).waiting.keys()];
}

/**
 * Resolves once the send is kept on this device, or is known not to be.
 * Null when nothing here keeps work on the device, so there is nothing to
 * wait for. Gives up after `timeoutMs`, as not kept.
 */
export function whenKeptLocally(
  client: WorkspaceClient,
  nonce: string,
  timeoutMs = 5_000,
): Promise<LocalOutcome> | null {
  const book = ledger(client);
  if (book.keepers === 0) return null;
  return new Promise((resolve) => {
    const listeners = book.waiting.get(nonce) ?? new Set();
    book.waiting.set(nonce, listeners);
    const timer = setTimeout(() => settle(client, nonce, "unsaved"), timeoutMs);
    listeners.add((outcome) => {
      clearTimeout(timer);
      resolve(outcome);
    });
  });
}
