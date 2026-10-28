/// <reference path="../assets.d.ts" />
import { GtcrnWorkletNode } from "@sapphi-red/web-noise-suppressor";
import workletUrl from "@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url";
import modelUrl from "@sapphi-red/web-noise-suppressor/gtcrn.wasm?inline";
import type { FilteredMicrophone } from "@ownbase/client-core";
import { AUDIO_START_MS, running } from "./audioRunning.js";

/**
 * GTCRN, a small speech-enhancement network (48k parameters), run on the
 * microphone in an AudioWorklet: it takes out typing, clatter and steady
 * hum alike, where the browser's own suppression only takes out the steady
 * kind. It costs about 0.5 ms of each 16 ms of sound and adds about 30 ms of
 * delay.
 */

/** How long the microphone may be heard with nothing coming out before the filter counts as broken. */
const SILENT_OUTPUT_MS = 1500;
const POLL_MS = 50;

/**
 * The model, from the data URL it is bundled as: read without a fetch, so it
 * loads the same in the browser and from the desktop app's files, and
 * compiled here first, so a page that may not run WebAssembly says so now
 * rather than leaving the worklet silent.
 */
let model: Promise<ArrayBuffer> | null = null;
function modelBytes(): Promise<ArrayBuffer> {
  model ??= (async () => {
    const binary = atob(modelUrl.slice(modelUrl.indexOf(",") + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await WebAssembly.compile(bytes);
    return bytes.buffer;
  })();
  // A failure is not kept: the next call tries again.
  model.catch(() => (model = null));
  return model;
}

/** Whether any sample in the analyser's latest window is not silence. */
function heard(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): boolean {
  analyser.getFloatTimeDomainData(samples);
  return samples.some((sample) => sample !== 0);
}

/**
 * Resolves once the filter puts out sound. The worklet loads its model on
 * its own and says nothing if that fails, only writing silence, so this
 * listens: sound in with only silence out for a while means it is broken.
 * A microphone that is itself silent (some virtual ones are, between words)
 * proves nothing either way, and is given until the timeout.
 */
function started(input: AnalyserNode, output: AnalyserNode): Promise<void> {
  const samplesIn = new Float32Array(new ArrayBuffer(input.fftSize * 4));
  const samplesOut = new Float32Array(new ArrayBuffer(output.fftSize * 4));
  return new Promise((resolve, reject) => {
    const began = Date.now();
    let heardFor = 0;
    const timer = setInterval(() => {
      if (heard(output, samplesOut)) {
        clearInterval(timer);
        resolve();
      } else if (heard(input, samplesIn) && (heardFor += POLL_MS) >= SILENT_OUTPUT_MS) {
        clearInterval(timer);
        reject(new Error("the filter heard the microphone but gave out only silence"));
      } else if (Date.now() - began >= AUDIO_START_MS) {
        clearInterval(timer);
        // Nothing came in to judge by; the filter is most likely fine.
        resolve();
      }
    }, POLL_MS);
  });
}

/** The microphone with its background noise taken out, as a call sends it. */
export async function filterMicrophone(microphone: MediaStream): Promise<FilteredMicrophone> {
  const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctx || typeof AudioWorkletNode === "undefined")
    throw new Error("this browser cannot run the filter");
  const wasmBinary = await modelBytes();
  // The model works on 48 kHz sound; the browser converts the microphone's.
  const context = new Ctx({ sampleRate: 48_000, latencyHint: "interactive" });
  try {
    await context.audioWorklet.addModule(workletUrl);
    const source = context.createMediaStreamSource(microphone);
    const node = new GtcrnWorkletNode(context, { maxChannels: 1, wasmBinary });
    const output = context.createMediaStreamDestination();
    output.channelCount = 1;
    const listenIn = context.createAnalyser();
    const listenOut = context.createAnalyser();
    source.connect(listenIn);
    source.connect(node).connect(output);
    node.connect(listenOut);
    await running(context);
    await started(listenIn, listenOut);
    listenIn.disconnect();
    listenOut.disconnect();
    return {
      stream: output.stream,
      stop() {
        source.disconnect();
        node.disconnect();
        node.destroy();
        output.stream.getTracks().forEach((track) => track.stop());
        void context.close().catch(() => {});
      },
    };
  } catch (err) {
    void context.close().catch(() => {});
    throw err;
  }
}
