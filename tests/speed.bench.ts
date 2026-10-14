// How fast files move between two browser windows on this computer, for each way of saving.
// Not part of `npm test`; run with `npm run speed` before and after a change that should affect speed.
// Two windows on one computer show Lanet's own ceiling, not a real Wi-Fi network.
import { test, expect } from "@playwright/test";
import { accept, batchTitle, checkStored, pair, pickFiles, type Sink } from "./helpers";

const MB = 400;
const runs: { sink: Sink; label: string }[] = [
  { sink: "folder", label: "Folder (Chrome, Edge on a computer)" },
  { sink: "browser", label: "Browser storage (iPhone, iPad)" },
  { sink: "memory", label: "Kept on the page (plain http)" },
];

test("speed: 200 smaller files (2 MB each)", async ({ browser }) => {
  test.setTimeout(240_000);
  const { host, guest } = await pair(browser, "folder");
  await pickFiles(guest, Array.from({ length: 200 }, (_, k) => ({ name: `small-${k}.bin`, mb: 2 })));
  const started = Date.now();
  await accept(host, "small-0.bin");
  await expect.poll(() => batchTitle(host, "small-0.bin"), { timeout: 200_000, intervals: [100] }).toBe("Received");
  const seconds = (Date.now() - started) / 1000;
  console.log(`SPEED  ${"200 smaller files, folder".padEnd(38)} 400 MB in ${seconds.toFixed(1)} s = ${(400 / seconds).toFixed(1)} MB/s`);
});

for (const { sink, label } of runs) {
  test(`speed: ${label}`, async ({ browser }) => {
    test.setTimeout(240_000);
    const { host, guest } = await pair(browser, sink);
    await pickFiles(guest, [{ name: "speed.bin", mb: MB }]);
    const started = Date.now();
    await accept(host, "speed.bin");
    await expect.poll(() => batchTitle(host, "speed.bin"), { timeout: 200_000, intervals: [100] }).toBe("Received");
    const seconds = (Date.now() - started) / 1000;
    if (sink !== "memory") expect(await checkStored(host, "speed.bin", MB)).toEqual({ found: true, size: MB << 20, bad: 0 });
    console.log(`SPEED  ${label.padEnd(38)} ${MB} MB in ${seconds.toFixed(1)} s = ${(MB / seconds).toFixed(1)} MB/s`);
  });
}
