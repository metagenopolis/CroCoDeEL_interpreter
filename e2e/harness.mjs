/* Shared pieces for the browser checks.

   e2e/smoke.mjs predates this file and keeps its own copy; the topic
   suites (e2e/*.e2e.mjs) import from here so each one stays a short list
   of scenarios. A suite runs on its own (`node e2e/x.e2e.mjs`, which
   starts a preview server unless BASE_URL is set) or through
   e2e/run-all.mjs, which starts one server for every file. */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.E2E_PORT || 4173);
export const BASE =
  process.env.BASE_URL || `http://127.0.0.1:${PORT}/CroCoDeEL_interpreter/`;
const HEADFUL = process.env.E2E_HEADFUL === "1";

/* ---------------------------------------------------------------- server */
let server = null;
export async function startServer() {
  if (process.env.BASE_URL) return; // caller provides one
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--port",
      String(PORT),
      "--strictPort",
      "--host",
      "127.0.0.1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", () => {});
  server.stderr.on("data", (d) => process.stderr.write(d));
  // Poll rather than parse stdout: the banner format is not a contract.
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`vite preview did not answer on ${BASE} within 30 s`);
}
export function stopServer() {
  if (server && !server.killed) server.kill("SIGTERM");
}

/* --------------------------------------------------------------- results */
const results = [];
export function check(ok, name, detail = "") {
  results.push({ ok, name, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? " — " + detail : ""}`);
}

/** Print the tally and set the exit code. Call once, at the very end. */
export function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFailures:");
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? " — " + f.detail : ""}`));
    process.exitCode = 1;
  }
}

/* --------------------------------------------------------------- browser */
export function launchBrowser() {
  return chromium.launch({ headless: !HEADFUL });
}

/** A fresh context that records every page error and console error. The
    tutorial is marked seen so it does not sit over the UI. */
export async function newPage(browser, contextOptions = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
    ...contextOptions,
  });
  const page = await ctx.newPage();
  const errors = trackErrors(page);
  await page.addInitScript(() =>
    localStorage.setItem("crocodeel-tutorial-seen", "1"),
  );
  await page.goto(BASE, { waitUntil: "networkidle" });
  return { ctx, page, errors };
}

/** Collect uncaught page errors and console errors of one page. */
export function trackErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("[console] " + m.text().slice(0, 300));
  });
  return errors;
}

export const tsvInput = (page, i) => page.locator('input[accept*=".tsv"]').nth(i);

export async function loadDemo(page) {
  await page.getByRole("button", { name: /load demo/i }).first().click();
  // The demo pulls four files and parses them; wait for a tab that only
  // lights up once events are in.
  await page
    .getByRole("button", { name: /^Validate$/ })
    .first()
    .waitFor({ state: "visible", timeout: 60000 });
  await page.waitForTimeout(2500);
}

export async function openTab(page, name) {
  await page.getByRole("button", { name: new RegExp(`^${name}$`) }).first().click();
  await page.waitForTimeout(900);
}

/** The headline counters of the Overview tab, as numbers (NaN if absent). */
export async function overviewStats(page) {
  await openTab(page, "Overview");
  const text = await page.locator("body").innerText();
  const stat = (re) => Number(text.match(re)?.[1] ?? NaN);
  return {
    tp: stat(/Validated \(TP\)\s*(\d+)/i),
    fp: stat(/Rejected \(FP\)\s*(\d+)/i),
    keep: stat(/Samples to keep\s*(\d+)/i),
    suppress: stat(/Samples to suppress\s*(\d+)/i),
  };
}

/** Rows of a TSV file in the repository, comment lines and header dropped. */
export function tsvRows(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .slice(1)
    .map((l) => l.split("\t"));
}
