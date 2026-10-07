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
     - two tabs restored at once on a session of the previous version
       both save: it is brought up to date once, when it is migrated;
     - what a tab still running the previous version saves after the
       migration is brought in at the next boot, and said;
     - the curated events TSV, reloaded into a fresh session, gives back
       the targets' verdicts set by hand (and so the curated table), the
       study and the automatic actions at once, and the events added by
       hand, which a later rerun's carry-over keeps;

   The stored state is read from IndexedDB, as the app reads it
   (src/persistence.js).

   Usage:  npm run build && node e2e/final-state.e2e.mjs
           (or through e2e/run-all.mjs; BASE_URL skips the server,
           E2E_ONLY=<regex> runs only the matching scenarios) */

import { readFileSync } from "node:fs";
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

/** The stored session rewritten in the previous version's layout: one
    "main" record (the events with their verdicts and notes, no sample
    curation version) and the table, without a token; `edit(main)` then
    changes it. The page leaves the app first, so that nothing writes
    meanwhile; its next goto(BASE) boots it again. */
async function toPreviousLayout(page, edit = () => {}) {
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
    runMetadata: r.events.runMetadata,
    metadata: r.metadata || null,
    plateMap: r.plate || null,
    analysisTitle: cur.analysisTitle,
    tab: r.ui?.tab,
    selId: r.ui?.selId,
    filter: r.ui?.filter,
    sort: r.ui?.sort,
  };
  edit(main);
  const { storageToken: _token, ...ab } = r.ab;
  await writeRecords(page, { main, ab }, ["events", "curation", "metadata", "plate", "ui"]);
  return main;
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

/** The curated events TSV of the Export tab. */
async function exportEventsTSV(page) {
  await openTab(page, "Export");
  return download(page, page.getByRole("button", { name: /Download events TSV/i }).first());
}

/** Load an events file through the card, answering the question it asks
    when the session holds curation (`choice`: "Carry over" or "Start
    fresh"). */
async function loadEvents(page, name, text, choice = "Carry over") {
  await upload(page, 0, name, text);
  const ask = page.getByRole("dialog", { name: "Replace the events file?" });
  if (await ask.count()) {
    await ask.getByRole("button", { name: choice }).click();
    await page.waitForTimeout(1500);
  }
}

/** The headline counters of the Overview tab. */
async function overview(page) {
  await openTab(page, "Overview");
  const text = await page.locator("body").innerText();
  const stat = (re) => Number(text.match(re)?.[1] ?? NaN);
  return {
    tp: stat(/Validated \(TP\)\s*(\d+)/i),
    keep: stat(/Samples to keep\s*(\d+)/i),
    suppress: stat(/Samples to suppress\s*(\d+)/i),
  };
}

/** Click a button of a Samples-tab row, by its label. */
async function sampleButton(page, id, label) {
  await openTab(page, "Samples");
  await page.locator(`#samplerow-${id} button[aria-label="${label}"]`).first().click();
  await page.waitForTimeout(300);
}

/** Add an event through Scatter › Explore new pairs (a true positive by
    default). */
