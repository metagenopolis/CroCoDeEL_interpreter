/* Browser checks for the session state as a whole, after the six work
   packages were merged: what a reload, a clear, an import or an export
   leaves of the curation.

     - clearing the session clears its study title too, so the next
       events file's "# study:" line names the study;
     - a session file whose filter holds markup brings none of it into
       the events HTML report;
     - while the abundance table's write keeps failing, a tab switch
       neither rewrites the curation record nor makes another tab stale,
       and the table is written once there is room again;
     - a session file of the previous version holding what its parser
       kept (a sample column with an empty name, an event of a blank
       line, a negative cell) imports, repaired and said; so does the
       session this version downloads after opening such a stored
       session; a damaged stored session opens instead of blanking the
       app;

   The stored state is read from IndexedDB, as the app reads it
   (src/persistence.js).

   Usage:  npm run build && node e2e/final-state.e2e.mjs
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

/** Import a session JSON through the files bar, replacing the session
    when the app asks. */
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
  const ask = page.getByRole("dialog", { name: "Replace your session with the imported one?" });
  if (await ask.count()) {
    await ask.getByRole("button", { name: "Replace session" }).click();
    await page.waitForTimeout(1000);
  }
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

/* Abort every write of the abundance record while window.__failAb is
   set, once its request has succeeded — how a full quota arrives (an
   abort at commit, no error event). */
