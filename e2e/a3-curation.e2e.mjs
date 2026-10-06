/* Browser checks for the event → sample curation rules (src/curation.js).

   Every path that changes an event evaluation must leave the target
   sample where the rule puts it, whatever the order of the clicks:
   any TP → Contaminated (+ Suppress), else any Uncertain → Uncertain,
   else any FP → Not contaminated, all pending → nothing automatic; and a
   value the curator set by hand is never changed. Each scenario below
   replays, on the demo, a sequence that used to end elsewhere.

   The sample state is read back from the session the app autosaves to
   IndexedDB: it is exactly what a reload restores, automatic flags
   included. User-visible counts come from the tabs themselves.

   Usage:  npm run build && node e2e/a3-curation.e2e.mjs
           (or through e2e/run-all.mjs; BASE_URL skips the server) */

import {
  startServer,
  stopServer,
  launchBrowser,
  newPage,
  loadDemo,
  openTab,
  overviewStats,
  check,
  finish,
  tsvRows,
} from "./harness.mjs";

const demoEvents = tsvRows("public/demo/contamination_events.tsv");
const targets = new Set(demoEvents.map((c) => c[1]));
const NC3_SOURCES = demoEvents.filter((c) => c[1] === "NC3").map((c) => c[0]);

/** The sample curation stored by the app, once the autosave has caught
    up with everything done so far (it is debounced by one second). */
async function storedCuration(page) {
  const since = await page.evaluate(() => Date.now());
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const main = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open("crocodeel-interpreter");
          req.onerror = () => resolve(null);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("kv")) return resolve(null);
            const get = db.transaction("kv", "readonly").objectStore("kv").get("main");
            get.onerror = () => resolve(null);
            get.onsuccess = () => resolve(get.result || null);
          };
        }),
    );
    if (main && Date.parse(main.savedAt) > since) {
      return main.sampleCuration || {};
    }
  }
  throw new Error("the session was not autosaved within 10 s");
}

const show = (entry) => JSON.stringify(entry ?? null);
const isAutoContaminated = (c) =>
  c?.verdict === "contaminated" &&
  c.verdictAuto === true &&
  c.action === "suppress" &&
  c.actionAuto === true;

const VERDICT_BUTTON = {
  tp: "mark as true positive",
  fp: "mark as false positive",
  u: "mark as uncertain",
};
/** Click a quick evaluation button on the Events-table row of the event
    source → target. The buttons toggle: clicking the active one sets the
    event back to pending. */
async function clickEvent(page, source, target, kind) {
  const title = VERDICT_BUTTON[kind];
  const idx = await page.evaluate(
    ([s, t, title]) =>
      [...document.querySelectorAll(`button[title="${title}"]`)].findIndex((b) => {
        const cells = [...b.closest("tr").querySelectorAll("td")].map((td) =>
          td.innerText.trim().split(/\s+/)[0],
        );
        const si = cells.indexOf(s);
        return si >= 0 && cells.indexOf(t, si + 1) > si;
      }),
    [source, target, title],
  );
  if (idx < 0) throw new Error(`no Events-table row for ${source} → ${target}`);
  await page.locator(`button[title="${title}"]`).nth(idx).click();
  await page.waitForTimeout(150);
}

async function openBulkDialog(page) {
  await openTab(page, "Events");
  await page.locator('button[aria-label="Bulk apply evaluation"]').first().click();
  await page.getByText(/Action on samples targeted/i).waitFor({ timeout: 20000 });
  return page
    .locator("div")
    .filter({ has: page.getByText(/Action on samples targeted/i) })
    .filter({ has: page.getByRole("button", { name: /^Apply to \d+ events?$/ }) })
    .last();
}

/** Bulk-apply an evaluation to every event with the dialog's default
    sample options (Automatic). `overwrite` unticks "don't overwrite
    previous evaluations" so already evaluated events are included. */
async function bulkEvaluate(page, label, { overwrite = false } = {}) {
  const dialog = await openBulkDialog(page);
  await dialog.getByRole("button", { name: new RegExp(`^${label}$`) }).first().click();
  if (overwrite) {
    const box = dialog
      .locator("label")
      .filter({ hasText: /previous evaluations/i })
      .locator('input[type="checkbox"]');
    if (await box.isChecked()) await box.uncheck();
  }
  await dialog.getByRole("button", { name: /^Apply to \d+ events?$/ }).click();
  await page.getByRole("button", { name: /^Apply to \d+$/ }).click();
  await page.waitForTimeout(600);
}

async function negativeControlPreset(page) {
  await openBulkDialog(page);
  await page
    .getByRole("button", { name: /Mark all events targeting a negative control as TP/i })
    .click();
  await page.getByRole("button", { name: /^Mark \d+ as TP$/ }).click();
  await page.waitForTimeout(600);
}

