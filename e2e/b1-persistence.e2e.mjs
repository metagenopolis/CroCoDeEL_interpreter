/* Browser checks for the session's persistence: what the browser keeps of
   the curation, and what replacing or importing files does to it.

     - the parsers' warnings (events, metadata, plate map) are in the
       data-warnings banner and survive a reload;
     - a tab switch writes the small UI record only, an evaluation the
       curation record only;
     - two tabs of one browser: the second cannot overwrite the first's
       decisions, and says so;
     - a T pressed half a second before a reload — or right before it —
       is kept;
     - a failed write shows "Not saved"; without IndexedDB the app runs in
       memory and says so;
     - clearing the events file keeps the abundance table and the metadata
       across a reload.

   The stored state is read from IndexedDB, rebuilt the way the app reads
   it (src/persistence.js).

   Usage:  npm run build && node e2e/b1-persistence.e2e.mjs
           (or through e2e/run-all.mjs; BASE_URL skips the server,
           E2E_ONLY=<regex> runs only the matching scenarios) */

import { readFileSync } from "node:fs";
import {
  BASE,
  startServer,
  stopServer,
  launchBrowser,
  newPage,
  trackErrors,
  loadDemo,
  openTab,
  overviewStats,
  tsvInput,
  check,
  finish,
} from "./harness.mjs";

const demo = (name) => readFileSync(`public/demo/${name}`, "utf8");

/* ------------------------------------------------------------- helpers */

/** Every record the app keeps in IndexedDB. */
function storedRecords(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("crocodeel-interpreter");
        req.onerror = () => resolve({});
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("kv")) return resolve({});
          const tx = db.transaction("kv", "readonly");
          const out = {};
          for (const k of ["events", "ab", "metadata", "plate", "curation", "ui", "main"]) {
            const get = tx.objectStore("kv").get(k);
            get.onsuccess = () => {
              if (get.result !== undefined) out[k] = get.result;
            };
          }
          tx.oncomplete = () => {
            db.close();
            resolve(out);
          };
        };
      }),
  );
}

/** The stored session: events with their verdicts and notes put back. */
async function storedSession(page) {
  const r = await storedRecords(page);
  const cur = r.curation || {};
  const rawEvents = (r.events?.events || []).map((e) => ({
    ...e,
    verdict: cur.verdicts?.[String(e.id)] || "pending",
    notes: cur.notes?.[String(e.id)] || "",
  }));
  return { records: r, rawEvents, sampleCuration: cur.sampleCuration || {} };
}

/** Let the autosave (0.3 s after the last change) write. */
const saved = (page) => page.waitForTimeout(1200);

/** Upload `text` through the i-th file card (0 events, 1 abundance,
    2 metadata, 3 plate map). */
async function upload(page, i, name, text) {
  await tsvInput(page, i).setInputFiles({
    name,
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from(text),
  });
  await page.waitForTimeout(1500);
}

/** Click a download button and return the file's text (null if none). */
async function download(page, button) {
  const [file] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
    button.click(),
  ]);
  return file ? readFileSync(await file.path(), "utf8") : null;
}

/** The session JSON of the files bar. */
async function exportSession(page) {
  return download(page, page.getByRole("button", { name: /^Download session$/ }).first());
}

/** The confirmation dialog titled `title`. */
const dialog = (page, title) => page.getByRole("dialog", { name: title });

/** A file card, by its label. */
function card(page, label) {
  return page
    .locator("div.rounded-sm")
    .filter({ has: page.getByText(label, { exact: true }) })
    .filter({ has: page.getByRole("button", { name: /^(Replace|Select file)$/ }) })
    .last();
}

/** Mark the i-th event of the Events table. */
async function mark(page, title, i) {
  await openTab(page, "Events");
  await page.locator(`button[title="mark as ${title}"]`).nth(i).click();
  await page.waitForTimeout(250);
}

/** The banner text of the data warnings. */
async function warningsBanner(page) {
  const box = page.locator("div").filter({ has: page.getByText("Check the input files.", { exact: true }) }).last();
  return (await box.count()) ? box.innerText() : "";
}

const banner = (page, state) => page.locator(`[data-save-banner="${state}"]`);
const notSavedPill = (page) => page.locator('[data-save-state="not-saved"]');

