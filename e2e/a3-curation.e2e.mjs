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
           (or through e2e/run-all.mjs; BASE_URL skips the server,
           E2E_ONLY=<regex> runs only the matching scenarios) */

import { readFileSync } from "node:fs";
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
    up with everything done so far. Saves are debounced by one second
    after the last change; when nothing changed, none comes and the
    stored session is already current. */
async function storedCuration(page) {
  const since = await page.evaluate(() => Date.now());
  let latest = null;
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
    latest = main;
    if (i >= 12 && latest) return latest.sampleCuration || {};
  }
  throw new Error("no autosaved session found");
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

/** Click a node of the Network graph; resolves once its popover is open. */
async function openNodePopover(page, id) {
  await openTab(page, "Network");
  await page.waitForTimeout(1200);
  // Dispatched on the circle itself: the nodes overlap their labels and
  // edges, so a click at coordinates can land on a neighbour.
  const found = await page.evaluate((id) => {
    const label = [...document.querySelectorAll("svg g > text")].find(
      (t) => t.textContent.trim() === id,
    );
    const circle = label?.parentElement.querySelector("circle");
    if (!circle) return false;
    const r = circle.getBoundingClientRect();
    circle.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
      }),
    );
    return true;
  }, id);
  if (!found) throw new Error(`no Network node labelled ${id}`);
  await page.getByText(/^Apply to events targeting$/i).waitFor({ timeout: 10000 });
  return page
    .locator("div")
    .filter({ has: page.getByText(/^Apply to events targeting$/i) })
    .filter({ has: page.getByRole("button", { name: /^Apply$/ }) })
    .last();
}

/** The Samples tab's bulk dialog. */
async function openSampleBulkDialog(page) {
  await openTab(page, "Samples");
  await page
    .locator('button[aria-label^="Bulk-apply a sample-level verdict"]')
    .first()
    .click();
  await page.getByText(/^New action$/).waitFor({ timeout: 20000 });
  return page
    .locator("div")
    .filter({ has: page.getByText(/^New action$/) })
    .filter({ has: page.getByRole("button", { name: /^Apply to \d+$/ }) })
    .last();
}

/** The Samples-tab row of sample `id`. */
function sampleRow(page, id) {
  return page
    .locator("tr")
    .filter({ has: page.locator('button[aria-label="Set verdict to Pending"]') })
    .filter({ has: page.getByText(id, { exact: true }) });
}

/** The info dialog opened by reopening a session saved by an earlier
    version: its text, once closed; null when none is open. */
async function takeSessionNotice(page) {
  const title = page.getByText("Session brought up to date", { exact: true });
  if ((await title.count()) === 0) return null;
  const text = await title.locator("xpath=..").innerText();
  await page.getByRole("button", { name: /^Close$/ }).last().click();
  await page.waitForTimeout(200);
  return text;
}

/** Import a session JSON through the files bar. Returns the text of the
    notice it opened (closed here), or null. */
async function importSession(page, session) {
  await page
    .locator('input[accept*="json"]')
    .first()
    .setInputFiles({
      name: "session.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(session)),
    });
  await page.waitForTimeout(1500);
  return takeSessionNotice(page);
}

/** Reload the page (the session comes back from the browser's storage),
    once the autosave — debounced by a second after the last change, a
    tab switch included — has written everything. Returns the text of
    the notice it opened (closed here), or null. */
async function reloadSession(page) {
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  return takeSessionNotice(page);
}

/** Click a download button and return the downloaded file's text. */
async function download(page, name) {
  const [file] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.getByRole("button", { name }).first().click(),
  ]);
  return readFileSync(await file.path(), "utf8");
}

/** Rewrite fields of the stored session (IndexedDB), as another version
    of the app would have saved it: `set` replaces fields, `remove`
    deletes them. */
async function editStoredSession(page, { set = {}, remove = [] }) {
  await page.evaluate(
    ([set, remove]) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("crocodeel-interpreter");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const store = req.result.transaction("kv", "readwrite").objectStore("kv");
          const get = store.get("main");
          get.onsuccess = () => {
            const main = { ...get.result, ...set };
            for (const k of remove) delete main[k];
            const put = store.put(main, "main");
            put.onsuccess = () => resolve();
            put.onerror = () => reject(put.error);
          };
        };
      }),
    [set, remove],
  );
}

/** True when the button exists and is drawn active (filled). */
const isFilled = async (locator) =>
  (await locator.count()) === 1 &&
  locator.evaluate((b) => getComputedStyle(b).backgroundColor !== "rgb(255, 255, 255)");

/** The "N of M samples" of the Export tab's curated abundance card. */
async function curatedCard(page) {
  await openTab(page, "Export");
  const text = await page.locator("body").innerText();
  const m = text.match(/Curated abundance table — (\d+) of (\d+) samples/);
  return m ? { kept: Number(m[1]), total: Number(m[2]) } : null;
}

