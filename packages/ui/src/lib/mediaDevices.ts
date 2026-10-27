import { useCallback, useEffect, useState, type RefObject } from "react";
import {
  listMediaDevices,
  type MediaDeviceLists,
  type WorkspaceClient,
} from "@ownbase/client-core";
import { microphoneOf, type CallDevices } from "./callPreferences.js";

const NONE: MediaDeviceLists = {
  microphones: [],
  cameras: [],
  speakers: [],
  named: false,
  defaultMicrophone: "",
  defaultSpeaker: "",
};

/**
 * The microphones, cameras and speakers this computer has, listed again as
 * they are plugged in and out. `refresh` lists them again on demand, as once
 * the browser has been allowed a device and starts giving their names.
 */
export function useMediaDevices(): MediaDeviceLists & { listed: boolean; refresh: () => void } {
  const [lists, setLists] = useState<MediaDeviceLists | null>(null);
  const refresh = useCallback(() => {
    listMediaDevices().then(setLists, () => setLists(NONE));
  }, []);
  useEffect(() => {
    let alive = true;
    const list = () => {
      listMediaDevices().then(
        (next) => alive && setLists(next),
        () => alive && setLists(NONE),
      );
    };
    list();
    navigator.mediaDevices?.addEventListener?.("devicechange", list);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", list);
    };
  }, []);
  return { ...(lists ?? NONE), listed: lists !== null, refresh };
}

/**
 * Whether there is more than one microphone or camera to choose between. A
 * browser that keeps devices' names back lists none, and a listing that
 * fails is no choice either.
 */
export async function hasDeviceChoice(): Promise<boolean> {
  const lists = await listMediaDevices().catch(() => NONE);
  return lists.microphones.length > 1 || lists.cameras.length > 1;
}

/** Whether a change to the device choices changes what the microphone opens. */
const MICROPHONE_KEYS: (keyof CallDevices)[] = [
  "microphoneId",
  "echoCancellation",
  "noiseSuppression",
  "noiseFilter",
  "autoGainControl",
];

/**
 * Makes a device choice: in a huddle the call changes over first, and only a
 * device that opened is kept, so a choice that fails rejects (for
 * `captureFailure` to word) and leaves everything as it was.
 */
export async function chooseDevices(
  client: WorkspaceClient,
  current: CallDevices,
  patch: CallDevices,
  save: (patch: CallDevices) => Promise<boolean>,
): Promise<boolean> {
  if (client.state.huddle) {
    const next = { ...current, ...patch };
    if (MICROPHONE_KEYS.some((key) => key in patch))
      await client.setMicrophone(microphoneOf(stripped(next)));
    if ("cameraId" in patch) await client.setCamera(next.cameraId || undefined);
  }
  return save(patch);
}

/** Without keys set to undefined, which `microphoneOf` would pass along. */
function stripped(devices: CallDevices): CallDevices {
  return Object.fromEntries(
    Object.entries(devices).filter(([, value]) => value !== undefined && value !== ""),
  );
}

/** Plays an element through the chosen speaker, where the browser can choose; "" is the default. */
export function useSpeaker(element: RefObject<HTMLMediaElement | null>, speakerId: string): void {
  useEffect(() => {
    const media = element.current as
      (HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    // A speaker unplugged since it was chosen leaves the sound where it was.
    void media?.setSinkId?.(speakerId).catch(() => {});
  }, [element, speakerId]);
}
