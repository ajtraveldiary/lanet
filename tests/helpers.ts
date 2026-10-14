// Shared steps for the tests: two browser windows (a main device and a joining device) driven
// through the real screens. Test files are made inside the page, so no files are needed on disk.
import { expect, type Browser, type Page } from "@playwright/test";

export type Sink = "folder" | "browser" | "memory" | "download";

// A browser window of its own (separate storage), optionally with a way of saving forced.
// "folder" saves into the browser's own storage as a stand-in for a folder the person picked.
export async function device(browser: Browser, sink?: Sink): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript((s) => {
    if (s) localStorage.setItem("lanet.sink", s);
    // Remember every data channel the page sends on, so a test can cut them like a dropped Wi-Fi.
    const w = window as unknown as {
      __chs: Set<RTCDataChannel>; __drop: () => number; __dropLanes: () => number;
      __maxFiles: number; __maxSlots: number;
    };
    w.__chs = new Set();
    // The most files moving at once, and the most connections one file was spread over (sending side).
    w.__maxFiles = 0;
    w.__maxSlots = 0;
    const send = RTCDataChannel.prototype.send as (this: RTCDataChannel, data: unknown) => void;
    (RTCDataChannel.prototype as unknown as { send: (this: RTCDataChannel, data: unknown) => void }).send = function (data) {
      w.__chs.add(this);
      const label = this.label.split(":");
      if (label[0] === "f" && typeof data !== "string") {
        const moving = new Set([...w.__chs].filter((c) => c.readyState === "open" && c.label.startsWith("f:")).map((c) => c.label.split(":").slice(1, 3).join(":")));
        w.__maxFiles = Math.max(w.__maxFiles, moving.size);
        w.__maxSlots = Math.max(w.__maxSlots, Number(label[5]) || 1);
      }
      send.call(this, data);
    };
    w.__drop = () => {
      let n = 0;
      for (const c of w.__chs) if (c.readyState === "open") { c.close(); n++; }
      w.__chs.clear();
      return n;
    };
    // Cuts only the file channels on the extra connections (slots 1 and 2), as if one of those dropped.
    w.__dropLanes = () => {
      let n = 0;
      for (const c of w.__chs) {
        const slot = Number(c.label.split(":")[4]);
        if (c.readyState === "open" && c.label.startsWith("f:") && slot >= 1) { c.close(); n++; }
      }
      return n;
    };
  }, sink ?? null);
  return context.newPage();
}

export async function startRoom(page: Page): Promise<{ id: string; pin: string }> {
  await page.goto("/");
  await page.getByRole("button", { name: "Start sharing" }).click();
  await expect(page.getByText("Room open")).toBeVisible();
  return page.evaluate(() => JSON.parse(sessionStorage.getItem("lanet.host")!));
}

export async function typePin(page: Page, pin: string) {
  await page.locator("#pin").fill(pin);
  await page.getByRole("button", { name: "Join", exact: true }).click();
}

export async function join(page: Page, room: { id: string; pin: string }) {
  await page.goto(`/#${room.id}`);
  await typePin(page, room.pin);
  await expect(page.getByText("Connected directly").first()).toBeVisible();
}

// The main device and one joined device, connected directly.
export async function pair(browser: Browser, hostSink?: Sink, guestSink?: Sink) {
  const host = await device(browser, hostSink);
  const guest = await device(browser, guestSink);
  const room = await startRoom(host);
  await join(guest, room);
  await expect(host.getByText("Connected directly").first()).toBeVisible();
  return { host, guest, room };
}

export type Spec = { name: string; mb?: number; bytes?: number; text?: string; seed?: number; path?: string; type?: string };

