import { useEffect } from "react";
import { createStore } from "zustand/vanilla";
import { matchesCallKey, releasesCallKey } from "@ownbase/client-core/callKeys";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import { useCallPreferences } from "../lib/callPreferences.js";

/**
 * The call keys another app held when the desktop app last tried them, as
 * written, so Voice & video settings can say which will not work from other
 * apps. A key changed since is not in it. Always empty in a browser.
 */
export const takenCallKeys = createStore<{ taken: string[] }>(() => ({ taken: [] }));

/**
 * The call keys (K16), mounted for the whole of a call: mute, deafen and push
 * to talk while this window is in front, and, in the desktop app, from any
 * other app too. Push to talk chosen mid-call takes effect at once.
 */
export function CallKeys() {
  const client = useClient();
  const platform = usePlatform();
  const { keys, talk } = useCallPreferences();
  const inCall = useWorkspace((s) => s.huddle !== null);
  const pushToTalk = talk.mode === "push";

  useEffect(() => {
    if (inCall) client.setPushToTalk(pushToTalk ? { releaseMs: talk.releaseMs } : null);
  }, [client, inCall, pushToTalk, talk.releaseMs]);

  useEffect(() => {
    if (!inCall) return;
    let holding = false;
    const release = () => {
      if (!holding) return;
      holding = false;
      client.releaseTalk();
    };
    // In the capture phase, so they work in a dialog and in the message box too.
    const down = (event: KeyboardEvent) => {
      if (matchesCallKey(keys.mute, event)) {
        event.preventDefault();
        if (!event.repeat) client.toggleMic();
      } else if (matchesCallKey(keys.deafen, event)) {
        event.preventDefault();
        if (!event.repeat) client.toggleDeafen();
      } else if (pushToTalk && matchesCallKey(keys.talk, event)) {
        event.preventDefault();
        if (holding) return;
        holding = true;
        client.pressTalk();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (holding && releasesCallKey(keys.talk, event)) release();
    };
    // The key coming up goes to whichever window is in front by then.
    window.addEventListener("blur", release);
    document.addEventListener("keydown", down, true);
    document.addEventListener("keyup", up, true);
    return () => {
      release();
      window.removeEventListener("blur", release);
      document.removeEventListener("keydown", down, true);
      document.removeEventListener("keyup", up, true);
    };
  }, [client, inCall, pushToTalk, keys.mute, keys.deafen, keys.talk]);

  const held = platform.callKeys;
  useEffect(() => {
    if (!held || !inCall) return;
    const chosen = { mute: keys.mute, deafen: keys.deafen, talk: pushToTalk ? keys.talk : null };
    const named = (actions: string[]) =>
      actions.flatMap((action) => chosen[action as keyof typeof chosen] ?? []);
    let live = true;
    void held.set(chosen).then(
      (taken) => live && takenCallKeys.setState({ taken: named(taken) }),
      () => {},
    );
    const offTaken = held.onTaken((taken) => takenCallKeys.setState({ taken: named(taken) }));
    const offPress = held.onPress((action) => {
      if (action === "mute") client.toggleMic();
      else if (action === "deafen") client.toggleDeafen();
      // Nothing says when a key held for another app comes up.
      else client.toggleTalk();
    });
    return () => {
      live = false;
      offTaken();
      offPress();
      void held.set(null).catch(() => {});
    };
  }, [held, client, inCall, pushToTalk, keys.mute, keys.deafen, keys.talk]);

  return null;
}
