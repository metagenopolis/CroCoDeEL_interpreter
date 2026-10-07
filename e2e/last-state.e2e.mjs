/* Browser checks for the last fixes to the session state:

     - a stored session of the previous version whose abundance table kept
       a sample column with an empty name (trailing tabs on its header):
       the column is left out, and the warning about the columns that sum
       to 0 no longer counts it;

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
} finally {
  await browser.close();
  stopServer();
}
finish();
