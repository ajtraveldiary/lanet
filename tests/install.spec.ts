import { test, expect } from "@playwright/test";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test("Lanet can be installed: a manifest with its icons and the share target", async ({ page, request }) => {
  await page.goto("/");
  expect(await page.locator('link[rel="manifest"]').getAttribute("href")).toBe("/manifest.webmanifest");
  expect(await page.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute("content")).toBe("yes");

  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  const m = await res.json();
  expect(m).toMatchObject({ name: "Lanet", start_url: "/", display: "standalone" });
  expect(m.share_target).toMatchObject({ action: "/share-target", method: "POST", enctype: "multipart/form-data" });
  const purposes = m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes} ${i.purpose}`);
  expect(purposes).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);

  // Every icon is really there, at the size the manifest says.
  for (const icon of m.icons as { src: string; sizes: string }[]) {
    const size = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return `${img.naturalWidth}x${img.naturalHeight}`;
    }, icon.src);
    expect(size).toBe(icon.sizes);
  }
});

test("iPhone: a hint explains Add to Home Screen, and stays closed once closed", async ({ browser }) => {
  const context = await browser.newContext({ userAgent: IPHONE_UA, viewport: { width: 320, height: 700 } });
  const page = await context.newPage();
  await page.goto("/");
  const hint = page.getByRole("note").filter({ hasText: "Add Lanet to your Home Screen" });
  await expect(hint).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await hint.getByRole("button", { name: "Close" }).click();
  await expect(hint).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Start sharing" })).toBeVisible();
  await expect(hint).toHaveCount(0);
});

test("iPhone: no hint inside the installed app, and none on other devices", async ({ browser }) => {
  const installed = await browser.newContext({ userAgent: IPHONE_UA });
  await installed.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
  const app = await installed.newPage();
  await app.goto("/");
  await expect(app.getByRole("button", { name: "Start sharing" })).toBeVisible();
  await expect(app.getByText("Add Lanet to your Home Screen")).toHaveCount(0);

  const desktop = await browser.newPage();
  await desktop.goto("/");
  await expect(desktop.getByRole("button", { name: "Start sharing" })).toBeVisible();
  await expect(desktop.getByText("Add Lanet to your Home Screen")).toHaveCount(0);
});

test("Chrome/Edge: an Install app button appears when the browser offers it, and asks the browser", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Install app" })).toHaveCount(0);
  // What Chrome does when Lanet can be installed.
  await page.evaluate(() => {
    const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> };
    e.prompt = async () => { (window as unknown as { __asked: boolean }).__asked = true; };
    e.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(e);
  });
  // The button fits beside the name even on the narrowest phone.
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.getByRole("button", { name: "Install app" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.getByRole("button", { name: "Install app" }).click();
  expect(await page.evaluate(() => (window as unknown as { __asked?: boolean }).__asked)).toBe(true);
  await expect(page.getByRole("button", { name: "Install app" })).toHaveCount(0);
});
