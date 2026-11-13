import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Accounts for stored blobs and reserves chunks before concurrent streams write
 * them, so the limit holds against uploads arriving at once rather than only
 * against one at a time.
 *
 * Reserving per chunk means two streams that reach the wall together can each
 * be holding part of the remaining space, and both are then refused even though
 * either alone would have fitted. That is the deliberate trade: the alternative
 * is reserving the maximum file size up front, which would cap concurrent
 * uploads at limit/maxFileSize however small they actually are. Refusing is
 * recoverable — the space is released and a retry succeeds — so the property
 * worth keeping is that the limit is never exceeded.
 */
export class StorageBudget {
  private files = new Map<string, number>();
  usedBytes = 0;

  constructor(
    directory: string | null,
    readonly limitBytes: number | null,
  ) {
    if (directory)
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const size = statSync(join(directory, entry.name)).size;
        this.files.set(entry.name, size);
        this.usedBytes += size;
      }
  }

  reserve(id: string, bytes: number): boolean {
    if (this.limitBytes !== null && bytes > this.limitBytes - this.usedBytes) return false;
    this.files.set(id, (this.files.get(id) ?? 0) + bytes);
    this.usedBytes += bytes;
    return true;
  }

  /** How many blobs the budget is counting. */
  get count(): number {
    return this.files.size;
  }

  /** Every blob the budget is counting, for reconciling against the database. */
  storedIds(): string[] {
    return [...this.files.keys()];
  }

  release(id: string): void {
    this.usedBytes -= this.files.get(id) ?? 0;
    this.files.delete(id);
  }
}
