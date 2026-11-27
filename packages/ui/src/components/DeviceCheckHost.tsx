import { lazy, Suspense } from "react";
import { useCallPreferences, useDeviceCheckEndsWithScreen } from "../lib/callPreferences.js";
import { useNavigationState } from "../lib/navigation.js";
import { CallOffer } from "./CallOffer.js";

/** Which microphone and camera to use, asked once before a first huddle. */
const DeviceCheckDialog = lazy(() =>
  import("./DeviceCheckDialog.js").then((module) => ({ default: module.DeviceCheckDialog })),
);

/**
 * Shows the device question while a huddle waits on it. Kept with the call
 * preferences, out of the first download: the workspace fetches this as it
 * opens, and when it goes, a join still waiting on the answer joins nothing.
 */
export function DeviceCheckHost() {
  const checking = useCallPreferences().checkingDevices;
  // A link to a call offers it from here (K18), out of the first download too.
  const callOffer = useNavigationState((s) => s.callOffer);
  useDeviceCheckEndsWithScreen();
  return (
    <>
      {callOffer && <CallOffer offer={callOffer} />}
      {checking && (
        <Suspense fallback={null}>
          <DeviceCheckDialog />
        </Suspense>
      )}
    </>
  );
}
