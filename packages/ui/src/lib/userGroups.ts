import { useContext, useSyncExternalStore } from "react";
import type { ID, UserGroup } from "@ownbase/protocol";
import { ClientContext } from "../context.js";

const NONE: Record<ID, UserGroup> = {};
const unsubscribed = () => undefined;

/**
 * The workspace's user groups by id (J13), or none outside a workspace. A
 * guest is given none, so a group mention reads as its label for them.
 */
export function useUserGroups(): Record<ID, UserGroup> {
  const client = useContext(ClientContext);
  const read = () => client?.store.getState().userGroups ?? NONE;
  return useSyncExternalStore(
    (changed) => client?.store.subscribe(changed) ?? unsubscribed,
    read,
    read,
  );
}

/** "12 people", "1 person": how many a group holds, as its rows say it. */
export function groupSize(group: UserGroup): string {
  const count = group.memberIds.length;
  return count === 1 ? "1 person" : `${count} people`;
}
