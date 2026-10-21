import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ID } from "@slackoss/protocol";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";

/**
 * How loud one person in a call is to you, as Discord's user volume: heard
 * only by you, and kept on this device for every call after.
 */
export interface PersonVolume {
  /** Percent of how they arrive: 100 as sent, up to 200 for a quiet microphone. */
  volume: number;
  /** Silenced for you alone. Their volume is kept for when they are not. */
  muted: boolean;
}

export const DEFAULT_VOLUME = 100;
export const MAX_VOLUME = 200;
export const AS_SENT: PersonVolume = { volume: DEFAULT_VOLUME, muted: false };

const KEY = "call-volumes";
/** A slider drag is many changes; they are written once it rests. */
export const WRITE_DELAY_MS = 400;

/** One person's choice from what was stored, or null for anything that is as sent. */
function volumeOf(saved: unknown): PersonVolume | null {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
  const { volume, muted } = saved as Record<string, unknown>;
  const level =
    typeof volume === "number" && Number.isFinite(volume)
      ? Math.round(Math.min(MAX_VOLUME, Math.max(0, volume)))
      : DEFAULT_VOLUME;
  if (level === DEFAULT_VOLUME && muted !== true) return null;
  return { volume: level, muted: muted === true };
}

/**
 * Where how loud someone's shared screen is to you is kept, beside their
 * voice and apart from it, so a loud video can be turned down while they
 * are still heard.
 */
export const screenSoundKey = (userId: ID): string => `screen:${userId}`;

/** How many times as loud as they arrive someone is played: 0 to 2. */
export function gainOf(choice: PersonVolume | undefined): number {
  if (!choice) return 1;
  return choice.muted ? 0 : choice.volume / 100;
}

interface Volumes {
  /** Only the people turned up, down or muted; everyone else is as sent. */
  volumes: Record<ID, PersonVolume>;
  set: (userId: ID, patch: Partial<PersonVolume>) => void;
}

const stores = new WeakMap<Platform, StoreApi<Volumes>>();

function createVolumes(platform: Platform): StoreApi<Volumes> {
  /** Changed here before what was saved had been read, so newer than it. */
  const changed = new Set<ID>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const read = Promise.resolve()
    .then(() => platform.storage.get<unknown>(KEY))
    .then((saved) => {
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
      const volumes = { ...store.getState().volumes };
      for (const [id, value] of Object.entries(saved)) {
        const choice = volumeOf(value);
        if (choice && !changed.has(id)) volumes[id] = choice;
      }
      store.setState({ volumes });
    })
    .catch(() => {
      // Unreadable: everyone is as sent, and the next change is written over it.
    });
  // Not before the read, or a change made first would replace everyone else's.
  const write = () => {
    timer = null;
    void read
      .then(() => platform.storage.set(KEY, store.getState().volumes))
      .catch(() => {
        // Still applied for this session; there is nothing more to do about it.
      });
  };
  const store = createStore<Volumes>((setState, get) => ({
    volumes: {},
    set: (userId, patch) => {
      changed.add(userId);
      const volumes = { ...get().volumes };
      const choice = volumeOf({ ...(volumes[userId] ?? AS_SENT), ...patch });
      if (choice) volumes[userId] = choice;
      else delete volumes[userId];
      setState({ volumes });
      if (timer) clearTimeout(timer);
      timer = setTimeout(write, WRITE_DELAY_MS);
    },
  }));
  return store;
}

/** Everyone's volume in calls on this device, read once and shared by the bar and the stage. */
export function useCallVolumes() {
  const platform = usePlatform();
  let store = stores.get(platform);
  if (!store) {
    store = createVolumes(platform);
    stores.set(platform, store);
  }
  return useStore(store);
}
