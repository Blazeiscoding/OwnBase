import { z } from "zod";
import type { AppScope, ChannelType } from "./entities.js";
import type { WorkspaceEvent } from "./events.js";

const HISTORY: Record<ChannelType, AppScope> = {
  public: "channels:history",
  private: "groups:history",
  dm: "im:history",
  group_dm: "mpim:history",
};
const history = (kind: ChannelType): AppScope => HISTORY[kind];
const rooms = (kind: ChannelType): AppScope =>
  kind === "public" ? "channels:read" : "groups:read";

/**
 * The native events an app can subscribe to, each sent in its Slack shape,
 * with the scope an app needs to be sent one from a conversation of each
 * kind, as Slack names them (E18c). A workspace-wide event reads as public.
 */
export const APP_EVENTS = {
  "message.created": history,
  "message.updated": history,
  "message.deleted": history,
  "reaction.added": () => "reactions:read",
  "reaction.removed": () => "reactions:read",
  "pin.added": () => "pins:read",
  "pin.removed": () => "pins:read",
  "channel.created": rooms,
  "channel.updated": rooms,
  "member.joined": rooms,
  "member.left": rooms,
  "user.joined": () => "users:read",
  "user.updated": () => "users:read",
} as const satisfies Partial<Record<WorkspaceEvent["type"], (kind: ChannelType) => AppScope>>;

export type AppEventType = keyof typeof APP_EVENTS;

export const APP_EVENT_TYPES = Object.keys(APP_EVENTS) as AppEventType[];

export const appEventType = z.enum(APP_EVENT_TYPES as [AppEventType, ...AppEventType[]]);

export function isAppEventType(type: string): type is AppEventType {
  return Object.hasOwn(APP_EVENTS, type);
}

/** The scope an app needs to be sent this event from a conversation of this kind, or from none. */
export function eventScope(type: AppEventType, channelType: ChannelType | null): AppScope {
  return APP_EVENTS[type](channelType ?? "public");
}

/** Every scope an event of this type can need, wherever it happens. */
export function eventScopes(type: AppEventType): AppScope[] {
  const kinds: ChannelType[] = ["public", "private", "dm", "group_dm"];
  return [...new Set(kinds.map((kind) => eventScope(type, kind)))];
}
