import { useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { PlatformContext } from "../context.js";
import type { Platform } from "../platform.js";
import { perDeviceOrPage } from "./perDevice.js";

const KEY = "unread-on-icon";

/**
 * Whether the app's icon, the tray and a tab's title show what is unread
 * (J16), chosen on this device and on by default.
 */
export interface UnreadOnIcon {
  show: boolean;
  setShow: (show: boolean) => void;
}

function create(platform: Platform | null): StoreApi<UnreadOnIcon> {
  // A choice made before the saved one is read wins over it.
  let chosen = false;
  const store = createStore<UnreadOnIcon>((set) => ({
    show: true,
    setShow: (show) => {
      chosen = true;
      set({ show });
      void platform?.storage.set(KEY, show).catch(() => {
        // Still in effect here; there is nothing more to do about it.
      });
    },
  }));
  void Promise.resolve()
    .then(() => platform?.storage.get<unknown>(KEY))
    .catch(() => null)
    .then((saved) => {
      if (!chosen && typeof saved === "boolean") store.setState({ show: saved });
    });
  return store;
}

export const unreadOnIcon = perDeviceOrPage(create);

export function useUnreadOnIcon(): UnreadOnIcon {
  return useStore(unreadOnIcon(useContext(PlatformContext)));
}
