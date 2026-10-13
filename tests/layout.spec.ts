import { test, expect, type Page } from "@playwright/test";
import { device, join, pickFiles, startRoom } from "./helpers";

const WIDTHS = [320, 360, 768, 1280];

// No sideways page scrolling, nothing poking out, and every visible button big enough for a thumb.
async function fits(page: Page) {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth - window.innerWidth,
    poking: [...document.querySelectorAll("main *")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).length,
    small: [...document.querySelectorAll("button")]
      .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44)
      .map((b) => b.textContent),
  }));
}

for (const width of WIDTHS) {
  test(`every screen fits at ${width} px`, async ({ browser }) => {
    const host = await device(browser);
    const guest = await device(browser);
    await host.setViewportSize({ width, height: 800 });
    await guest.setViewportSize({ width, height: 800 });

    await host.goto("/");
    expect(await fits(host)).toEqual({ scroll: 0, poking: 0, small: [] });

    const room = await startRoom(host);
    await guest.goto(`/#${room.id}`);
    expect(await fits(guest)).toEqual({ scroll: 0, poking: 0, small: [] });

    await join(guest, room);
    await pickFiles(guest, [{ name: "A very long file name that goes on and on without any break whatsoever.bin", mb: 1 }]);
    await expect(host.getByText(/wants to send you/).first()).toBeAttached();
    for (const page of [host, guest]) {
      // On narrow screens, look at each part the tab bar offers.
      const tabs = page.locator("nav[aria-label=Sections] button");
      const n = width < 1024 ? await tabs.count() : 1;
      for (let i = 0; i < n; i++) {
        if (width < 1024) await tabs.nth(i).click();
        expect(await fits(page)).toEqual({ scroll: 0, poking: 0, small: [] });
      }
    }
  });
}

test("dark mode keeps text readable on the main buttons", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto("/");
  const colours = await page.getByRole("button", { name: "Start sharing" }).evaluate((b) => {
    const s = getComputedStyle(b);
    return { fg: s.color, bg: s.backgroundColor };
  });
  expect(colours.fg).not.toBe(colours.bg);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(255, 255, 255)");
});
