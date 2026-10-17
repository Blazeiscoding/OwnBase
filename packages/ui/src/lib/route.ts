import type { ID } from "@slackoss/protocol";
import { isAccountSection, type AccountSection } from "./accountSections.js";

/** Side panels that are places of their own, as the address names them. */
export const ROUTE_VIEWS = ["pins", "saved", "threads", "scheduled", "activity", "dms"] as const;
export type RouteView = (typeof ROUTE_VIEWS)[number];

function isView(value: unknown): value is RouteView {
  return (ROUTE_VIEWS as readonly unknown[]).includes(value);
}

/**
 * Dialogs that are places too: settings and lists someone may want to come
 * back to. Forms, pickers and search are passing moments and stay out.
 */
export const ROUTE_DIALOGS = [
  "account",
  "workspace",
  "people",
  "apps",
  "invite",
  "shortcuts",
  "details",
] as const;
export type RouteDialogName = (typeof ROUTE_DIALOGS)[number];

/** A dialog open over the conversation, and for Account settings, its section. */
export interface RouteDialog {
  name: RouteDialogName;
  section?: AccountSection;
}

function isDialogName(value: unknown): value is RouteDialogName {
  return (ROUTE_DIALOGS as readonly unknown[]).includes(value);
}

/** A dialog from untrusted data: an address, or a history entry's state. */
function readDialog(name: unknown, section: unknown): RouteDialog | null {
  if (!isDialogName(name)) return null;
  if (section === undefined || section === null) return { name };
  return name === "account" && isAccountSection(section) ? { name, section } : null;
}

/**
 * Where someone is in a workspace: a conversation, and the thread or side
 * panel open beside it. Only one is open at a time, so a route with a thread
 * has no view.
 */
export interface WorkspaceRoute {
  channelId: ID;
  threadRootId: ID | null;
  view?: RouteView | null;
  dialog?: RouteDialog | null;
  /**
   * The phone's navigation drawer is open over it. Kept in the history entry
   * only, never in the address: it is a step to go Back through, not a place
   * to link to.
   */
  drawer?: boolean;
}

/** Channel and message ids never contain anything else. */
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

/** The key this app's part of a history entry's state sits under. */
const KEY = "tandem";

interface RouteState {
  server: string;
  channelId: ID;
  threadRootId: ID | null;
  view?: RouteView | null;
  dialog?: RouteDialog | null;
  drawer?: boolean;
  /** Where the conversation was being read, if not at the newest message. */
  scroll?: ReadingPosition | null;
}

/**
 * The message at the top of the timeline, and how far below the top of the
 * view it sat. Kept in a history entry, so Back, Forward and a reload return
 * to where someone was reading.
 */
export interface ReadingPosition {
  messageId: ID;
  offset: number;
}

/**
 * Reads "#/c/<channel>", then optionally "/t/<thread root>" or
 * "/p/<side panel>", then optionally "/d/<dialog>", with Account settings'
 * section after it, as in "#/c/<channel>/d/account/security". A link to one
 * message, "#/c/<channel>/m/<message>", is not a place to stay: it is handed
 * over once and taken out of the address, so it is not read here.
 */
export function parseRouteHash(hash: string): WorkspaceRoute | null {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] !== "c" || !TOKEN.test(parts[1] ?? "")) return null;
  const route: WorkspaceRoute = { channelId: parts[1]!, threadRootId: null };
  let at = 2;
  if (parts[at] === "t" && TOKEN.test(parts[at + 1] ?? "")) {
    route.threadRootId = parts[at + 1]!;
    at += 2;
  } else if (parts[at] === "p" && isView(parts[at + 1])) {
    route.view = parts[at + 1] as RouteView;
    at += 2;
  }
  if (parts[at] === "d") {
    const section = parts.length === at + 3 ? parts[at + 2] : undefined;
    const dialog = readDialog(parts[at + 1], section);
    if (!dialog) return null;
    route.dialog = dialog;
    at += section === undefined ? 2 : 3;
  }
  return at === parts.length ? route : null;
}

export function routeHash(route: WorkspaceRoute): string {
  const e = encodeURIComponent;
  const place = route.threadRootId
    ? `#/c/${e(route.channelId)}/t/${e(route.threadRootId)}`
    : route.view
      ? `#/c/${e(route.channelId)}/p/${route.view}`
      : `#/c/${e(route.channelId)}`;
  const dialog = route.dialog;
  if (!dialog) return place;
  return `${place}/d/${dialog.name}${dialog.section ? `/${dialog.section}` : ""}`;
}

function stateOf(state: unknown): RouteState | null {
  const value = (state as Record<string, unknown> | null)?.[KEY] as RouteState | undefined;
  if (!value || typeof value.server !== "string" || typeof value.channelId !== "string")
    return null;
  return value;
}

