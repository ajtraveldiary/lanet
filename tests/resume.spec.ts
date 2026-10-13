import { test, expect } from "@playwright/test";
import { accept, batch, batchTitle, checkStored, checkZip, dropConnection, pair, pickFiles, sendText, waitForPercent } from "./helpers";

test("a dropped connection pauses, then carries on from the same byte", async ({ browser }) => {
  const { host, guest } = await pair(browser, "folder");
  await sendText(guest, "before the drop");
  await pickFiles(guest, [{ name: "resume.bin", mb: 300 }]);
  await accept(host, "resume.bin");
  await waitForPercent(host, "resume.bin", 30);

  expect(await dropConnection(guest)).toBeGreaterThan(0);
  await expect(batch(host, "resume.bin")).toContainText("Paused");
  await expect.poll(() => batchTitle(guest, "resume.bin"), { timeout: 60_000 }).toBe("Sent");
  await expect.poll(() => batchTitle(host, "resume.bin")).toBe("Received");
  expect(await checkStored(host, "resume.bin", 300)).toEqual({ found: true, size: 300 << 20, bad: 0 });
  await expect(host.getByText("before the drop")).toBeVisible();
});

test("a drop while a folder is being zipped still gives a valid .zip", async ({ browser }) => {
  const { host, guest } = await pair(browser, undefined, "browser");
  await pickFiles(host, [
    { name: "one.bin", path: "Album/one.bin", mb: 120 },
    { name: "two.bin", path: "Album/two.bin", mb: 120, seed: 7 },
  ], true);
  await accept(guest, "Album/one.bin");
  await waitForPercent(guest, "Album/one.bin", 60);
  await dropConnection(host);
  await expect(guest.getByText("Packed into “Album.zip”.")).toBeVisible({ timeout: 60_000 });
  const zip = await checkZip(guest, "Album.zip");
  expect(zip?.entries.map((e) => [e.name, e.size, e.ok])).toEqual([["Album/one.bin", 120 << 20, true], ["Album/two.bin", 120 << 20, true]]);
});

test("after the sending page reloads, the same files carry on where they stopped", async ({ browser }) => {
  const { host, guest } = await pair(browser, undefined, "browser");
  const file = { name: "reload.bin", mb: 300 };
  await pickFiles(host, [file]);
  await accept(guest, "reload.bin");
  await waitForPercent(guest, "reload.bin", 40);

  host.on("dialog", (d) => d.accept());  // "Leave site?" while files are moving
  await host.reload();
  await expect(batch(guest, "reload.bin")).toContainText("no longer has this transfer");
  await expect(host.getByText("Connected directly").first()).toBeVisible();

  await pickFiles(host, [file]);
  await expect(guest.getByText(/wants to carry on sending/)).toBeVisible();
  await guest.locator("li").filter({ hasText: "wants to carry on sending" }).first().getByRole("button", { name: "Accept" }).click();
  await expect.poll(() => batchTitle(guest, "reload.bin"), { timeout: 60_000 }).toBe("Received");
  await expect(guest.locator("li").filter({ hasText: "reload.bin" }).filter({ hasText: /Received|Paused/ })).toHaveCount(1);
  expect(await checkStored(guest, "reload.bin", 300)).toEqual({ found: true, size: 300 << 20, bad: 0 });
});

test("after the receiving page reloads, the sender is told it stopped", async ({ browser }) => {
  const { host, guest } = await pair(browser, "folder");
  await pickFiles(guest, [{ name: "gone.bin", mb: 300 }]);
  await accept(host, "gone.bin");
  await waitForPercent(host, "gone.bin", 30);
  host.on("dialog", (d) => d.accept());
  await host.reload();
  await expect(batch(guest, "gone.bin")).toContainText("Stopped on the other device", { timeout: 60_000 });
});
