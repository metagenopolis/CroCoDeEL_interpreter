/* Browser checks for the session's persistence: what the browser keeps of
   the curation, and what replacing or importing files does to it.

     - replacing the events file — Replace, a file dropped on the card,
       the run page's result — asks first when the session holds
       curation, saying what carrying over drops: carry it over (matched
       by source and target; the events added by hand kept), start
       fresh, or cancel — and a banner says what happened; clearing the
       events file asks too and says the curation goes with it;
     - the curated events TSV of the Export tab, reloaded into a fresh
       session, gives back the same evaluations, notes, sample actions,
       Overview counts and curated-abundance card; carried over into its
       own session, it keeps the run header and the diagnostics;
     - the parsers' warnings (events, metadata, plate map) are in the
       data-warnings banner and survive a reload;
     - a tab switch writes the small UI record only, an evaluation the
       curation record only;
     - a session stored by the previous versions ("main" record,
       localStorage keys, plain or compressed) is migrated once, and kept
       whole when that migration fails;
     - two tabs of one browser: the second cannot overwrite the first's
       decisions, and says so — not even with the last save of a page
       that goes away;
     - a T pressed half a second before a reload — or right before it, or
       right before the tab is closed or left — is kept;
     - a failed write shows "Not saved"; a session restored without its
       table says so once; without IndexedDB, or with site data blocked,
       the app runs in memory and says so;
     - a malformed session JSON — or one whose content would break a
       tab — is refused and the previous session stays, across a reload;
       the error screen says what is really stored;
     - clearing the events file keeps the abundance table and the metadata
       across a reload;
     - a tab that crashes keeps the navigation and Export usable;
     - the fields of the first wave of fixes survive a reload and the
       session JSON round trip.

   The stored state is read from IndexedDB, rebuilt the way the app reads
   it (src/persistence.js).

   Usage:  npm run build && node e2e/b1-persistence.e2e.mjs
           (or through e2e/run-all.mjs; BASE_URL skips the server,
           E2E_ONLY=<regex> runs only the matching scenarios) */

import { readFileSync } from "node:fs";
import LZString from "lz-string";
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

/** Rewrite one stored record, as a damaged profile could leave it. */
function editRecord(page, key, edit) {
  return page.evaluate(
    ([key, edit]) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("crocodeel-interpreter");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("kv", "readwrite");
          const store = tx.objectStore("kv");
          const get = store.get(key);
          get.onsuccess = () => {
            store.put(new Function("r", edit)(get.result), key);
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => reject(tx.error);
        };
      }),
    [key, edit],
  );
}

/** Put and delete stored records in one transaction. */
function writeRecords(page, puts, dels = []) {
  return page.evaluate(
    ([puts, dels]) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("crocodeel-interpreter");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("kv", "readwrite");
          for (const [k, v] of Object.entries(puts)) tx.objectStore("kv").put(v, k);
          for (const k of dels) tx.objectStore("kv").delete(k);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => reject(tx.error);
        };
      }),
    [puts, dels],
  );
}

/** Rewrite the stored session in the layout the previous versions wrote,
    the way they wrote it: everything but the abundance table in one
    "main" record (the events with their verdicts and notes), the table
    in "ab" (no token) — or, with `local`, under the localStorage keys of
    the versions before IndexedDB, "plain" JSON or "lz"-compressed. The
    current records are deleted. The page leaves the app first, so that
    nothing writes meanwhile; `page.goto(BASE)` boots it again. */
