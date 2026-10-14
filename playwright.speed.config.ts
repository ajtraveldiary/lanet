import base from "./playwright.config";
import { defineConfig } from "@playwright/test";

// `npm run speed`: the same setup as the tests, running only the speed measurements.
export default defineConfig({ ...base, testMatch: "*.bench.ts" });
