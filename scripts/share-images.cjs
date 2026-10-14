// Makes the link-preview image (public/og.jpg, from share-image.html) and the app icons (from
// public/icon.svg): the iPhone home-screen icon, and the 192 / 512 px and "maskable" icons the app
// manifest lists. Run after changing either source: npm run share-images
const fs = require("fs");
const path = require("path");
const { chromium } = require("@playwright/test");

const root = path.join(__dirname, "..");
const svg = fs.readFileSync(path.join(root, "public", "icon.svg"), "utf8");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto("file:///" + path.join(__dirname, "share-image.html").replace(/\\/g, "/"));
  await page.evaluate(() => document.fonts.ready);
  // JPEG keeps it well under the ~300 KB WhatsApp accepts for previews.
  await page.screenshot({ path: path.join(root, "public", "og.jpg"), type: "jpeg", quality: 88 });

  // The plain icon, filling the square.
  for (const [file, size] of [["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]]) {
    const icon = await browser.newPage({ viewport: { width: size, height: size } });
    await icon.setContent(`<body style="margin:0;background:#5b3df5">${svg.replace("<svg ", `<svg width="${size}" height="${size}" style="display:block" `)}</body>`);
    await icon.screenshot({ path: path.join(root, "public", file) });
    await icon.close();
  }

  // Android crops "maskable" icons to a circle or other shape, so the drawing sits in the middle
  // 60% on a violet square that fills the whole image.
  const m = await browser.newPage({ viewport: { width: 512, height: 512 } });
  await m.setContent(
    `<body style="margin:0;width:512px;height:512px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#6a4dff,#4a2fe0)">` +
    // Without the logo's own rounded square, which would show as a faint second square.
    svg.replace(/<rect[^>]*\/>/, "").replace("<svg ", '<svg width="308" height="308" style="display:block" ') + "</body>",
  );
  await m.screenshot({ path: path.join(root, "public", "icon-maskable-512.png") });
  await browser.close();
})();
