import { test, expect } from "@playwright/test";
import { accept, batchTitle, checkStored, device, join, pickFiles, sendText, startRoom } from "./helpers";

test("the app is served with the security headers", async ({ request }) => {
  const res = await request.get("/");
  const h = res.headers();
  expect(h["content-security-policy"]).toContain("default-src 'self'");
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("no-referrer");
});

test("nothing the app does is blocked by its own security rules", async ({ browser }) => {
  const host = await device(browser, "folder");
  const guest = await device(browser, "browser");
  const blocked: string[] = [];
  for (const page of [host, guest]) {
    page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) blocked.push(m.text()); });
  }
  const room = await startRoom(host);
  await join(guest, room);
  await sendText(guest, "hello");
  await expect(host.getByText("hello")).toBeVisible();
  await pickFiles(guest, [{ name: "checked.bin", mb: 3 }]);
  await accept(host, "checked.bin");
  await expect.poll(() => batchTitle(host, "checked.bin")).toBe("Received");
  expect(await checkStored(host, "checked.bin", 3)).toEqual({ found: true, size: 3 << 20, bad: 0 });
  // The other way too, into browser storage (uses the worker that writes files).
  await pickFiles(host, [{ name: "back.bin", mb: 2 }]);
  await accept(guest, "back.bin");
  await expect.poll(() => batchTitle(guest, "back.bin")).toBe("Received");
  expect(blocked).toEqual([]);
});
