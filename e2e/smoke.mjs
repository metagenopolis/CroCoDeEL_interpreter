/* End-to-end smoke test.

   The unit suite covers pure functions; this covers the things only a real
   browser can catch — and that have actually bitten:

     - a hook called after an early return, which throws "Rendered more
       hooks than during the previous render" and, with no route
       boundaries, unmounts the whole app to a blank page;
     - an error object rendered as a React child, which took the app down
       when a session file failed to parse;
     - any tab that throws on mount;
     - the export path, end to end, including the numbers in the file.

   Deliberately plain `playwright` and a node script rather than
   @playwright/test: no extra config, no extra runner, and the script owns
   its own server so `npm run test:e2e` behaves identically on a laptop and
   in CI.

   Usage:  npm run build && npm run test:e2e
           BASE_URL=http://host/path/ npm run test:e2e   (skip the server) */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.E2E_PORT || 4173);
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}/CroCoDeEL_interpreter/`;
const HEADFUL = process.env.E2E_HEADFUL === "1";

const results = [];
function check(ok, name, detail = "") {
  results.push({ ok, name, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? " — " + detail : ""}`);
}

/* ---------------------------------------------------------------- server */
let server = null;
async function startServer() {
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
function stopServer() {
  if (server && !server.killed) server.kill("SIGTERM");
}

/* ------------------------------------------------------------------ main */
await startServer();
const browser = await chromium.launch({ headless: !HEADFUL });

/** A fresh context that records every page error and console error. The
    tutorial is marked seen so it does not sit over the UI. */
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("[console] " + m.text().slice(0, 300));
  });
  await page.addInitScript(() =>
    localStorage.setItem("crocodeel-tutorial-seen", "1"),
  );
  await page.goto(BASE, { waitUntil: "networkidle" });
  return { ctx, page, errors };
}

const tsvInput = (page, i) => page.locator('input[accept*=".tsv"]').nth(i);

async function loadDemo(page) {
  await page.getByRole("button", { name: /load demo/i }).first().click();
  // The demo pulls four files and parses them; wait for a tab that only
  // lights up once events are in.
  await page
    .getByRole("button", { name: /^Validate$/ })
    .first()
    .waitFor({ state: "visible", timeout: 60000 });
  await page.waitForTimeout(2500);
}

