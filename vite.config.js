import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

// Resolve the build's commit hash + ISO date so the running page can
// show which version it is. Falls back to "dev" / current date when
// git isn't available (tarball install, CI without checkout, etc.).
// On GitHub Actions the GITHUB_SHA env var is honoured first since it
// already names the exact commit being deployed.
function gitShort() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

const APP_VERSION = {
  hash: gitShort(),
  date: new Date().toISOString().slice(0, 10),
};

export default defineConfig({
  plugins: [react()],
  base: "/CroCoDeEL_interpreter/",
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
});
