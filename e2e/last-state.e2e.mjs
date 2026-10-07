/* Browser checks for the last fixes to the session state:

     - a stored session of the previous version whose abundance table kept
       a sample column with an empty name (trailing tabs on its header):
       the column is left out, and the warning about the columns that sum
       to 0 no longer counts it;
     - a tab still running the previous version saves after the update,
       then this tab saves (or reloads right after a change, or had found
       nothing stored): this tab stops saving and says so, and the next
       boot brings that save in, instead of losing it without a word;
     - an event targets "s2", the abundance table names it "S2": the
       Samples tab has one row for it, the table's, with the event's
       curation, as the samples TSV and the curated table have; its
       decisions and its drill-ins reach the event's spelling;

   The stored state is read from IndexedDB, as the app reads it
   (src/persistence.js).

   Usage:  npm run build && node e2e/last-state.e2e.mjs
           (or through e2e/run-all.mjs; BASE_URL skips the server,
           E2E_ONLY=<regex> runs only the matching scenarios) */

import {
  BASE,
  startServer,
  stopServer,
  launchBrowser,
  newPage,
  loadDemo,
  openTab,
  tsvInput,
  check,
  finish,
} from "./harness.mjs";

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

/** The "main" record of the previous version for the session the records
    hold: the events with their verdicts and notes, no sample curation
    version. */
function previousMain(r, savedAt = new Date().toISOString()) {
  const cur = r.curation;
  return {
    version: 1,
    savedAt,
    rawEvents: r.events.events.map((e) => ({
      ...e,
      verdict: cur.verdicts[String(e.id)] || "pending",
      notes: cur.notes[String(e.id)] || "",
    })),
    sampleCuration: cur.sampleCuration,
    runMetadata: r.events.runMetadata,
    metadata: r.metadata || null,
    plateMap: r.plate || null,
    analysisTitle: cur.analysisTitle,
    tab: r.ui?.tab,
    selId: r.ui?.selId,
    filter: r.ui?.filter,
    sort: r.ui?.sort,
  };
}

/** Evaluate an event in the Events table. */
async function mark(page, id, kind) {
  await openTab(page, "Events");
  await page.locator(`tr[data-event-row="${id}"] button[title="mark as ${kind}"]`).click();
}

const banner = (page, state) => page.locator(`[data-save-banner="${state}"]`);

/** Write, as a tab still running the previous version does, its "main"
    record over the current records: the session the records hold with
    events 8 and 9 marked true positive, saved now. */
async function earlierTabSaves(page) {
  const r = await storedRecords(page);
  const main = previousMain(r);
  for (const e of main.rawEvents) if (e.id === 8 || e.id === 9) e.verdict = "true_positive";
  await writeRecords(page, { main });
  return r;
}

/** Upload `text` through the i-th file card (0 events, 1 abundance). */
async function upload(page, i, name, text) {
  await tsvInput(page, i).setInputFiles({
    name,
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from(text),
  });
  await page.waitForTimeout(1500);
}

/** The counters of the tab on screen, by label. */
function stats(page) {
  return page.evaluate(() => {
    const out = {};
    for (const v of document.querySelectorAll("div.mt-1.tabular")) {
      const label = v.previousElementSibling?.textContent?.trim();
      if (label) out[label] = Number(v.textContent.trim());
    }
    return out;
  });
}

/** The "N of M samples" of the Export tab's curated abundance card. */
async function curatedCard(page) {
  await openTab(page, "Export");
  const text = await page.locator("body").innerText();
  const m = text.match(/Curated abundance table — (\d+) of (\d+) samples/);
  return m ? `${m[1]} of ${m[2]}` : null;
}

/** The text of the notice banner ("" when there is none). */
async function noticeText(page) {
  const n = page.locator("[data-notice]");
  return (await n.count()) ? (await n.first().innerText()).replace(/\s+/g, " ") : "";
}

/** Let the autosave (0.3 s after the last change) write. */
const saved = (page) => page.waitForTimeout(1200);

/** Leave the app, so that nothing writes while the records are changed;
    `back(page)` boots it again. */
const leave = (page) => page.goto(`${BASE}favicon.svg`);
async function back(page) {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
}

await startServer();
const browser = await launchBrowser();

/* One fresh page per scenario. A scenario that throws is reported as a
   failed check and the others still run. E2E_ONLY=<regex> runs only the
   scenarios whose name matches. */
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
async function scenario(name, run, { demo: withDemo = true } = {}) {
  if (ONLY && !ONLY.test(name)) return;
  const { ctx, page, errors } = await newPage(browser);
  try {
    if (withDemo) await loadDemo(page);
    await run(page, ctx);
  } catch (e) {
    check(false, `${name} runs to the end`, String(e).split("\n")[0]);
  }
  check(errors.length === 0, `${name}: no JS error`, errors[0] || "");
  await ctx.close();
}

