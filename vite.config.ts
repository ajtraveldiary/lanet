import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  // Listen on the Wi-Fi address too, so phones on the same network can open the dev and preview servers.
  server: { host: true },
  preview: { host: true },
});