/* Put a stub on IndexedDB writes: while window.__failWrites is set, every
   transaction that writes is aborted once its requests have succeeded —
   which is how a full quota arrives (QuotaExceededError at commit: an
   abort, no error event). */
const FAIL_WRITES = () => {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const req = put.apply(this, args);
    if (window.__failWrites) {
      const tx = this.transaction;
      req.addEventListener("success", () => {
        try {
          tx.abort();
        } catch {
          // already finished
        }
      });
    }
    return req;
  };
};

await startServer();
const browser = await launchBrowser();

/* One fresh page per scenario. A scenario that throws is reported as a
   failed check and the others still run. E2E_ONLY=<regex> runs only the
   scenarios whose name matches. `expectedErrors` lists page errors the
   scenario provokes on purpose. */
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
async function scenario(name, run, { demo: withDemo = true, expectedErrors = null } = {}) {
  if (ONLY && !ONLY.test(name)) return;
  const { ctx, page, errors } = await newPage(browser);
  try {
    if (withDemo) await loadDemo(page);
    await run(page, ctx);
  } catch (e) {
    check(false, `${name} runs to the end`, String(e).split("\n")[0]);
  }
  const unexpected = expectedErrors ? errors.filter((e) => !expectedErrors.test(e)) : errors;
  check(unexpected.length === 0, `${name}: no JS error`, unexpected[0] || "");
  await ctx.close();
}