try {
  /* The previous version stored a table read from a file with trailing
     tabs: 92 samples, one of them named "", and its warning that 1 of 92
     columns sums to 0. */
  await scenario("LS previous table with an empty-named column", async (page) => {
    await saved(page);
    await leave(page);
    const r = await storedRecords(page);
    const ab = structuredClone(r.ab);
    delete ab.storageToken;
    delete ab.colSums;
    delete ab.integerCols;
    ab.samples.push("");
    ab.warnings = [`1 of ${ab.samples.length} sample columns sum to 0 and were left empty.`];
    await writeRecords(page, { main: previousMain(r), ab }, ["events", "curation", "metadata", "plate", "ui"]);
    await back(page);
    const said = await noticeText(page);
    check(
      /column with an empty name and no value/.test(said),
      "LS the notice says the empty-named column was left out",
      said.slice(0, 200),
    );
    const body = await page.locator("body").innerText();
    check(
      !/sample columns sum to 0/.test(body),
      "LS and no warning counts it among the columns that sum to 0 any more",
      (body.match(/.{0,40}sample columns sum to 0.{0,40}/) || [""])[0],
    );
    await saved(page);
    const after = await storedRecords(page);
    check(
      after.ab?.samples?.length === 91 && !(after.ab.warnings || []).some((w) => /sum to 0/.test(w)),
      "LS the stored table has the 91 samples, without that warning",
      `${after.ab?.samples?.length} samples, ${JSON.stringify(after.ab?.warnings)}`,
    );
  });

  /* A tab still running the previous version (open since before the
     update) saves after this tab migrated the session, then this tab
     saves. The earlier tab's save used to be lost without a word: this
     tab's save was newer, so the next boot took that record for one it
     had superseded. */
  await scenario("LS earlier-version tab saves, then this tab saves", async (page) => {
    await mark(page, 1, "true positive");
    await saved(page);
    const before = await earlierTabSaves(page);
    await mark(page, 10, "false positive");
    await saved(page);
    const r = await storedRecords(page);
    check(
      (await banner(page, "conflict").count()) === 1,
      "LS this tab's next save finds the earlier version's save, and says the session was changed in another tab",
    );
    check(
      r.curation.rev === before.curation.rev && r.curation.verdicts["10"] === undefined && !!r.main,
      "LS …and writes nothing over it",
      `rev ${before.curation.rev} -> ${r.curation.rev}, event 10: ${r.curation.verdicts["10"]}, main kept: ${!!r.main}`,
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    check(
      /earlier version of this interface saved the session/.test(await noticeText(page)),
      "LS after a reload, the notice says the earlier version's save is the session",
      (await noticeText(page)).slice(0, 160),
    );
    const after = await storedRecords(page);
    check(
      after.curation.verdicts["8"] === "true_positive" && after.curation.verdicts["9"] === "true_positive" && !after.main,
      "LS …and its evaluations are there, its record dropped",
      `8: ${after.curation.verdicts["8"]}, 9: ${after.curation.verdicts["9"]}, main kept: ${!!after.main}`,
    );
  });

  /* The same, when this tab's change is saved as the page goes away (a
     reload right after it): that last save cannot check anything, and
     must not hide the earlier version's save either. */
  await scenario("LS earlier-version tab saves, then this tab reloads right after a change", async (page) => {
    await mark(page, 1, "true positive");
    await saved(page);
    await earlierTabSaves(page);
    await mark(page, 10, "false positive");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    check(
      /earlier version of this interface saved the session/.test(await noticeText(page)),
      "LS the notice says the earlier version's save is the session",
      (await noticeText(page)).slice(0, 160),
    );
    const after = await storedRecords(page);
    check(
      after.curation.verdicts["8"] === "true_positive" && after.curation.verdicts["9"] === "true_positive" && !after.main,
      "LS …and its evaluations are there, its record dropped",
      `8: ${after.curation.verdicts["8"]}, 9: ${after.curation.verdicts["9"]}, main kept: ${!!after.main}`,
    );
  });

  /* An event targets "s2", the abundance table names it "S2". The Samples
     tab listed both: "s2" with its event and its automatic Suppress, and
     "S2" with no event, no verdict and no action, while the curated table
     dropped S2 and the samples TSV had one S2 row. */
  await scenario(
    "LS a target written in another case, on the Samples tab",
    async (page) => {
      await upload(
        page,
        0,
        "contamination_events.tsv",
        [
          "source\ttarget\trate\tprobability\tcontamination_specific_species",
          "S1\ts2\t0.25\t0.97\tsp_A,sp_B",
          "S3\tS4\t0.1\t0.8\tsp_C",
        ].join("\n"),
      );
      await upload(
        page,
        1,
        "species_abundance.tsv",
        [
          "OTU_ID\tS1\tS2\tS3\tS4\tS5\tS6\tS7\tS8",
          "sp_A\t5\t1\t0\t3\t9\t3\t0\t1",
          "sp_B\t6\t1\t6\t9\t0\t5\t4\t4",
          "sp_C\t1\t2\t3\t4\t5\t6\t7\t8",
        ].join("\n"),
      );
      await mark(page, 0, "true positive");
      await saved(page);
      await openTab(page, "Samples");
      const row = page.locator("#samplerow-S2");
      check(
        (await page.locator("#samplerow-s2").count()) === 0 && (await row.count()) === 1,
        "LS the Samples tab has one row for S2, the table's",
        `rows s2: ${await page.locator("#samplerow-s2").count()}, S2: ${await row.count()}`,
      );
      const s = await stats(page);
      check(
        s.Samples === 8 && s.Contaminated === 1 && s["To suppress"] === 1,
        "LS it counts the table's 8 samples, S2 contaminated and to suppress",
        JSON.stringify(s),
      );
      const verdictTitle = await row.locator('button[data-verdict-chip="contaminated"]').getAttribute("title").catch(() => null);
      const suppress = row.locator('button[aria-label="Suppress S2"]');
      const suppressTitle = (await suppress.count()) ? await suppress.getAttribute("title") : null;
      check(
        /^Contaminated, automatic/.test(verdictTitle || "") && /^Suppress \(automatic/.test(suppressTitle || ""),
        "LS S2's row shows the event's automatic Contaminated and Suppress",
        `${verdictTitle} | ${suppressTitle}`,
      );
      // A decision on that row reaches the curation the event's spelling
      // holds, where the rule writes: the Suppress it replaces.
      const keep = row.locator('button[aria-label="Keep S2"]');
      if (await keep.count()) {
        await keep.click();
        await saved(page);
      }
      const sc = (await storedRecords(page)).curation?.sampleCuration || {};
      check(
        sc.s2?.action === "keep" && !sc.s2.actionAuto && !("S2" in sc),
        "LS Keep on that row is the event's sample's own Keep, stored once",
        JSON.stringify({ s2: sc.s2, S2: sc.S2 }),
      );
      const after = await stats(page);
      check(
        after["To suppress"] === 0 && after["To keep"] === 1 && (await curatedCard(page)) === "8 of 8",
        "LS S2 is kept: the counters and the curated table agree",
        `${JSON.stringify(after)}, curated ${await curatedCard(page)}`,
      );
      // Its drill-in finds the event, which names it "s2".
      await openTab(page, "Samples");
      const drill = page.locator('#samplerow-S2 button[title="Open the events where S2 is the target in the Events table"]');
      if (await drill.count()) {
        await drill.click();
        await page.waitForTimeout(900);
      }
      check(
        (await page.locator('tr[data-event-row="0"]').count()) === 1 && (await page.locator('tr[data-event-row="1"]').count()) === 0,
        "LS its Events drill-in lists the event that targets s2, and only it",
        `event rows: ${await page.locator("tr[data-event-row]").count()}`,
      );
    },
    { demo: false },
  );

  /* What this version wrote after the earlier tab's save stays this
     version's when that save came before it: superseded, as before. */
  await scenario("LS earlier-version save older than this tab's", async (page) => {
    await saved(page);
    const r = await storedRecords(page);
    const main = previousMain(r, "2020-01-01T00:00:00.000Z");
    for (const e of main.rawEvents) if (e.id === 8) e.verdict = "false_positive";
    await writeRecords(page, { main });
    await mark(page, 10, "false positive");
    await saved(page);
    const after = await storedRecords(page);
    check(
      (await banner(page, "conflict").count()) === 0 && after.curation.verdicts["10"] === "false_positive",
      "LS a save of the earlier version older than this tab's last one does not stop this tab",
      `event 10: ${after.curation.verdicts["10"]}`,
    );
  });

  /* Nothing was stored when this tab opened; a tab of the previous
     version loads files and saves, then this one loads the demo. Its
     first save, which writes every record, deleted that session. */
  await scenario(
    "LS earlier-version tab saves into an empty store, then this tab saves",
    async (page) => {
      const ev = (id, source, target) => ({
        id,
        source,
        target,
        rate: 0.1,
        score: 0.9,
        introduced: ["sp_a"],
        verdict: "true_positive",
        notes: "",
      });
      await writeRecords(page, {
        main: {
          version: 1,
          savedAt: new Date().toISOString(),
          rawEvents: [ev(0, "A1", "B1"), ev(1, "A2", "B2")],
          sampleCuration: {},
          runMetadata: null,
          metadata: null,
          plateMap: null,
          analysisTitle: "",
          tab: "overview",
          selId: null,
        },
      });
      await loadDemo(page);
      await saved(page);
      const r = await storedRecords(page);
      check(
        (await banner(page, "conflict").count()) === 1 && !r.curation && !!r.main,
        "LS this tab's first save finds that session, writes nothing over it, and says so",
        `curation stored: ${!!r.curation}, main kept: ${!!r.main}`,
      );
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(2500);
      const after = await storedRecords(page);
      check(
        after.events?.events?.length === 2 && Object.keys(after.curation?.verdicts || {}).length === 2 && !after.main,
        "LS after a reload, that session is the one stored",
        `${after.events?.events?.length} events, ${Object.keys(after.curation?.verdicts || {}).length} evaluated`,
      );
    },
    { demo: false },
  );
} finally {
  await browser.close();
  stopServer();
}
finish();
