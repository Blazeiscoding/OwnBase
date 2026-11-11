import type { CallLogEntry } from "@ownbase/protocol";

/** How many lines the host can look back over; older ones fall off. */
export const CALL_LOG_LIMIT = 500;

/**
 * What happened in huddles lately, for the host working out why someone
 * cannot connect: who joined and left, which call setups the server passed
 * on or could not, and what each side reported of its connection. Memory
 * only, like huddles themselves: nothing here survives a restart, and none
 * of it is an address, an SDP or anything said in a call.
 */
export class CallLog {
  private lines: CallLogEntry[] = [];

  constructor(private now: () => number = Date.now) {}

  add(entry: Omit<CallLogEntry, "at">): void {
    this.lines.push({ at: this.now(), ...entry });
    if (this.lines.length > CALL_LOG_LIMIT)
      this.lines.splice(0, this.lines.length - CALL_LOG_LIMIT);
  }

  /** Oldest first, only for the channels `visible` says the reader may see. */
  entries(visible: (channelId: string) => boolean): CallLogEntry[] {
    const seen = new Map<string, boolean>();
    return this.lines.filter((entry) => {
      let ok = seen.get(entry.channelId);
      if (ok === undefined) seen.set(entry.channelId, (ok = visible(entry.channelId)));
      return ok;
    });
  }
}
