import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function resolveCommit(): string {
  if (process.env.APP_COMMIT) return process.env.APP_COMMIT;
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "development"; }
}

export default defineConfig({
  plugins: [react()],
  define: { __APP_COMMIT__: JSON.stringify(resolveCommit()) },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: { "/api": { target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001" } },
  },
  preview: { host: "0.0.0.0", allowedHosts: true },
});
