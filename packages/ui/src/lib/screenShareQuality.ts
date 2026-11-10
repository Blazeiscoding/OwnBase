import { SCREEN_SHARE_QUALITY, type ScreenShareQuality } from "@ownbase/client-core";

export const RESOLUTIONS = [720, 1080] as const;
export const FRAME_RATES = [15, 30, 60] as const;

/** A saved quality, each part that is not one on offer replaced by the default. */
export function qualityOf(saved: unknown): ScreenShareQuality {
  const value = (saved ?? {}) as Record<string, unknown>;
  return {
    height: RESOLUTIONS.find((height) => height === value.height) ?? SCREEN_SHARE_QUALITY.height,
    frameRate:
      FRAME_RATES.find((rate) => rate === value.frameRate) ?? SCREEN_SHARE_QUALITY.frameRate,
  };
}
