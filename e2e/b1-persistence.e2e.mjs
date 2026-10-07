/* Browser checks for the session's persistence: what the browser keeps of
   the curation, and what replacing or importing files does to it.

     - replacing the events file asks first when the session holds
       curation: carry it over (matched by source and target), start
       fresh, or cancel — and a banner says what happened; clearing the
       events file asks too and says the curation goes with it;
     - the curated events TSV of the Export tab, reloaded into a fresh
       session, gives back the same evaluations, notes, sample actions,
       Overview counts and curated-abundance card;
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
     - a malformed session JSON is refused and the previous session stays,
       across a reload; the error screen says what is really stored;
     - clearing the events file keeps the abundance table and the metadata
       across a reload;
     - the fields of the first wave of fixes survive a reload and the
       session JSON round trip.

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

  /* B1.4 Importing a malformed session JSON. */
  await scenario("B1.4 malformed import", async (page) => {
    await mark(page, "true positive", 0);
    await mark(page, "true positive", 1);
    await saved(page);
    const good = JSON.parse(await exportSession(page));
    const alert = async () => (await page.locator('[role="alert"]').allInnerTexts()).join(" ");
    for (const [what, edit, re] of [
      ["an abundance table that is not one", (j) => (j.abundance.matrix = "oops"), /abundance: "matrix"/],
      ["an event without a target", (j) => delete j.events[3].target, /event 4 has no source or no target/],
      ["metadata without its samples", (j) => (j.metadata = { nSamples: 3 }), /metadata: "bySample"/],
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

  /* B1.4 The error screen says what is really stored, and offers it. */
  await scenario(
    "B1.4 error screen",
    async (page, ctx) => {
      await mark(page, "true positive", 0);
      await saved(page);
      // A plate map stored without its format: the plate card cannot
      // render, outside any tab — the whole app stops.
      await editRecord(page, "plate", "r.format = null; return r;");
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
      // That file imports in a fresh session (its plate format repaired).
      const p2 = await (await ctx.browser().newContext()).newPage();
      await p2.addInitScript(() => localStorage.setItem("crocodeel-tutorial-seen", "1"));
      await p2.goto(BASE, { waitUntil: "networkidle" });
      await importSession(p2, json || "{}");
      check((await overviewStats(p2)).tp === 1, "B1.4 the downloaded session imports, with its TP");
      await p2.context().close();
    },
    { expectedErrors: /Cannot read properties of null|render error|The above error occurred/ },
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
