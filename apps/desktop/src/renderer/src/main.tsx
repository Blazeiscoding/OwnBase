import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, setReaderLocale, webPlatform } from "@ownbase/ui";
import { electronPlatform, followPlace } from "./platform.js";
import "./index.css";

const bridge = window.ownbase;
// Dates and times follow the system's regional format, not Chromium's language.
if (bridge?.capabilities.readerLocale) setReaderLocale(bridge.capabilities.readerLocale);
const platform = bridge ? electronPlatform(bridge) : webPlatform();

// After a crash, the page comes back where it was before the app reads it.
void (bridge ? followPlace(bridge) : Promise.resolve()).then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App platform={platform} />
    </StrictMode>,
  ),
);
