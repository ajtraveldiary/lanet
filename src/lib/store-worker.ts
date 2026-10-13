// Writes arriving files into the browser's own storage (the origin private file system).
// Runs in a worker because Safari only allows the fast, synchronous file writes there.

// Typed by hand: the app is checked with the DOM types, which clash with the worker ones.
const ctx = self as unknown as { onmessage: (e: MessageEvent) => void; postMessage(m: unknown): void };

type SyncHandle = {
  write(b: BufferSource, o: { at: number }): number;
  flush(): void;
  close(): void;
};

export {};

const open = new Map<string, { h: SyncHandle; at: number }>();

async function folder(key: string, create: boolean) {
  const root = await navigator.storage.getDirectory();
  const incoming = await root.getDirectoryHandle("lanet-incoming", { create: true });
  return { incoming, dir: await incoming.getDirectoryHandle(key, { create }) };
}

ctx.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.op === "open") {
      const { dir } = await folder(m.key, true);
      const fh = await dir.getFileHandle(m.name, { create: true });
      const h = await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
      open.set(m.key, { h, at: 0 });
    } else if (m.op === "write") {
      const f = open.get(m.key)!;
      f.at += f.h.write(new Uint8Array(m.buf), { at: f.at });
    } else if (m.op === "close") {
      const f = open.get(m.key)!;
      f.h.flush();
      f.h.close();
      open.delete(m.key);
    } else if (m.op === "abort") {
      const f = open.get(m.key);
      if (f) { try { f.h.close(); } catch { /* already closed */ } }
      open.delete(m.key);
      const { incoming } = await folder(m.key, true);
      await incoming.removeEntry(m.key, { recursive: true });
    }
    ctx.postMessage({ id: m.id, ok: true });
  } catch (err) {
    const name = (err as DOMException)?.name;
    ctx.postMessage({
      id: m.id,
      ok: false,
      error: name === "QuotaExceededError" ? "This device ran out of space" : `Couldn't save here (${name || "error"})`,
    });
  }
};
