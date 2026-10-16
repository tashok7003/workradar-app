import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// The browser calls relative `api/...` URLs. In development those go to the
// WorkRadar server (server/index.ts) on port 8787, which holds the Gemini and
// GitHub keys. On static hosting (GitHub Pages, the Claude artifact) there is
// no server, and the app falls back to mock data and a rules-based briefing.
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react(), ...(mode === "single" ? [viteSingleFile()] : [])],
  server: {
    proxy: { "/api": { target: `http://localhost:${process.env.PORT || 8787}`, changeOrigin: true } },
  },
  build: { outDir: mode === "single" ? "dist-single" : "dist" },
  test: { include: ["src/**/*.test.ts", "server/**/*.test.ts"] },
}));
