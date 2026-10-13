import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { clearOldStored } from "./lib/sinks";
import "./styles.css";

// The service worker only streams received files into downloads (public/sw.js); it caches nothing.
// Browsers allow it on https pages and on localhost only.
if (window.isSecureContext && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
void clearOldStored();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
