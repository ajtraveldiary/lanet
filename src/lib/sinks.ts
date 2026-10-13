// Where a received file goes. Picked by what this browser can do, best first:
//   folder   Chrome and Edge on a computer write straight into a folder the person picks (remembered).
//   download Others stream it into a normal download through the service worker (public/sw.js).
//   browser  iPhone and iPad keep it in the browser's own storage first, then the person taps Save.
//   memory   Last resort (plain-http pages, very old browsers): held in memory, so kept small.
import { kvGet, kvSet } from "./kv";
import { isIOS, isSafari, numbered } from "./files";
import { randomKey } from "./peer";

export type SinkKind = "folder" | "download" | "browser" | "memory";
export type Saved =
  | { kind: "folder"; name: string }
  | { kind: "download"; name: string }
  | { kind: "file"; file: File }
  | { kind: "zipped" };  // went into the batch's .zip

export interface FileWriter {
  write(b: ArrayBuffer): Promise<void>;
  close(): Promise<Saved>;
  abort(): Promise<void>;
}
// One per accepted batch. Only the folder kind takes paths with folders in them ("Photos/a.jpg");
// the others get plain names, and a sent folder reaches them as one .zip (zip.ts).
export interface Sink {
  kind: SinkKind;
  where: string;
  open(path: string, size: number, type: string): Promise<FileWriter>;
}

export const MEMORY_LIMIT = 500 * 1024 ** 2;
const FOLDER_KEY = "folder";

export function sinkKind(): SinkKind {
  // Test-only switch, so every kind can be tried in one browser.
  const forced = safeLocal("lanet.sink");
  if (forced === "folder" || forced === "download" || forced === "browser" || forced === "memory") return forced;
  if (window.showDirectoryPicker && !isIOS()) return "folder";
  if (!isIOS() && !isSafari() && navigator.serviceWorker?.controller) return "download";
  if (window.isSecureContext && "storage" in navigator && "getDirectory" in navigator.storage) return "browser";
  return "memory";
}

function safeLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

// Free room in the browser's own storage, for the sender's warning and the receiver's check.
export async function browserRoom(): Promise<number | undefined> {
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    return Math.max(0, quota - usage);
  } catch {
    return undefined;
  }
}

export async function savedFolderName(): Promise<string | null> {
  return (await kvGet<FileSystemDirectoryHandle>(FOLDER_KEY))?.name ?? null;
}

// Must run straight from a click: the folder picker and the permission prompt need one.
export async function chooseFolder(): Promise<FileSystemDirectoryHandle> {
  if (safeLocal("lanet.sink") === "folder") return navigator.storage.getDirectory();
  const dir = await window.showDirectoryPicker!({ id: "lanet", mode: "readwrite", startIn: "downloads" });
  await kvSet(FOLDER_KEY, dir);
  return dir;
}

async function folder(): Promise<FileSystemDirectoryHandle> {
  const dir = await kvGet<FileSystemDirectoryHandle>(FOLDER_KEY);
  if (dir?.queryPermission) {
    const now = await dir.queryPermission({ mode: "readwrite" });
    if (now === "granted") return dir;
    if (now === "prompt" && (await dir.requestPermission?.({ mode: "readwrite" })) === "granted") return dir;
  }
  return chooseFolder();
}

// Throws an AbortError when the person closes the folder picker; the offer then stays open.
export async function openSink(kind: SinkKind, total: number): Promise<Sink> {
  if (kind === "folder") {
    const dir = await folder();
    await clearUnfinished();
    const tops = new Map<string, string>();
    return { kind, where: dir.name ? `the “${dir.name}” folder` : "the folder you picked", open: (path) => folderWriter(dir, path, tops) };
  }
  if (kind === "download") return { kind, where: "your downloads", open: (name, size) => downloadWriter(name, size) };
  if (kind === "browser") {
    const room = await browserRoom();
    if (room !== undefined && total > room) {
      throw new Error(`Not enough space on this device: these files need ${Math.ceil(total / 1024 ** 2)} MB more than the browser can keep.`);
    }
    navigator.storage.persist?.().catch(() => {});
    return { kind, where: "this browser until you save them", open: (name) => browserWriter(name) };
  }
  if (total > MEMORY_LIMIT) throw new Error("This page can take at most 500 MB at a time. Open Lanet over https to receive bigger files.");
  return { kind, where: "this page until you save them", open: (name, _size, type) => memoryWriter(name, type) };
}

