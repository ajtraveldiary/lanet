import { test, expect } from "@playwright/test";
import { pair, sendText } from "./helpers";

test("text and links go both ways; links are clickable, HTML stays text", async ({ browser }) => {
  const { host, guest } = await pair(browser);

  await sendText(guest, "Here it is: https://example.com/page?a=1. Done.");
  const link = host.getByRole("link", { name: "https://example.com/page?a=1" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");

  await sendText(guest, '<img src=x onerror="window.__hacked=1"><b>not bold</b>');
  await expect(host.getByText('<img src=x onerror="window.__hacked=1"><b>not bold</b>')).toBeVisible();
  expect(await host.evaluate(() => (window as unknown as { __hacked?: number }).__hacked)).toBeUndefined();
  expect(await host.locator("ol img, ol b").count()).toBe(0);

  await sendText(host, "reply from the main device");
  await expect(guest.getByText("reply from the main device")).toBeVisible();
  await expect(host.getByText("Delivered").last()).toBeVisible();
});

test("a 60,000-character text arrives whole (sent in parts)", async ({ browser }) => {
  const { host, guest } = await pair(browser);
  const long = "ക".repeat(30_000) + "END" + "x".repeat(30_000);
  await sendText(guest, long);
  await expect.poll(() => host.evaluate(() => Math.max(0, ...[...document.querySelectorAll("ol li div[id^=msg-]")].map((d) => d.textContent!.length)))).toBe(60_003);
});
