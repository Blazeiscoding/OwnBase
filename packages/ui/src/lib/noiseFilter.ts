import type { NoiseFilter } from "@ownbase/client-core";

/**
 * Strong noise suppression for calls and the microphone check. The model and
 * its audio code are fetched the first time one wants it, not with the app.
 */
export const noiseFilter: NoiseFilter = async (microphone) =>
  (await import("./gtcrnFilter.js")).filterMicrophone(microphone);
