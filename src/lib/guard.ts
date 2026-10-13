import { useEffect } from "react";

// While files are moving: keep the screen on (a sleeping phone drops the connection)
// and ask before the page is closed.
export function useBusyGuard(busy: boolean) {
  useEffect(() => {
    if (!busy) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onLeave);
    let lock: WakeLockSentinel | null = null, stopped = false;
    const take = async () => {
      try { lock = (await navigator.wakeLock?.request("screen")) ?? null; } catch { /* not allowed here */ }
      if (stopped) void lock?.release();
    };
    // The browser drops the lock whenever the page is hidden; take it again on return.
    const onShow = () => { if (document.visibilityState === "visible" && (!lock || lock.released)) void take(); };
    void take();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      stopped = true;
      window.removeEventListener("beforeunload", onLeave);
      document.removeEventListener("visibilitychange", onShow);
      void lock?.release().catch(() => {});
    };
  }, [busy]);
}
