import { useCallback, useEffect, useState } from "react";
import { SCREEN_SHARE_QUALITY, type ScreenShareQuality } from "@ownbase/client-core";
import { usePlatform } from "../context.js";

/** Where the last resolution and frame rate chosen are kept on this device. */
export const QUALITY_KEY = "screen-share-quality";
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

/**
 * The share quality this device last chose, read once, and a way to keep a
 * new one. Read ahead of time, so a browser's share asks for it at the press
 * itself, with nothing waited on between them.
 */
export function useScreenShareQuality(): [ScreenShareQuality, (next: ScreenShareQuality) => void] {
  const platform = usePlatform();
  const [quality, setQuality] = useState(SCREEN_SHARE_QUALITY);
  useEffect(() => {
    let live = true;
    void platform.storage
      .get(QUALITY_KEY)
      .then((saved) => {
        if (live) setQuality(qualityOf(saved));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [platform]);
  const keep = useCallback(
    (next: ScreenShareQuality) => {
      setQuality(next);
      void platform.storage.set(QUALITY_KEY, next).catch(() => {});
    },
    [platform],
  );
  return [quality, keep];
}
