import { contextBridge, ipcRenderer } from "electron";
import {
  CHANNELS,
  EVENTS,
  MICROPHONE_PORT,
  readCapabilities,
  type OwnBaseBridge,
} from "../shared/bridge.js";

const calls = new Set<string>(CHANNELS);
const events = new Set<string>(EVENTS);

const bridge: OwnBaseBridge = {
  invoke: (channel, ...args) =>
    calls.has(channel)
      ? ipcRenderer.invoke(channel, ...args)
      : Promise.resolve({ ok: false, error: { code: "refused", message: "No such call." } }),
  on: (event, listener) => {
    if (!events.has(event)) return () => {};
    const heard = (_event: unknown, payload: never) => listener(payload);
    ipcRenderer.on(event, heard);
    return () => ipcRenderer.removeListener(event, heard);
  },
  capabilities: readCapabilities(process.argv),
};

// A port cannot cross the context bridge, so this passes each microphone's
// on to the page as a message to its own window, which nothing else hears.
ipcRenderer.on("microphone:port", (event, data: { session?: unknown } | undefined) => {
  const port = event.ports[0];
  if (!port || typeof data?.session !== "number") return;
  window.postMessage({ type: MICROPHONE_PORT, session: data.session }, "*", [port]);
});

contextBridge.exposeInMainWorld("ownbase", bridge);
