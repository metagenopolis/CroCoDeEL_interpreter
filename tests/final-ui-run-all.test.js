import { describe, it, expect } from "vitest";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* e2e/run-all.mjs ran the browser suites one after the other with
   spawnSync and no timeout: about 25 minutes for the seven suites, and a
   suite that hung held the CI job for its default six hours. It now runs
   them side by side (E2E_JOBS), stops one that runs past
   E2E_SUITE_TIMEOUT_MIN, prints each one's output whole, and takes the
   suites to run as arguments. Checked here on stand-in suites. */

const ROOT = join(import.meta.dirname, "..");

describe("e2e/run-all.mjs", () => {
  it("runs the suites side by side, stops a hung one, and reports the failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-all-"));
    try {
      const suite = (name, body) => {
        writeFileSync(join(dir, name), body);
        return join(dir, name);
      };
      const slow = (n) =>
        suite(`slow${n}.mjs`, `console.log("slow ${n} starts");\nsetTimeout(() => console.log("slow ${n} done"), 2500);\n`);
      const suites = [
        slow(1),
        slow(2),
        suite("fails.mjs", `console.log("failing");\nprocess.exitCode = 1;\n`),
        suite("hangs.mjs", `console.log("hanging");\nsetInterval(() => {}, 1000);\n`),
      ];
      const started = Date.now();
      const res = spawnSync(process.execPath, ["e2e/run-all.mjs", ...suites], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 30_000,
        // BASE_URL: no preview server is started.
        env: { ...process.env, BASE_URL: "http://127.0.0.1:9/", E2E_JOBS: "4", E2E_SUITE_TIMEOUT_MIN: "0.05" },
      });
      const elapsed = Date.now() - started;
      const out = res.stdout;
      expect(res.status).toBe(1);
      // One after the other: at least 2.5 + 2.5 + 3 seconds.
      expect(elapsed).toBeLessThan(7000);
      expect(out).toMatch(/2\/4 suites passed — failed: .*fails\.mjs/);
      expect(out).toMatch(/failed: .*hangs\.mjs/);
      expect(out).toMatch(/hangs\.mjs — FAILED in \d+ s \(stopped after 0\.05 min\)/);
      // Each suite's output in one block, under its own heading.
      expect(out).toMatch(/slow1\.mjs — passed in \d+ s\nslow 1 starts\nslow 1 done\n/);
      expect(out).toMatch(/slow2\.mjs — passed in \d+ s\nslow 2 starts\nslow 2 done\n/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
