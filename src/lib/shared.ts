// Files, text or a link shared to Lanet from another app (Android, Lanet installed). The service worker
// keeps each share in the browser's own storage (lanet-shared/<id>/files/… and meta.json) until it is sent
// or removed; anything older than a day is cleared. Nothing here leaves the device by itself.
import { useCallback, useEffect, useState } from "react";

export type SharedSet = { id: string; at: number; text: string; files: File[] };

const DAY = 24 * 3600_000;
type Entries = AsyncIterable<[string, FileSystemHandle]>;

async function folder(): Promise<FileSystemDirectoryHandle | null> {
  try { return await (await navigator.storage.getDirectory()).getDirectoryHandle("lanet-shared"); } catch { return null; }
}

export async function loadShared(): Promise<SharedSet[]> {
  const shared = await folder();
  if (!shared) return [];
  const out: SharedSet[] = [];
  for await (const [id, h] of shared as unknown as Entries) {
    if (h.kind !== "directory") continue;
    const set = h as FileSystemDirectoryHandle;
    let meta: { at?: number; text?: string };
    try {
      meta = JSON.parse(await (await (await set.getFileHandle("meta.json")).getFile()).text());
    } catch {
      continue;  // still arriving
    }
    const at = Number(meta.at) || 0;
    if (Date.now() - at > DAY) { await shared.removeEntry(id, { recursive: true }).catch(() => {}); continue; }
    const files: File[] = [];
    try {
      for await (const [, f] of (await set.getDirectoryHandle("files")) as unknown as Entries) {
        if (f.kind === "file") files.push(await (f as FileSystemFileHandle).getFile());
      }
    } catch { /* text only */ }
    files.sort((a, b) => a.name.localeCompare(b.name));
    out.push({ id, at, text: String(meta.text ?? ""), files });
  }
  return out.sort((a, b) => a.at - b.at);
}

export async function removeShared(id: string) {
  await (await folder())?.removeEntry(id, { recursive: true }).catch(() => {});
}

// What's waiting, looked at again whenever this page comes back to the front: the share may have
// opened in another Lanet window, or arrived while this one was in the background.
export function useShared() {
  const [sets, setSets] = useState<SharedSet[]>([]);
  const refresh = useCallback(() => { void loadShared().then(setSets); }, []);
  useEffect(() => {
    refresh();
    // Opened by a share: keep the room's # part, drop the ?shared marker.
    if (location.search.includes("shared=")) history.replaceState(null, "", location.pathname + location.hash);
    const onShow = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [refresh]);
  const remove = useCallback(async (id: string) => { await removeShared(id); refresh(); }, [refresh]);
  return { sets, refresh, remove };
}
