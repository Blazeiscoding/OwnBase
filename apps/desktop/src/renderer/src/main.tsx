import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, setReaderLocale, webPlatform } from "@ownbase/ui";
import { electronPlatform, followPlace } from "./platform.js";
import "./index.css";

// window.ownbase is absent when this page is opened in a plain browser.
// Dates and times follow the system's regional format, not Chromium's language.
if (window.ownbase?.readerLocale) setReaderLocale(window.ownbase.readerLocale);
const platform = window.ownbase ? electronPlatform() : webPlatform();

// After a crash, the page comes back where it was before the app reads it.
void (window.ownbase ? followPlace(window.ownbase) : Promise.resolve()).then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App platform={platform} />
    </StrictMode>,
  ),
);
