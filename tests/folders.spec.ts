import { test, expect } from "@playwright/test";
import { accept, batch, batchTitle, checkStored, checkZip, pair, pickFiles, type Spec } from "./helpers";

const trip: Spec[] = [
  { name: "a.txt", path: "Trip/a.txt", text: "file a" },
  { name: "b.bin", path: "Trip/sub/b.bin", mb: 5 },
  { name: "c.txt", path: "Trip/sub/deeper/c.txt", text: "file c" },
  { name: "evil.txt", path: "Trip/../../evil.txt", text: "evil" },
];

test("a folder keeps its shape; a second copy becomes “Trip (2)”", async ({ browser }) => {
  const { host, guest } = await pair(browser, "folder");
  await pickFiles(guest, trip, true);
  await expect(batch(host, "Trip/sub/b.bin")).toContainText("Folder: Trip");
  await expect(batch(host, "Trip/sub/b.bin")).toContainText("Trip/evil.txt");
  await accept(host, "Trip/sub/b.bin");
  await expect.poll(() => batchTitle(host, "Trip/sub/b.bin")).toBe("Received");
  expect(await checkStored(host, "Trip/sub/b.bin", 5)).toEqual({ found: true, size: 5 << 20, bad: 0 });
  expect((await checkStored(host, "Trip/sub/deeper/c.txt", 0)).found).toBe(true);
  expect((await checkStored(host, "Trip/evil.txt", 0)).found).toBe(true);

  await pickFiles(guest, trip, true);
  await host.locator("li").filter({ hasText: "wants to send you" }).first().getByRole("button", { name: "Accept" }).click();
  await expect(host.getByText(/as “Trip \(2\)”/)).toBeVisible();
  expect(await checkStored(host, "Trip (2)/sub/b.bin", 5)).toEqual({ found: true, size: 5 << 20, bad: 0 });
});

test("a device that can't save folders gets one valid .zip", async ({ browser }) => {
  const { host, guest } = await pair(browser, "browser");
  await pickFiles(guest, trip, true);
  await expect(batch(host, "Trip/sub/b.bin")).toContainText("arrives as one .zip file");
  await accept(host, "Trip/sub/b.bin");
  await expect(host.getByText("Packed into “Trip.zip”.")).toBeVisible();
  const zip = await checkZip(host, "Trip.zip");
  expect(zip?.entries.map((e) => e.name)).toEqual(["Trip/a.txt", "Trip/sub/b.bin", "Trip/sub/deeper/c.txt", "Trip/evil.txt"]);
  expect(zip?.entries.every((e) => e.ok)).toBe(true);
  await expect(batch(host, "Trip/sub/b.bin").getByRole("button", { name: "Save the .zip" })).toBeVisible();
});