await startServer();
const browser = await launchBrowser();
try {
  /* (a) Bulk TP with the dialog's defaults now reaches every target, and
     rejecting one event of a target that still has TP events changes
     nothing — it used to be what created the suppression. */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadDemo(page);
    await bulkEvaluate(page, "True positive");
    let sc = await storedCuration(page);
    const synced = [...targets].filter((t) => isAutoContaminated(sc[t]));
    check(
      synced.length === targets.size,
      "(a) bulk TP with Automatic targets makes every target Contaminated + Suppress",
      `${synced.length} of ${targets.size}`,
    );
    await openTab(page, "Events");
    await clickEvent(page, "60D38", "63D9", "fp");
    sc = await storedCuration(page);
    check(
      isAutoContaminated(sc["63D9"]),
      "(a) an FP on one event of 63D9 leaves it Contaminated (three TP remain)",
      show(sc["63D9"]),
    );
    const s = await overviewStats(page);
    check(s.suppress === targets.size, "(a) Overview counts every target to suppress", `suppress=${s.suppress}`);
    check(errors.length === 0, "(a) no JS error", errors[0] || "");
    await ctx.close();
  }

  /* (b) An automatic Not contaminated must not survive the NC preset. */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadDemo(page);
    await openTab(page, "Events");
    await clickEvent(page, "82D361", "NC3", "fp");
    let sc = await storedCuration(page);
    check(
      sc.NC3?.verdict === "correct" && sc.NC3.verdictAuto === true,
      "(b) an FP on 82D361 → NC3 makes NC3 automatically Not contaminated",
      show(sc.NC3),
    );
    await negativeControlPreset(page);
    sc = await storedCuration(page);
    check(
      isAutoContaminated(sc.NC3),
      "(b) the NC preset then makes NC3 Contaminated + Suppress",
      show(sc.NC3),
    );
    const s = await overviewStats(page);
    check(s.suppress === 1, "(b) Overview: one sample to suppress", `suppress=${s.suppress}`);
    check(errors.length === 0, "(b) no JS error", errors[0] || "");
    await ctx.close();
  }

  /* (c) What the NC preset sets is automatic: rejecting the events takes
     it back. */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadDemo(page);
    await negativeControlPreset(page);
    let sc = await storedCuration(page);
    check(isAutoContaminated(sc.NC3), "(c) the NC preset makes NC3 Contaminated + Suppress (automatic)", show(sc.NC3));
    await openTab(page, "Events");
    for (const src of NC3_SOURCES) await clickEvent(page, src, "NC3", "fp");
    sc = await storedCuration(page);
    check(
      sc.NC3?.verdict === "correct" && sc.NC3.verdictAuto === true && sc.NC3.action == null,
      "(c) FP on all three NC3 events makes NC3 Not contaminated, without Suppress",
      show(sc.NC3),
    );
    const s = await overviewStats(page);
    check(s.suppress === 0, "(c) Overview: nothing left to suppress", `suppress=${s.suppress}`);
    check(errors.length === 0, "(c) no JS error", errors[0] || "");
    await ctx.close();
  }

  /* (d) Back to pending leaves no automatic verdict behind. */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadDemo(page);
    await openTab(page, "Events");
    await clickEvent(page, "63D250", "63D9", "fp");
    await clickEvent(page, "63D250", "63D9", "fp"); // toggles back to pending
    let sc = await storedCuration(page);
    check(sc["63D9"] === undefined, "(d) F then P on 63D250 → 63D9 leaves 63D9 without a verdict", show(sc["63D9"]));
    await clickEvent(page, "63D250", "63D9", "u");
    sc = await storedCuration(page);
    check(sc["63D9"]?.verdict === "uncertain", "(d) U makes 63D9 Uncertain", show(sc["63D9"]));
    await clickEvent(page, "63D250", "63D9", "u");
    sc = await storedCuration(page);
    check(sc["63D9"] === undefined, "(d) U then P leaves 63D9 without a verdict", show(sc["63D9"]));
    // The new rule on a mix: one FP and one Uncertain → Uncertain, in
    // either order (the old rule echoed the most recent click).
    await clickEvent(page, "63D250", "63D9", "fp");
    await clickEvent(page, "58D256", "63D9", "u");
    sc = await storedCuration(page);
    const fpThenU = sc["63D9"];
    await clickEvent(page, "63D250", "63D9", "fp");
    await clickEvent(page, "58D256", "63D9", "u");
    await clickEvent(page, "60D38", "63D9", "u");
    await clickEvent(page, "79M", "63D9", "fp");
    sc = await storedCuration(page);
    const uThenFp = sc["63D9"];
    check(
      [fpThenU, uThenFp].every((c) => c?.verdict === "uncertain" && c.verdictAuto === true),
      "(d) FP + Uncertain on 63D9 → Uncertain, in either order",
      `${show(fpThenU)} / ${show(uThenFp)}`,
    );
    check(errors.length === 0, "(d) no JS error", errors[0] || "");
    await ctx.close();
  }

  /* (e) A bulk FP over TP events removes the automatic suppressions. */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadDemo(page);
    await openTab(page, "Events");
    const buttons = page.locator('button[title="mark as true positive"]');
    const n = await buttons.count();
    for (let i = 0; i < n; i++) {
      await buttons.nth(i).click();
      await page.waitForTimeout(100);
    }
    let s = await overviewStats(page);
    check(s.suppress === targets.size, "(e) one TP click per event flags every target", `suppress=${s.suppress}`);
    await bulkEvaluate(page, "False positive", { overwrite: true });
    const sc = await storedCuration(page);
    const left = [...targets].filter((t) => sc[t]?.action);
    const correct = [...targets].filter((t) => sc[t]?.verdict === "correct" && sc[t].verdictAuto);
    check(left.length === 0, "(e) bulk FP over them removes every automatic Suppress", `${left.length} left: ${left.join(", ")}`);
    check(correct.length === targets.size, "(e) …and makes every target Not contaminated", `${correct.length} of ${targets.size}`);
    s = await overviewStats(page);
    check(s.fp === demoEvents.length && s.suppress === 0, "(e) Overview: all FP, nothing to suppress", `fp=${s.fp} suppress=${s.suppress}`);
    check(errors.length === 0, "(e) no JS error", errors[0] || "");
    await ctx.close();
  }
} finally {
  await browser.close();
  stopServer();
}
finish();
