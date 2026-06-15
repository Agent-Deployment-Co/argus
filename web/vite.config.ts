import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server proxies the data API to the local Hono server (default port 4242), so
// `bun run dev:web` gives live-reloading UI while `argus serve` provides the data. The production
// build lands in dist/web, which the Hono server serves as static files.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": `http://localhost:${process.env.ARGUS_PORT || 4242}`,
    },
  },
});
