import type { FastifyBaseLogger } from "fastify";
import type { EventEnvelope, WorkspaceEvent } from "@ownbase/protocol";
import { eventChannel, writeEffects } from "../events/registry.js";
import type { Audiences } from "../events/outbox.js";
import type { Gateway } from "../gateway.js";
import type { Store } from "../store.js";
import type { BackgroundWork } from "./background.js";

/** Appends an event to the log, with what it writes besides, inside the caller's transaction. */
export type RecordEvent = (event: WorkspaceEvent) => EventEnvelope;

/**
 * Runs `work` in one transaction, and once it has committed tells everyone
 * allowed to see them of the events it recorded, then runs what it left for
 * after the commit.
 */
export type Mutate = <T>(
  work: (record: RecordEvent, afterCommit: (effect: () => void) => void) => T,
) => T;

export interface Commits {
  recordEvent: RecordEvent;
  mutate: Mutate;
  /**
   * Calls `listener` with each event as it is recorded, inside its
   * transaction, so what it writes commits or rolls back with the event.
   */
  onRecorded(listener: (envelope: EventEnvelope) => void): void;
  /** Calls `listener` after committed events have gone out. */
  onPublished(listener: () => void): void;
}

export function createCommits(deps: {
  store: Store;
  gateway: Gateway;
  log: FastifyBaseLogger;
  background: BackgroundWork;
}): Commits {
  const { store, gateway, log, background } = deps;
  const recorded: ((envelope: EventEnvelope) => void)[] = [];
  const published: (() => void)[] = [];

  const recordEvent: RecordEvent = (event) => {
    const envelope = store.appendEvent(event, eventChannel(event));
    writeEffects(event, envelope.seq, store);
    for (const listener of recorded) listener(envelope);
    return envelope;
  };

  /**
   * Hands committed events to everyone allowed to see them (REV-10). The
   * change has happened, so nothing here may turn its answer into a failure
   * or stop the events after it. A frame that cannot be fanned out closes
   * every socket, so each client reconnects from the last event it has and
   * replays the rest, rather than taking the next event as its checkpoint and
   * never asking for it.
   */
  const publishCommitted = (events: readonly EventEnvelope[], audiences: Audiences): void => {
    for (const envelope of events) {
      try {
        gateway.publish(envelope, audiences);
      } catch (err) {
        log.error(
          { err, seq: envelope.seq },
          "could not send a committed event; clients replay it",
        );
        gateway.resynchronize();
      }
    }
    if (events.length > 0) for (const listener of published) listener();
  };

  /**
   * Commits synchronous state and its event log before exposing any side
   * effects. What the writes tell people goes out around the change's events:
   * notices ahead of them, then the events, then the rest, each channel's
   * audience read once for all of it (F10).
   */
  const mutate: Mutate = (work) => {
    const events: EventEnvelope[] = [];
    const effects: (() => void)[] = [];
    const audiences: Audiences = new Map();
    return store.outbox.hold(() => {
      const result = store.transaction(() =>
        work(
          (event) => {
            const envelope = recordEvent(event);
            events.push(envelope);
            return envelope;
          },
          (effect) => effects.push(effect),
        ),
      );
      store.outbox.flushAhead();
      for (const effect of effects) background.afterCommitted("apply a committed change", effect);
      publishCommitted(events, audiences);
      return result;
    }, audiences);
  };

  return {
    recordEvent,
    mutate,
    onRecorded: (listener) => recorded.push(listener),
    onPublished: (listener) => published.push(listener),
  };
}
