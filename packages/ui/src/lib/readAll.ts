import type { Unread } from "@ownbase/client-core";

/** "3 conversations", "1 thread", "2 conversations, 1 thread and 1 removal note". */
export function unreadSummary({ channels, threads, removals }: Unread): string {
  const parts: string[] = [];
  const count = (n: number, one: string) => n && parts.push(`${n} ${one}${n === 1 ? "" : "s"}`);
  count(channels.length, "conversation");
  count(threads.length, "thread");
  count(removals.length, "removal note");
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join("");
}
