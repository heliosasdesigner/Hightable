import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  // Relative base so the packaged app loads /assets via file:// URLs
  // resolved against the asar bundle, not the filesystem root. Dev server
  // works fine either way because it serves from "/".
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5300,
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
