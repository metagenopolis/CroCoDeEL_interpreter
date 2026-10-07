/* Run every browser suite against one preview server.

   e2e/smoke.mjs and each e2e/*.e2e.mjs, each in its own process so a
   crash in one suite cannot hide the others. Exits non-zero if any suite
   failed.

   The suites are independent — each opens its own browser, and the server
   only serves static files — so they run side by side, E2E_JOBS at a time
   (default: up to 4, never more than the machine's cores). One after the
   other they took about 25 minutes, mostly waiting on the page; side by
   side the run takes about as long as the longest suite. Each suite's
   output is printed whole once it is done, so the logs do not interleave.
   A suite still running after E2E_SUITE_TIMEOUT_MIN minutes (default 20)
   is stopped and counts as failed: a hang no longer holds the run.

   Usage:  npm run build && npm run test:e2e
           node e2e/run-all.mjs e2e/a1-parsing.e2e.mjs …   (only those)
           BASE_URL=http://host/path/ npm run test:e2e   (skip the server)
           E2E_JOBS=1 npm run test:e2e                   (one at a time) */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { BASE, startServer, stopServer } from "./harness.mjs";

const all = [
  "e2e/smoke.mjs",
  ...readdirSync("e2e")
    .filter((f) => f.endsWith(".e2e.mjs"))
    .sort()
    .map((f) => `e2e/${f}`),
];
const suites = process.argv.length > 2 ? process.argv.slice(2) : all;
const jobs = Math.max(
  1,
  Math.min(suites.length, Number(process.env.E2E_JOBS) || Math.min(4, availableParallelism())),
);
const timeoutMs = (Number(process.env.E2E_SUITE_TIMEOUT_MIN) || 20) * 60_000;

/** Run one suite; resolve with its outcome and everything it printed. */
function runSuite(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [suite], {
      env: { ...process.env, BASE_URL: BASE },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    child.stdout.on("data", (d) => output.push(d));
    child.stderr.on("data", (d) => output.push(d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        suite,
        ok: code === 0 && !timedOut,
        timedOut,
        secs: Math.round((Date.now() - started) / 1000),
        output: Buffer.concat(output).toString(),
      });
    };
    child.on("error", (e) => {
      output.push(Buffer.from(`${e}\n`));
      done(1);
    });
    child.on("close", (code) => done(code));
  });
}

console.log(`${suites.length} suites, ${jobs} at a time, against ${BASE}`);
await startServer();
const results = [];
try {
  const queue = [...suites];
  const worker = async () => {
    for (let suite = queue.shift(); suite; suite = queue.shift()) {
      const r = await runSuite(suite);
      console.log(
        `\n=== ${r.suite} — ${r.ok ? "passed" : "FAILED"} in ${r.secs} s` +
          (r.timedOut ? ` (stopped after ${timeoutMs / 60_000} min)` : ""),
      );
      process.stdout.write(r.output);
      results.push(r);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
} finally {
  stopServer();
}

const failed = results.filter((r) => !r.ok).map((r) => r.suite);
console.log(
  `\n${suites.length - failed.length}/${suites.length} suites passed` +
    (failed.length ? ` — failed: ${failed.join(", ")}` : ""),
);
if (failed.length) process.exitCode = 1;
