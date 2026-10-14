// The way of saving that Android, Firefox and others use: a file streamed into a normal download.
// The test browser keeps these downloads to itself, so nothing reaches the computer's Downloads folder.
import { test, expect, type Download, type Page } from "@playwright/test";
import { accept, batchTitle, pair, pickFiles, type Spec } from "./helpers";

// The service worker has to be in charge of the page before it can stream a download.
const swReady = (page: Page) => page.waitForFunction(() => !!navigator.serviceWorker.controller);

async function bytesOf(download: Download): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of (await download.createReadStream()) as unknown as AsyncIterable<Uint8Array>) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// Same pattern as pickFiles: every MB starts with its number and is filled with (number + seed) % 251.
function badMegabytes(b: Uint8Array, mb: number, seed: number): number {
  let bad = 0;
  for (let k = 0; k < mb; k++) {
    const o = k << 20, want = (k + seed) % 251;
    const n = (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    if (n !== k || b[o + 6] !== want || b[o + (1 << 20) - 1] !== want) bad++;
  }
  return bad;
}

// Reads a .zip's entries, and checks each against the pattern it was made with.
function zipEntries(b: Uint8Array) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = b.length - 22;
  while (dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: { name: string; data: Uint8Array }[] = [];
  for (let k = 0; k < count; k++) {
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const size = dv.getUint32(p + 20, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
    const data = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    out.push({ name, data: b.subarray(data, data + size) });
    p += 46 + nl + el + cl;
  }
  return out;
}

test("a file streams into a normal download, byte for byte", async ({ browser }) => {
  const { host, guest } = await pair(browser, "download");
  await swReady(host);
  await pickFiles(guest, [{ name: "holiday.mp4", mb: 50, seed: 4 }]);
  const started = host.waitForEvent("download");
  await accept(host, "holiday.mp4");
  const download = await started;
  expect(download.suggestedFilename()).toBe("holiday.mp4");
  const bytes = await bytesOf(download);
  expect(bytes.length).toBe(50 << 20);
  expect(badMegabytes(bytes, 50, 4)).toBe(0);
  await expect.poll(() => batchTitle(host, "holiday.mp4")).toBe("Received");
  await expect(host.getByText("Saved in your downloads.")).toBeVisible();
});

test("a folder arrives as one downloaded .zip with every file whole", async ({ browser }) => {
  const { host, guest } = await pair(browser, "download");
  await swReady(host);
  const files: Spec[] = [
    { name: "a.jpg", path: "Trip/a.jpg", mb: 3, seed: 1 },
    { name: "b.jpg", path: "Trip/day 2/b.jpg", mb: 2, seed: 2 },
    { name: "c.jpg", path: "Trip/day 2/c.jpg", mb: 40, seed: 3 },
  ];
  await pickFiles(guest, files, true);
  const started = host.waitForEvent("download");
  await accept(host, "Trip/a.jpg");
  const download = await started;
  expect(download.suggestedFilename()).toBe("Trip.zip");
  const entries = zipEntries(await bytesOf(download));
  expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.path));
  entries.forEach((e, k) => expect(badMegabytes(e.data, files[k].mb!, files[k].seed!)).toBe(0));
  await expect(host.getByText("Saved to your downloads as “Trip.zip”.")).toBeVisible();
});
