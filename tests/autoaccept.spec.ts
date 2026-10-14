import { test, expect, type Page } from "@playwright/test";
import { batch, batchTitle, checkStored, pair, pickFiles } from "./helpers";

const switchFor = (page: Page) => page.getByRole("switch", { name: /Accept files from .* automatically/ });

// An offer straight onto the control channel, as a sending device would make it (no file data needed).
async function offerOnly(page: Page, id: string, files: { path: string; size: number }[]) {
  await page.evaluate(({ id, files }) => {
    const w = window as unknown as { __chs: Set<RTCDataChannel> };
    const ctl = [...w.__chs].find((c) => c.label === "ctl" && c.readyState === "open")!;
    ctl.send(JSON.stringify({ t: "offer", id, files: files.map((f) => ({ ...f, type: "", modified: 0 })) }));
  }, { id, files });
}

test("off by default; switched on, files arrive without Accept and are marked", async ({ browser }) => {
  const { host, guest } = await pair(browser, "folder");
  await expect(switchFor(host)).toHaveAttribute("aria-checked", "false");

  await switchFor(host).click();
  await expect(switchFor(host)).toHaveAttribute("aria-checked", "true");
  await pickFiles(guest, [{ name: "a.jpg", mb: 3, seed: 1 }, { name: "b.jpg", mb: 2, seed: 2 }]);
  // No Accept tap anywhere.
  await expect.poll(() => batchTitle(host, "a.jpg"), { timeout: 30_000 }).toBe("Received");
  await expect(batch(host, "a.jpg")).toContainText("Accepted automatically");
  expect(await checkStored(host, "a.jpg", 3, 1)).toEqual({ found: true, size: 3 << 20, bad: 0 });
  expect(await checkStored(host, "b.jpg", 2, 2)).toEqual({ found: true, size: 2 << 20, bad: 0 });
});

test("still asks for a batch over 1 GB, a program or installer, or a folder with one inside", async ({ browser }) => {
  const { host, guest } = await pair(browser, "folder");
  await switchFor(host).click();

  await offerOnly(guest, "hugebatch", [{ path: "film.mkv", size: 2 * 1024 ** 3 }]);
  await expect(batch(host, "film.mkv")).toContainText("Over 1 GB");
  await expect(batch(host, "film.mkv").getByRole("button", { name: "Accept" })).toBeVisible();

  await pickFiles(guest, [{ name: "setup.exe", mb: 1 }]);
  await expect(batch(host, "setup.exe")).toContainText("program, installer or script");
  await expect(batch(host, "setup.exe").getByRole("button", { name: "Accept" })).toBeVisible();

  await pickFiles(guest, [
    { name: "photo.jpg", path: "Mixed/photo.jpg", mb: 1 },
    { name: "app.apk", path: "Mixed/tools/app.apk", mb: 1 },
  ], true);
  await expect(batch(host, "Mixed/photo.jpg")).toContainText("program, installer or script");
  await expect(batch(host, "Mixed/photo.jpg").getByRole("button", { name: "Accept" })).toBeVisible();
});

test("switched off, Accept is needed again; a reload turns it off", async ({ browser }) => {
  // The joining device receiving from the main device this time.
  const { host, guest } = await pair(browser, undefined, "browser");
  await switchFor(guest).click();
  await switchFor(guest).click();
  await expect(switchFor(guest)).toHaveAttribute("aria-checked", "false");
  await pickFiles(host, [{ name: "after-off.txt", text: "hi" }]);
  await expect(batch(guest, "after-off.txt").getByRole("button", { name: "Accept" })).toBeVisible();

  await switchFor(guest).click();
  await guest.reload();
  await expect(guest.getByText("Connected directly").first()).toBeVisible();
  await expect(switchFor(guest)).toHaveAttribute("aria-checked", "false");
});

test("the switch fits the narrowest phone", async ({ browser }) => {
  const { host } = await pair(browser);
  await host.setViewportSize({ width: 320, height: 700 });
  await host.getByRole("button", { name: /^Files/ }).click();
  await expect(switchFor(host)).toBeVisible();
  const box = await switchFor(host).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(await host.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});
