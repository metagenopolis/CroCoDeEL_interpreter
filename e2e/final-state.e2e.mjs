/* Browser checks for the session state as a whole, after the six work
   packages were merged: what a reload, a clear, an import or an export
   leaves of the curation.

     - clearing the session clears its study title too, so the next
       events file's "# study:" line names the study;
     - a session file whose filter holds markup brings none of it into
       the events HTML report;

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
} finally {
  await browser.close();
  stopServer();
}
finish();
