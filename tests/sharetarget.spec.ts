// "Share to Lanet" from another app. Android sends the shared files to /share-target as a form;
// these tests send the same form, then use the "Waiting to send" card.
import { test, expect, type Page } from "@playwright/test";
import { accept, batch, batchTitle, checkStored, device, join, pair, startRoom, type Spec } from "./helpers";

async function shareToLanet(page: Page, files: Spec[], text?: { title?: string; text?: string; url?: string }) {
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.evaluate(async ({ files, text }) => {
    const form = new FormData();
    for (const s of files) {
      const parts: BlobPart[] = [];
      for (let k = 0; k < (s.mb ?? 1); k++) {
        const b = new Uint8Array(1 << 20);
        b.fill((k + (s.seed ?? 0)) % 251);
        new DataView(b.buffer).setUint32(0, k);
        parts.push(b);
      }
      form.append("files", new File(parts, s.name, { type: s.type ?? "" }));
    }
    for (const [k, v] of Object.entries(text ?? {})) form.append(k, v as string);
    const res = await fetch("/share-target", { method: "POST", body: form });
    if (!res.ok || !res.url.includes("shared=1")) throw new Error("share not taken in");
    window.dispatchEvent(new Event("focus"));  // as when Lanet comes back to the front
  }, { files, text });
}

const card = (page: Page) => page.getByRole("region", { name: "Shared to Lanet" });

const sharedLeft = (page: Page) => page.evaluate(async () => {
  try {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("lanet-shared");
    let n = 0;
    for await (const _ of d as unknown as AsyncIterable<unknown>) n++;
    return n;
  } catch { return 0; }
});

test("files and a link shared from another app are sent to the main device, then cleared", async ({ browser }) => {
  const { host, guest } = await pair(browser, "folder");
  await shareToLanet(guest, [{ name: "IMG_1001.jpg", mb: 4, seed: 1, type: "image/jpeg" }, { name: "clip.mp4", mb: 40, seed: 2 }], {
    title: "A link", text: "https://example.com/trip", url: "https://example.com/trip",
  });
  await expect(card(guest)).toContainText("IMG_1001.jpg");
  await expect(card(guest)).toContainText("https://example.com/trip");
  await card(guest).getByRole("button", { name: /^Send to / }).click();

  // The link goes as a message, once; the files as an offer.
  await expect(host.getByRole("link", { name: "https://example.com/trip" })).toHaveCount(1);
  await accept(host, "clip.mp4");
  await expect.poll(() => batchTitle(host, "clip.mp4"), { timeout: 60_000 }).toBe("Received");
  expect(await checkStored(host, "IMG_1001.jpg", 4, 1)).toEqual({ found: true, size: 4 << 20, bad: 0 });
  expect(await checkStored(host, "clip.mp4", 40, 2)).toEqual({ found: true, size: 40 << 20, bad: 0 });
  // Arrived, so no longer kept on the phone.
  await expect(card(guest)).toHaveCount(0);
  await expect.poll(() => sharedLeft(guest)).toBe(0);
});

test("the main device picks which device to send to; declined files wait again", async ({ browser }) => {
  const host = await device(browser);
  const room = await startRoom(host);
  const first = await device(browser, "folder"), second = await device(browser, "folder");
  await join(first, room);
  await join(second, room);
  await expect(host.getByText("Devices (2)")).toBeVisible();

  await shareToLanet(host, [{ name: "plan.pdf", mb: 2, seed: 3 }]);
  const choices = card(host).getByRole("group", { name: "Send to" }).getByRole("button");
  await expect(choices).toHaveCount(2);
  const names = await choices.allInnerTexts();
  await card(host).getByRole("button", { name: names[1], exact: true }).click();
  await card(host).getByRole("button", { name: `Send to ${names[1]}` }).click();

  await batch(second, "plan.pdf").getByRole("button", { name: "Decline" }).click();
  await expect(card(host)).toContainText("Not sent");
  await expect(card(host).getByRole("button", { name: /^Send to / })).toBeEnabled();
  await card(host).getByRole("button", { name: "Remove" }).click();
  await expect(card(host)).toHaveCount(0);
  expect(await sharedLeft(host)).toBe(0);
});

test("shared before joining a room: it waits, then can be sent once connected", async ({ browser }) => {
  const host = await device(browser, "folder");
  const guest = await device(browser);
  await guest.goto("/");
  await guest.setViewportSize({ width: 320, height: 700 });
  await shareToLanet(guest, [{ name: "a very long name for a shared file that goes on and on without a break.bin", mb: 1, seed: 7 }]);
  await expect(card(guest)).toContainText("Start sharing");
  // Fits the narrowest phone: no sideways scrolling, every button big enough to tap.
  expect(await guest.evaluate(() => ({
    scroll: document.documentElement.scrollWidth - innerWidth,
    small: [...document.querySelectorAll("button")].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).length,
  }))).toEqual({ scroll: 0, small: 0 });

  const room = await startRoom(host);
  await join(guest, room);
  await card(guest).getByRole("button", { name: /^Send to / }).click();
  await accept(host, "a very long name");
  await expect.poll(() => checkStored(host, "a very long name for a shared file that goes on and on without a break.bin", 1, 7)).toEqual({ found: true, size: 1 << 20, bad: 0 });
});

test("anything shared more than a day ago is cleared", async ({ page }) => {
  await page.goto("/");
  await shareToLanet(page, [{ name: "old.bin", mb: 1 }]);
  await expect(card(page)).toContainText("old.bin");
  // Make the share look two days old.
  await page.evaluate(async () => {
    const shared = await (await navigator.storage.getDirectory()).getDirectoryHandle("lanet-shared");
    for await (const [, set] of shared as unknown as AsyncIterable<[string, FileSystemDirectoryHandle]>) {
      const w = await (await set.getFileHandle("meta.json")).createWritable();
      await w.write(JSON.stringify({ at: Date.now() - 2 * 24 * 3600_000, text: "" }));
      await w.close();
    }
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Start sharing" })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  expect(await sharedLeft(page)).toBe(0);
});
