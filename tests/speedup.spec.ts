import { test, expect } from "@playwright/test";
import { accept, batchTitle, checkStored, checkZip, dropLanes, pair, pickFiles, usage, waitForPercent, type Spec } from "./helpers";

test("several smaller files move at the same time, and all arrive whole", async ({ browser }) => {
  const { host, guest } = await pair(browser, "folder");
  const files: Spec[] = Array.from({ length: 12 }, (_, k) => ({ name: `photo-${k}.jpg`, mb: 6, seed: k }));
  await pickFiles(guest, files);
  await accept(host, "photo-0.jpg");
  await expect.poll(() => batchTitle(host, "photo-0.jpg"), { timeout: 60_000 }).toBe("Received");
  expect((await usage(guest)).files).toBeGreaterThanOrEqual(2);
  expect((await usage(guest)).files).toBeLessThanOrEqual(4);
  for (let k = 0; k < 12; k++) expect(await checkStored(host, `photo-${k}.jpg`, 6, k)).toEqual({ found: true, size: 6 << 20, bad: 0 });
});

test("a big file is spread over three connections and arrives whole", async ({ browser }) => {
  const { host, guest } = await pair(browser, "browser");
  // The extra connections come up just after the main one.
  await guest.waitForTimeout(1500);
  await pickFiles(guest, [{ name: "big.bin", mb: 120, seed: 3 }]);
  await accept(host, "big.bin");
  await expect.poll(() => batchTitle(host, "big.bin"), { timeout: 60_000 }).toBe("Received");
  expect((await usage(guest)).slots).toBe(3);
  expect(await checkStored(host, "big.bin", 120, 3)).toEqual({ found: true, size: 120 << 20, bad: 0 });
});

test("an extra connection dropping mid-file pauses for a moment and carries on from the same byte", async ({ browser }) => {
  const { host, guest } = await pair(browser, "folder");
  await guest.waitForTimeout(1500);
  await pickFiles(guest, [{ name: "lane-drop.bin", mb: 250, seed: 5 }]);
  await accept(host, "lane-drop.bin");
  await waitForPercent(host, "lane-drop.bin", 30);
  expect(await dropLanes(guest)).toBeGreaterThan(0);
  // No reconnect of the main connection is needed: it carries on by itself.
  await expect.poll(() => batchTitle(host, "lane-drop.bin"), { timeout: 60_000 }).toBe("Received");
  expect(await checkStored(host, "lane-drop.bin", 250, 5)).toEqual({ found: true, size: 250 << 20, bad: 0 });
  await expect(host.getByText("Connected directly").first()).toBeVisible();
});

test("a folder packed into a .zip still arrives one file at a time, in order", async ({ browser }) => {
  const { host, guest } = await pair(browser, "browser");
  const files: Spec[] = Array.from({ length: 6 }, (_, k) => ({ name: `p${k}.jpg`, path: `Album/p${k}.jpg`, mb: 3, seed: k }));
  await pickFiles(guest, files, true);
  await accept(host, "Album/p0.jpg");
  await expect(host.getByText("Packed into “Album.zip”.")).toBeVisible({ timeout: 60_000 });
  expect((await usage(guest)).files).toBe(1);
  const zip = await checkZip(host, "Album.zip");
  expect(zip?.entries.map((e) => e.name)).toEqual(files.map((f) => f.path));
  expect(zip?.entries.every((e) => e.ok)).toBe(true);
});

test("a device running a different version is asked to reload; files can't be sent meanwhile", async ({ browser }) => {
  const { host, guest } = await pair(browser);
  // Pretend the guest is an older page: it tells the main device a different protocol version.
  await guest.evaluate(() => {
    const w = window as unknown as { __chs: Set<RTCDataChannel> };
    const ctl = [...w.__chs].find((c) => c.label === "ctl" && c.readyState === "open");
    ctl?.send(JSON.stringify({ t: "hello", v: 1, ios: false, sink: "folder", open: [], done: [] }));
  });
  await expect(host.getByText(/running a different version of Lanet/)).toBeVisible();
  await expect(host.getByRole("button", { name: "Send files" })).toBeDisabled();
});
