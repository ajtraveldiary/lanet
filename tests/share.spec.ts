import { test, expect } from "@playwright/test";

// The preview that chat and social apps show when the Lanet link is shared.
test("the link preview has a title, a one-line description and a 1200 × 630 image", async ({ page, request }) => {
  await page.goto("/");
  const meta = (key: string) => page.locator(`meta[property="${key}"], meta[name="${key}"]`).first().getAttribute("content");

  expect(await meta("og:title")).toBe("Lanet: share files on your Wi-Fi");
  const description = (await meta("og:description"))!;
  expect(description.length).toBeLessThanOrEqual(160);
  expect(await meta("description")).toBe(description);
  expect(await meta("twitter:card")).toBe("summary_large_image");

  // Apps need a full https address for the image, and WhatsApp skips images over about 300 KB.
  const image = (await meta("og:image"))!;
  expect(image).toMatch(/^https:\/\/.+\/og\.jpg$/);
  const res = await request.get("/og.jpg");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/jpeg");
  expect((await res.body()).length).toBeLessThan(300 * 1024);
  expect(res.headers()["cross-origin-resource-policy"]).toBe("cross-origin");

  const size = await page.evaluate(async () => {
    const img = new Image();
    img.src = "/og.jpg";
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  });
  expect(size).toEqual([1200, 630]);

  expect((await request.get("/apple-touch-icon.png")).status()).toBe(200);
  // Everything else stays for Lanet's own pages only.
  expect((await request.get("/")).headers()["cross-origin-resource-policy"]).toBe("same-origin");
});
