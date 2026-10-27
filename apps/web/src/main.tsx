/// <reference types="vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, webPlatform } from "@ownbase/ui";
import "./index.css";

const root = createRoot(document.getElementById("root")!);

// The primitives gallery, #/gallery, is for development. A build replaces
// import.meta.env.DEV with false and drops this branch, the import with it,
// so the gallery never reaches what the server serves.
if (import.meta.env.DEV && /^#\/?gallery(\/|$)/.test(window.location.hash)) {
  void import("@ownbase/ui/gallery").then(({ Gallery }) =>
    root.render(
      <StrictMode>
        <Gallery />
      </StrictMode>,
    ),
  );
} else {
  // Notification permission is asked from a banner after signing in, not here:
  // asking on the first click anywhere usually meant asking on Sign in.
  root.render(
    <StrictMode>
      <App platform={webPlatform()} />
    </StrictMode>,
  );
}
