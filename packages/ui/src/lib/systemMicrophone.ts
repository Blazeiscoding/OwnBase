/// <reference path="../assets.d.ts" />
import type { OpenSystemMicrophone, SystemMicrophone } from "@ownbase/client-core";
import type { OpenedSystemMicrophone, Platform, SystemMicrophoneDevice } from "../platform.js";
import { running } from "./audioRunning.js";
// Never inlined: a data URL is not a script the page's policy lets it load.
import workletUrl from "./systemMicrophone.worklet.js?url&no-inline";

/**
 * Chromium names a USB microphone as Windows does, then its vendor and
 * product ids: "Microphone (KREO KAST) (0a67:d1b5)".
 */
const USB_IDS = /\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i;

/**
 * Which of the system's microphones the browser's device is: the one with its
 * name, as long as only one has it. Two of one model cannot be told apart by
 * name, so neither is taken, and nor is a device whose name the browser keeps
 * back.
 */
export function matchMicrophone(
  label: string,
  microphones: SystemMicrophoneDevice[],
): SystemMicrophoneDevice | null {
  const name = label.replace(USB_IDS, "").trim();
  if (!name) return null;
  const same = microphones.filter((microphone) => microphone.name === name);
  return same.length === 1 ? same[0]! : null;
}

/** The browser's name for one of its microphones; rejects as getUserMedia would for one it does not list. */
async function labelOf(deviceId: string): Promise<string> {
  const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  const device = devices.find((d) => d.kind === "audioinput" && d.deviceId === deviceId);
  if (!device) throw new DOMException("That microphone is not connected.", "NotFoundError");
  return device.label;
}

/**
 * Opens microphones the way other apps on this computer do, where the
 * platform can (`Platform.systemMicrophone`), for calls and the microphone
 * check. Undefined elsewhere.
 */
export function systemMicrophoneOpener(
  platform: Pick<Platform, "systemMicrophone"> | null,
): OpenSystemMicrophone | undefined {
  const system = platform?.systemMicrophone;
  if (!system) return undefined;
  return async (deviceId) => {
    const label = deviceId ? await labelOf(deviceId) : null;
    const { defaultId, microphones } = await system.list();
    const id = label === null ? defaultId : (matchMicrophone(label, microphones)?.id ?? null);
    if (!id) return null;
    return play(await system.open(id));
  };
}

/** Its sound as a track a call can send: the port's samples played into a stream. */
async function play(opened: OpenedSystemMicrophone): Promise<SystemMicrophone> {
  const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctx || typeof AudioWorkletNode === "undefined") {
    opened.close();
    throw new Error("this browser cannot play it");
  }
  // At the microphone's own rate, so nothing is converted until the call's encoder.
  const context = new Ctx({ sampleRate: opened.sampleRate, latencyHint: "interactive" });
  try {
    await context.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(context, "ownbase-system-microphone", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const output = context.createMediaStreamDestination();
    output.channelCount = 1;
    node.connect(output);
    // The samples go to the worklet's own thread, not through this page's.
    node.port.postMessage({ port: opened.port }, [opened.port]);
    await running(context);
    let stopped = false;
    const microphone: SystemMicrophone = {
      stream: output.stream,
      label: opened.name,
      onEnded: null,
      stop() {
        if (stopped) return;
        stopped = true;
        node.port.onmessage = null;
        node.disconnect();
        output.stream.getTracks().forEach((track) => track.stop());
        opened.close();
        void context.close().catch(() => {});
      },
    };
    node.port.onmessage = (event: MessageEvent<{ ended?: string }>) => {
      if (event.data?.ended && !stopped) microphone.onEnded?.();
    };
    return microphone;
  } catch (err) {
    opened.close();
    void context.close().catch(() => {});
    throw err;
  }
}
