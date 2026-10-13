import { defineConfig, devices } from "@playwright/test";

// `npm test` builds first, then this starts the built app (Worker and rooms included) and runs tests/.
// localhost counts as a secure page, so the service worker and browser storage are there, as on https.
export default defineConfig({
  testDir: "tests",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Each test uses two browser windows talking to each other; running several at once only slows them down.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4174",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: "npx vite preview --port 4174 --strictPort",
    url: "http://localhost:4174",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