/** Click a verdict button in the Samples-tab row of `id`. */
async function setSampleVerdictInTable(page, id, label) {
  await openTab(page, "Samples");
  await sampleRow(page, id).locator(`button[aria-label="Set verdict to ${label}"]`).click();
  await page.waitForTimeout(200);
}

await startServer();
const browser = await launchBrowser();

/* One fresh page with the demo per scenario. A scenario that throws is
   reported as a failed check and the others still run. E2E_ONLY=<regex>
   runs only the scenarios whose name matches. */
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
async function scenario(name, run, { demo = true } = {}) {
  if (ONLY && !ONLY.test(name)) return;
  const { ctx, page, errors } = await newPage(browser);
  try {
    if (demo) await loadDemo(page);
    await run(page);
  } catch (e) {
    check(false, `${name} runs to the end`, String(e).split("\n")[0]);
  }
  check(errors.length === 0, `${name} no JS error`, errors[0] || "");
  await ctx.close();
}

try {
  /* (a) Bulk TP with the dialog's defaults now reaches every target, and
     rejecting one event of a target that still has TP events changes
     nothing — it used to be what created the suppression. */
  await scenario("(a)", async (page) => {
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
  });

  /* (b) An automatic Not contaminated must not survive the NC preset. */
  await scenario("(b)", async (page) => {
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
  });

  /* (c) What the NC preset sets is automatic: rejecting the events takes
     it back. */
  await scenario("(c)", async (page) => {
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
  });

  /* (d) Back to pending leaves no automatic verdict behind. */
  await scenario("(d)", async (page) => {
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
  });

  /* (e) A bulk FP over TP events removes the automatic suppressions. */
  await scenario("(e)", async (page) => {
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
  });
  /* A session saved by the previous version keeps the automatic values
     its click order produced; on load they are recomputed with the rule
     (manual values untouched). */
  await scenario(
    "(a)-(e) old session",
    async (page) => {
      const event = (id, source, target, verdict) => ({
        id,
        source,
        target,
        contamination_rate: 0.1,
        probability: 0.9,
        introduced_species: [],
        verdict,
        notes: "",
      });
      const notice = await importSession(page, {
        schema_version: 2,
        events: [
          event(0, "S1", "T1", "pending"),
          event(1, "S2", "T2", "true_positive"),
          event(2, "S3", "T3", "false_positive"),
          event(3, "S4", "T3", "false_positive"),
          event(4, "S5", "T4", "false_positive"),
        ],
        sample_curation: {
          T1: { verdict: "correct", verdictAuto: true }, // F then P
          // T2: a bulk TP never reached it
          T3: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true }, // bulk FP over TP
          T4: { verdict: "contaminated", action: "suppress" }, // by hand: kept
        },
      });
      const sc = await storedCuration(page);
      check(
        sc.T1 === undefined &&
          isAutoContaminated(sc.T2) &&
          sc.T3?.verdict === "correct" && sc.T3.verdictAuto === true && sc.T3.action == null &&
          sc.T4?.verdict === "contaminated" && !sc.T4.verdictAuto && sc.T4.action === "suppress",
        "an imported session's automatic values are recomputed, manual ones kept",
        JSON.stringify(sc),
      );
      check(
        /Now to suppress \(1\): T2\b/.test(notice || "") &&
          /No longer suppressed \(1\): T3\b/.test(notice || ""),
        "…and a notice lists what the curated table now drops differently",
        notice || "no notice",
      );
      // Same through a reload: write stale values straight into the
      // stored session, as an older version would have left them (no
      // curation version).
      await editStoredSession(page, {
        set: {
          sampleCuration: {
            T1: { verdict: "correct", verdictAuto: true },
            T3: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true },
          },
        },
        remove: ["sampleCurationVersion"],
      });
      const reloadNotice = await reloadSession(page);
      const restored = await storedCuration(page);
      check(
        restored.T1 === undefined &&
          isAutoContaminated(restored.T2) &&
          restored.T3?.verdict === "correct" && restored.T3.action == null,
        "a session restored from the browser's storage is recomputed the same way",
        JSON.stringify(restored),
      );
      check(
        /Now to suppress \(1\): T2\b/.test(reloadNotice || ""),
        "…with the same notice",
        reloadNotice || "no notice",
      );
      // Once saved again, it is a current session: no notice any more.
      check((await reloadSession(page)) === null, "…shown once: the next reload opens no notice");
    },
    { demo: false },
  );

  /* A3.2 "Don't overwrite …" protects what the curator set by hand,
     not the automatic values: an automatic Suppress must not make a
     bulk Keep skip the sample. Events dialog first. */
  await scenario("A3.2 events dialog", async (page) => {
    await openTab(page, "Events");
    await clickEvent(page, "63D250", "63D9", "tp"); // 63D9: automatic Contaminated + Suppress
    const dialog = await openBulkDialog(page);
    await dialog.getByRole("button", { name: /^True positive$/ }).first().click();
    await dialog.getByRole("button", { name: /^Keep$/ }).first().click();
    await dialog.getByRole("button", { name: /^Apply to \d+ events?$/ }).click();
    await page.getByRole("button", { name: /^Apply to \d+$/ }).click();
    await page.waitForTimeout(600);
    const sc = await storedCuration(page);
    check(
      sc["63D9"]?.action === "keep" && !sc["63D9"].actionAuto,
      "A3.2 bulk Keep (don't overwrite on) replaces 63D9's automatic Suppress",
      show(sc["63D9"]),
    );
  });

  /* A3.2, the Samples tab's own bulk dialog. */
  await scenario("A3.2 Samples dialog", async (page) => {
    await openTab(page, "Events");
    await clickEvent(page, "63D250", "63D9", "tp"); // automatic Contaminated + Suppress
    await clickEvent(page, "63D29", "63D40", "tp");
    await setSampleVerdictInTable(page, "63D40", "Uncertain"); // by hand
    const dialog = await openSampleBulkDialog(page);
    await dialog.getByRole("button", { name: /^Not contaminated$/ }).last().click();
    await dialog.getByRole("button", { name: /^Keep$/ }).last().click();
    await dialog.getByRole("button", { name: /^Apply to \d+$/ }).click();
    await page.waitForTimeout(600);
    const sc = await storedCuration(page);
    check(
      sc["63D9"]?.verdict === "correct" &&
        !sc["63D9"].verdictAuto &&
        sc["63D9"].action === "keep" &&
        !sc["63D9"].actionAuto,
      "A3.2 Samples bulk dialog overwrites 63D9's automatic values",
      show(sc["63D9"]),
    );
    check(
      sc["63D40"]?.verdict === "uncertain" && !sc["63D40"].verdictAuto && sc["63D40"].action == null,
      "A3.2 Samples bulk dialog leaves 63D40's verdict set by hand alone",
      show(sc["63D40"]),
    );
  });
  /* A3.3 The Network node popover writes the sample verdict / action
     the curator picks with the events, on confirmation: cancelling
     leaves the sample as it was. */
  await scenario("A3.3", async (page) => {
    const pickContaminatedSuppress = async (pop) => {
      await pop.getByRole("button", { name: /^Contaminated$/ }).click();
      await pop.getByRole("button", { name: /^Suppress$/ }).click();
    };
    let pop = await openNodePopover(page, "NC3");
    await pickContaminatedSuppress(pop); // TP, NC3 Contaminated + Suppress by hand
    await pop.getByRole("button", { name: /^Apply$/ }).click();
    await page.getByRole("button", { name: /^Apply to \d+$/ }).waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: /^Cancel$/ }).last().click();
    let sc = await storedCuration(page);
    let s = await overviewStats(page);
    check(
      sc.NC3 === undefined && s.tp === 0 && s.suppress === 0,
      "A3.3 Network → NC3 → Apply → Cancel leaves NC3 and its events untouched",
      `NC3=${show(sc.NC3)} tp=${s.tp} suppress=${s.suppress}`,
    );
    pop = await openNodePopover(page, "NC3");
    await pickContaminatedSuppress(pop);
    await pop.getByRole("button", { name: /^Apply$/ }).click();
    await page.getByRole("button", { name: /^Apply to \d+$/ }).click();
    await page.waitForTimeout(600);
    sc = await storedCuration(page);
    s = await overviewStats(page);
    check(
      sc.NC3?.verdict === "contaminated" &&
        !sc.NC3.verdictAuto &&
        sc.NC3.action === "suppress" &&
        !sc.NC3.actionAuto &&
        s.tp === NC3_SOURCES.length,
      "A3.3 …and confirming applies the events and NC3's verdict / action",
      `NC3=${show(sc.NC3)} tp=${s.tp}`,
    );
  });
  /* The Network popover and the Explore-new-pairs form follow the rule
     by default (target verdict and action Automatic): what they set can
     be taken back by later evaluations, exactly as after clicks. They
     used to pre-select Contaminated + Suppress (Not contaminated for an
     FP) and write them by hand — symptom (c) again, through the
     Network. */
  await scenario("Network and Explore defaults", async (page) => {
    let pop = await openNodePopover(page, "NC3");
    await pop.getByRole("button", { name: /^Apply$/ }).click(); // TP, defaults
    await page.getByRole("button", { name: /^Apply to \d+$/ }).click();
    await page.waitForTimeout(600);
    let sc = await storedCuration(page);
    check(isAutoContaminated(sc.NC3), "Network → NC3 → Apply (defaults) makes NC3 Contaminated + Suppress, automatic", show(sc.NC3));
    await openTab(page, "Events");
    for (const src of NC3_SOURCES) await clickEvent(page, src, "NC3", "fp");
    sc = await storedCuration(page);
    let s = await overviewStats(page);
    check(
      sc.NC3?.verdict === "correct" && sc.NC3.verdictAuto === true && sc.NC3.action == null && s.suppress === 0,
      "…and FP on its three events by click makes it Not contaminated, nothing to suppress",
      `${show(sc.NC3)} suppress=${s.suppress}`,
    );
    pop = await openNodePopover(page, "63D9");
    await pop.getByRole("button", { name: /^FP$/ }).click();
    await pop.getByRole("button", { name: /^Apply$/ }).click();
    await page.getByRole("button", { name: /^Apply to \d+$/ }).click();
    await page.waitForTimeout(600);
    sc = await storedCuration(page);
    check(
      sc["63D9"]?.verdict === "correct" && sc["63D9"].verdictAuto === true,
      "Network → 63D9 → FP (defaults) makes 63D9 Not contaminated, automatic",
      show(sc["63D9"]),
    );
    await openTab(page, "Events");
    await clickEvent(page, "60D38", "63D9", "tp");
    sc = await storedCuration(page);
    check(isAutoContaminated(sc["63D9"]), "…so a later TP click makes it Contaminated + Suppress", show(sc["63D9"]));

    await openTab(page, "Scatter");
    await page.getByRole("button", { name: /^Explore new pairs$/ }).first().click();
    await page.waitForTimeout(800);
    const pick = async (placeholder, id) => {
      const input = page.locator(`input[placeholder="${placeholder}"]`);
      await input.click();
      await input.fill(id);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
    };
    await pick("Type to search… e.g. ERS848718", "63D250");
    await pick("Pick from neighbors / same subject / others…", "40D89");
    await page.getByRole("button", { name: /Save as new contamination event/ }).click(); // TP, defaults
    await page.waitForTimeout(600);
    sc = await storedCuration(page);
    check(isAutoContaminated(sc["40D89"]), "Explore new pairs 63D250 → 40D89 (TP, defaults) makes 40D89 Contaminated + Suppress, automatic", show(sc["40D89"]));
    await openTab(page, "Events");
    await page.locator('tr[data-event-row="manual-1"] button[title="mark as false positive"]').click();
    await page.waitForTimeout(300);
    sc = await storedCuration(page);
    s = await overviewStats(page);
    check(
      sc["40D89"]?.verdict === "correct" && sc["40D89"].action == null && s.suppress === 1,
      "…and FP on that event takes the Suppress back (63D9 is the one left)",
      `${show(sc["40D89"])} suppress=${s.suppress}`,
    );
  });

  /* A3.4 A Suppress set by hand that survives "Not contaminated" stays
     visible in the Samples tab (flagged), and can be cleared. */
  await scenario("A3.4", async (page) => {
    let pop = await openNodePopover(page, "63D9");
    await pop.getByRole("button", { name: /^Contaminated$/ }).click(); // TP + Contaminated + Suppress by hand
    await pop.getByRole("button", { name: /^Suppress$/ }).click();
    await pop.getByRole("button", { name: /^Apply$/ }).click();
    await page.getByRole("button", { name: /^Apply to \d+$/ }).click();
    await page.waitForTimeout(500);
    pop = await openNodePopover(page, "63D9");
    await pop.getByRole("button", { name: /^FP$/ }).click();
    await pop.getByRole("button", { name: /^Not contaminated$/ }).click(); // by hand; the action is not offered
    await pop.locator("label").filter({ hasText: /previous evaluations/i }).locator("input").uncheck();
    await pop.getByRole("button", { name: /^Apply$/ }).click();
    await page.getByRole("button", { name: /^Apply to \d+$/ }).click();
    await page.waitForTimeout(500);
    let sc = await storedCuration(page);
    check(
      sc["63D9"]?.verdict === "correct" && sc["63D9"].action === "suppress" && !sc["63D9"].actionAuto,
      "A3.4 the repro leaves 63D9 Not contaminated with its manual Suppress",
      show(sc["63D9"]),
    );
    await openTab(page, "Samples");
    const row = sampleRow(page, "63D9");
    const clear = row.locator('button[aria-label="Clear suppress on 63D9"]');
    const flag = row.locator('[aria-label="Suppressed but not marked Contaminated"]');
    check((await clear.count()) === 1, "A3.4 the Samples row shows 63D9's Suppress");
    check((await flag.count()) === 1, "A3.4 …flagged: suppressed but not Contaminated");
    let card = await curatedCard(page);
    check(card?.kept === card?.total - 1, "A3.4 Export drops 63D9 as the row shows", JSON.stringify(card));
    await openTab(page, "Samples");
    await clear.click();
    await page.waitForTimeout(300);
    sc = await storedCuration(page);
    check(
      sc["63D9"]?.verdict === "correct" && sc["63D9"].action == null,
      "A3.4 clearing it from the row removes the Suppress",
      show(sc["63D9"]),
    );
    check((await flag.count()) === 0, "A3.4 …and the flag");
    card = await curatedCard(page);
    check(card?.kept === card?.total, "A3.4 Export keeps every sample again", JSON.stringify(card));

    // Automatic values are marked; clicking one makes it the curator's.
    await openTab(page, "Events");
    await clickEvent(page, "63D29", "63D40", "tp");
    await openTab(page, "Samples");
    const row40 = sampleRow(page, "63D40");
    check(
      (await row40.locator("[data-auto-mark]").count()) === 2,
      "A3.4 63D40's automatic verdict and Suppress are tagged auto",
    );
    await row40.locator('button[aria-label="Suppress 63D40"]').click();
    await page.waitForTimeout(300);
    sc = await storedCuration(page);
    check(
      sc["63D40"]?.action === "suppress" && !sc["63D40"].actionAuto && sc["63D40"].verdictAuto === true,
      "A3.4 clicking the automatic Suppress makes it a manual one",
      show(sc["63D40"]),
    );
  });
  /* The Keep / Suppress chips mean the same in the Events table, the
     gallery cards and the Samples tab. A click on an automatic action
     makes it the curator's own: it used to "clear" it, and the rule put
     it straight back, so nothing happened. A click on the curator's own
     action hands the sample back to the rule, which on a Contaminated
     sample means Suppress — the label says so (a "Clear keep" used to
     suppress the sample silently). A Suppress on a target that is not
     Contaminated is shown, flagged, in the Events table and the gallery
     as well (A3.4). */
  await scenario("action chips", async (page) => {
    await openTab(page, "Events");
    await clickEvent(page, "63D250", "63D9", "tp"); // 63D9: automatic Contaminated + Suppress
    const row = page.locator('tr[data-event-row="0"]'); // 63D250 → 63D9
    const chip = (where, label) => where.locator(`button[aria-label="${label}"]`);
    const title = async (where, label) =>
      (await chip(where, label).count()) === 1 ? chip(where, label).getAttribute("title") : null;
    check(
      /automatic/i.test((await title(row, "Suppress 63D9")) || ""),
      "Events table: 63D9's automatic Suppress is labelled automatic",
      String(await title(row, "Suppress 63D9")),
    );
    await chip(row, "Suppress 63D9").click();
    await page.waitForTimeout(300);
    let sc = await storedCuration(page);
    check(
      sc["63D9"]?.action === "suppress" && !sc["63D9"].actionAuto,
      "Events table: clicking it makes the Suppress the curator's own",
      show(sc["63D9"]),
    );
    await chip(row, "Keep 63D9").click();
    await page.waitForTimeout(300);
    let card = await curatedCard(page);
    check(card?.kept === card?.total, "Events table: Keep keeps 63D9 in the curated table", JSON.stringify(card));
    await openTab(page, "Events");
    const clearKeep = (await title(row, "Clear keep on 63D9")) || "";
    check(
      /automatic Suppress/.test(clearKeep),
      "Events table: 'Clear keep' on Contaminated 63D9 says it goes back to the automatic Suppress",
      clearKeep,
    );
    await chip(row, "Clear keep on 63D9").click();
    await page.waitForTimeout(300);
    sc = await storedCuration(page);
    check(isAutoContaminated(sc["63D9"]), "…and does", show(sc["63D9"]));

    // Suppress set by hand on a target then marked Not contaminated.
    await chip(row, "Suppress 63D9").click(); // automatic → the curator's own
    await row.locator(`button[title="Set 63D9's sample-level verdict to Not contaminated"]`).click();
    await page.waitForTimeout(300);
    sc = await storedCuration(page);
    check(
      sc["63D9"]?.verdict === "correct" && sc["63D9"].action === "suppress" && !sc["63D9"].actionAuto,
      "63D9 is Not contaminated with a Suppress set by hand",
      show(sc["63D9"]),
    );
    check(
      (await chip(row, "Clear suppress on 63D9").count()) === 1 &&
        (await row.locator('[aria-label="Suppressed but not marked Contaminated"]').count()) === 1,
      "Events table: that Suppress is shown, flagged, instead of a dash",
    );
    card = await curatedCard(page);
    check(card?.kept === card?.total - 1, "…and the curated table drops 63D9, as shown", JSON.stringify(card));

    // The gallery card's popover: same chips, same meaning.
    await openTab(page, "Scatter");
    const nc3 = page.locator('[data-event-card="5"]'); // 83D88 → NC3
    await nc3.waitFor({ timeout: 20000 });
    await nc3.locator('button[title="mark as true positive"]').click();
    await page.waitForTimeout(500);
    check(
      /automatic/i.test((await title(nc3, "Suppress NC3")) || ""),
      "gallery: NC3's automatic Suppress is labelled automatic",
      String(await title(nc3, "Suppress NC3")),
    );
    await chip(nc3, "Suppress NC3").click();
    await page.waitForTimeout(300);
    sc = await storedCuration(page);
    check(
      sc.NC3?.action === "suppress" && !sc.NC3.actionAuto,
      "gallery: clicking it makes the Suppress the curator's own",
      show(sc.NC3),
    );
    const s = await overviewStats(page);
    check(s.suppress === 2, "Overview: 63D9 and NC3 to suppress", `suppress=${s.suppress}`);
  });

  /* A3.7 A legacy session (actions stored on the events) whose events
     disagree about one target migrates to Suppress, as the legacy app
     read it. */
  await scenario(
    "A3.7",
    async (page) => {
      const legacyEvent = (id, source, action) => ({
        id,
        source,
        target: "T1",
        contamination_rate: 0.1,
        probability: 0.9,
        introduced_species: [],
        verdict: "true_positive",
        action,
        notes: "",
      });
      const session = {
        schema_version: 1,
        events: [legacyEvent(0, "S1", "keep"), legacyEvent(1, "S2", "suppress")],
      };
      await importSession(page, session);
      const sc = await storedCuration(page);
      check(
        sc.T1?.action === "suppress",
        "A3.7 keep + suppress on one target migrates to Suppress",
        show(sc.T1),
      );
      const s = await overviewStats(page);
      check(s.suppress === 1, "A3.7 Overview: one sample to suppress", `suppress=${s.suppress}`);
    },
    { demo: false },
  );
  /* A3.5 A never-targeted sample is Not contaminated + Keep by default:
     derived, automatic, the same in every tab whether or not the Samples
     tab was visited, and not a Keep decision. 63D250 is a source only. */
  await scenario("A3.5", async (page) => {
    let s = await overviewStats(page);
    check(s.keep === 0, "A3.5 Overview: 0 samples to keep after loading", `keep=${s.keep}`);
    await openTab(page, "Samples");
    const row = sampleRow(page, "63D250");
    check(
      (await isFilled(row.locator('button[aria-label="Set verdict to Not contaminated"]'))) &&
        (await isFilled(row.locator('button[aria-label="Keep 63D250"]'))),
      "A3.5 the Samples tab shows never-targeted 63D250 Not contaminated / Keep",
    );
    check(
      (await row.locator("[data-auto-mark]").count()) === 2,
      "A3.5 …both tagged automatic",
    );
    let sc = await storedCuration(page);
    check(Object.keys(sc).length === 0, "A3.5 visiting Samples stores nothing", `${Object.keys(sc).length} entries`);
    s = await overviewStats(page);
    check(s.keep === 0, "A3.5 Overview: still 0 to keep after visiting Samples", `keep=${s.keep}`);
    await openTab(page, "Export");
    const text = await page.locator("body").innerText();
    check(/To keep\s*0\b/i.test(text), "A3.5 Export: 0 to keep", text.match(/To keep\s*\d+/i)?.[0] || "");
    // The default does not block the Contaminated → Suppress pairing.
    await setSampleVerdictInTable(page, "63D250", "Contaminated");
    sc = await storedCuration(page);
    check(
      sc["63D250"]?.verdict === "contaminated" && sc["63D250"].action === "suppress",
      "A3.5 marking 63D250 Contaminated pairs it with Suppress",
      show(sc["63D250"]),
    );
    // Network colours read the same view: 63D250 is no longer grey.
    s = await overviewStats(page);
    check(s.suppress === 1 && s.keep === 0, "A3.5 Overview: 1 to suppress, 0 to keep", `suppress=${s.suppress} keep=${s.keep}`);
  });

  /* A3.5 A session saved while the Samples tab stamped never-targeted
     samples as Not contaminated + Keep (manual) loses those stamps. */
  await scenario(
    "A3.5 old session",
    async (page) => {
      const event = (id, source, target) => ({
        id,
        source,
        target,
        contamination_rate: 0.1,
        probability: 0.9,
        introduced_species: [],
        verdict: "pending",
        notes: "",
      });
      await importSession(page, {
        schema_version: 2,
        events: [event(0, "S1", "T1"), event(1, "S2", "T1")],
        sample_curation: {
          S1: { verdict: "correct", action: "keep" }, // stamp
          S2: { verdict: "correct", action: "keep", notes: "checked" }, // annotated: kept
          T1: { verdict: "correct", action: "keep" }, // targeted: a decision
        },
      });
      const sc = await storedCuration(page);
      check(
        sc.S1 === undefined && sc.S2?.notes === "checked" && sc.T1?.action === "keep",
        "A3.5 an old stamp is dropped; annotated and targeted entries are kept",
        JSON.stringify(sc),
      );
      const s = await overviewStats(page);
      check(s.keep === 2, "A3.5 Overview: the two remaining Keep decisions", `keep=${s.keep}`);
    },
    { demo: false },
  );
  /* A3.5 Not contaminated + Keep is also what a curator writes on
     purpose on a never-targeted sample. Saved by this version, it is a
     decision: it must survive a reload and a session export / import
     (only sessions saved by an earlier version lose their stamps). */
  await scenario("A3.5 decisions survive a reload", async (page) => {
    const mine = { verdict: "correct", action: "keep" };
    await setSampleVerdictInTable(page, "63D250", "Not contaminated");
    await sampleRow(page, "63D250").locator('button[aria-label="Keep 63D250"]').click();
    await page.waitForTimeout(300);
    let sc = await storedCuration(page);
    check(show(sc["63D250"]) === show(mine), "A3.5 63D250 set by hand to Not contaminated + Keep", show(sc["63D250"]));
    let notice = await reloadSession(page);
    sc = await storedCuration(page);
    let s = await overviewStats(page);
    check(
      show(sc["63D250"]) === show(mine) && s.keep === 1 && notice === null,
      "A3.5 …survives a reload (still 1 to keep, no notice)",
      `${show(sc["63D250"])} keep=${s.keep} notice=${notice}`,
    );
    const session = JSON.parse(await download(page, /^Download session$/));
    check(
      session.sample_curation_version === 2 && show(session.sample_curation["63D250"]) === show(mine),
      "A3.5 the session JSON carries it, with its curation version",
      `version=${session.sample_curation_version} ${show(session.sample_curation["63D250"])}`,
    );
    notice = await importSession(page, session);
    sc = await storedCuration(page);
    s = await overviewStats(page);
    check(
      show(sc["63D250"]) === show(mine) && s.keep === 1 && notice === null,
      "A3.5 …and a session export / import",
      `${show(sc["63D250"])} keep=${s.keep} notice=${notice}`,
    );
    // The Samples tab's bulk dialog writes the same entry on every
    // sample it applies to.
    const dialog = await openSampleBulkDialog(page);
    await dialog.getByRole("button", { name: /^Not contaminated$/ }).last().click();
    await dialog.getByRole("button", { name: /^Keep$/ }).last().click();
    await dialog.getByRole("button", { name: /^Apply to \d+$/ }).click();
    await page.waitForTimeout(600);
    const before = (await overviewStats(page)).keep;
    await reloadSession(page);
    const after = (await overviewStats(page)).keep;
    check(
      before > 75 && after === before,
      "A3.5 a bulk Not contaminated + Keep on the Samples tab survives a reload",
      `keep ${before} → ${after}`,
    );
  });

  /* A session saved by the release before this change: removing the
     Suppress of a Contaminated sample left it with no action, and the
     curated table kept it. Reopened now, it is marked Keep — the
     rule must not pair it with Suppress again — and the notice says so,
     along with what the update does change. */
  await scenario("release session", async (page) => {
    await openTab(page, "Events");
    await clickEvent(page, "83D88", "NC3", "tp");
    await clickEvent(page, "63D250", "63D9", "tp");
    await clickEvent(page, "63D29", "63D40", "tp");
    const session = JSON.parse(await download(page, /^Download session$/));
    // As the release saved it: no curation version; NC3's Suppress
    // removed by the curator ("Clear suppress"); 63D40 never reached by
    // the target sync (the bulk-TP bug). Each event carries its target's
    // action, as the release's export wrote it.
    delete session.sample_curation_version;
    session.sample_curation.NC3 = { verdict: "contaminated", verdictAuto: true };
    delete session.sample_curation["63D40"];
    for (const e of session.events) e.action = session.sample_curation[e.target]?.action || null;
    const notice = await importSession(page, session);
    const sc = await storedCuration(page);
    check(
      show(sc.NC3) === show({ verdict: "contaminated", verdictAuto: true, action: "keep" }),
      "release session: NC3, whose Suppress the curator removed, comes back as Keep set by hand",
      show(sc.NC3),
    );
    check(isAutoContaminated(sc["63D9"]), "release session: 63D9 keeps its automatic Suppress", show(sc["63D9"]));
    check(isAutoContaminated(sc["63D40"]), "release session: 63D40 (TP, never synced) is now Contaminated + Suppress", show(sc["63D40"]));
    check(
      /Now to suppress \(1\): 63D40\b/.test(notice || "") &&
        /now marked Keep \(1\): NC3\b/.test(notice || "") &&
        !/No longer suppressed/.test(notice || ""),
      "release session: the notice lists 63D40 (now suppressed) and NC3 (kept, now Keep)",
      notice || "no notice",
    );
    const card = await curatedCard(page);
    check(
      card && card.total - card.kept === 2,
      "release session: the curated table drops 63D9 and 63D40, and still keeps NC3",
      JSON.stringify(card),
    );
  });

  /* A3.6 Keep / suppress counts agree everywhere, and "to suppress" is
     what the curated abundance export drops — whatever the event filter
     of the Export tab. */
  await scenario("A3.6", async (page) => {
    await openTab(page, "Events");
    await clickEvent(page, "63D250", "63D9", "tp"); // 63D9: automatic Suppress
    await setSampleVerdictInTable(page, "63D250", "Contaminated");
    await sampleRow(page, "63D250").locator('button[aria-label="Suppress 63D250"]').click(); // by hand
    await page.waitForTimeout(300);
    const s = await overviewStats(page);
    const card = await curatedCard(page);
    const exportText = await page.locator("body").innerText();
    const exportStat = (re) => Number(exportText.match(re)?.[1] ?? NaN);
    const exp = {
      suppress: exportStat(/To suppress\s*(\d+)/i),
      keep: exportStat(/To keep\s*(\d+)/i),
    };
    check(s.suppress === 2 && s.keep === 0, "A3.6 Overview: 2 to suppress, 0 to keep", `suppress=${s.suppress} keep=${s.keep}`);
    check(exp.suppress === 2 && exp.keep === 0, "A3.6 Export: 2 to suppress, 0 to keep", JSON.stringify(exp));
    check(card && card.total - card.kept === 2, "A3.6 the curated abundance card drops those 2", JSON.stringify(card));
    // A filter on the Export tab narrows the events, not the samples.
    await page.getByPlaceholder("sample id or name…").first().fill("63D29");
    await page.waitForTimeout(600);
    const filtered = await page.locator("body").innerText();
    check(
      Number(filtered.match(/To suppress\s*(\d+)/i)?.[1]) === 2,
      "A3.6 …and still 2 with an events filter on",
      filtered.match(/To suppress\s*\d+/i)?.[0] || "",
    );
    await page.getByPlaceholder("sample id or name…").first().fill("");
    await page.waitForTimeout(400);
    const report = async (label) => {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        page.getByRole("button", { name: label }).first().click(),
      ]);
      return readFileSync(await download.path(), "utf8");
    };
    const eventsHtml = await report(/Download events HTML/i);
    const value = (html, label) =>
      Number(html.match(new RegExp(`>${label}</div><div class="value">(\\d+)<`))?.[1] ?? NaN);
    check(
      value(eventsHtml, "To suppress") === 2 && value(eventsHtml, "To keep") === 0,
      "A3.6 events HTML report: 2 to suppress, 0 to keep",
      `${value(eventsHtml, "To suppress")} / ${value(eventsHtml, "To keep")}`,
    );
    const samplesHtml = await report(/Download samples HTML/i);
    check(
      value(samplesHtml, "Suppress") === 2 && value(samplesHtml, "Keep") === 0,
      "A3.6 samples HTML report: 2 suppress, 0 keep",
      `${value(samplesHtml, "Suppress")} / ${value(samplesHtml, "Keep")}`,
    );
  });
  /* A3.8 Drilling from the Network into one sample of the Samples tab
     is recognised as a drill-in: the row is focused, and the scroll
     position saved when the Samples tab was left is NOT restored over
     it (the drill target used to be read inside a deferred setFilter
     updater, so the return looked like a plain tab switch). */
  await scenario("A3.8", async (page) => {
    await openTab(page, "Samples");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    const pop = await openNodePopover(page, "NC3"); // leaves Samples scrolled down
    await page.evaluate(() => {
      window.__scrollTo = [];
      const scrollTo = window.scrollTo.bind(window);
      window.scrollTo = (...args) => {
        window.__scrollTo.push(args);
        return scrollTo(...args);
      };
    });
    await pop.getByRole("button", { name: "→ Samples" }).click();
    await page.waitForTimeout(2000);
    const restores = await page.evaluate(() => window.__scrollTo.length);
    check(restores === 0, "A3.8 the drill-in does not restore the old scroll position", `${restores} scrollTo call(s)`);
    const row = await page.evaluate(() => {
      const r = document.getElementById("samplerow-NC3")?.getBoundingClientRect();
      return r ? { top: r.top, bottom: r.bottom, h: window.innerHeight } : null;
    });
    check(
      !!row && row.top >= 0 && row.bottom <= row.h,
      "A3.8 the NC3 row is in view",
      JSON.stringify(row),
    );
    const text = await page.locator("body").innerText();
    check(!/as target · |as source · /i.test(text), "A3.8 the single-sample scope is cleared on arrival");
  });

  /* A3.8, the other branch: a plain round trip through another tab
     (no drill-in) still restores the saved scroll position. */
  await scenario("A3.8 round trip", async (page) => {
    await openTab(page, "Samples");
    const tabButton = (label) =>
      page.evaluate(
        (label) =>
          [...document.querySelectorAll("button")]
            .find((b) => b.textContent.trim() === label)
            .click(),
        label,
      );
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(400);
    await tabButton("Overview");
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      window.__scrollTo = [];
      const scrollTo = window.scrollTo.bind(window);
      window.scrollTo = (...args) => {
        window.__scrollTo.push(args);
        return scrollTo(...args);
      };
    });
    await tabButton("Samples");
    await page.waitForTimeout(1000);
    const back = await page.evaluate(() => window.__scrollTo.map((a) => a[0]?.top));
    check(
      back.length === 1 && back[0] > 0,
      "A3.8 Samples → Overview → Samples restores the saved scroll position",
      JSON.stringify(back),
    );
  });
} finally {
  await browser.close();
  stopServer();
}
finish();
