import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { usePlatform } from "../context.js";
import type { Platform } from "../platform.js";
import { inOneWindow } from "./focusedView.js";
import { perDevice } from "./perDevice.js";

/**
 * The app's own notification sounds (K10), made with Web Audio as the ring
 * is (ringTone.ts), so they need no file and cost the first download
 * nothing: this file loads as the workspace opens. A notification the app
 * sounds itself goes to the system silent, so there are never two sounds.
 */

/** One note: when it starts, its pitch, how long it rings, and its wave. */
interface Note {
  at: number;
  hz: number;
  decay: number;
  wave?: OscillatorType;
}

const TONES = {
  chime: [
    { at: 0, hz: 880, decay: 0.45 },
    { at: 0.12, hz: 1175, decay: 0.6 },
  ],
  pop: [{ at: 0, hz: 1320, decay: 0.12 }],
  knock: [
    { at: 0, hz: 196, decay: 0.16, wave: "triangle" },
    { at: 0.14, hz: 196, decay: 0.16, wave: "triangle" },
  ],
  bell: [
    { at: 0, hz: 1046, decay: 1.1 },
    { at: 0, hz: 2093, decay: 0.5 },
  ],
} satisfies Record<string, Note[]>;

/** The calls' own: a step up as someone comes in, a step down as they go. */
const CALL_TONES = {
  join: [
    { at: 0, hz: 523, decay: 0.22 },
    { at: 0.1, hz: 784, decay: 0.3 },
  ],
  leave: [
    { at: 0, hz: 784, decay: 0.22 },
    { at: 0.1, hz: 523, decay: 0.3 },
  ],
} satisfies Record<string, Note[]>;

export type ToneName = keyof typeof TONES;
export const TONE_NAMES = Object.keys(TONES) as ToneName[];
export type SoundChoice = ToneName | "none";
export const TONE_LABELS: Record<SoundChoice, string> = {
  chime: "Chime",
  pop: "Pop",
  knock: "Knock",
  bell: "Bell",
  none: "None",
};

interface Sounds {
  /** Channel messages and mentions, threads and reminders. */
  messages: SoundChoice;
  directMessages: SoundChoice;
  /** Someone coming into or leaving a call this device is in. */
  calls: boolean;
  loaded: boolean;
  error: string | null;
  set: (change: Partial<Pick<Sounds, "messages" | "directMessages" | "calls">>) => Promise<boolean>;
}

const KEY = "sounds";
const DEFAULTS = { messages: "pop", directMessages: "chime", calls: true } as const;

const choiceOf = (value: unknown, fallback: SoundChoice): SoundChoice =>
  value === "none" || (TONE_NAMES as unknown[]).includes(value) ? (value as SoundChoice) : fallback;

function createSounds(platform: Platform) {
  const store = createStore<Sounds>(() => ({
    ...DEFAULTS,
    loaded: false,
    error: null,
    set: async (change) => {
      const before = store.getState();
      const next = {
        messages: change.messages ?? before.messages,
        directMessages: change.directMessages ?? before.directMessages,
        calls: change.calls ?? before.calls,
      };
      store.setState({ ...next, error: null });
      try {
        await platform.storage.set(KEY, next);
        return true;
      } catch {
        store.setState({
          messages: before.messages,
          directMessages: before.directMessages,
          calls: before.calls,
          error: "Could not save your sounds on this device. Please try again.",
        });
        return false;
      }
    },
  }));
  void platform.storage
    .get<{ messages?: unknown; directMessages?: unknown; calls?: unknown }>(KEY)
    .then((saved) =>
      store.setState({
        messages: choiceOf(saved?.messages, DEFAULTS.messages),
        directMessages: choiceOf(saved?.directMessages, DEFAULTS.directMessages),
        calls: typeof saved?.calls === "boolean" ? saved.calls : DEFAULTS.calls,
        loaded: true,
      }),
    )
    .catch(() => store.setState({ loaded: true }));
  return store;
}

const soundsOf = perDevice(createSounds);

/** Reads this device's choices now, so the first sound after a workspace opens knows them. */
export function readSounds(platform: Platform): void {
  soundsOf(platform);
}

/** This device's sound choices, across workspaces. */
export function useSounds() {
  return useStore(soundsOf(usePlatform()));
}

let context: AudioContext | null = null;

/** Plays a tone once. Silent where there is no Web Audio. */
function play(notes: readonly Note[], volume = 0.18): void {
  const Context = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Context) return;
  try {
    context ??= new Context();
  } catch {
    return;
  }
  const audio = context;
  void audio.resume().catch(() => {});
  const out = audio.createGain();
  out.gain.value = volume;
  out.connect(audio.destination);
  const now = audio.currentTime;
  for (const note of notes) {
    const start = now + note.at;
    const level = audio.createGain();
    level.gain.setValueAtTime(0.0001, start);
    level.gain.exponentialRampToValueAtTime(1, start + 0.008);
    level.gain.exponentialRampToValueAtTime(0.0001, start + note.decay);
    level.connect(out);
    const tone = audio.createOscillator();
    tone.type = note.wave ?? "sine";
    tone.frequency.value = note.hz;
    tone.connect(level);
    tone.start(start);
    tone.stop(start + note.decay + 0.05);
  }
}

/** Settings' Play: the tone as a notification would sound it. */
export function playTone(name: ToneName): void {
  play(TONES[name]);
}

/**
 * A browser plays nothing until the person has used the page once. Until
 * then the system's own sound is the only one there can be.
 */
function mayPlay(): boolean {
  const activation = (navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return activation ? activation.hasBeenActive : true;
}

/** How long one window keeps a notification's sound to itself, so others that heard it stay quiet. */
const SOUND_HELD_MS = 4000;

/**
 * Sounds a notification, in one of this account's windows, and says whether
 * the app sounded it: the system notification is then sent silent. False
 * while the choice is still being read, or before the page may play, so the
 * system's sound plays instead.
 */
export function soundNotification(
  platform: Platform,
  kind: "message" | "direct",
  account: string | null,
  id: string,
): boolean {
  const sounds = soundsOf(platform).getState();
  if (!sounds.loaded || !mayPlay()) return false;
  const choice = kind === "direct" ? sounds.directMessages : sounds.messages;
  if (choice === "none") return true;
  const stop = inOneWindow(account, `sound ${id}`, () => {
    play(TONES[choice]);
    return () => {};
  });
  setTimeout(stop, SOUND_HELD_MS);
  return true;
}

/** Someone came into or left the call this window is in, when calls are to sound. */
export function soundCall(platform: Platform, change: "join" | "leave"): void {
  const sounds = soundsOf(platform).getState();
  if (sounds.loaded && sounds.calls && mayPlay()) play(CALL_TONES[change], 0.12);
}

/** For a test: the next tone starts a new audio context. */
export function forgetAudio(): void {
  context = null;
}