try {
  /* ---------------------------------------- 1. boot + every tab renders */
  {
    const { ctx, page, errors } = await newPage();
    check(errors.length === 0, "the page boots clean", errors[0] || "");
    await loadDemo(page);
    check(errors.length === 0, "the demo dataset loads", errors[0] || "");

    for (const tab of [
      "Overview",
      "Samples",
      "Events",
      "Scatter",
      "Validate",
      "Network",
      "Plate",
      "Export",
    ]) {
      const before = errors.length;
      await page.getByRole("button", { name: new RegExp(`^${tab}$`) }).first().click();
      await page.waitForTimeout(900);
      const text = (await page.locator("body").innerText()).trim();
      check(
        errors.length === before && text.length > 400,
        `tab ${tab} renders`,
        errors.slice(before).join(" | ") || (text.length <= 400 ? "near-blank page" : ""),
      );
    }
    await ctx.close();
  }

  /* ------------- 2. regression: hooks after an early return in ScatterTab
     Sitting on the Scatter tab with no abundance table and then loading one
     is exactly what the tab's own notice tells the user to do. It used to
     change the hook count between two renders and blank the app. */
  {
    const { ctx, page, errors } = await newPage();
    await tsvInput(page, 0).setInputFiles("public/demo/contamination_events.tsv");
    await page
      .getByRole("button", { name: /^Scatter$/ })
      .first()
      .waitFor({ state: "visible", timeout: 60000 });
    await page.getByRole("button", { name: /^Scatter$/ }).first().click();
    await page.waitForTimeout(800);
    const notice = await page.locator("body").innerText();
    check(
      /require the abundance table/i.test(notice),
      "Scatter tab explains it needs the abundance table",
    );

    const before = errors.length;
    await tsvInput(page, 1).setInputFiles("public/demo/species_abundance.tsv");
    await page.waitForTimeout(4000);
    const after = (await page.locator("body").innerText()).trim();
    const hookCrash = errors
      .slice(before)
      .some((e) => /Rendered more hooks|Minified React error #(300|310)/.test(e));
    check(!hookCrash, "loading the abundance table there does not crash", errors.slice(before)[0] || "");
    check(after.length > 500, "the app is still rendered afterwards", `body=${after.length} chars`);
    await ctx.close();
  }

  /* --------- 3. regression: an error object rendered as a React child
     A session file that fails to parse must report the failure, not take
     the application down with it. */
  {
    const { ctx, page, errors } = await newPage();
    await page
      .locator('input[accept*="json"]')
      .first()
      .setInputFiles({
        name: "session.json",
        mimeType: "application/json",
        buffer: Buffer.from("not json at all"),
      });
    await page.waitForTimeout(2500);
    const body = await page.locator("body").innerText();
    check(
      /Failed to import session/i.test(body),
      "a broken session file reports the failure",
    );
    check(
      !/Something went wrong while rendering/i.test(body),
      "the error boundary did not have to catch it",
    );
    check(
      !errors.some((e) => /not valid as a React child/i.test(e)),
      "no 'objects are not valid as a React child'",
      errors.find((e) => /React child/i.test(e)) || "",
    );
    await ctx.close();
  }

  /* ------------------------------ 4. curated abundance export, end to end */
  {
    const { ctx, page, errors } = await newPage();
    await loadDemo(page);
    await page.getByRole("button", { name: /^Samples$/ }).first().click();
    // Marking a sample Contaminated defaults its action to Suppress, which
    // is what the export acts on.
    const contaminated = page.locator('button[title="Verdict: Contaminated"]');
    await contaminated.first().waitFor({ state: "visible", timeout: 60000 });
    await contaminated.nth(0).click();
    await page.waitForTimeout(500);
    await contaminated.nth(1).click();
    await page.waitForTimeout(800);

    await page.getByRole("button", { name: /^Export$/ }).first().click();
    await page.waitForTimeout(1500);
    const title = await page.locator("body").innerText();
    const m = title.match(/Curated abundance table — (\d+) of (\d+) samples/);
    check(!!m, "the export card reports the sample counts", m ? m[0] : "not found");
    if (m) {
      check(
        Number(m[2]) - Number(m[1]) === 2,
        "exactly the two suppressed samples are dropped",
        `${m[1]}/${m[2]}`,
      );
    }

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
      page
        .getByRole("button", { name: /Download curated abundance TSV/i })
        .first()
        .click(),
    ]);
    check(!!download, "the curated abundance TSV downloads");
    if (download) {
      const text = readFileSync(await download.path(), "utf8");
      const lines = text.split("\n").filter((l) => l.length);
      const comments = lines.filter((l) => l.startsWith("#"));
      const data = lines.filter((l) => !l.startsWith("#"));
      const cols = data[0].split("\t");
      check(
        comments.some((c) => /^# suppressed samples \(2\):/.test(c)),
        "the file header records the suppressed ids",
      );
      // The point of not renormalising: dropping a column cannot change
      // the others, so every remaining column must still sum to 1.
      const sums = new Array(cols.length - 1).fill(0);
      for (const line of data.slice(1)) {
        const cells = line.split("\t");
        for (let i = 1; i < cells.length; i++) sums[i - 1] += parseFloat(cells[i]) || 0;
      }
      const worst = Math.max(...sums.map((s) => Math.abs(s - 1)));
      check(worst < 1e-9, "every remaining column still sums to 1", `max deviation ${worst.toExponential(2)}`);
    }
    check(errors.length === 0, "no JS error across the export flow", errors[0] || "");
    await ctx.close();
  }

  /* ------------------------- 5. pin a species by clicking a scatter point */
  {
    const { ctx, page, errors } = await newPage();
    await loadDemo(page);
    await page.getByRole("button", { name: /^Validate$/ }).first().click();
    await page.waitForTimeout(2500);

    const rings = () => page.locator('svg circle[stroke="#423089"]').count();
    check((await rings()) === 0, "no species is pinned to start with");

    // Click by coordinate: the dots overlap, so Playwright's actionability
    // check on an individual <circle> never settles.
    const at = await page.evaluate(() => {
      const svg = [...document.querySelectorAll("svg")].find(
        (s) => s.querySelectorAll("circle").length > 50,
      );
      const c = svg
        ? [...svg.querySelectorAll("circle")].find(
            (x) => x.style.cursor === "pointer" && x.querySelector("title"),
          )
        : null;
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    check(!!at, "the scatter renders clickable points");
    if (at) {
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(600);
      check((await rings()) === 1, "clicking a point pins that species");
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(600);
      check((await rings()) === 0, "clicking it again unpins it");
    }
    check(errors.length === 0, "no JS error while pinning", errors[0] || "");
    await ctx.close();
  }

  /* --------------------------------- 6. contamination graph export */
  {
    const { ctx, page, errors } = await newPage();
    await loadDemo(page);
    await page.getByRole("button", { name: /^Export$/ }).first().click();
    await page.waitForTimeout(1500);
    const card = await page.locator("body").innerText();
    const counts = card.match(/Contamination graph — (\d+) nodes?, (\d+) edges?/);
    check(!!counts, "the graph card reports node and edge counts", counts ? counts[0] : "");

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
      page.getByRole("button", { name: /Download GraphML/i }).first().click(),
    ]);
    check(!!download, "the GraphML downloads");
    if (download && counts) {
      const xml = readFileSync(await download.path(), "utf8");
      // Parse it rather than pattern-match: a malformed file is the whole
      // failure mode, and Gephi would just refuse to open it.
      const parsed = await page.evaluate((text) => {
        const doc = new DOMParser().parseFromString(text, "application/xml");
        if (doc.querySelector("parsererror")) return { error: true };
        const declared = new Set(
          [...doc.getElementsByTagName("key")].map((k) => k.getAttribute("id")),
        );
        return {
          directed: doc.querySelector("graph")?.getAttribute("edgedefault"),
          nodes: doc.getElementsByTagName("node").length,
          edges: doc.getElementsByTagName("edge").length,
          orphan: [...doc.getElementsByTagName("data")].filter(
            (d) => !declared.has(d.getAttribute("key")),
          ).length,
        };
      }, xml);
      check(!parsed.error, "the GraphML is well-formed XML");
      check(parsed.directed === "directed", "the graph is declared directed");
      check(
        String(parsed.nodes) === counts[1] && String(parsed.edges) === counts[2],
        "the file matches the counts shown on the card",
        `file ${parsed.nodes}/${parsed.edges} vs card ${counts[1]}/${counts[2]}`,
      );
      check(parsed.orphan === 0, "every <data> resolves to a declared key");
    }
    check(errors.length === 0, "no JS error across the graph export", errors[0] || "");
    await ctx.close();
  }
} finally {
  await browser.close();
  stopServer();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nFailures:");
  failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? " — " + f.detail : ""}`));
  process.exit(1);
}