try {
  /* B1.1 Replacing the events file: cancel, carry over, start fresh. */


  /* B1.5 Clearing the events file. */
  await scenario("B1.5 clear events", async (page) => {
    const events = card(page, "contamination_events.tsv");
    await mark(page, "true positive", 0);
    await events.getByRole("button", { name: /^Clear$/ }).click();
    await dialog(page, "Remove the loaded contamination_events.tsv?").getByRole("button", { name: "Remove" }).click();
    await saved(page);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const abText = await card(page, "species_abundance.tsv").innerText();
    const mdText = await card(page, "metadata.tsv").innerText();
    const pmText = await card(page, "plate_map.tsv").innerText();
    const evText = await card(page, "contamination_events.tsv").innerText();
    check(
      /91 samples × \d+ species/.test(abText) && /samples annotated/.test(mdText) && /wells/.test(pmText) && !/events loaded/.test(evText),
      "B1.5 after a reload the abundance table, the metadata and the plate map are still there, the events are not",
      [abText, mdText, pmText].map((t) => t.split("\n").find((l) => l.startsWith("✓")) || "-").join(" | "),
    );
  });

  /* B1.2 The parsers' warnings, in the banner, across a reload. */
  await scenario(
    "B1.2 warnings",
    async (page) => {
      const lines = demo("contamination_events.tsv").split("\n");
      const i = lines.findIndex((l) => l.startsWith("63D29\t63D40\t"));
      const c = lines[i].split("\t");
      c[2] = "1.5";
      lines[i] = c.join("\t");
      lines.push("40D89\t\t0.1\t0.9\t");
      await upload(page, 0, "contamination_events.tsv", lines.join("\n"));
      await upload(page, 1, "species_abundance.tsv", demo("species_abundance.tsv"));
      const md = demo("metadata.tsv").split("\n").filter((l) => l);
      await upload(page, 2, "metadata.tsv", [...md, md.find((l) => l.startsWith("58M\t"))].join("\n"));
      await upload(page, 3, "plate_map.tsv", [...demo("plate_map.tsv").split("\n").filter((l) => l), "83D239\tP3\tZ99"].join("\n"));
      const want = [
        /Events file: 1 event has a rate outside \(0, 1\] — first on line \d+ \(63D29 → 63D40\): 1\.5\./,
        /Events file: 1 row with an empty source or target was skipped/,
        /Metadata: .*more than one row \("58M"\)/,
        /Plate map: 1 row with no readable well was skipped/,
      ];
      let text = await warningsBanner(page);
      check(want.every((re) => re.test(text)), "B1.2 the events, metadata and plate-map warnings are in the data-warnings banner", text.replace(/\s+/g, " ").slice(0, 400));
      await saved(page);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      text = await warningsBanner(page);
      check(want.every((re) => re.test(text)), "B1.2 …and still there after a reload", text.replace(/\s+/g, " ").slice(0, 400));
      // Replaced by a clean file: its warnings go, the others stay.
      await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
      text = await warningsBanner(page);
      check(!/Events file:/.test(text) && /Metadata:/.test(text) && /Plate map:/.test(text), "B1.2 replacing the events file drops its warnings only", text.replace(/\s+/g, " ").slice(0, 300));
    },
    { demo: false },
  );

  /* B1.3a A tab switch writes the UI record, an evaluation the curation. */
  await scenario("B1.3a records", async (page) => {
    await page.evaluate(() => {
      window.__puts = [];
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        window.__puts.push(String(key));
        return put.call(this, value, key);
      };
    });
    await saved(page);
    const take = () => page.evaluate(() => window.__puts.splice(0).sort().join(","));
    await take();
    await openTab(page, "Help");
    await openTab(page, "Learn");
    await saved(page);
    const tabs = await take();
    check(tabs === "ui" || tabs === "ui,ui", "B1.3a a tab switch writes the UI record only", tabs);
    await openTab(page, "Events");
    await saved(page);
    await take();
    await page.locator('button[title="mark as true positive"]').first().click();
    await saved(page);
    const verdict = await take();
    check(verdict === "curation", "B1.3a an evaluation writes the curation record only", verdict);
    const r = await storedRecords(page);
    check(
      r.events && !r.main && r.events.events.every((e) => !("verdict" in e) && !("notes" in e)) && Object.keys(r.curation.verdicts).length === 1,
      "B1.3a the events are stored without their curation, which is stored by event id",
    );
  });

  /* B1.3b Two pages of one browser. */
  await scenario("B1.3b two tabs", async (page, ctx) => {
    await saved(page);
    const b = await ctx.newPage();
    const errorsB = trackErrors(b);
    await b.goto(BASE, { waitUntil: "networkidle" });
    await b.waitForTimeout(1500);
    check(/24 events loaded/.test(await b.locator("body").innerText()), "B1.3b the second tab opens the same session");
    await mark(page, "true positive", 0);
    await mark(page, "true positive", 1);
    await saved(page);
    const conflict = banner(b, "conflict");
    check(
      (await conflict.count()) === 1 &&
        /This session was changed in another tab — reload to see the latest version/.test(await conflict.innerText()),
      "B1.3b the second tab says at once that the session was changed in another tab",
    );
    check((await notSavedPill(b).count()) === 1, "B1.3b …and shows Not saved");
    // B, which only had to switch to Network, cannot overwrite A's TPs —
    // nor can an evaluation of its own.
    await openTab(b, "Network");
    await mark(b, "false positive", 5);
    await saved(b);
    const s = await storedSession(page);
    check(
      s.rawEvents.filter((e) => e.verdict === "true_positive").length === 2 &&
        s.rawEvents.every((e) => e.verdict !== "false_positive") &&
        s.records.ui.tab !== "network",
      "B1.3b the stored session keeps the first tab's two TPs, and nothing of the second",
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const a = await overviewStats(page);
    check(a.tp === 2 && a.fp === 0, "B1.3b the first tab, reloaded, has its two TPs", JSON.stringify(a));
    await conflict.getByRole("button", { name: "Reload" }).click();
    await b.waitForLoadState("networkidle");
    await b.waitForTimeout(1500);
    check((await overviewStats(b)).tp === 2 && (await banner(b, "conflict").count()) === 0, "B1.3b Reload brings the latest version to the second tab");
    check(errorsB.length === 0, "B1.3b no JS error in the second tab", errorsB[0] || "");
  });

  await scenario("B1.3b two tabs, revision check alone", async (page, ctx) => {
    await saved(page);
    const b = await ctx.newPage();
    // No BroadcastChannel in this one: only the revision check is left.
    await b.addInitScript(() => {
      delete window.BroadcastChannel;
    });
    await b.goto(BASE, { waitUntil: "networkidle" });
    await b.waitForTimeout(1500);
    await mark(page, "true positive", 0);
    await saved(page);
    check((await banner(b, "conflict").count()) === 0, "B1.3b without the channel, the second tab does not know yet");
    await mark(b, "false positive", 3);
    await saved(b);
    check((await banner(b, "conflict").count()) === 1, "B1.3b …its first save finds a newer session, writes nothing, and says so");
    const s = await storedSession(page);
    check(
      s.rawEvents.filter((e) => e.verdict === "true_positive").length === 1 && s.rawEvents.every((e) => e.verdict !== "false_positive"),
      "B1.3b the first tab's TP is kept, the second tab's FP was not written",
    );
  });

  /* B1.3c A T just before a reload. */
  await scenario("B1.3c T then reload", async (page) => {
    await saved(page);
    await openTab(page, "Validate");
    await page.keyboard.press("t");
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    check((await overviewStats(page)).tp === 1, "B1.3c a T pressed 0.5 s before a reload is kept");
    await openTab(page, "Validate");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    await page.keyboard.press("t");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    check((await overviewStats(page)).tp === 2, "B1.3c …and one pressed right before it too (saved when the page goes away)");
  });

  /* B1.3d A write the browser refuses. */
  await scenario("B1.3d storage failure", async (page) => {
    await page.evaluate(FAIL_WRITES);
    await saved(page);
    await page.evaluate(() => {
      window.__failWrites = true;
    });
    await mark(page, "true positive", 0);
    await saved(page);
    const failed = banner(page, "failed");
    check((await notSavedPill(page).count()) === 1, "B1.3d a refused write shows Not saved");
    check(
      (await failed.count()) === 1 &&
        /Not saved — browser storage is full or unavailable/.test(await failed.innerText()) &&
        /Download the session JSON to keep your work/.test(await failed.innerText()),
      "B1.3d …with a banner that says to download the session JSON",
    );
    const json = await download(page, failed.getByRole("button", { name: "Download session" }));
    const kept = json ? JSON.parse(json).events.filter((e) => e.verdict === "true_positive").length : 0;
    check(kept === 1, "B1.3d …whose button downloads the session, unsaved TP included");
    // Storage works again: the next change (after a short pause) saves.
    await page.evaluate(() => {
      window.__failWrites = false;
    });
    await mark(page, "true positive", 1);
    await page.waitForTimeout(6000);
    check(
      (await failed.count()) === 0 && (await notSavedPill(page).count()) === 0,
      "B1.3d once a write succeeds again, Not saved goes away",
    );
    check((await storedSession(page)).rawEvents.filter((e) => e.verdict === "true_positive").length === 2, "B1.3d …and both TPs are stored");
  });

  /* B1.3e Without IndexedDB, or when it cannot be opened. */
  for (const [label, init] of [
    [
      "no IndexedDB",
      () => Object.defineProperty(window, "indexedDB", { get: () => undefined, configurable: true }),
    ],
    [
      "IndexedDB that fails to open",
      () => {
        const open = () => {
          const req = {};
          setTimeout(() => req.onerror?.(), 0);
          return req;
        };
        Object.defineProperty(window, "indexedDB", { get: () => ({ open }), configurable: true });
      },
    ],
  ]) {
    await scenario(
      `B1.3e ${label}`,
      async (_page, ctx) => {
        const page = await ctx.newPage();
        const errors = trackErrors(page);
        await page.addInitScript(() => localStorage.setItem("crocodeel-tutorial-seen", "1"));
        await page.addInitScript(init);
        await page.goto(BASE, { waitUntil: "networkidle" });
        await page.waitForTimeout(800);
        const body = await page.locator("body").innerText();
        check(!/Browser not supported|IndexedDB is required/.test(body), `B1.3e ${label}: no "unsupported" screen`);
        const unavailable = banner(page, "unavailable");
        check(
          (await unavailable.count()) === 1 && /Not saved — this browser's storage is unavailable/.test(await unavailable.innerText()),
          `B1.3e ${label}: the app runs in memory and says the session is not saved`,
        );
        await loadDemo(page);
        await mark(page, "true positive", 0);
        check((await overviewStats(page)).tp === 1 && (await notSavedPill(page).count()) === 1, `B1.3e ${label}: curating works, Not saved stays`);
        const json = await exportSession(page);
        check(!!json && JSON.parse(json).events.length === 24, `B1.3e ${label}: the session can be downloaded`);
        check(errors.filter((e) => !/IndexedDB load failed/.test(e)).length === 0, `B1.3e ${label}: no JS error`, errors[0] || "");
      },
      { demo: false },
    );
  }



} finally {
  await browser.close();
  stopServer();
}

finish();