// `tops` remembers, for one batch, what each sent top-level folder is called here.
async function folderWriter(root: FileSystemDirectoryHandle, path: string, tops: Map<string, string>): Promise<FileWriter> {
  const parts = path.split("/");
  const wanted = parts.pop()!;
  let dir = root;
  if (parts.length) {
    // A sent folder never merges into one already here: "Photos" becomes "Photos (2)" as a whole.
    let top = tops.get(parts[0]);
    if (!top) {
      top = parts[0];
      for (let n = 2; await taken(root, top); n++) top = `${parts[0]} (${n})`;
      tops.set(parts[0], top);
    }
    dir = await root.getDirectoryHandle(top, { create: true });
    for (const p of parts.slice(1)) dir = await dir.getDirectoryHandle(p, { create: true });
  }
  let name = wanted;
  // Never overwrite: "photo.jpg" becomes "photo (2).jpg" when the folder already has one.
  for (let n = 2; await taken(dir, name); n++) name = numbered(wanted, n);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  const shown = [...(parts.length ? [tops.get(parts[0])!, ...parts.slice(1)] : []), name].join("/");
  const mark = unfinished(dir, name);
  return {
    write: (b) => w.write(b),
    close: async () => { await w.close(); await mark.done(); return { kind: "folder", name: shown }; },
    // The browser writes to a hidden temporary file until close, so only the empty name needs removing.
    abort: async () => { await w.abort().catch(() => {}); await dir.removeEntry(name).catch(() => {}); await mark.done(); },
  };
}

// While a file is being written into the person's folder, the folder only holds an empty file of
// that name (the data waits in a hidden temporary file). If the page is closed mid-file, the browser
// drops the data but leaves the empty name; these are remembered and removed the next time files
// are accepted, if they are still empty.
type Unfinished = { id: string; dir: FileSystemDirectoryHandle; name: string };
const UNFINISHED = "unfinished";
const writingNow = new Set<string>();
let listLock: Promise<unknown> = Promise.resolve();

function editList(fn: (list: Unfinished[]) => Unfinished[]) {
  const next = listLock.then(async () => kvSet(UNFINISHED, fn((await kvGet<Unfinished[]>(UNFINISHED)) ?? [])));
  listLock = next.catch(() => {});
  return next;
}

function unfinished(dir: FileSystemDirectoryHandle, name: string) {
  const id = randomKey();
  writingNow.add(id);
  const added = editList((list) => [...list, { id, dir, name }]);
  return {
    async done() {
      writingNow.delete(id);
      await added.catch(() => {});
      await editList((list) => list.filter((u) => u.id !== id)).catch(() => {});
    },
  };
}

async function clearUnfinished() {
  await listLock;
  const list = (await kvGet<Unfinished[]>(UNFINISHED)) ?? [];
  const handled: string[] = [];
  for (const u of list) {
    if (writingNow.has(u.id)) continue;  // still being written by this page
    try {
      // Without permission for that folder now, try again another time.
      if ((await u.dir.queryPermission?.({ mode: "readwrite" })) !== "granted") continue;
      const f = await (await u.dir.getFileHandle(u.name)).getFile();
      if (f.size === 0) await u.dir.removeEntry(u.name);
    } catch { /* already gone */ }
    handled.push(u.id);
  }
  if (handled.length) await editList((now) => now.filter((u) => !handled.includes(u.id))).catch(() => {});
}

// A file or a folder of that name is already there.
async function taken(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try { await dir.getFileHandle(name); return true; } catch (e) {
    if ((e as DOMException)?.name === "TypeMismatchError") return true;
  }
  try { await dir.getDirectoryHandle(name); return true; } catch { return false; }
}

