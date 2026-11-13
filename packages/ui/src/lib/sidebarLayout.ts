import { createStore, useStore } from "zustand";
import { isDirect, type Channel, type ID } from "@ownbase/protocol";
import { blockedPartner, isUnread, type WorkspaceState } from "@ownbase/client-core";
import { channelTitle } from "./format.js";
import { isClosed } from "./conversationChoices.js";

/** Where the collapsed sections are kept, outside the device store's "ownbase:" names. */
export const COLLAPSED_SECTIONS_KEY = "ownbase-collapsed-sections";

function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/**
 * Which sidebar categories are folded away, kept on this device. Storage
 * that is unavailable, as in a private window, only means they reopen.
 */
export const collapsedSections = createStore<{ collapsed: Set<string> }>(() => ({
  collapsed: readCollapsed(),
}));

export function toggleCollapsed(section: string): void {
  const next = new Set(collapsedSections.getState().collapsed);
  if (next.has(section)) next.delete(section);
  else next.add(section);
  try {
    localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...next]));
  } catch {
    // Kept for this session only.
  }
  collapsedSections.setState({ collapsed: next });
}

/** Reads storage again, for a page whose storage changed under it, as a test's does. */
export function reloadCollapsed(): void {
  collapsedSections.setState({ collapsed: readCollapsed() });
}

export function useCollapsed(): Set<string> {
  return useStore(collapsedSections, (s) => s.collapsed);
}

export interface SidebarGroups {
  starred: Channel[];
  /** Each of this account's sections (E8), by id, in the sections' order. */
  sectioned: Map<ID, Channel[]>;
  rooms: Channel[];
  dms: Channel[];
}

type LayoutState = Pick<
  WorkspaceState,
  | "channels"
  | "memberships"
  | "channelLastSeq"
  | "prefs"
  | "users"
  | "self"
  | "sidebarSections"
  | "blocked"
  | "mentionCounts"
>;

/** The conversations of the sidebar, in the groups and order it draws them. */
export function sidebarGroups(s: LayoutState, activeId: ID | null): SidebarGroups {
  const selfId = s.self?.id;
  const starred: Channel[] = [];
  const sectioned = new Map<ID, Channel[]>(s.sidebarSections.map((x) => [x.id, []]));
  const rooms: Channel[] = [];
  const dms: Channel[] = [];
  for (const ch of Object.values(s.channels)) {
    // An archived channel keeps its star, and comes back to Starred with it.
    if (ch.archived || !(ch.id in s.memberships)) continue;
    // A DM with someone this account blocked leaves the sidebar (E12).
    if (blockedPartner(ch, selfId, s.blocked)) continue;
    // So does one it closed, until someone writes there; the open one stays.
    if (
      isDirect(ch.type) &&
      ch.id !== activeId &&
      isClosed(s.prefs[ch.id], s.channelLastSeq[ch.id])
    )
      continue;
    // Starred moves a conversation out of its usual section, as Slack's does,
    // and so does a section of this account's (E8); one it no longer has is none.
    const inSection = sectioned.get(s.prefs[ch.id]?.sectionId ?? "");
    if (s.prefs[ch.id]?.starred) starred.push(ch);
    else if (inSection) inSection.push(ch);
    else if (isDirect(ch.type)) dms.push(ch);
    else rooms.push(ch);
  }
  // By name, channels and people together, so a row stays where it was put
  // rather than jumping each time a message arrives.
  const named = (ch: Channel) => (isDirect(ch.type) ? channelTitle(ch, s.users, selfId) : ch.name);
  const byName = (a: Channel, b: Channel) => named(a).localeCompare(named(b));
  starred.sort(byName);
  for (const list of sectioned.values()) list.sort(byName);
  rooms.sort((a, b) => a.name.localeCompare(b.name));
  dms.sort((a, b) => (s.channelLastSeq[b.id] ?? 0) - (s.channelLastSeq[a.id] ?? 0));
  return { starred, sectioned, rooms, dms };
}

/** Unread and not muted, or naming this account: what Alt+Shift+Up/Down stop at. */
export function rowWaits(s: LayoutState, id: ID): boolean {
  return (isUnread(s, id) && !(s.prefs[id]?.muted ?? false)) || (s.mentionCounts[id] ?? 0) > 0;
}

/**
 * Whether a row shows in its section: a collapsed category still shows where
 * you are and what is waiting, as Discord's do.
 */
export function rowShown(
  s: LayoutState,
  collapsed: Set<string>,
  section: string,
  id: ID,
  activeId: ID | null,
): boolean {
  return !collapsed.has(section) || id === activeId || rowWaits(s, id);
}

/** Every row the sidebar shows, top to bottom: starred, sections, channels, then direct messages. */
export function sidebarRows(s: LayoutState, collapsed: Set<string>, activeId: ID | null): ID[] {
  const groups = sidebarGroups(s, activeId);
  const shown = (section: string) => (ch: Channel) =>
    rowShown(s, collapsed, section, ch.id, activeId);
  return [
    ...groups.starred.filter(shown("starred")),
    ...s.sidebarSections.flatMap((section) =>
      (groups.sectioned.get(section.id) ?? []).filter(shown(`section:${section.id}`)),
    ),
    ...groups.rooms.filter(shown("channels")),
    ...groups.dms.filter(shown("dms")),
  ].map((ch) => ch.id);
}

/**
 * The conversation above or below `active` in the sidebar, as it is drawn.
 * With `unreadOnly`, the nearest with something unread. None past either end.
 */
export function neighbourConversation(
  s: LayoutState,
  collapsed: Set<string>,
  active: ID | null,
  step: -1 | 1,
  unreadOnly: boolean,
): ID | null {
  const ids = sidebarRows(s, collapsed, active);
  const at = active ? ids.indexOf(active) : -1;
  // Nothing open, or the open one not listed: start from the end it walks away from.
  let i = at === -1 ? (step === 1 ? -1 : ids.length) : at;
  for (i += step; i >= 0 && i < ids.length; i += step) {
    if (!unreadOnly || rowWaits(s, ids[i]!)) return ids[i]!;
  }
  return null;
}
