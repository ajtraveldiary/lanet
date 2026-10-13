// A tiny key–value store in IndexedDB, for things localStorage can't hold (a folder handle).
// Any failure (private windows, blocked storage) just means nothing is remembered.

function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const req = indexedDB.open("lanet", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    const d = await db();
    return await new Promise((ok) => {
      const req = d.transaction("kv").objectStore("kv").get(key);
      req.onsuccess = () => ok(req.result as T);
      req.onerror = () => ok(undefined);
    });
  } catch {
    return undefined;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((ok) => {
      const tx = d.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => ok();
      tx.onerror = () => ok();
    });
  } catch { /* not remembered */ }
}
