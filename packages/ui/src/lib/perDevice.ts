import type { Platform } from "../platform.js";

/**
 * One store for each platform, made when first asked for, so every part of
 * the page on this device shares what was read and saved. A platform is the
 * device's storage: a test that makes a new one starts from nothing.
 */
export function perDevice<T extends object>(
  create: (platform: Platform) => T,
): (platform: Platform) => T {
  const made = new WeakMap<Platform, T>();
  return (platform) => {
    let store = made.get(platform);
    if (!store) made.set(platform, (store = create(platform)));
    return store;
  };
}
