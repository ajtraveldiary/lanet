import { test, expect } from "@playwright/test";
import { accept, batch, batchTitle, checkStored, pair, pickFiles } from "./helpers";

test("files arrive byte for byte; unsafe names are cleaned; nothing is overwritten", async ({ browser }) => {
  const { host, guest } = await pair(browser, "folder");
  await pickFiles(guest, [
    { name: "hello.txt", text: "hello from the guest" },
    { name: "empty.bin", bytes: 0 },
    { name: "pattern.bin", mb: 40 },
    { name: "../../evil<>.txt", text: "x" },
  ]);
  await expect(batch(host, "pattern.bin")).toContainText("wants to send you");
  await accept(host, "pattern.bin");
  await expect.poll(() => batchTitle(host, "pattern.bin")).toBe("Received");
  await expect.poll(() => batchTitle(guest, "pattern.bin")).toBe("Sent");

  expect(await checkStored(host, "pattern.bin", 40)).toEqual({ found: true, size: 40 << 20, bad: 0 });
  expect((await checkStored(host, "empty.bin", 0)).size).toBe(0);
  // "../../evil<>.txt": the climbing-out parts are dropped and the characters Windows refuses replaced.
  expect((await checkStored(host, "evil__.txt", 0)).found).toBe(true);
  expect(await host.evaluate(async () => {
    const names: string[] = [];
    for await (const [n] of (await navigator.storage.getDirectory()) as unknown as AsyncIterable<[string]>) names.push(n);
    return names.filter((n) => n.includes("..") || n.includes("/")).length;
  })).toBe(0);

  // The same name again is saved alongside, never over the first.
  await pickFiles(guest, [{ name: "pattern.bin", mb: 2 }]);
  await accept(host, "pattern.bin");
  await expect.poll(() => checkStored(host, "pattern (2).bin", 2)).toEqual({ found: true, size: 2 << 20, bad: 0 });
});

test("decline and cancel both reach the other side; a cancelled file is removed", async ({ browser }) => {
  const { host, guest } = await pair(browser, "folder");
  await pickFiles(guest, [{ name: "no-thanks.txt", text: "no" }]);
  await batch(host, "no-thanks.txt").getByRole("button", { name: "Decline" }).click();
  await expect.poll(() => batchTitle(guest, "no-thanks.txt")).toMatch(/declined$/);

  await pickFiles(guest, [{ name: "stop-me.bin", mb: 300 }]);
  await accept(host, "stop-me.bin");
  await expect(batch(host, "stop-me.bin")).toContainText("%");
  await batch(host, "stop-me.bin").getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => batchTitle(guest, "stop-me.bin")).toBe("Cancelled");
  expect((await checkStored(host, "stop-me.bin", 0)).found).toBe(false);
});

test("the main device can send too, into browser storage, with Save buttons", async ({ browser }) => {
  const { host, guest } = await pair(browser, undefined, "browser");
  await pickFiles(host, [{ name: "photo.jpg", mb: 3, type: "image/jpeg" }, { name: "notes.pdf", mb: 1, seed: 9 }]);
  await accept(guest, "photo.jpg");
  await expect.poll(() => batchTitle(guest, "photo.jpg")).toBe("Received");
  await expect(batch(guest, "photo.jpg").getByRole("button", { name: "Save", exact: true })).toHaveCount(2);
  await expect(batch(guest, "photo.jpg").getByRole("button", { name: "Save all" })).toBeVisible();
  expect(await checkStored(guest, "notes.pdf", 1, 9)).toEqual({ found: true, size: 1 << 20, bad: 0 });
});

test("a receiver that can only hold 500 MB says so before the sender sends", async ({ browser }) => {
  const { host, guest } = await pair(browser, "memory");
  await pickFiles(guest, [{ name: "too-big.bin", bytes: 600 * 1024 * 1024 }]);
  await expect(guest.getByText(/can take at most 500 MB at a time/)).toBeVisible();
  await guest.getByRole("button", { name: "Send anyway" }).click();
  await accept(host, "too-big.bin");
  await expect(batch(host, "too-big.bin")).toContainText("This page can take at most 500 MB at a time");
});
