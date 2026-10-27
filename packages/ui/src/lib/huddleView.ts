import { useCallback, useEffect, useRef, useState } from "react";
import type { HuddleState } from "@ownbase/client-core";
import type { HuddleRing, ID, User } from "@ownbase/protocol";
import { useWorkspace } from "../context.js";
import { namesList } from "./catchUp.js";

/**
 * Where a huddle shows: the call, taking the conversation's column with the
 * chat beside it or under it, or the chat, with the huddle bar above the
 * composer.
 */
export type HuddleView = "call" | "chat";

/** Anyone sending video, which is when the call has more than faces to show. */
export function huddleHasVideo(huddle: HuddleState | null): boolean {
  if (!huddle) return false;
  return (
    huddle.localCameraStream !== null ||
    huddle.localScreenStream !== null ||
    huddle.peers.some((p) => p.cameraStream !== null || p.screenStream !== null)
  );
}

/**
 * The huddle's view, and the way to change it. The call opens by itself when
 * video starts, and again when someone new starts sharing, since that is what
 * people came to see. When the video stops it goes back to the chat, unless
 * you opened the call yourself. Out of a huddle it is the chat.
 */
export function useHuddleView(): [HuddleView, (view: HuddleView) => void] {
  const inHuddle = useWorkspace((s) => s.huddle !== null);
  const video = useWorkspace((s) => huddleHasVideo(s.huddle));
  const sharer = useWorkspace((s) => s.huddle?.peers.find((p) => p.screenStream)?.userId ?? null);
  const [view, setView] = useState<HuddleView>("chat");
  /** You opened the call, rather than video opening it for you. */
  const chosen = useRef(false);
  const lastVideo = useRef(false);
  const lastSharer = useRef<ID | null>(null);

  useEffect(() => {
    if (inHuddle) return;
    chosen.current = false;
    setView("chat");
  }, [inHuddle]);
  useEffect(() => {
    if (video === lastVideo.current) return;
    lastVideo.current = video;
    if (video) setView("call");
    else if (!chosen.current) setView("chat");
  }, [video]);
  useEffect(() => {
    if (sharer && sharer !== lastSharer.current) setView("call");
    lastSharer.current = sharer;
  }, [sharer]);

  const choose = useCallback((next: HuddleView) => {
    chosen.current = next === "call";
    setView(next);
  }, []);
  return [view, choose];
}

/** Who is in a channel's huddle, by name: you first, as "you", then everyone else. */
/**
 * Who a call's ring still rings (E10), such as "Ringing Maya…", for whoever is
 * in that call; null without one. The workspace keeps a ring only while it
 * rings someone, so there is always someone to name.
 */
export function ringingLine(ring: HuddleRing | undefined, users: Record<ID, User>): string | null {
  if (!ring) return null;
  return `Ringing ${namesList(ring.ringing.map((id) => users[id]?.displayName ?? "someone"))}…`;
}

/**
 * What someone alone in a call reads of its ring (E10): who it is ringing,
 * or then, for the caller, who declined or that nobody answered.
 */
export function aloneLine(
  ring: HuddleRing | undefined,
  notice: { channelId: ID; message: string } | null,
  channelId: ID,
  users: Record<ID, User>,
): string | null {
  return ringingLine(ring, users) ?? (notice?.channelId === channelId ? notice.message : null);
}

/**
 * How many cameras a call holds up with (E13b). Each one costs everyone else
 * a decoder, and its owner an encoder for every one of them, so it is the
 * cameras more than the people that weigh on a call: eight people on camera
 * each used most of a core, and twelve with two cameras on a third of one.
 * See "How many people a call holds" in docs/DEPLOYMENT.md.
 */
export const CAMERAS_HOLD = 8;

/**
 * How many people a call holds up with, however few cameras are on: the most
 * measured, sixteen with two cameras on and two talking. A muted microphone
 * sends nothing, so it is the people talking who cost the others.
 */
export const CALL_HOLDS = 16;

/**
 * What a call this big tells everyone in it, once, as it gets so; null for one
 * that holds up.
 */
export function bigCallLine(people: number, cameras: number): string | null {
  if (cameras > CAMERAS_HOLD)
    return `With more than ${CAMERAS_HOLD} cameras on, the call can stutter. Turning cameras off helps.`;
  if (people > CALL_HOLDS)
    return `Calls of more than ${CALL_HOLDS} people can stutter. Muting when you're not talking helps.`;
  return null;
}

export function huddleNames(
  ids: readonly ID[],
  users: Record<ID, User>,
  selfId: ID | undefined,
): string[] {
  const others = ids.filter((id) => id !== selfId).map((id) => users[id]?.displayName ?? "someone");
  return selfId && ids.includes(selfId) ? ["you", ...others] : others;
}
