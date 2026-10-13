// Makes the link-preview image (public/og.jpg, from share-image.html) and the home-screen icon
// (public/apple-touch-icon.png, from public/icon.svg). Run after changing either: npm run share-images
const fs = require("fs");
const path = require("path");
const { chromium } = require("@playwright/test");

const root = path.join(__dirname, "..");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto("file:///" + path.join(__dirname, "share-image.html").replace(/\\/g, "/"));
  await page.evaluate(() => document.fonts.ready);
  // JPEG keeps it well under the ~300 KB WhatsApp accepts for previews.
  await page.screenshot({ path: path.join(root, "public", "og.jpg"), type: "jpeg", quality: 88 });

  const icon = await browser.newPage({ viewport: { width: 180, height: 180 } });
  const svg = fs.readFileSync(path.join(root, "public", "icon.svg"), "utf8")
    .replace("<svg ", '<svg width="180" height="180" style="display:block" ');
  await icon.setContent(`<body style="margin:0;background:#5b3df5">${svg}</body>`);
  await icon.screenshot({ path: path.join(root, "public", "apple-touch-icon.png") });
  await browser.close();
})();
