import type { AppEventType, EphemeralEvent, ID, WorkspaceEvent } from "@ownbase/protocol";
import type { Store } from "../store.js";
import { adminEphemeral } from "../admin/events.js";
import { appsEphemeral } from "../apps/events.js";
import { channelDurable, channelEphemeral } from "../channels/events.js";
import { huddleEphemeral } from "../huddles/events.js";
import { messageDurable, messageEphemeral } from "../messages/events.js";
import { peopleDurable, peopleEphemeral } from "../people/events.js";
import { pollEphemeral } from "../polls/events.js";
import { reminderEphemeral } from "../reminders/events.js";
import { savedDurable, savedEphemeral } from "../saved/events.js";

/**
 * Every event the server sends, by type: who hears it, and for the durable
 * ones what else they write and how an app is told of them. Each feature
 * declares its own events beside its routes; this puts them together and
 * fails to compile while any event is undeclared.
 */

export type DurableType = WorkspaceEvent["type"];
export type DurableOf<T extends DurableType> = Extract<WorkspaceEvent, { type: T }>;

/** How an app subscribed to an event is sent it. */
export interface AppDelivery<E extends WorkspaceEvent> {
  /** Who caused it: an app is never sent what its own bot did. */
  actor(event: E): ID | null;
  /** The Slack Events API shape it is sent in, or null for a change apps are not told of. */
  slack(event: E): Record<string, unknown> | null;
}

export interface DurableSpec<E extends WorkspaceEvent> {
  /**
   * The conversation it happened in, whose readers hear it, live and on
   * replay; null for everyone signed in.
   */
  channel(event: E): ID | null;
  /** What else it writes, in the transaction that records it, once it has its seq. */
  effects?(event: E, seq: number, store: Store): void;
}

/** An app may subscribe to exactly the events protocol lists in `APP_EVENTS`. */
type DurableEntry<T extends DurableType> = DurableSpec<DurableOf<T>> &
  (T extends AppEventType ? { app: AppDelivery<DurableOf<T>> } : { app?: never });

export type DurableRegistry = { [T in DurableType]: DurableEntry<T> };

/**
 * Who hears an ephemeral event:
 * - `person`: every device of one account, its own state or something said to it;
 * - `channel`: everyone who can read one conversation;
 * - `everyone`: everyone signed in;
 * - `admins`: the owner and admins;
 * - `device`: the one socket it answers, never fanned out.
 */
export type Audience = "person" | "channel" | "everyone" | "admins" | "device";

export type EphemeralRegistry = { [T in EphemeralEvent["type"]]: Audience };

export const DURABLE_EVENTS: DurableRegistry = {
  ...messageDurable,
  ...channelDurable,
  ...peopleDurable,
  ...savedDurable,
};

export const EPHEMERAL_AUDIENCE = {
  ...messageEphemeral,
  ...channelEphemeral,
  ...peopleEphemeral,
  ...adminEphemeral,
  ...huddleEphemeral,
  ...appsEphemeral,
  ...reminderEphemeral,
  ...pollEphemeral,
  ...savedEphemeral,
} as const satisfies EphemeralRegistry;

type Audiences = typeof EPHEMERAL_AUDIENCE;

/** The ephemeral events whose audience is `A`. */
export type EventTo<A extends Audience> = Extract<
  EphemeralEvent,
  { type: { [T in keyof Audiences]: Audiences[T] extends A ? T : never }[keyof Audiences] }
>;

/** The conversation whose readers hear a durable event, or null for everyone. */
export function eventChannel(event: WorkspaceEvent): ID | null {
  return (DURABLE_EVENTS[event.type] as DurableSpec<WorkspaceEvent>).channel(event);
}

/** Writes what a durable event changes besides itself; see `DurableSpec.effects`. */
export function writeEffects(event: WorkspaceEvent, seq: number, store: Store): void {
  (DURABLE_EVENTS[event.type] as DurableSpec<WorkspaceEvent>).effects?.(event, seq, store);
}

/** How an app is sent this event, or null when no app may subscribe to it. */
export function appDelivery(event: WorkspaceEvent): AppDelivery<WorkspaceEvent> | null {
  return (DURABLE_EVENTS[event.type].app as AppDelivery<WorkspaceEvent> | undefined) ?? null;
}