async function toLegacyLayout(page, local = null) {
  await page.goto(`${BASE}favicon.svg`);
  const r = await storedRecords(page);
  const cur = r.curation;
  const main = {
    version: 1,
    savedAt: new Date().toISOString(),
    rawEvents: r.events.events.map((e) => ({
      ...e,
      verdict: cur.verdicts[String(e.id)] || "pending",
      notes: cur.notes[String(e.id)] || "",
    })),
    sampleCuration: cur.sampleCuration,
    sampleCurationVersion: cur.sampleCurationVersion,
    runMetadata: r.events.runMetadata,
    metadata: r.metadata || null,
    plateMap: r.plate || null,
    analysisTitle: cur.analysisTitle,
    tab: r.ui?.tab,
    selId: r.ui?.selId,
    filter: r.ui?.filter,
    sort: r.ui?.sort,
  };
  const { storageToken: _token, ...ab } = r.ab;
  const current = ["events", "curation", "metadata", "plate", "ui"];
  if (!local) {
    await writeRecords(page, { main, ab }, current);
    return;
  }
  await writeRecords(page, {}, [...current, "ab"]);
  const text = (v) => (local === "lz" ? `lz:${LZString.compressToUTF16(JSON.stringify(v))}` : JSON.stringify(v));
  await page.evaluate(
    ([m, a]) => {
      localStorage.setItem("crocodeel-interpreter-v1", m);
      localStorage.setItem("crocodeel-interpreter-v1-ab", a);
    },
    [text(main), text(ab)],
  );
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

/** Import a session JSON through the files bar. */
async function importSession(page, json) {
  await page
    .locator('input[accept*="json"]')
    .first()
    .setInputFiles({
      name: "session.json",
      mimeType: "application/json",
      buffer: Buffer.from(typeof json === "string" ? json : JSON.stringify(json)),
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

/** The curated events TSV of the Export tab. */
async function exportEventsTSV(page) {
  await openTab(page, "Export");
  return download(page, page.getByRole("button", { name: /Download events TSV/i }).first());
}

/** The session JSON of the files bar. */
async function exportSession(page) {
  return download(page, page.getByRole("button", { name: /^Download session$/ }).first());
}

/** The "N of M samples" of the Export tab's curated abundance card. */
async function curatedCard(page) {
  await openTab(page, "Export");
  const text = await page.locator("body").innerText();
  const m = text.match(/Curated abundance table — (\d+) of (\d+) samples/);
  return m ? `${m[1]} of ${m[2]}` : null;
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

/** The Samples-tab row of a sample. */
function sampleRow(page, id) {
  return page
    .locator("tr")
    .filter({ has: page.locator('button[aria-label="Set verdict to Pending"]') })
    .filter({ has: page.getByText(id, { exact: true }) });
}

/** A Suppress set by hand on a sample that is not Contaminated: the
    action chips only show next to a Contaminated verdict or an action, so
    the curator makes it Contaminated, makes the Suppress their own, and
    hands the verdict back to the rule. */
async function suppressByHand(page, id) {
  await openTab(page, "Samples");
  const row = sampleRow(page, id);
  await row.locator('button[aria-label="Set verdict to Contaminated"]').click();
  await page.waitForTimeout(200);
  await row.locator(`button[aria-label="Suppress ${id}"]`).click();
  await page.waitForTimeout(200);
  await row.locator('button[aria-label="Set verdict to Pending"]').click();
  await page.waitForTimeout(200);
}

/** Mark the i-th event of the Events table. */
async function mark(page, title, i) {
  await openTab(page, "Events");
  await page.locator(`button[title="mark as ${title}"]`).nth(i).click();
  await page.waitForTimeout(250);
}

/** Some curation of the demo: two TPs, an FP, a note, a Keep set by hand
    on a source no event targets. */
async function curateSome(page) {
  await mark(page, "true positive", 0);
  await mark(page, "true positive", 1);
  await mark(page, "false positive", 2);
  await openTab(page, "Validate");
  await page.locator('textarea[placeholder^="Notes: related samples"]').fill("a note to keep");
  await page.waitForTimeout(500);
  await openTab(page, "Samples");
  await sampleRow(page, "63D250").locator('button[aria-label="Keep 63D250"]').click();
  await page.waitForTimeout(300);
}

/** The verdict, note and target action of every event, by pair. */
function curationByPair(session) {
  const sc = session.sampleCuration;
  return session.rawEvents
    .map((e) => `${e.source}→${e.target} ${e.verdict} [${e.notes}] ${sc[e.target]?.action || "-"}`)
    .sort();
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
  await scenario("B1.1 replace", async (page) => {
    await mark(page, "true positive", 0);
    await mark(page, "true positive", 1);
    await openTab(page, "Validate");
    await page.locator('textarea[placeholder^="Notes: related samples"]').fill("carried note");
    await page.waitForTimeout(500);
    // Two sample decisions set by hand: a Keep on a source no event
    // targets, a Suppress on a target.
    await openTab(page, "Samples");
    await sampleRow(page, "63D250").locator('button[aria-label="Keep 63D250"]').click();
    await suppressByHand(page, "58D47");
    await saved(page);
    const before = await storedSession(page);
    const stats = await overviewStats(page);
    const curated = curationByPair(before);

    await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
    const ask = dialog(page, "Replace the events file?");
    const askText = (await ask.count()) ? await ask.innerText() : "";
    check(
      /Your session holds 2 evaluations, 1 note and 2 sample decisions/.test(askText),
      "B1.1 replacing the events file asks first, naming the curation it holds",
      askText.slice(0, 160),
    );
    check(
      (await ask.getByRole("button", { name: "Carry over" }).count()) === 1 &&
        (await ask.getByRole("button", { name: "Start fresh" }).count()) === 1 &&
        (await ask.getByRole("button", { name: "Cancel" }).count()) === 1,
      "B1.1 …offering Carry over, Start fresh and Cancel",
    );
    await ask.getByRole("button", { name: "Cancel" }).click();
    await saved(page);
    check(
      JSON.stringify(await overviewStats(page)) === JSON.stringify(stats) &&
        JSON.stringify(curationByPair(await storedSession(page))) === JSON.stringify(curated),
      "B1.1 Cancel leaves the session as it was",
    );

    // The same file again (choosing it again fires again), carried over.
    await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
    await dialog(page, "Replace the events file?").getByRole("button", { name: "Carry over" }).click();
    await saved(page);
    const notice = await page.locator("[data-notice]").innerText().catch(() => "");
    check(
      /Events file replaced/.test(notice) &&
        /24 events in the new file: 24 matched an event of your session/.test(notice) &&
        /Kept from your session: 2 evaluations, 1 note, 2 sample decisions/.test(notice),
      "B1.1 Carry over keeps the evaluations, the note and the sample decisions, and the banner says so",
      notice.replace(/\s+/g, " ").slice(0, 300),
    );
    check(
      JSON.stringify(curationByPair(await storedSession(page))) === JSON.stringify(curated) &&
        JSON.stringify(await overviewStats(page)) === JSON.stringify(stats),
      "B1.1 …every evaluation, note and sample action is where it was, and the Overview counts too",
    );
    const sc = (await storedSession(page)).sampleCuration;
    check(
      sc["63D250"]?.action === "keep" && !sc["63D250"].actionAuto && sc["58D47"]?.action === "suppress" && !sc["58D47"].actionAuto,
      "B1.1 …the sample decisions set by hand stay the curator's own",
      JSON.stringify([sc["63D250"], sc["58D47"]]),
    );
    await page.locator("[data-notice] button[aria-label=Dismiss]").click();
    check((await page.locator("[data-notice]").count()) === 0, "B1.1 the banner can be dismissed");

    // A file without one of the evaluated events, with a new one.
    const tp = (await storedSession(page)).rawEvents.filter((e) => e.verdict === "true_positive");
    const lines = demo("contamination_events.tsv").split("\n");
    const edited = [
      ...lines.filter((l) => !l.startsWith(`${tp[0].source}\t${tp[0].target}\t`)),
      "40D89\t40M\t0.05\t0.9\t",
    ].join("\n");
    await upload(page, 0, "contamination_events.tsv", edited);
    await dialog(page, "Replace the events file?").getByRole("button", { name: "Carry over" }).click();
    await saved(page);
    const notice2 = await page.locator("[data-notice]").innerText().catch(() => "");
    check(
      /24 events in the new file: 23 matched an event of your session \(same source and target\), 1 new one/.test(notice2) &&
        /1 event of your session is not in the new file: the evaluations and notes of 1 of them were dropped/.test(notice2),
      "B1.1 the banner names the new event and the dropped one",
      notice2.replace(/\s+/g, " ").slice(0, 300),
    );
    check((await overviewStats(page)).tp === 1, "B1.1 …and only the dropped event's TP is gone");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    check((await overviewStats(page)).tp === 1, "B1.1 the carried-over session survives a reload");

    // Start fresh.
    await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
    await dialog(page, "Replace the events file?").getByRole("button", { name: "Start fresh" }).click();
    await saved(page);
    const fresh = await overviewStats(page);
    const notice3 = await page.locator("[data-notice]").innerText().catch(() => "");
    check(
      fresh.tp === 0 && fresh.keep === 0 && fresh.suppress === 0 &&
        /Started fresh: your previous curation \(1 evaluation, (1 note, )?2 sample decisions\) was dropped/.test(notice3),
      "B1.1 Start fresh drops the curation, and says what was dropped",
      `${JSON.stringify(fresh)} ${notice3.replace(/\s+/g, " ").slice(0, 200)}`,
    );
  });

  /* B1.1(c) The curated events TSV, reloaded into a fresh session. */
  await scenario("B1.1 export round trip", async (page, ctx) => {
    await mark(page, "true positive", 0);
    await mark(page, "true positive", 1);
    await mark(page, "true positive", 2);
    await mark(page, "false positive", 3);
    await mark(page, "false positive", 4);
    await mark(page, "uncertain", 5);
    await openTab(page, "Validate");
    await page.locator('textarea[placeholder^="Notes: related samples"]').fill("kept as typed");
    await page.waitForTimeout(500);
    await saved(page);
    let s = await storedSession(page);
    const tpTargets = new Set(s.rawEvents.filter((e) => e.verdict === "true_positive").map((e) => e.target));
    const fpTarget = s.rawEvents.find((e) => e.verdict === "false_positive" && !tpTargets.has(e.target))?.target;
    const keptTarget = [...tpTargets][0];
    await openTab(page, "Samples");
    // A contaminated target kept by hand, a clean one suppressed by hand.
    await sampleRow(page, keptTarget).locator(`button[aria-label="Keep ${keptTarget}"]`).click();
    await suppressByHand(page, fpTarget);
    await saved(page);
    s = await storedSession(page);
    const stats = await overviewStats(page);
    const cardA = await curatedCard(page);
    const tsv = await exportEventsTSV(page);
    check(
      !!tsv && stats.tp === 3 && stats.keep === 1 && stats.suppress >= 2,
      "B1.1 export: a curated session with a Keep and a Suppress set by hand",
      `${JSON.stringify(stats)} ${keptTarget} ${fpTarget}`,
    );

    // A fresh session (another browser profile) with the same files.
    const fresh = await ctx.browser().newContext({ viewport: { width: 1500, height: 1000 } });
    const p2 = await fresh.newPage();
    const errors2 = trackErrors(p2);
    await p2.addInitScript(() => localStorage.setItem("crocodeel-tutorial-seen", "1"));
    await p2.goto(BASE, { waitUntil: "networkidle" });
    await loadDemo(p2);
    await upload(p2, 0, "contamination_events_curated.tsv", tsv || "");
    check((await dialog(p2, "Replace the events file?").count()) === 0, "B1.1 export: a session without curation is replaced without a question");
    await saved(p2);
    const notice = await p2.locator("[data-notice]").innerText().catch(() => "");
    check(
      /Restored from the file: 6 evaluations, 1 note, 2 sample actions/.test(notice) &&
        /only the session JSON \(Download session\) keeps them/.test(notice),
      "B1.1 export: the banner says what was restored and what the events TSV does not hold",
      notice.replace(/\s+/g, " ").slice(0, 300),
    );
    const s2 = await storedSession(p2);
    check(
      JSON.stringify(curationByPair(s2)) === JSON.stringify(curationByPair(s)),
      "B1.1 export: the same evaluations, notes and sample actions, event by event",
      curationByPair(s2).find((l, i) => l !== curationByPair(s)[i]) || "",
    );
    const stats2 = await overviewStats(p2);
    check(JSON.stringify(stats2) === JSON.stringify(stats), "B1.1 export: the same Overview counts", `${JSON.stringify(stats2)} vs ${JSON.stringify(stats)}`);
    const cardB = await curatedCard(p2);
    check(!!cardA && cardB === cardA, "B1.1 export: the same curated-abundance card", `${cardB} vs ${cardA}`);
    const tsv2 = await exportEventsTSV(p2);
    const rows = (t) => (t || "").split("\n").filter((l) => l && !l.startsWith("#")).sort().join("\n");
    check(rows(tsv2) === rows(tsv), "B1.1 export: exporting again gives the same file");
    check(errors2.length === 0, "B1.1 export: no JS error in the fresh session", errors2[0] || "");
    await fresh.close();
  });

  /* B1.1 The curated events TSV carries the study title, not CroCoDeEL's
     run header: reloaded into the session it came from (Carry over), the
     session's run header — and so the diagnostics — used to be replaced
     by { study }. */
  await scenario("B1.1 curated export keeps the run header", async (page, ctx) => {
    await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv").replace("filtering_ab_thr_factor: None", "filtering_ab_thr_factor: 20.0"));
    await mark(page, "true positive", 0);
    await mark(page, "false positive", 1);
    await saved(page);
    const toggle = page.getByRole("checkbox", { name: /low-abundance filter to the diagnostics/i });
    const runParams = async () => {
      await openTab(page, "Overview");
      const text = await page.locator("body").innerText();
      return /Low-abundance filter 20×/.test(text) && /applied to diagnostics, as in CroCoDeEL/.test(text);
    };
    const diagnostics = async (pair) => {
      await openTab(page, "Validate");
      const re = new RegExp(`^${pair.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9.]+%`);
      await page.locator("button").filter({ hasText: re }).first().click();
      await page.waitForTimeout(600);
      const text = await page.locator("body").innerText();
      const i = text.indexOf("DIAGNOSTIC CHECKS");
      return i < 0 ? "" : text.slice(i, i + 700).replace(/\s+/g, " ");
    };
    const before = await diagnostics("83D88 → NC3");
    check((await runParams()) && /low-abundance filter \(20×\), as in the run/.test(before), "B1.1 a session whose run applied a low-abundance filter (20×)", before.slice(0, 200));
    const tsv = await exportEventsTSV(page);
    await upload(page, 0, "contamination_events_curated.tsv", tsv || "");
    await dialog(page, "Replace the events file?").getByRole("button", { name: "Carry over" }).click();
    await saved(page);
    // (Should the export carry the run header one day, it is the file's.)
    const fileHasRunHeader = /^#.*crocodeel version/im.test(tsv || "");
    const notice = (await page.locator("[data-notice]").innerText().catch(() => "")).replace(/\s+/g, " ");
    check(
      fileHasRunHeader || /The new file has no CroCoDeEL run header: your session's run parameters are kept/.test(notice),
      "B1.1 its curated export, carried over, says that the session's run parameters are kept",
      notice.slice(0, 300),
    );
    check(await runParams(), "B1.1 …the run parameters are still the run's (low-abundance filter 20×, applied)");
    const after = await diagnostics("83D88 → NC3");
    check(after === before, "B1.1 …and the diagnostics of an event are unchanged", after.slice(0, 200));
    const stored = (await storedRecords(page)).events.runMetadata;
    check(stored?.filtering_ab_thr_factor === "20.0" && !("study" in stored), "B1.1 …the stored run header is the run's, without the study title", JSON.stringify(stored).slice(0, 200));
    // The curator's low-abundance toggle, switched off, stays off.
    await openTab(page, "Overview");
    await toggle.uncheck();
    await page.waitForTimeout(1500);
    await upload(page, 0, "contamination_events_curated.tsv", tsv || "");
    await dialog(page, "Replace the events file?").getByRole("button", { name: "Carry over" }).click();
    await openTab(page, "Overview");
    check(!(await toggle.isChecked()), "B1.1 …and the curator's low-abundance toggle stays off");

    // In a session without a title, the file's "# study:" line names it.
    const other = await ctx.browser().newContext({ viewport: { width: 1500, height: 1000 } });
    const p2 = await other.newPage();
    await p2.addInitScript(() => localStorage.setItem("crocodeel-tutorial-seen", "1"));
    await p2.goto(BASE, { waitUntil: "networkidle" });
    await upload(p2, 0, "contamination_events_curated.tsv", tsv || "");
    await saved(p2);
    const r2 = await storedRecords(p2);
    const run2 = r2.events?.runMetadata;
    check(
      /^# study: Demo — Lou et al\. 2023/m.test(tsv || "") &&
        r2.curation?.analysisTitle === "Demo — Lou et al. 2023 (early-life metagenomes, plate 3)" &&
        (fileHasRunHeader ? run2?.filtering_ab_thr_factor === "20.0" && !("study" in run2) : run2 === null),
      "B1.1 loaded into a session without a title, the curated export's study names it, and is no run parameter",
      JSON.stringify([r2.curation?.analysisTitle, run2]),
    );
    await other.close();
  });

  /* B1.1 The question says, before the choice, what carrying over drops —
     also for a curated file, such as a filtered curated export. */
  await scenario("B1.1 the question counts what is dropped", async (page) => {
    await mark(page, "true positive", 0);
    await mark(page, "false positive", 1);
    await mark(page, "false positive", 2);
    await saved(page);
    const tsv = await exportEventsTSV(page);
    const lines = (tsv || "").split("\n");
    const header = lines.findIndex((l) => l.startsWith("source\t"));
    const verdictCol = lines[header].split("\t").indexOf("verdict");
    const onlyTP = [...lines.slice(0, header + 1), ...lines.slice(header + 1).filter((l) => l.split("\t")[verdictCol] === "true_positive")];
    await upload(page, 0, "contamination_events_curated.tsv", onlyTP.join("\n"));
    const ask = dialog(page, "Replace the events file?");
    const text = ((await ask.count()) ? await ask.innerText() : "").replace(/\s+/g, " ");
    check(
      onlyTP.length === header + 2 &&
        /The new file has its own evaluations/.test(text) &&
        /23 events of yours are not in the new file and will be dropped, with the evaluations and notes of 2 of them\./.test(text),
      "B1.1 a curated file holding one event: the question says that 23 events, 2 of them evaluated, will be dropped",
      text.slice(0, 500),
    );
    await ask.getByRole("button", { name: "Cancel" }).click();
    await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
    const again = ((await ask.count()) ? await ask.innerText() : "").replace(/\s+/g, " ");
    check(/Every event of yours is in the new file\./.test(again), "B1.1 …and that none is when the new file holds them all", again.slice(0, 400));
    await ask.getByRole("button", { name: "Cancel" }).click();
    check((await overviewStats(page)).fp === 2, "B1.1 …and Cancel keeps the session");
  });

  /* B1.1 An event added by hand (Scatter › Explore new pairs: a false
     negative CroCoDeEL missed) is in no CroCoDeEL file: carrying the
     curation over to a rerun used to drop it, every time. */
  await scenario("B1.1 events added by hand", async (page) => {
    const json = JSON.parse(await exportSession(page));
    json.events.push({
      id: "manual-1",
      source: "40D89",
      target: "40M",
      contamination_rate: 0.05,
      probability: 0.9,
      introduced_species: [],
      verdict: "true_positive",
      action: null,
      notes: "missed by CroCoDeEL, added by hand",
    });
    await importSession(page, json);
    await saved(page);
    check(/25 events loaded/.test(await card(page, "contamination_events.tsv").innerText()), "B1.1 a session with an event added by hand");
    await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
    const ask = dialog(page, "Replace the events file?");
    const text = ((await ask.count()) ? await ask.innerText() : "").replace(/\s+/g, " ");
    check(
      /The event you added by hand \(Explore new pairs\), which no CroCoDeEL file holds, is kept with its evaluation and notes\./.test(text) &&
        /Start fresh: all of it is dropped, the event you added by hand included,/.test(text),
      "B1.1 replacing the events says that Carry over keeps the event added by hand, and Start fresh drops it",
      text.slice(0, 600),
    );
    await ask.getByRole("button", { name: "Carry over" }).click();
    await saved(page);
    const notice = (await page.locator("[data-notice]").innerText().catch(() => "")).replace(/\s+/g, " ");
    check(
      /1 event you added by hand \(Explore new pairs\) is not in the new file: kept, with its evaluation and notes\./.test(notice),
      "B1.1 Carry over keeps it, and the banner says so",
      notice.slice(0, 400),
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const kept = (await storedSession(page)).rawEvents.find((e) => e.source === "40D89" && e.target === "40M");
    check(
      kept?.id === "manual-1" && kept.verdict === "true_positive" && kept.notes === "missed by CroCoDeEL, added by hand" &&
        /25 events loaded/.test(await card(page, "contamination_events.tsv").innerText()) &&
        (await overviewStats(page)).tp === 1,
      "B1.1 …with its evaluation and note, across a reload",
      JSON.stringify(kept),
    );
  });

  /* B1.1 A file dropped on the events card is asked about like a file
     picked with Replace. */
  await scenario("B1.1 drop on the events card", async (page) => {
    await mark(page, "true positive", 0);
    await saved(page);
    const dt = await page.evaluateHandle((text) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], "contamination_events.tsv", { type: "text/tab-separated-values" }));
      return transfer;
    }, demo("contamination_events.tsv"));
    const target = card(page, "contamination_events.tsv");
    await target.dispatchEvent("dragover", { dataTransfer: dt });
    await target.dispatchEvent("drop", { dataTransfer: dt });
    await page.waitForTimeout(1500);
    const ask = dialog(page, "Replace the events file?");
    check((await ask.count()) === 1, "B1.1 a file dropped on the events card asks first");
    await ask.getByRole("button", { name: "Carry over" }).click();
    await saved(page);
    const notice = (await page.locator("[data-notice]").innerText().catch(() => "")).replace(/\s+/g, " ");
    check(
      /Kept from your session: 1 evaluation/.test(notice) && (await overviewStats(page)).tp === 1,
      "B1.1 …and Carry over keeps the evaluation",
      notice.slice(0, 200),
    );
  });

  /* B1.1 The run page's "Use these events + abundance in this session".
     CroCoDeEL itself is not run: its worker is replaced by one that
     answers with the demo's events file. */
  await scenario("B1.1 run page", async (page, ctx) => {
    const tsv = demo("contamination_events.tsv");
    await ctx.route(/crocodeel\.worker-.*\.js/, (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `self.onmessage = (e) => { if (e.data && e.data.type === "run") self.postMessage({ type: "done", tsv: ${JSON.stringify(tsv)} }); };`,
      }),
    );
    await mark(page, "true positive", 0);
    await mark(page, "true positive", 1);
    await saved(page);
    const stats = await overviewStats(page);
    await page.evaluate(() => {
      window.location.hash = "#runCroCoDeEL";
    });
    const runPage = page.getByRole("dialog", { name: "Run CroCoDeEL in your browser" });
    await runPage.waitFor({ state: "visible", timeout: 10000 });
    await runPage.getByRole("button", { name: /^Run CroCoDeEL$/ }).first().click();
    const use = runPage.getByRole("button", { name: /Use these events \+ abundance in this session/ });
    await use.waitFor({ state: "visible", timeout: 30000 });
    await use.click();
    const ask = dialog(page, "Replace the events file?");
    await ask.waitFor({ state: "visible", timeout: 10000 });
    // Above the run page: what is at the centre of its buttons is them.
    const onTop = await ask.getByRole("button").evaluateAll((buttons) =>
      buttons.every((b) => {
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !!hit && b.contains(hit);
      }),
    );
    check(onTop, "B1.1 run page: the question shows above the run page");
    await ask.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(500);
    check(
      (await use.isVisible()) &&
        (await storedSession(page)).rawEvents.filter((e) => e.verdict === "true_positive").length === 2,
      "B1.1 run page: Cancel keeps the run page with its results, and the session",
    );
    await use.click();
    await ask.getByRole("button", { name: "Carry over" }).click();
    await saved(page);
    check((await runPage.count()) === 0, "B1.1 run page: Carry over closes the run page");
    const notice = (await page.locator("[data-notice]").innerText().catch(() => "")).replace(/\s+/g, " ");
    check(
      /24 events in the new file: 24 matched an event of your session/.test(notice) &&
        /Kept from your session: 2 evaluations/.test(notice) &&
        JSON.stringify(await overviewStats(page)) === JSON.stringify(stats),
      "B1.1 run page: …and keeps the curation",
      notice.slice(0, 200),
    );
  });

  /* B1.1(e) + B1.5 Clearing the events file. */
  await scenario("B1.5 clear events", async (page) => {
    const events = card(page, "contamination_events.tsv");
    // Without curation: the plain question.
    await events.getByRole("button", { name: /^Clear$/ }).click();
    check((await dialog(page, "Remove the loaded contamination_events.tsv?").count()) === 1, "B1.1(e) without curation, Clear asks the usual question");
    await page.getByRole("button", { name: /^Cancel$/ }).click();
    await mark(page, "true positive", 0);
    await events.getByRole("button", { name: /^Clear$/ }).click();
    const ask = dialog(page, "Remove the events file and your curation?");
    const text = (await ask.count()) ? await ask.innerText() : "";
    check(
      /Your curation of these events will be lost: 1 evaluation/.test(text) && /abundance table, metadata and plate map stay loaded/.test(text),
      "B1.1(e) with curation, Clear says plainly that the curation will be lost",
      text.replace(/\s+/g, " ").slice(0, 200),
    );
    await ask.getByRole("button", { name: "Remove and lose the curation" }).click();
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

  /* B1.1(e) The questions say what is lost, and what is not. */
  await scenario("B1.1 the questions name what is lost", async (page) => {
    await mark(page, "true positive", 0);
    // The guided tour replaces the session with the demo's.
    await openTab(page, "Help");
    await page.getByRole("button", { name: /Restart guided tour/ }).first().click();
    const tour = dialog(page, "Replace your session with the demo dataset?");
    const tourText = ((await tour.count()) ? await tour.innerText() : "").replace(/\s+/g, " ");
    check(/your curation will be lost: 1 evaluation\./.test(tourText), "B1.1(e) the guided tour's question names the curation it would lose", tourText.slice(0, 300));
    await tour.getByRole("button", { name: "Cancel" }).click();
    // Clearing the events names the files that stay loaded — only those.
    await card(page, "plate_map.tsv").getByRole("button", { name: /^Clear$/ }).click();
    await dialog(page, "Remove the loaded plate_map.tsv?").getByRole("button", { name: "Remove" }).click();
    await card(page, "contamination_events.tsv").getByRole("button", { name: /^Clear$/ }).click();
    const ask = dialog(page, "Remove the events file and your curation?");
    const text = ((await ask.count()) ? await ask.innerText() : "").replace(/\s+/g, " ");
    check(
      /The abundance table and metadata stay loaded\./.test(text) && !/plate map/.test(text),
      "B1.1(e) clearing the events names the files that stay loaded, not a plate map that is not",
      text.slice(0, 300),
    );
    await ask.getByRole("button", { name: "Cancel" }).click();
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

  /* B1.3a A session stored by the previous versions — one "main" record,
     or the localStorage keys before IndexedDB — comes back, migrated
     once to the current records. */
  for (const [label, local] of [
    ['the "main" record', null],
    ["the localStorage keys", "plain"],
    ["the lz-compressed localStorage keys", "lz"],
  ]) {
    await scenario(`B1.3a migration from ${label}`, async (page) => {
      await curateSome(page);
      await saved(page);
      const stats = await overviewStats(page);
      const curated = curationByPair(await storedSession(page));
      await toLegacyLayout(page, local);
      await page.goto(BASE, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      const back = await overviewStats(page);
      check(JSON.stringify(back) === JSON.stringify(stats), `B1.3a ${label}: the session comes back`, `${JSON.stringify(back)} vs ${JSON.stringify(stats)}`);
      await saved(page);
      const r = await storedRecords(page);
      check(
        ["events", "curation", "ui", "metadata", "plate", "ab"].every((k) => r[k]) && !r.main,
        `B1.3a ${label}: written as the current records, without the earlier copy`,
        Object.keys(r).sort().join(","),
      );
      check(
        JSON.stringify(curationByPair(await storedSession(page))) === JSON.stringify(curated),
        `B1.3a ${label}: every evaluation, note and sample action is migrated`,
      );
      if (local) {
        const left = await page.evaluate(() =>
          ["crocodeel-interpreter-v1", "crocodeel-interpreter-v1-ab"].filter((k) => localStorage.getItem(k) != null),
        );
        check(left.length === 0, `B1.3a ${label}: the localStorage keys are removed`, left.join(", "));
      }
    });
  }

  /* B1.3a The one-time migration fails (its transaction aborts, as a full
     quota makes it): the session is read from the earlier layout, and the
     first save must write every record — writing only the curation used
     to leave the events, the metadata and the plate map in "main", which
     no later boot read again. */
  for (const [label, local] of [
    ['the "main" record', null],
    ["the localStorage keys", "lz"],
  ]) {
    await scenario(`B1.3a migration from ${label} that fails`, async (page) => {
      await curateSome(page);
      await saved(page);
      const stats = await overviewStats(page);
      await toLegacyLayout(page, local);
      await page.addInitScript(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, key) {
          const req = put.call(this, value, key);
          if (key === "curation" && !sessionStorage.getItem("migration-aborted")) {
            sessionStorage.setItem("migration-aborted", "1");
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
      });
      await page.goto(BASE, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      const read = await overviewStats(page);
      check(JSON.stringify(read) === JSON.stringify(stats), `B1.3a failed migration from ${label}: the session is read as it was stored`, JSON.stringify(read));
      await mark(page, "true positive", 5);
      await saved(page);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      const ev = await card(page, "contamination_events.tsv").innerText();
      const md = await card(page, "metadata.tsv").innerText();
      const pm = await card(page, "plate_map.tsv").innerText();
      check(
        /24 events loaded/.test(ev) && /samples annotated/.test(md) && /wells/.test(pm),
        `B1.3a failed migration from ${label}: after a change and a reload, the events, the metadata and the plate map are still there`,
        [ev, md, pm].map((t) => t.split("\n").find((l) => l.startsWith("✓")) || "-").join(" | "),
      );
      const after = await overviewStats(page);
      check(
        after.tp === stats.tp + 1 && after.fp === stats.fp,
        `B1.3a failed migration from ${label}: …with every evaluation, the one made since included`,
        JSON.stringify(after),
      );
      const left = await page.evaluate(() =>
        ["crocodeel-interpreter-v1", "crocodeel-interpreter-v1-ab"].filter((k) => localStorage.getItem(k) != null),
      );
      check(!(await storedRecords(page)).main && left.length === 0, `B1.3a failed migration from ${label}: …and the earlier copy is gone`, left.join(", "));
    });
  }

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

  /* B1.3b + B1.3c The last save of a page that goes away cannot wait for
     the revision check: without BroadcastChannel, it used to write the
     page's older copy over another tab's newer session. */
  await scenario("B1.3b two tabs, reload right after a change", async (page, ctx) => {
    await saved(page);
    await page.addInitScript(() => {
      delete window.BroadcastChannel;
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const b = await ctx.newPage();
    await b.goto(BASE, { waitUntil: "networkidle" });
    await b.waitForTimeout(1500);
    await mark(b, "true positive", 0);
    await saved(b);
    // The first tab, which has not heard of it, marks another event and
    // reloads at once.
    await openTab(page, "Events");
    await page.locator('button[title="mark as false positive"]').nth(3).click();
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const s = await storedSession(page);
    check(
      s.rawEvents.filter((e) => e.verdict === "true_positive").length === 1 && s.rawEvents.every((e) => e.verdict !== "false_positive"),
      "B1.3b a page reloaded right after a change does not write its older copy over the other tab's save",
      JSON.stringify(s.rawEvents.filter((e) => e.verdict !== "pending").map((e) => `${e.source}→${e.target} ${e.verdict}`)),
    );
    check((await overviewStats(page)).tp === 1, "B1.3b …and comes back with the other tab's TP");
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

  /* B1.3c An evaluation right before the tab is closed, or the page
     left for another site. */
  await scenario("B1.3c T then close or leave", async (page, ctx) => {
    await saved(page);
    await openTab(page, "Validate");
    await page.keyboard.press("t");
    await page.close({ runBeforeUnload: true });
    const p2 = await ctx.newPage();
    await p2.goto(BASE, { waitUntil: "networkidle" });
    await p2.waitForTimeout(1500);
    check((await overviewStats(p2)).tp === 1, "B1.3c a T pressed right before the tab is closed is kept");
    await openTab(p2, "Validate");
    await p2.keyboard.press("ArrowRight");
    await p2.waitForTimeout(200);
    await p2.keyboard.press("t");
    await p2.goto("about:blank");
    await p2.goto(BASE, { waitUntil: "networkidle" });
    await p2.waitForTimeout(1500);
    check((await overviewStats(p2)).tp === 2, "B1.3c …and one right before leaving for another page");
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

  /* B1.3d A session restored without its table (the table's last write
     failed, an older one was left behind) says so once — not at every
     reload until another table is loaded. */
  await scenario("B1.3d lost table said once", async (page) => {
    await mark(page, "true positive", 0);
    await saved(page);
    const rev = (await storedRecords(page)).curation.rev;
    await editRecord(page, "ab", "r.storageToken = 'an older write'; return r;");
    const notice = page.locator("[data-notice]");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    check(
      /The abundance table was not restored/.test(await notice.innerText().catch(() => "")),
      "B1.3d a session restored without its table says so",
    );
    await notice.locator("button[aria-label=Dismiss]").click();
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    check((await notice.count()) === 0, "B1.3d …once: the next reload does not say it again", await notice.innerText().catch(() => ""));
    const r = await storedRecords(page);
    check(
      !r.ab && r.curation.abToken === null && r.curation.rev === rev,
      "B1.3d …the curation record no longer names the table, in place, and the older table is deleted",
      JSON.stringify({ ab: !!r.ab, abToken: r.curation.abToken, rev: r.curation.rev, was: rev }),
    );
    check((await overviewStats(page)).tp === 1, "B1.3d …and the session is otherwise whole");
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
    [
      // What Chrome does when the user blocks site data: localStorage
      // throws on every access, IndexedDB refuses to open.
      "blocked site data",
      () => {
        Object.defineProperty(window, "localStorage", {
          get() {
            throw new DOMException(
              "Failed to read the 'localStorage' property from 'Window': Access is denied for this document.",
              "SecurityError",
            );
          },
          configurable: true,
        });
        const open = () => {
          const req = { error: new DOMException("The user denied permission to access the database.", "UnknownError") };
          setTimeout(() => req.onerror?.(), 0);
          return req;
        };
        Object.defineProperty(window, "indexedDB", { get: () => ({ open, deleteDatabase: open }), configurable: true });
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
        // Without localStorage the tutorial cannot be marked as seen.
        const skip = page.getByRole("button", { name: "Skip", exact: true });
        if (await skip.count()) await skip.click();
        const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
        const stopped = body.match(/(Browser not supported|IndexedDB is required|Something went wrong while rendering).{0,200}/);
        check(!stopped, `B1.3e ${label}: no "unsupported" or error screen`, stopped?.[0] || "");
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

  /* B1.4 Importing a malformed session JSON. */
  await scenario("B1.4 malformed import", async (page) => {
    await mark(page, "true positive", 0);
    await mark(page, "true positive", 1);
    await saved(page);
    const good = JSON.parse(await exportSession(page));
    const alert = async () => (await page.locator('[role="alert"]').allInnerTexts()).join(" ");
    const firstSample = Object.keys(good.metadata.bySample)[0];
    for (const [what, edit, re] of [
      ["an abundance table that is not one", (j) => (j.abundance.matrix = "oops"), /abundance: "matrix"/],
      // An event without a target is what the previous version's parser
      // made of a blank line: left out, said (e2e/final-state.e2e.mjs).
      ["an event whose target is not text", (j) => (j.events[3].target = { id: 1 }), /event 4: its source or its target is neither text nor a number/],
      ["metadata without its samples", (j) => (j.metadata = { nSamples: 3 }), /metadata: "bySample"/],
      // These passed the check, then broke a tab at every visit.
      ["a matrix row the species list does not name", (j) => (j.abundance.matrix.__ghost = null), /abundance: "matrix" has a row for "__ghost"/],
      ["a run parameter that is an object", (j) => (j.run_metadata = { ...j.run_metadata, datetime: { a: 1 } }), /run_metadata: "datetime" is not text/],
      ["a metadata subject that is an object", (j) => (j.metadata.bySample[firstSample].subject = { id: 1 }), /metadata: the subject of .+ is not text/],
    ]) {
      const json = structuredClone(good);
      edit(json);
      await importSession(page, json);
      const text = await alert();
      check(/Failed to import session/.test(text) && re.test(text), `B1.4 ${what} is refused, saying where`, text.slice(0, 200));
      check((await dialog(page, "Replace your session with the imported one?").count()) === 0, `B1.4 …before anything is asked or replaced`);
    }
    check((await overviewStats(page)).tp === 2, "B1.4 the current session is untouched");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    check((await overviewStats(page)).tp === 2, "B1.4 …and still there after a reload");

    // A filter without q (it crashed every render): imported, after asking.
    const noQ = structuredClone(good);
    noQ.ui_state.filter = { minScore: 0 };
    noQ.ui_state.tab = "table";
    noQ.events.forEach((e) => (e.verdict = "pending"));
    noQ.sample_curation = {};
    await importSession(page, noQ);
    const ask = dialog(page, "Replace your session with the imported one?");
    check(/Your current session holds 2 evaluations/.test((await ask.count()) ? await ask.innerText() : ""), "B1.4 importing over a curated session asks first");
    await ask.getByRole("button", { name: "Cancel" }).click();
    check((await overviewStats(page)).tp === 2, "B1.4 Cancel keeps the session");
    await importSession(page, noQ);
    await dialog(page, "Replace your session with the imported one?").getByRole("button", { name: "Replace session" }).click();
    await saved(page);
    const body = await page.locator("body").innerText();
    check(!/Something went wrong/.test(body) && (await overviewStats(page)).tp === 0, "B1.4 a session whose filter has no q imports without crashing");
    const ui = (await storedRecords(page)).ui;
    check(ui?.filter?.q === "" && ui.filter.lowAbFilter === true, "B1.4 …its filter merged over the defaults (lowAbFilter on)", JSON.stringify(ui?.filter));
  });

  /* B1.4 Metadata written as numbers (a hand-edited session JSON): read
     as text. It used to be accepted as it was, and the Samples, Events,
     Scatter and Validate tabs then failed on it at every visit. */
  await scenario("B1.4 numbers in the metadata", async (page) => {
    const json = JSON.parse(await exportSession(page));
    let n = 0;
    for (const m of Object.values(json.metadata.bySample)) {
      delete m.extra;
      m.sampleName = 1000 + n;
      if (/^\d+$/.test(m.subject)) m.subject = Number(m.subject);
      n++;
    }
    await importSession(page, json);
    const alert = (await page.locator('[role="alert"]').allInnerTexts()).join(" ");
    check(!/Failed to import session/.test(alert), "B1.4 a session whose metadata holds numbers imports", alert.slice(0, 200));
    const failed = [];
    for (const name of ["Overview", "Samples", "Events", "Scatter", "Validate", "Network", "Plate", "Export"]) {
      await openTab(page, name);
      if (await page.locator("[data-tab-error]").count()) failed.push(name);
    }
    check(failed.length === 0, "B1.4 …and every tab shows it", failed.join(", "));
    check((await storedRecords(page)).metadata.bySample[Object.keys(json.metadata.bySample)[0]].sampleName === "1000", "B1.4 …read as text");
  });

  /* B1.4 The error screen says what is really stored, and offers it.
     A damaged stored record no longer stops the app — the session readers
     repair it or leave it out (e2e/final-state.e2e.mjs) — so the error is
     made outside any tab: the app's first history write, on mount,
     throws. */
  await scenario(
    "B1.4 error screen",
    async (page, ctx) => {
      await mark(page, "true positive", 0);
      await saved(page);
      await ctx.addInitScript(() => {
        if (sessionStorage.getItem("e2e-fail-mount")) {
          history.replaceState = () => {
            throw new Error("injected: the app failed on mount");
          };
        }
      });
      await page.evaluate(() => sessionStorage.setItem("e2e-fail-mount", "1"));
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      const text = await page.locator("[data-stored-session]").innerText().catch(() => "");
      check(
        /This browser has the last saved version of your session: 24 events \(1 evaluated\), the abundance table, the metadata, the plate map/.test(text),
        "B1.4 the error screen says what this browser has stored",
        text.slice(0, 200),
      );
      const json = await download(page, page.getByRole("button", { name: "Download the saved session (JSON)" }));
      check(!!json && JSON.parse(json).events.filter((e) => e.verdict === "true_positive").length === 1, "B1.4 …and downloads it as a session JSON");
      // That file imports in a fresh session.
      const p2 = await (await ctx.browser().newContext()).newPage();
      await p2.addInitScript(() => localStorage.setItem("crocodeel-tutorial-seen", "1"));
      await p2.goto(BASE, { waitUntil: "networkidle" });
      await importSession(p2, json || "{}");
      check((await overviewStats(p2)).tp === 1, "B1.4 the downloaded session imports, with its TP");
      await p2.context().close();
    },
    { expectedErrors: /injected: the app failed on mount|render error|The above error occurred/ },
  );

  /* B1.6 A tab that crashes keeps the navigation and Export usable. A
     damaged stored well no longer breaks the Plate tab (the session
     readers leave it out), so the tab is made to fail on the row labels
     of its plate grid (Inspect mode), while it renders. */
  await scenario(
    "B1.6 tab crash",
    async (page) => {
      await mark(page, "true positive", 0);
      await saved(page);
      await page.evaluate(() => {
        const fromCharCode = String.fromCharCode;
        String.fromCharCode = function (...codes) {
          if (window.__failPlateTab) throw new Error("injected: the Plate tab failed to render");
          return fromCharCode.apply(this, codes);
        };
      });
      await openTab(page, "Plate");
      await page.evaluate(() => (window.__failPlateTab = true));
      await page.getByRole("button", { name: /^Inspect$/ }).first().click();
      await page.waitForTimeout(800);
      await page.evaluate(() => (window.__failPlateTab = false));
      const fallback = page.locator('[data-tab-error="Plate"]');
      check(
        (await fallback.count()) === 1 && /The Plate tab could not be shown/.test(await fallback.innerText()),
        "B1.6 the Plate tab shows its error in its place",
      );
      check(
        (await page.getByRole("button", { name: /^Export$/ }).count()) === 1 && !/Something went wrong while rendering/.test(await page.locator("body").innerText()),
        "B1.6 …the navigation is still there",
      );
      await fallback.getByRole("button", { name: "Go to Export" }).click();
      await page.waitForTimeout(800);
      const tsv = await exportEventsTSV(page);
      check(!!tsv && tsv.split("\n").some((l) => l.includes("\ttrue_positive\t")), "B1.6 Export works and downloads the curation");
      const json = await exportSession(page);
      check(!!json && JSON.parse(json).events.length === 24, "B1.6 Download session works");
      check((await overviewStats(page)).tp === 1, "B1.6 the other tabs render");
    },
    { expectedErrors: /injected: the Plate tab failed|the Plate tab failed|The above error occurred/ },
  );

  /* B1.7 The first wave's fields, across a reload and a session JSON
     round trip. */
  await scenario(
    "B1.7 fields",
    async (page, ctx) => {
      const events = demo("contamination_events.tsv")
        .replace("filtering_ab_thr_factor: None", "filtering_ab_thr_factor: 20.0")
        .split("\n")
        .map((l) => (l.startsWith("63D29\t63D40\t") ? l.replace("\t6.75e-01\t", "\t1.5\t") : l))
        .join("\n");
      // Counts, so that colSums / integerCols mean something.
      const ab = demo("species_abundance.tsv")
        .split("\n")
        .map((l, i) => (i === 0 || !l ? l : l.split("\t").map((c, j) => (j === 0 ? c : String(Math.round(Number(c) * 1e7)))).join("\t")))
        .join("\n");
      const md = demo("metadata.tsv").split("\n").filter((l) => l);
      await upload(page, 0, "contamination_events.tsv", events);
      await upload(page, 1, "species_abundance.tsv", ab);
      await upload(page, 2, "metadata.tsv", [...md, md.find((l) => l.startsWith("58M\t"))].join("\n"));
      await upload(page, 3, "plate_map.tsv", [...demo("plate_map.tsv").split("\n").filter((l) => l), "83D239\tP3\tZ99"].join("\n"));
      await openTab(page, "Overview");
      const toggle = page.getByRole("checkbox", { name: /low-abundance filter to the diagnostics/i });
      await toggle.uncheck();
      await mark(page, "true positive", 0);
      await saved(page);
      const fields = (s) => ({
        firstHeader: s.ab?.firstHeader,
        colSums: JSON.stringify(s.ab?.colSums),
        integer: Object.values(s.ab?.integerCols || {}).every((v) => v === true),
        species: (s.ab?.species || []).join(","),
        lowAbFilter: s.filter?.lowAbFilter,
        version: s.version,
        metadata: JSON.stringify([s.metadata?.cols, s.metadata?.warnings]),
        plate: JSON.stringify([s.plate?.cols, s.plate?.warnings]),
        eventsWarnings: JSON.stringify(s.eventsWarnings),
      });
      const fromStorage = async () => {
        const r = await storedRecords(page);
        return fields({
          ab: r.ab,
          filter: r.ui?.filter,
          version: r.curation?.sampleCurationVersion,
          metadata: r.metadata,
          plate: r.plate,
          eventsWarnings: r.events?.warnings,
        });
      };
      const stored = await fromStorage();
      check(
        stored.firstHeader === "id_mgs" && stored.integer && stored.lowAbFilter === false && stored.version === 2 &&
          /more than one row/.test(stored.metadata) && /no readable well/.test(stored.plate) && /outside \(0, 1\]/.test(stored.eventsWarnings),
        "B1.7 the first wave's fields are stored",
        JSON.stringify(stored).slice(0, 300),
      );
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      await openTab(page, "Overview");
      await saved(page);
      check(JSON.stringify(await fromStorage()) === JSON.stringify(stored), "B1.7 …unchanged after a reload");
      check(!(await toggle.isChecked()), "B1.7 the low-abundance filter is still off after a reload");
      check(/Events file: 1 event has a rate outside/.test(await warningsBanner(page)), "B1.7 the events parser's warning is still shown after a reload");

      const fromJSON = (j) =>
        fields({
          ab: j.abundance,
          filter: j.ui_state?.filter,
          version: j.sample_curation_version,
          metadata: j.metadata,
          plate: j.plate_map,
          eventsWarnings: j.events_warnings,
        });
      const text = await exportSession(page);
      const first = text ? fromJSON(JSON.parse(text)) : null;
      check(JSON.stringify(first) === JSON.stringify(stored), "B1.7 the session JSON carries them", JSON.stringify(first).slice(0, 300));
      // Imported in a fresh profile, then downloaded again.
      const other = await ctx.browser().newContext({ viewport: { width: 1500, height: 1000 } });
      const p2 = await other.newPage();
      await p2.addInitScript(() => localStorage.setItem("crocodeel-tutorial-seen", "1"));
      await p2.goto(BASE, { waitUntil: "networkidle" });
      await importSession(p2, text || "{}");
      await p2.waitForTimeout(1500);
      const again = await exportSession(p2);
      check(!!again && JSON.stringify(fromJSON(JSON.parse(again))) === JSON.stringify(stored), "B1.7 …and get through an import and a second download unchanged");
      await other.close();
    },
    { demo: false },
  );
} finally {
  await browser.close();
  stopServer();
}

finish();
