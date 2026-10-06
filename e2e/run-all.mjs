/* Run every browser suite against one preview server.

   e2e/smoke.mjs first, then each e2e/*.e2e.mjs in name order, each in its
   own process so a crash in one suite cannot hide the others. Exits
   non-zero if any suite failed.

   Usage:  npm run build && npm run test:e2e
           BASE_URL=http://host/path/ npm run test:e2e   (skip the server) */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { BASE, startServer, stopServer } from "./harness.mjs";

const suites = [
  "e2e/smoke.mjs",
  ...readdirSync("e2e")
    .filter((f) => f.endsWith(".e2e.mjs"))
    .sort()
    .map((f) => `e2e/${f}`),
];

await startServer();
const failed = [];
try {
  for (const suite of suites) {
    console.log(`\n=== ${suite}`);
    const res = spawnSync(process.execPath, [suite], {
      stdio: "inherit",
      env: { ...process.env, BASE_URL: BASE },
    });
    if (res.status !== 0) failed.push(suite);
  }
} finally {
  stopServer();
}

console.log(
  `\n${suites.length - failed.length}/${suites.length} suites passed` +
    (failed.length ? ` — failed: ${failed.join(", ")}` : ""),
);
if (failed.length) process.exitCode = 1;
