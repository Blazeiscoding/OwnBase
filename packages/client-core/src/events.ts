import type { ID, Message, Reminder } from "@ownbase/protocol";

/** What a `WorkspaceClient` tells whoever listens, by name, with what each carries. */
export interface ClientEvents {
  /**
   * A message from someone else has landed. `live` is false while replaying
   * what was missed during a disconnect, which `@here` has to know about.
   */
  message: [message: Message, context: { live: boolean }];
  /** A message was deleted, so whatever was about to be said of it is not news. */
  messageDeleted: [messageId: ID];
  /** One of this account's reminders came due now. */
  reminderDue: [reminder: Reminder, message: Message];
}

export type ClientListener<K extends keyof ClientEvents> = (...args: ClientEvents[K]) => void;

/** Any number of listeners for each event, each added and removed on its own. */
export class ClientEmitter {
  private readonly listeners = new Map<keyof ClientEvents, Set<unknown>>();

  /** Adds a listener; the function returned removes it. */
  on<K extends keyof ClientEvents>(event: K, listener: ClientListener<K>): () => void {
    let set = this.listeners.get(event) as Set<ClientListener<K>> | undefined;
    if (!set) this.listeners.set(event, (set = new Set<ClientListener<K>>()) as Set<unknown>);
    // The same function added twice is two listeners, each removed by its own call.
    const own: ClientListener<K> = (...args) => listener(...args);
    set.add(own);
    return () => set.delete(own);
  }

  /**
   * What a listener does with the news can fail on its own (Android's Chrome
   * throws from a page's `new Notification`); that must neither stop the
   * event being applied nor keep it from the other listeners.
   */
  emit<K extends keyof ClientEvents>(event: K, ...args: ClientEvents[K]): void {
    const set = this.listeners.get(event) as Set<ClientListener<K>> | undefined;
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (error) {
        console.error(error);
      }
    }
  }
}