const FAIL_AB = () => {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const req = put.apply(this, args);
    if (window.__failAb && args[1] === "ab") {
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

const banner = (page, state) => page.locator(`[data-save-banner="${state}"]`);

/** The text of the notice banner ("" when there is none). */
async function noticeText(page) {
  const n = page.locator("[data-notice]");
  return (await n.count()) ? (await n.first().innerText()).replace(/\s+/g, " ") : "";
}

/** The "N of M samples" of the Export tab's curated abundance card. */
async function curatedCard(page) {
  await openTab(page, "Export");
  const text = await page.locator("body").innerText();
  const m = text.match(/Curated abundance table — (\d+) of (\d+) samples/);
  return m ? `${m[1]} of ${m[2]}` : null;
}

/** What the previous version's parser kept in a session of the demo,
    put into a session JSON of this version: no curation version nor
    parser warnings, no column sums, a sample "" holding 0 everywhere
    (tabs at the end of every abundance line), an event with an empty
    source and target (a line of tabs at the end of the events file),
    and a negative fraction. */
function asPreviousVersion(json) {
  const out = structuredClone(json);
  delete out.sample_curation_version;
  delete out.events_warnings;
  const ab = out.abundance;
  delete ab.colSums;
  delete ab.integerCols;
  delete ab.firstHeader;
  ab.samples.push("");
  for (const sp of ab.species) ab.matrix[sp][""] = 0;
  ab.matrix[ab.species[0]][ab.samples[0]] = -0.001;
  out.events.push({
    id: out.events.length,
    source: "",
    target: "",
    contamination_rate: 0,
    probability: 0,
    introduced_species: [],
    verdict: "pending",
    action: null,
    notes: "",
  });
  return out;
}

/** The title in the study pill of the files bar ("" when it is hidden). */
async function studyLabel(page) {
  const pill = page.locator('[title^="Inline study label"]');
  if (!(await pill.count())) return "";
  return (await pill.first().innerText()).replace(/^\s*study\s*/i, "").trim();
}

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
  /* Clear session: the study title goes with the rest. */
  await scenario("FS clear session clears the study", async (page) => {
    check(/^Demo/.test(await studyLabel(page)), "FS the demo names its study", await studyLabel(page));
    await page.getByRole("button", { name: /^Clear session$/ }).first().click();
    await page.getByRole("dialog", { name: "Clear the entire session?" }).getByRole("button", { name: /^Clear session$/ }).click();
    await saved(page);
    const r = await storedRecords(page);
    check(
      !r.curation || r.curation.analysisTitle === "",
      "FS Clear session leaves no study title behind",
      JSON.stringify(r.curation?.analysisTitle ?? null),
    );
    // The next events file's "# study:" line names the study.
    const [run, ...rest] = demo("contamination_events.tsv").split("\n");
    await upload(page, 0, "curated.tsv", [run, "# study: Plate 3, second look", ...rest].join("\n"));
    await saved(page);
    check(
      (await studyLabel(page)) === "Plate 3, second look",
      "FS the next file's '# study:' line names the study",
      await studyLabel(page),
    );
    check(
      (await storedRecords(page)).curation?.analysisTitle === "Plate 3, second look",
      "FS and it is the stored title",
    );
  });

  /* A crafted session file: its filter values never reach the report. */
  let crafted = null;
  await scenario("FS crafted filter (export)", async (page) => {
    crafted = JSON.parse(await exportSession(page));
    const f = crafted.ui_state.filter;
    f.subject = `<img src=x onerror="document.title='XSS-'+document.title">`;
    f.group = "<b id=xssgroup>g</b>";
    f.adjacent = "<i id=xssadj>a</i>";
    f.verdicts = ["true_positive", "<u id=xssverdict>v</u>"];
  });
  await scenario(
    "FS crafted filter stays out of the HTML report",
    async (page) => {
      await importSession(page, crafted);
      check(
        (await page.getByText("Failed to import session").count()) === 0,
        "FS the crafted session imports (its filter falls back to the defaults)",
      );
      await openTab(page, "Export");
      const html = await download(page, page.getByRole("button", { name: /Download events HTML/i }).first());
      const banner = (html || "").match(/<div class="filter-banner">[\s\S]{0,300}/)?.[0] || "";
      check(
        !!html && !/<(img|b|i|u) id=xss|<img src=x/.test(html),
        "FS the events HTML report holds none of the filter's markup",
        banner.replace(/\s+/g, " ").slice(0, 200),
      );
    },
    { demo: false },
  );

  /* The abundance table's write keeps failing (a full quota). */
  await scenario("FS failing table write and two tabs", async (page, ctx) => {
    await ctx.addInitScript(FAIL_AB);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.evaluate(() => (window.__failAb = true));
    await upload(page, 1, "species_abundance.tsv", demo("species_abundance.tsv"));
    await saved(page);
    const before = await storedRecords(page);
    check(
      !!before.curation?.abToken && !before.ab,
      "FS the table's write failed after the session's (its token named, no table stored)",
      `token ${before.curation?.abToken}, table ${!!before.ab}`,
    );
    // Another tab of the same session.
    const other = await ctx.newPage();
    await other.goto(page.url().replace(/#.*$/, ""), { waitUntil: "networkidle" });
    await other.waitForTimeout(1500);
    const rev = (await storedRecords(page)).curation.rev;
    // The first tab only switches tabs, each time after the retry pause.
    for (const t of ["Samples", "Overview", "Events"]) {
      await page.waitForTimeout(5300);
      await openTab(page, t);
    }
    await page.waitForTimeout(1500);
    check(
      (await storedRecords(page)).curation.rev === rev,
      "FS tab switches while the table waits do not rewrite the curation record",
      `${rev} -> ${(await storedRecords(page)).curation.rev}`,
    );
    check((await banner(other, "conflict").count()) === 0, "FS and the other tab is not told the session changed");
    // Room again: the table is stored, and the curation record names it
    // again (the other tab, which found the session without its table,
    // stopped naming it): the session has its table back, which the
    // other tab's copy lacks, so that tab is told.
    await page.evaluate(() => (window.__failAb = false));
    await page.waitForTimeout(5300);
    await openTab(page, "Overview");
    await page.waitForTimeout(1500);
    const after = await storedRecords(page);
    check(
      !!after.ab && after.ab.storageToken === after.curation.abToken && after.curation.rev === rev + 1,
      "FS once there is room, the table is stored and named by the curation record again",
      `token ${after.curation.abToken}, table ${after.ab?.storageToken}, rev ${rev} -> ${after.curation.rev}`,
    );
    check((await banner(other, "conflict").count()) === 1, "FS only then is the other tab told the session changed");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await openTab(page, "Export");
    check(
      /Curated abundance table — \d+ of 91 samples/.test(await page.locator("body").innerText()),
      "FS and the table comes back with the session after a reload",
    );
  });

  /* The previous version's session files and stored sessions. */
  let previous = null;
  await scenario("FS previous session (export)", async (page) => {
    await openTab(page, "Events");
    await page.locator('button[title="mark as true positive"]').first().click();
    await saved(page);
    previous = asPreviousVersion(JSON.parse(await exportSession(page)));
  });
  await scenario(
    "FS previous session file imports, repaired",
    async (page) => {
      await importSession(page, previous);
      check(
        (await page.getByText("Failed to import session").count()) === 0,
        "FS a session file of the previous version imports",
      );
      const said = await noticeText(page);
      check(
        /left out/.test(said) && /negative abundance was read as 0/.test(said),
        "FS and the notice says what was repaired",
        said.slice(0, 260),
      );
      check((await curatedCard(page)) === "90 of 91", "FS the empty column is gone, the TP's target suppressed", await curatedCard(page));
      const r = await storedRecords(page);
      check(
        r.events?.events?.length === 24 && !r.ab.samples.includes(""),
        "FS the stored session has the 24 events and the 91 samples",
        `${r.events?.events?.length} events, ${r.ab?.samples?.length} samples`,
      );
    },
    { demo: false },
  );
  await scenario("FS previous stored session opens repaired, and its download imports", async (page) => {
    // The previous version's layout: one "main" record and the table.
    await page.goto(page.url().replace(/#.*$/, "") + "favicon.svg");
    const r = await storedRecords(page);
    const cur = r.curation;
    const ab = structuredClone(r.ab);
    delete ab.storageToken;
    delete ab.colSums;
    delete ab.integerCols;
    ab.samples.push("");
    const main = {
      version: 1,
      savedAt: new Date().toISOString(),
      rawEvents: [
        ...r.events.events.map((e) => ({ ...e, verdict: cur.verdicts[String(e.id)] || "pending", notes: cur.notes[String(e.id)] || "" })),
        { id: r.events.events.length, source: "", target: "", rate: 0, score: 0, introduced: [], verdict: "pending", notes: "" },
      ],
      sampleCuration: cur.sampleCuration,
      runMetadata: r.events.runMetadata,
      metadata: r.metadata || null,
      plateMap: r.plate || null,
      analysisTitle: cur.analysisTitle,
      tab: "overview",
      selId: null,
      filter: r.ui?.filter,
      sort: r.ui?.sort,
    };
    await writeRecords(page, { main, ab }, ["events", "curation", "metadata", "plate", "ui"]);
    await page.goto(page.url().replace(/favicon\.svg$/, ""), { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    const close = page.getByRole("button", { name: /^Close$/ });
    if (await close.count()) await close.first().click();
    check(
      /left out/.test(await noticeText(page)),
      "FS the previous version's stored session opens, the notice says what was repaired",
      (await noticeText(page)).slice(0, 200),
    );
    await saved(page);
    const json = JSON.parse(await exportSession(page));
    check(
      json.events.length === 24 && !json.abundance.samples.includes(""),
      "FS its download holds 24 events and no empty sample name",
      `${json.events.length} events`,
    );
    // Into a fresh page.
    const { ctx: ctx2, page: fresh } = await newPage(browser);
    await importSession(fresh, json);
    check(
      (await fresh.getByText("Failed to import session").count()) === 0 &&
        (await curatedCard(fresh)) === (await curatedCard(page)),
      "FS and that download imports, with the same curated table",
      await curatedCard(fresh),
    );
    await ctx2.close();
  });
  await scenario("FS damaged stored session opens", async (page) => {
    await saved(page);
    await page.goto(page.url().replace(/#.*$/, "") + "favicon.svg");
    const r = await storedRecords(page);
    const events = structuredClone(r.events);
    events.events[0].introduced = events.events[0].introduced.join(",");
    const plate = { ...r.plate, format: null };
    const metadata = structuredClone(r.metadata);
    metadata.bySample[Object.keys(metadata.bySample)[0]] = "P1";
    await writeRecords(page, { events, plate, metadata });
    await page.goto(page.url().replace(/favicon\.svg$/, ""), { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    check(
      (await page.getByText("Something went wrong while rendering").count()) === 0,
      "FS a stored species list kept as one text, a plate map without its format and a metadata row that is not an object do not blank the app",
    );
    const said = await noticeText(page);
    check(
      /split at the commas/.test(said) && /metadata/.test(said),
      "FS the notice says what was repaired and what was left out",
      said.slice(0, 260),
    );
    await openTab(page, "Plate");
    await openTab(page, "Samples");
    check(
      (await page.getByText("Something went wrong").count()) === 0,
      "FS the Plate and Samples tabs show",
    );
  });
} finally {
  await browser.close();
  stopServer();
}
finish();