/** Whether this page is the web client the workspace itself serves. */
function servesPage(serverUrl: string, origin: string): boolean {
  try {
    return new URL(serverUrl).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The route this page's history entry, or failing that its address, gives
 * for this workspace. An entry remembers which workspace it belongs to, so a
 * desktop app with several never opens one workspace at another's channel.
 * An address with no entry state behind it, typed or shared into a browser,
 * can only mean the workspace serving the page.
 */
export function currentRoute(
  serverUrl: string,
  location: Pick<Location, "hash" | "origin"> = window.location,
  historyState: unknown = window.history.state,
): WorkspaceRoute | null {
  const remembered = stateOf(historyState);
  if (remembered) {
    if (remembered.server !== serverUrl) return null;
    const threadRootId = remembered.threadRootId ?? null;
    const route: WorkspaceRoute = { channelId: remembered.channelId, threadRootId };
    if (!threadRootId && isView(remembered.view)) route.view = remembered.view;
    const dialog = readDialog(remembered.dialog?.name, remembered.dialog?.section);
    if (dialog) route.dialog = dialog;
    if (remembered.drawer === true) route.drawer = true;
    return route;
  }
  return servesPage(serverUrl, location.origin) ? parseRouteHash(location.hash) : null;
}

export function sameRoute(a: WorkspaceRoute | null, b: WorkspaceRoute | null): boolean {
  return (
    a?.channelId === b?.channelId &&
    (a?.threadRootId ?? null) === (b?.threadRootId ?? null) &&
    (a?.view ?? null) === (b?.view ?? null) &&
    (a?.dialog?.name ?? null) === (b?.dialog?.name ?? null) &&
    (a?.dialog?.section ?? null) === (b?.dialog?.section ?? null) &&
    (a?.drawer ?? false) === (b?.drawer ?? false)
  );
}

/**
 * Records where someone went. Moving from one place in this workspace to
 * another adds a history entry, so Back returns to it. An entry that is not
 * yet this workspace's, such as the page as it loaded or a link just taken
 * out of the address, is replaced instead, and so is one the app moved away
 * from on its own ("replace"), so Back does not lead somewhere unavailable.
 * Says whether it added a step, rewrote the entry, or had nothing to do.
 */
export function writeRoute(
  serverUrl: string,
  route: WorkspaceRoute,
  mode: "auto" | "replace" = "auto",
): "push" | "replace" | "unchanged" {
  const entry = stateOf(window.history.state);
  const own = entry?.server === serverUrl;
  const here = own && sameRoute(entry, route);
  if (here && window.location.hash === routeHash(route)) return "unchanged";
  const state = { [KEY]: { server: serverUrl, ...route } satisfies RouteState };
  const url = window.location.pathname + window.location.search + routeHash(route);
  // Somewhere new in this workspace is a step to go Back through. Anything
  // else, such as the same place after a link was taken out of the address,
  // rewrites the entry it is on.
  if (own && !here && mode === "auto") {
    window.history.pushState(state, "", url);
    return "push";
  }
  window.history.replaceState(state, "", url);
  return "replace";
}

/**
 * Notes where this entry's conversation is being read, or null at the
 * newest message, without adding a step or changing the address. It writes
 * only to an entry of this workspace showing that conversation, so a late
 * note never lands on the entry for somewhere else.
 */
export function rememberReadingPosition(
  serverUrl: string,
  channelId: ID,
  position: ReadingPosition | null,
): void {
  const entry = stateOf(window.history.state);
  if (entry?.server !== serverUrl || entry.channelId !== channelId) return;
  const current = entry.scroll ?? null;
  if (
    current?.messageId === position?.messageId &&
    Math.round(current?.offset ?? 0) === Math.round(position?.offset ?? 0)
  )
    return;
  const state = {
    ...(window.history.state as Record<string, unknown>),
    [KEY]: { ...entry, scroll: position },
  };
  window.history.replaceState(state, "", window.location.href);
}

/** Where this entry's conversation was being read, if it says. */
export function rememberedReadingPosition(
  serverUrl: string,
  channelId: ID,
): ReadingPosition | null {
  const entry = stateOf(window.history.state);
  if (entry?.server !== serverUrl || entry.channelId !== channelId) return null;
  const scroll = entry.scroll as Partial<ReadingPosition> | null | undefined;
  return scroll &&
    typeof scroll.messageId === "string" &&
    TOKEN.test(scroll.messageId) &&
    typeof scroll.offset === "number" &&
    Number.isFinite(scroll.offset)
    ? { messageId: scroll.messageId, offset: scroll.offset }
    : null;
}