async function addEventByHand(page, source, target) {
  await openTab(page, "Scatter");
  await page.getByRole("button", { name: /^Explore new pairs$/ }).first().click();
  await page.waitForTimeout(800);
  const src = page.locator('input[placeholder="Type to search… e.g. ERS848718"]');
  await src.click();
  await src.fill(source);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const tgt = page.locator('input[placeholder="Pick from neighbors / same subject / others…"]');
  await tgt.click();
  await tgt.fill(target);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /Save as new contamination event/ }).click();
  await page.waitForTimeout(1500);
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

  /* Two tabs restored at once on a session of the previous version. */
  await scenario("FS two tabs open a previous session at once", async (page, ctx) => {
    await openTab(page, "Events");
    await page.locator('button[title="mark as true positive"]').first().click();
    await saved(page);
    await toPreviousLayout(page, (main) => {
      // Its model: a bulk TP left the target without an entry, the
      // Samples tab stamped a sample no event targets.
      const target = main.rawEvents.find((e) => e.verdict === "true_positive").target;
      delete main.sampleCuration[target];
      main.sampleCuration["63D250"] = { verdict: "correct", action: "keep" };
    });
    const other = await ctx.newPage();
    await Promise.all([page.goto(BASE, { waitUntil: "networkidle" }), other.goto(BASE, { waitUntil: "networkidle" })]);
    await page.waitForTimeout(3000);
    let told = 0;
    for (const p of [page, other]) {
      const dialog = p.getByRole("dialog", { name: "Session brought up to date" });
      if (await dialog.count()) {
        told += /Now to suppress \(1\)/.test(await dialog.innerText()) ? 1 : 0;
        await dialog.getByRole("button", { name: /^Close$/ }).click();
      }
    }
    check(told === 1, "FS the tab that migrated it says what the update changed", `${told} tab(s)`);
    const r = await storedRecords(page);
    check(
      r.curation?.rev === 1 && r.curation?.sampleCurationVersion === 2 && !r.main,
      "FS the previous session is migrated once, up to date",
      `rev ${r.curation?.rev}, version ${r.curation?.sampleCurationVersion}, main ${!!r.main}`,
    );
    check(
      (await banner(page, "conflict").count()) === 0 && (await banner(other, "conflict").count()) === 0,
      "FS neither tab is told the session changed in another tab",
    );
    // The second tab saves.
    await openTab(other, "Events");
    await other.locator('button[title="mark as false positive"]').nth(3).click();
    await saved(other);
    const after = await storedRecords(other);
    check(
      after.curation?.rev === 2 && Object.values(after.curation.verdicts).includes("false_positive"),
      "FS and the second tab saves its evaluation",
      `rev ${after.curation?.rev}`,
    );
  });

  /* A tab still running the previous version saves after the migration. */
  await scenario("FS earlier-version tab saves after the migration", async (page) => {
    await openTab(page, "Events");
    await page.locator('button[title="mark as true positive"]').first().click();
    await saved(page);
    await page.goto(`${BASE}favicon.svg`);
    const r = await storedRecords(page);
    const cur = r.curation;
    // That tab's "main" record: the session as it holds it, with two more
    // evaluations, saved after the current records.
    const oldTab = (savedAt, verdict) => ({
      version: 1,
      savedAt,
      rawEvents: r.events.events.map((e) => ({
        ...e,
        verdict: e.id === 8 || e.id === 9 ? verdict : cur.verdicts[String(e.id)] || "pending",
        notes: cur.notes[String(e.id)] || "",
      })),
      sampleCuration: cur.sampleCuration,
      runMetadata: r.events.runMetadata,
      metadata: r.metadata || null,
      plateMap: r.plate || null,
      analysisTitle: cur.analysisTitle,
      tab: "table",
      selId: null,
      filter: r.ui?.filter,
      sort: r.ui?.sort,
    });
    await writeRecords(page, { main: oldTab(new Date(Date.now() + 1000).toISOString(), "true_positive") });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    const after = await storedRecords(page);
    check(
      after.curation.verdicts["8"] === "true_positive" && after.curation.verdicts["9"] === "true_positive" && !after.main,
      "FS the earlier-version tab's save is brought in, its record dropped",
      `8: ${after.curation.verdicts["8"]}, 9: ${after.curation.verdicts["9"]}, main ${!!after.main}, rev ${cur.rev} -> ${after.curation.rev}`,
    );
    check(/earlier version of this interface saved the session/.test(await noticeText(page)), "FS and the notice says so", (await noticeText(page)).slice(0, 160));
    // A save of that tab older than this version's last one: superseded.
    await page.goto(`${BASE}favicon.svg`);
    await writeRecords(page, { main: oldTab("2020-01-01T00:00:00.000Z", "false_positive") });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    const last = await storedRecords(page);
    check(
      last.curation.verdicts["8"] === "true_positive" && last.curation.rev === after.curation.rev,
      "FS an older save of that tab does not replace this version's",
      `8: ${last.curation.verdicts["8"]}`,
    );
  });

  /* The curated events TSV, reloaded into a colleague's fresh session. */
  await scenario("FS curated TSV round trip", async (page) => {
    // 58M → 58D7 (event 2) is a true positive, yet the curator keeps
    // 58D7: Not contaminated, set by hand. 63D29 → 63D40 (event 1) too.
    await openTab(page, "Events");
    for (const id of [2, 1]) {
      await page.locator(`tr[data-event-row="${id}"] button[title="mark as true positive"]`).click();
      await page.waitForTimeout(300);
    }
    await sampleButton(page, "58D7", "Set verdict to Not contaminated");
    await page.locator('button[title="Click to rename this study"]').first().click();
    await page.locator('input[placeholder="Study title"]').fill("Plate 3, curated");
    await page.keyboard.press("Enter");
    await saved(page);
    const before = { card: await curatedCard(page), ...(await overview(page)) };
    check(before.card === "90 of 91" && before.suppress === 1, "FS the curated session keeps 58D7", JSON.stringify(before));
    const text = await exportEventsTSV(page);
    const { ctx: ctx2, page: fresh } = await newPage(browser);
    try {
      await loadEvents(fresh, "contamination_events_curated.tsv", text);
      await upload(fresh, 1, "species_abundance.tsv", demo("species_abundance.tsv"));
      await saved(fresh);
      const after = { card: await curatedCard(fresh), ...(await overview(fresh)) };
      check(
        JSON.stringify(after) === JSON.stringify(before),
        "FS reloaded into a fresh session: the same counts and curated table, 58D7 kept",
        `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
      );
      check((await studyLabel(fresh)) === "Plate 3, curated", "FS and its study, without a reload", await studyLabel(fresh));
      const sc = (await storedRecords(fresh)).curation.sampleCuration;
      check(
        JSON.stringify(sc["58D7"]) === JSON.stringify({ verdict: "correct" }) && sc["63D40"]?.action === "suppress",
        "FS 58D7 is Not contaminated by hand again, 63D40 suppressed automatically",
        JSON.stringify([sc["58D7"], sc["63D40"]]),
      );
    } finally {
      await ctx2.close();
    }
  });

  /* An event added by hand, through the curated TSV and two reruns. */
  await scenario("FS curated TSV keeps the events added by hand", async (page) => {
    await addEventByHand(page, "69M", "69D49");
    await saved(page);
    const manualPair = async (p) => {
      const r = await storedRecords(p);
      const e = (r.events?.events || []).find((x) => x.source === "69M" && x.target === "69D49");
      return { id: e?.id, verdict: e ? r.curation.verdicts[String(e.id)] : undefined, action: r.curation.sampleCuration["69D49"]?.action };
    };
    const added = await manualPair(page);
    check(added.id === "manual-1" && added.verdict === "true_positive", "FS the event added by hand is stored", JSON.stringify(added));
    const text = await exportEventsTSV(page);
    // Carried over: the session's own export, then the next CroCoDeEL run.
    await loadEvents(page, "contamination_events_curated.tsv", text);
    await saved(page);
    check(JSON.stringify(await manualPair(page)) === JSON.stringify(added), "FS its own export carried over keeps it added by hand", JSON.stringify(await manualPair(page)));
    await loadEvents(page, "contamination_events.tsv", demo("contamination_events.tsv"));
    await saved(page);
    const rerun = await manualPair(page);
    check(
      rerun.id === "manual-1" && rerun.verdict === "true_positive" && rerun.action === "suppress",
      "FS the next run, which does not have it, keeps it with its TP and its target suppressed",
      JSON.stringify(rerun),
    );
    // A colleague's fresh session.
    const { ctx: ctx2, page: fresh } = await newPage(browser);
    try {
      await loadEvents(fresh, "contamination_events_curated.tsv", text);
      check(JSON.stringify(await manualPair(fresh)) === JSON.stringify(added), "FS reloaded into a fresh session, it is added by hand there too", JSON.stringify(await manualPair(fresh)));
    } finally {
      await ctx2.close();
    }
  });
} finally {
  await browser.close();
  stopServer();
}
finish();
