// Installing Lanet as an app. Chrome and Edge say once, early, that the page can be installed
// ("beforeinstallprompt"); it's caught here, before the page has drawn, so the Install button can use it.
// iPhones and iPads never say so: people add Lanet with Share → Add to Home Screen.
import { useSyncExternalStore } from "react";

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };

let offer: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

// Opened from the Home Screen or as an installed app, not in a browser tab.
export function installed(): boolean {
  return matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

window.addEventListener("beforeinstallprompt", (e) => {
  // The page shows its own Install button instead of the browser's banner.
  e.preventDefault();
  offer = e as InstallPrompt;
  notify();
});
window.addEventListener("appinstalled", () => { offer = null; notify(); });

export async function install() {
  const o = offer;
  if (!o) return;
  await o.prompt();
  await o.userChoice.catch(() => {});
  offer = null;
  notify();
}

export function useCanInstall(): boolean {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => !!offer && !installed(),
  );
}

// The iPhone/iPad hint, once closed, stays closed on this device.
const HINT = "lanet.hint.ios";
export function hintClosed(): boolean {
  try { return localStorage.getItem(HINT) === "closed"; } catch { return false; }
}
export function closeHint() {
  try { localStorage.setItem(HINT, "closed"); } catch { /* shown again next time */ }
}
