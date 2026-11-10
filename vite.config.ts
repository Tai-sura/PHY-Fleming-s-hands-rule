import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the app works on GitHub Pages project URLs and at localhost.
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
    outDir: "docs",
    emptyOutDir: true,
  },
});