// Picks files the way the file or folder picker would. Big files carry a checkable pattern:
// every MB starts with its number and is filled with (number + seed) % 251.
export async function pickFiles(page: Page, specs: Spec[], folder = false) {
  await page.evaluate(({ specs, folder }) => {
    const dt = new DataTransfer();
    for (const s of specs) {
      let parts: BlobPart[];
      if (s.text !== undefined) parts = [s.text];
      else if (s.bytes !== undefined) parts = [new Uint8Array(s.bytes)];
      else {
        parts = [];
        for (let k = 0; k < (s.mb ?? 1); k++) {
          const b = new Uint8Array(1 << 20);
          b.fill((k + (s.seed ?? 0)) % 251);
          new DataView(b.buffer).setUint32(0, k);
          parts.push(b);
        }
      }
      const f = new File(parts, s.name, { type: s.type ?? "", lastModified: 1_700_000_000_000 });
      if (s.path) Object.defineProperty(f, "webkitRelativePath", { value: s.path });
      dt.items.add(f);
    }
    const inputs = document.querySelectorAll<HTMLInputElement>("input[type=file]");
    const input = inputs[folder ? 1 : 0];
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { specs, folder });
}

// The card of one batch in the Files panel, found by a file name in it.
export const batch = (page: Page, name: string) =>
  page.locator("li").filter({ hasText: name }).filter({ has: page.locator("button, dl, p") }).first();

export async function accept(page: Page, name: string) {
  await batch(page, name).getByRole("button", { name: "Accept" }).click();
}

export async function batchTitle(page: Page, name: string) {
  return (await batch(page, name).innerText()).split("\n").find((l) => l.trim()) ?? "";
}

// Finds a received file in the browser's own storage (where "browser" keeps files and "folder" stands in
// for the picked folder) and checks its pattern. `path` may include folders.
export async function checkStored(page: Page, path: string, mb: number, seed = 0) {
  return page.evaluate(async ({ path, mb, seed }) => {
    const root = await navigator.storage.getDirectory();
    const find = async (dir: FileSystemDirectoryHandle, parts: string[]): Promise<File | null> => {
      try {
        let d = dir;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
        return await (await d.getFileHandle(parts[parts.length - 1])).getFile();
      } catch { return null; }
    };
    let file = await find(root, path.split("/"));
    if (!file) {
      // Kept in the browser: lanet-incoming/<key>/<name>
      try {
        const inc = await root.getDirectoryHandle("lanet-incoming");
        for await (const [, d] of inc as unknown as AsyncIterable<[string, FileSystemDirectoryHandle]>) {
          file = (await find(d, [path.split("/").pop()!])) ?? file;
        }
      } catch { /* none */ }
    }
    if (!file) return { found: false, size: 0, bad: -1 };
    let bad = 0;
    for (let k = 0; k < mb; k++) {
      const head = new Uint8Array(await file.slice(k << 20, (k << 20) + 8).arrayBuffer());
      const tail = new Uint8Array(await file.slice(((k + 1) << 20) - 2, (k + 1) << 20).arrayBuffer());
      const want = (k + seed) % 251;
      if (head.length < 8 || new DataView(head.buffer).getUint32(0) !== k || head[6] !== want || tail[1] !== want) bad++;
    }
    return { found: true, size: file.size, bad };
  }, { path, mb, seed });
}

// Reads a received .zip from browser storage and checks every entry's checksum.
export async function checkZip(page: Page, name: string) {
  return page.evaluate(async (name) => {
    const inc = await (await navigator.storage.getDirectory()).getDirectoryHandle("lanet-incoming");
    let file: File | null = null;
    for await (const [, d] of inc as unknown as AsyncIterable<[string, FileSystemDirectoryHandle]>) {
      try { file = await (await d.getFileHandle(name)).getFile(); } catch { /* not here */ }
    }
    if (!file) return null;
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer);
    const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    let eocd = buf.length - 22;
    while (dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries: { name: string; size: number; ok: boolean }[] = [];
    for (let k = 0; k < count; k++) {
      const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      const size = dv.getUint32(p + 20, true), off = dv.getUint32(p + 42, true), want = dv.getUint32(p + 16, true);
      const entry = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl));
      const data = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      entries.push({ name: entry, size, ok: crc(buf.subarray(data, data + size)) === want });
      p += 46 + nl + el + cl;
    }
    return { size: file.size, entries };
  }, name);
}

export async function sendText(page: Page, text: string) {
  await page.locator("#draft").fill(text);
  await page.getByRole("button", { name: "Send text" }).click();
}

// Cuts the direct connection from this page, as a dropped Wi-Fi would.
export const dropConnection = (page: Page) => page.evaluate(() => (window as unknown as { __drop: () => number }).__drop());

// Cuts only the extra connections' file channels from this page.
export const dropLanes = (page: Page) => page.evaluate(() => (window as unknown as { __dropLanes: () => number }).__dropLanes());

// On the sending page: the most files that moved at once, and the most connections one file used.
export const usage = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __maxFiles: number; __maxSlots: number };
    return { files: w.__maxFiles, slots: w.__maxSlots };
  });

// Waits until a transfer shows at least this much done.
export async function waitForPercent(page: Page, name: string, pct: number) {
  await expect.poll(async () => Number((await batch(page, name).innerText()).match(/(\d+)%/)?.[1] ?? 0), { timeout: 30_000 }).toBeGreaterThanOrEqual(pct);
}