function downloadWriter(name: string, size: number): Promise<FileWriter> {
  const sw = navigator.serviceWorker?.controller;
  if (!sw) return Promise.reject(new Error("Downloads aren't ready on this page. Reload and try again."));
  const { port1, port2 } = new MessageChannel();
  const id = randomKey();
  let credits = 0, cancelled = false;
  let wake: (() => void) | null = null;
  let ready: () => void;
  const isReady = new Promise<void>((r) => { ready = r; });
  port1.onmessage = (e) => {
    if (e.data === "ready") ready();
    else if (e.data === "pull") credits++;
    else if (e.data === "cancelled") cancelled = true;
    wake?.();
  };
  sw.postMessage({ type: "download", id, name, size }, [port2]);
  // While a transfer is paused no data flows; a nudge now and then keeps the browser from
  // stopping the idle service worker and with it the download.
  const keepAlive = setInterval(() => sw.postMessage({ type: "ping" }), 10_000);
  let frame: HTMLIFrameElement | null = null;
  const done = () => { clearInterval(keepAlive); setTimeout(() => frame?.remove(), 60_000); };
  return isReady.then(() => {
    // Loading the address in a hidden frame starts the download without leaving the page.
    frame = document.createElement("iframe");
    frame.hidden = true;
    frame.src = `/__download/${id}`;
    document.body.appendChild(frame);
    return {
      async write(b) {
        while (!credits && !cancelled) await new Promise<void>((r) => { wake = r; });
        if (cancelled) throw new Error("The download was stopped on this device");
        credits--;
        port1.postMessage(b, [b]);
      },
      async close() { port1.postMessage("end"); done(); return { kind: "download", name }; },
      async abort() { port1.postMessage("abort"); done(); },
    };
  });
}

let worker: Worker | null = null;
const replies = new Map<string, { ok: () => void; fail: (e: Error) => void }>();

function store(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<void> {
  if (!worker) {
    worker = new Worker(new URL("./store-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const r = replies.get(e.data.id);
      replies.delete(e.data.id);
      if (e.data.ok) r?.ok(); else r?.fail(new Error(e.data.error));
    };
  }
  const id = randomKey();
  return new Promise((ok, fail) => {
    replies.set(id, { ok, fail });
    worker!.postMessage({ ...msg, id }, transfer);
  });
}

async function browserWriter(name: string): Promise<FileWriter> {
  const key = randomKey();
  await store({ op: "open", key, name });
  return {
    write: (b) => store({ op: "write", key, buf: b }, [b]),
    async close() {
      await store({ op: "close", key });
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle("lanet-incoming")).getDirectoryHandle(key);
      return { kind: "file", file: await (await dir.getFileHandle(name)).getFile() };
    },
    abort: () => store({ op: "abort", key }).catch(() => {}),
  };
}

async function memoryWriter(name: string, type: string): Promise<FileWriter> {
  let parts: ArrayBuffer[] = [];
  return {
    async write(b) { parts.push(b); },
    async close() { const file = new File(parts, name, { type }); parts = []; return { kind: "file", file }; },
    async abort() { parts = []; },
  };
}

// Files kept in browser storage from earlier visits; once a few hours old they have been saved or forgotten.
export async function clearOldStored(maxAgeMs = 6 * 3600_000) {
  try {
    const root = await navigator.storage.getDirectory();
    const incoming = await root.getDirectoryHandle("lanet-incoming");
    const now = Date.now();
    for await (const [key, entry] of (incoming as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
      if (entry.kind !== "directory") continue;
      let newest = 0;
      for await (const [, f] of (entry as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
        if (f.kind === "file") newest = Math.max(newest, (await (f as FileSystemFileHandle).getFile()).lastModified);
      }
      if (now - newest > maxAgeMs) await incoming.removeEntry(key, { recursive: true });
    }
  } catch { /* nothing stored, or no browser storage here */ }
}

export function saveFile(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFiles(files: File[]): boolean {
  try { return !!navigator.canShare?.({ files }); } catch { return false; }
}
