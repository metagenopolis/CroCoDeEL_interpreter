/* Browser checks for the diagnostics fixes (work package a2-diagnostics).

   Each scenario loads small crafted files through the upload cards, so the
   expected outcome is known exactly:

     1. an event whose target is missing from the abundance table is "not
        evaluable" — never PROBABLY NOT CONTAMINATED — in Guided validation
        and the HTML report, and neither a pass nor a fail in the bulk
        dialog;
     2. the exported events HTML report prints a cascade's upstream rate,
        not "(NaN%)";
     3. species ids that CroCoDeEL rewrote as integers ("1" for the table's
        "001") still land on the contamination line, and pinning one from
        its chip rings the plotted point;
     4. a target written in another case than the table's column ("tgt"
        for "TGT") gets its introduced % in the exported events TSV;
     5. a run whose header declares `filtering_ab_thr_factor: 20.0` shows
        the low-abundance filter and its toggle; every diagnostic consumer
        (Guided validation, gallery, bulk dialog, HTML report, cascades)
        follows the filter and switching it off changes them — after the
        toggle says it is recomputing them — while the abundance download
        and the session keep the table as loaded; the choice survives a
        reload and a session file; a run with "None" shows no toggle;
     6. the bulk dialog's "Biological similarity" pass / fail picks select
        the events Guided validation ticks / crosses: high ρ between
        unrelated samples passes, high ρ within a subject or a group fails;
     7. the in-browser runner describes --filter-low-ab as the filter it is.

   Runs on its own (`node e2e/a2-diagnostics.e2e.mjs`, which starts a
   preview server unless BASE_URL is set) or through e2e/run-all.mjs. */

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

const tsvFile = (name, lines) => ({
  name,
  mimeType: "text/tab-separated-values",
  buffer: Buffer.from(lines.join("\n") + "\n"),
});

/** 30 species; SRC spans four decades, TGT holds 10 % of SRC on sp_0..sp_19
    plus natives of its own, OTHER is unrelated. */
function abundanceLines() {
  const lines = ["species\tSRC\tTGT\tOTHER"];
  for (let i = 0; i < 30; i++) {
    const src = 10 ** (-4 * (i / 29));
    const tgt = i < 20 ? 0.1 * src : i % 2 ? 0.5 : 0;
    lines.push(`sp_${i}\t${src.toPrecision(6)}\t${tgt.toPrecision(6)}\t${(i % 3) + 1}`);
  }
  return lines;
}
const ON_LINE = Array.from({ length: 20 }, (_, i) => `sp_${i}`).join(",");

/** A cascade C → A → B. A received six marker species from C (rate 0.2)
    and passed them on to B far below its own rate (0.05), so they sit
    above A → B's line, where only C → A can explain them. */
function cascadeLines() {
  const lines = ["species\tC\tA\tB"];
  for (let i = 0; i < 20; i++) {
    const a = 10 ** (-3 * (i / 19));
    lines.push(`s_${i}\t0\t${a.toPrecision(6)}\t${(0.05 * a).toPrecision(6)}`);
  }
  for (let i = 0; i < 6; i++) {
    const c = 10 ** (-1 - i / 3);
    lines.push(`m_${i}\t${c.toPrecision(6)}\t${(0.2 * c).toPrecision(6)}\t${(1e-4 * c).toPrecision(6)}`);
  }
  return lines;
}

/** SRC spans four decades; the HIGH_* targets hold 10 % of SRC on every
    species, so they rank exactly like SRC (ρ ≈ 1); LOW holds the same
    species in reverse order (ρ ≈ −1). Only the metadata tells the HIGH_*
    pairs apart. */
const BIOSIM_TARGETS = [
  "HIGH_UNRELATED",
  "HIGH_SAME_SUBJECT",
  "HIGH_SAME_GROUP",
  "HIGH_NO_METADATA",
  "LOW",
];
function biosimLines() {
  const lines = [["species", "SRC", ...BIOSIM_TARGETS].join("\t")];
  for (let i = 0; i < 30; i++) {
    const src = 10 ** (-4 * (i / 29));
    const low = 0.1 * 10 ** (-4 * ((29 - i) / 29));
    const cols = [src, 0.1 * src, 0.1 * src, 0.1 * src, 0.1 * src, low];
    lines.push([`sp_${i}`, ...cols.map((v) => v.toPrecision(8))].join("\t"));
  }
  return lines;
}

/** Load an events file and an abundance file through the upload cards,
    and a metadata file if given. */
async function loadFiles(page, events, abundance, metadata) {
  await tsvInput(page, 0).setInputFiles(events);
  await page
    .getByRole("button", { name: /^Validate$/ })
    .first()
    .waitFor({ state: "visible", timeout: 60000 });
  await tsvInput(page, 1).setInputFiles(abundance);
  await page.waitForTimeout(2000);
  if (metadata) {
    await tsvInput(page, 2).setInputFiles(metadata);
    await page.waitForTimeout(1000);
  }
}

/* ------------------------------------------------ bulk dialog helpers */
const applyButton = (page) =>
  page.getByRole("button", { name: /^Apply to \d+ events?$/ }).first();

/** Open "Bulk apply" from the Events tab. */
async function openBulk(page) {
  await openTab(page, "Events");
  await page.locator('button[aria-label="Bulk apply evaluation"]').first().click();
  await applyButton(page).waitFor({ timeout: 20000 });
}

/** Pick "any", "pass" or "fail" for the criterion whose label starts with
    `label`, and return how many events the dialog would apply to — or
    null if the criterion row is not there. */
async function bulkPick(page, label, pick) {
  const text = { any: "any", pass: "✓ pass", fail: "✗ fail" }[pick];
  const found = await page.evaluate(
    ({ label, text }) => {
      const span = [...document.querySelectorAll("span")].find((el) =>
        el.textContent.startsWith(label),
      );
      const button = span
        ? [...span.parentElement.querySelectorAll("button")].find(
            (b) => b.textContent.trim() === text,
          )
        : null;
      button?.click();
      return !!button;
    },
    { label, text },
  );
  if (!found) return null;
  await page.waitForTimeout(400);
  const name = await applyButton(page).innerText();
  return Number(name.match(/\d+/)[0]);
}

async function closeBulk(page) {
  await page.getByRole("button", { name: /^Cancel$/ }).first().click();
  await page.waitForTimeout(300);
}

/* --------------------------------------------------- download helpers */
/** Click `button` and return the file it downloads, { name, text }, or
    null if nothing downloads. */
async function downloadVia(page, button) {
  const [file] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
    button.click(),
  ]);
  return file ? { name: file.suggestedFilename(), text: readFileSync(await file.path(), "utf8") } : null;
}

/** The abundance table, as the files bar's Download gives it back. */
async function downloadAbundance(page) {
  const buttons = page.locator('button[title="Download this file"]');
  for (let i = 0; i < (await buttons.count()); i++) {
    const file = await downloadVia(page, buttons.nth(i));
    if (file?.name === "species_abundance.tsv") return file.text;
  }
  return null;
}

/** "Download session": the parsed JSON, or its text with { raw: true }. */
async function downloadSession(page, { raw = false } = {}) {
  const file = await downloadVia(page, page.getByRole("button", { name: /Download session/ }).first());
  if (!file) return null;
  return raw ? file.text : JSON.parse(file.text);
}

/** A cell of a TSV text, as a number (NaN if absent). */
function tsvCell(text, species, sample) {
  const rows = (text || "").split("\n").map((l) => l.split("\t"));
  const col = rows[0].indexOf(sample);
  return Number(rows.find((r) => r[0] === species)?.[col]);
}

/** Points drawn by the Scatter tab's gallery thumbnails (MiniScatter:
    grey, or red for on-line points when they are coloured). */
async function galleryPoints(page) {
  await openTab(page, "Scatter");
  return page.evaluate(
    () => document.querySelectorAll('svg circle[fill="#7d8b91"], svg circle[fill="#ed6e6c"]').length,
  );
}

await startServer();
const browser = await launchBrowser();
try {
  /* ------------- 1. target missing from the abundance table → not evaluable
     After a CroCoDeEL -s2 run (sources and targets in two tables) with only
     one table loaded, every event has a sample missing from the table. Its
     empty scatter used to score "0 species on the line" — a fail — and the
     panel announced PROBABLY NOT CONTAMINATED. */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadFiles(
      page,
      tsvFile("contamination_events.tsv", [
        "source\ttarget\trate\tprobability\tcontamination_specific_species",
        // Highest probability first, so Guided validation opens on it.
        `SRC\tNOT_IN_TABLE\t0.1\t0.99\t${ON_LINE}`,
        `SRC\tTGT\t0.1\t0.60\t${ON_LINE}`,
      ]),
      tsvFile("species_abundance.tsv", abundanceLines()),
    );
    await openTab(page, "Validate");
    const text = await page.locator("body").innerText();
    check(
      /not evaluable/i.test(text),
      "a pair missing from the abundance table is shown as not evaluable",
    );
    check(
      !/PROBABLY NOT CONTAMINATED/i.test(text),
      "…and is not graded PROBABLY NOT CONTAMINATED",
    );
    check(
      /Target sample "NOT_IN_TABLE" not found/i.test(text),
      "the panel says which sample is missing",
    );

    // The resolvable event of the same files is still graded normally.
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(800);
    const next = await page.locator("body").innerText();
    check(
      /CONTAMINATED — CroCoDeEL is probably right|POSSIBLY NOT CONTAMINATED|PROBABLY NOT CONTAMINATED/i.test(next) &&
        !/NOT EVALUABLE/.test(next),
      "the next, resolvable event gets a grade",
    );

    // Neither a pass nor a fail in the bulk dialog: SRC → TGT has 20
    // species on its line, the missing pair none to count.
    await openBulk(page);
    const pass = await bulkPick(page, "n on line", "pass");
    const fail = await bulkPick(page, "n on line", "fail");
    check(pass === 1 && fail === 0, "the bulk dialog matches the missing pair with neither pass nor fail", `pass ${pass}, fail ${fail}`);
    await closeBulk(page);

    // The HTML report says so too, rather than "abundance table required"
    // (the table is loaded) or a grade: SRC → TGT is CONTAMINATED, so any
    // other grade in the report would be the missing pair's.
    await openTab(page, "Export");
    const report = await downloadVia(page, page.getByRole("button", { name: /Download events HTML/i }).first());
    const html = report?.text || "";
    check(
      /Not evaluable — Target sample &quot;NOT_IN_TABLE&quot; not found in abundance table/.test(html),
      "the HTML report shows the pair as not evaluable and names the missing sample",
    );
    check(
      !!report && !/abundance table required/i.test(html) && !/NOT CONTAMINATED/.test(html),
      "…and gives it no grade",
      (html.match(/[^>]*NOT CONTAMINATED[^<]*/) || [""])[0],
    );
    check(errors.length === 0, "no JS error on a missing-sample event", errors[0] || "");
    await ctx.close();
  }

  /* ------------------------ 2. cascade rate in the exported HTML report
     The report prints each explaining upstream event as "C → A (rate%)",
     reading a rate the cascade entries never carried: "(NaN%)". */
  {
    const { ctx, page, errors } = await newPage(browser);
    const markers = Array.from({ length: 6 }, (_, i) => `m_${i}`).join(",");
    const shared = Array.from({ length: 20 }, (_, i) => `s_${i}`).join(",");
    await loadFiles(
      page,
      tsvFile("contamination_events.tsv", [
        "source\ttarget\trate\tprobability\tcontamination_specific_species",
        `C\tA\t0.2\t0.9\t${markers}`,
        `A\tB\t0.05\t0.8\t${shared}`,
      ]),
      tsvFile("species_abundance.tsv", cascadeLines()),
    );
    await openTab(page, "Overview");
    const overview = await page.locator("body").innerText();
    check(/Cascades detected\s*1\b/i.test(overview), "the crafted cascade is detected");
    await openTab(page, "Export");
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
      page.getByRole("button", { name: /Download events HTML/i }).first().click(),
    ]);
    check(!!download, "the events HTML report downloads");
    if (download) {
      const html = readFileSync(await download.path(), "utf8");
      check(/Cascade detected/.test(html), "the report has the cascade section");
      check(!/NaN%/.test(html), "the report contains no NaN%", (html.match(/.{0,60}NaN%/) || [""])[0]);
      check(
        /C<\/strong>|C → A/.test(html) && /\(20\.00%\) explains 6 species/.test(html),
        "the upstream event C → A is printed with its 20.00 % rate",
      );
    }
    check(errors.length === 0, "no JS error across the cascade report", errors[0] || "");
    await ctx.close();
  }

  /* ----------------------- 3. integer species ids rewritten by pandas
     A table whose species ids are all integers ("001".."030") is read by
     CroCoDeEL as an int64 index, so its events name the species "1".."20".
     An exact match found none of them: no point on the line, and the
     "match NOTHING in the abundance table" warning. */
  {
    const { ctx, page, errors } = await newPage(browser);
    const ids = Array.from({ length: 30 }, (_, i) => String(i + 1).padStart(3, "0"));
    const lines = ["species\tSRC\tTGT"];
    ids.forEach((id, i) => {
      const src = 10 ** (-4 * (i / 29));
      lines.push(`${id}\t${src.toPrecision(6)}\t${i < 20 ? (0.1 * src).toPrecision(6) : 0}`);
    });
    const written = Array.from({ length: 20 }, (_, i) => String(i + 1)).join(",");
    await loadFiles(
      page,
      tsvFile("contamination_events.tsv", [
        "source\ttarget\trate\tprobability\tcontamination_specific_species",
        `SRC\tTGT\t0.1\t0.9\t${written}`,
      ]),
      tsvFile("species_abundance.tsv", lines),
    );
    await openTab(page, "Validate");
    const text = await page.locator("body").innerText();
    check(/\b20 species on line\b/i.test(text), "the 20 introduced species are on the line", (text.match(/\d+ species on line|Only \d+ species on line/i) || ["none"])[0]);
    check(!/match NOTHING/i.test(text), "no unresolved-species warning");

    // Pinning "1" from the introduced-species chips rings the plotted
    // "001" (a violet ring labelled with the table's name).
    await page.getByRole("button", { name: /Introduced species \(20\)/ }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /^1$/ }).first().click();
    await page.waitForTimeout(500);
    const rings = await page.locator('svg circle[stroke="#423089"]').count();
    const ringLabel = await page
      .locator("svg text")
      .filter({ hasText: /tgt .* src / })
      .first()
      .textContent()
      .catch(() => "");
    check(rings === 1 && /^001\b/.test(ringLabel || ""), "pinning the chip “1” rings the table's species 001", `${rings} ring(s), label ${JSON.stringify(ringLabel)}`);
    check(errors.length === 0, "no JS error with integer species ids", errors[0] || "");
    await ctx.close();
  }

  /* ------------- 4. introduced % of a target resolved like the scatter
     The scatter finds "tgt" in a table whose column is "TGT"; the species
     count behind the introduced % was looked up by the raw name, so the
     events TSV carried a blank introduced_pct for it. */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadFiles(
      page,
      tsvFile("contamination_events.tsv", [
        "source\ttarget\trate\tprobability\tcontamination_specific_species",
        `SRC\ttgt\t0.1\t0.9\t${ON_LINE}`,
      ]),
      tsvFile("species_abundance.tsv", abundanceLines()),
    );
    await openTab(page, "Export");
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
      page.getByRole("button", { name: /Download events TSV/i }).first().click(),
    ]);
    check(!!download, "the events TSV downloads");
    if (download) {
      const rows = readFileSync(await download.path(), "utf8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.split("\t"));
      const col = rows[0].indexOf("introduced_pct");
      // TGT holds sp_0..sp_19 plus five natives: 20 / 25 species.
      check(
        col >= 0 && rows[1]?.[col] === "0.8000",
        "the target's introduced_pct is filled (20 of 25 species)",
        `introduced_pct=${JSON.stringify(rows[1]?.[col])}`,
      );
    }
    check(errors.length === 0, "no JS error on a case-different target", errors[0] || "");
    await ctx.close();
  }

  /* ------------------------------ 5. CroCoDeEL's low-abundance filter
     The run header declares --filter-low-ab 20. CroCoDeEL zeroed, in each
     sample, every abundance ≤ 20 × the sample's smallest one before
     fitting: in TGT that removes the lower half of the contamination
     line (sp_10..sp_19), so 10 of the 20 introduced species remain on
     it, and 5 of the pair's 30 points are gone. The interpreter used to
     fit all 20.

     Every diagnostic consumer must follow the filter — Guided validation,
     the gallery, the bulk dialog's criteria, the HTML report — and no
     data consumer may: the abundance download, the session file and the
     auto-save keep the table as loaded. */
  {
    const { ctx, page, errors } = await newPage(browser);
    const LINE = /(Only )?\d+ species on line/i;
    await loadFiles(
      page,
      tsvFile("contamination_events.tsv", [
        "# crocodeel version: 1.2.1 | species_ab_table: species_abundance.tsv | filtering_ab_thr_factor: 20.0 | probability_cutoff: 0.5 | rate_cutoff: 0.0",
        "source\ttarget\trate\tprobability\tcontamination_specific_species",
        `SRC\tTGT\t0.1\t0.9\t${ON_LINE}`,
      ]),
      tsvFile("species_abundance.tsv", abundanceLines()),
    );
    const toggle = page.getByRole("checkbox", {
      name: /low-abundance filter to the diagnostics/i,
    });
    await openTab(page, "Overview");
    let text = await page.locator("body").innerText();
    check(
      /Low-abundance filter 20×\s*— applied to diagnostics, as in CroCoDeEL/i.test(text),
      "the run parameters show the filter as applied",
    );
    check((await toggle.count()) === 1 && (await toggle.isChecked()), "the toggle is on by default");

    await openTab(page, "Validate");
    text = await page.locator("body").innerText();
    check(/Only 10 species on line/i.test(text), "the diagnostics use the filtered table (10 species on the line)", (text.match(LINE) || ["none"])[0]);
    check(/After CroCoDeEL's low-abundance filter \(20×\)/i.test(text), "Guided validation says the filter is applied");

    let points = await galleryPoints(page);
    check(points === 25, "the gallery plots the filtered pair (25 points)", `${points} points`);
    await openBulk(page);
    let pass = await bulkPick(page, "n on line", "pass");
    let fail = await bulkPick(page, "n on line", "fail");
    check(pass === 0 && fail === 1, "the bulk dialog's criteria use the filtered table (n on line fails)", `pass ${pass}, fail ${fail}`);
    await closeBulk(page);

    await openTab(page, "Export");
    const report = await downloadVia(page, page.getByRole("button", { name: /Download events HTML/i }).first());
    const html = report?.text || "";
    check(
      /Low-abundance filter<\/div><div class="v">20× — applied to the diagnostics/.test(html) &&
        /Only 10 species on line/.test(html),
      "the HTML report states the filter and uses it",
    );

    // sp_19 is one of the TGT values the filter zeroes: data consumers
    // must still hold it.
    const abundance = await downloadAbundance(page);
    check(tsvCell(abundance, "sp_19", "TGT") > 0, "the abundance download is the table as loaded", `sp_19 / TGT = ${tsvCell(abundance, "sp_19", "TGT")}`);
    let session = await downloadSession(page);
    check(
      session?.abundance?.matrix?.sp_19?.TGT > 0 && session?.ui_state?.filter?.lowAbFilter === true,
      "the session file holds the table as loaded, and the filter on",
      `sp_19 / TGT = ${session?.abundance?.matrix?.sp_19?.TGT}, lowAbFilter = ${session?.ui_state?.filter?.lowAbFilter}`,
    );

    await openTab(page, "Overview");
    // Record what the line next to the box says, change by change: the
    // switch recomputes every diagnostic in one blocking render (seconds
    // on a large run), so it must say so before that render starts.
    await page.evaluate(() => {
      const box = document.querySelector('input[aria-label="Apply CroCoDeEL\'s low-abundance filter to the diagnostics"]');
      const line = box?.closest("div")?.querySelector("span");
      window.__lowAbLine = [];
      if (line)
        new MutationObserver(() => window.__lowAbLine.push(line.textContent)).observe(line, {
          childList: true,
          characterData: true,
          subtree: true,
        });
    });
    // Guarded so that a build without the toggle reports the checks
    // below as failures instead of timing out here.
    if (await toggle.count()) await toggle.uncheck();
    await page.waitForTimeout(600);
    text = await page.locator("body").innerText();
    check(/Low-abundance filter 20×\s*— not applied/i.test(text), "switching it off is shown");
    const seen = await page.evaluate(() => window.__lowAbLine || []);
    check(
      seen.length >= 2 && /recomputing the diagnostics/.test(seen[0]) && /not applied/.test(seen.at(-1)),
      "…after saying the diagnostics are being recomputed",
      JSON.stringify(seen),
    );
    await openTab(page, "Validate");
    text = await page.locator("body").innerText();
    check(/\b20 species on line/i.test(text) && !/Only 10 species on line/i.test(text), "switching it off changes the diagnostics (20 species on the line)", (text.match(LINE) || ["none"])[0]);
    check(
      /Low-abundance filter \(20×\) switched off — diagnostics on the table as loaded, unlike the run/.test(text) &&
        !/After CroCoDeEL's low-abundance filter/.test(text),
      "Guided validation says the filter is switched off",
    );
    points = await galleryPoints(page);
    check(points === 30, "…and the gallery plots the table as loaded (30 points)", `${points} points`);
    await openBulk(page);
    pass = await bulkPick(page, "n on line", "pass");
    fail = await bulkPick(page, "n on line", "fail");
    check(pass === 1 && fail === 0, "…and so do the bulk dialog's criteria (n on line passes)", `pass ${pass}, fail ${fail}`);
    await closeBulk(page);
    const sessionText = await downloadSession(page, { raw: true });
    session = sessionText ? JSON.parse(sessionText) : null;
    check(session?.ui_state?.filter?.lowAbFilter === false, "the session file records the filter off");

    // Saved with the session: the auto-save is debounced by a second.
    await page.waitForTimeout(2500);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    await openTab(page, "Overview");
    check(
      (await toggle.count()) === 1 && !(await toggle.isChecked()),
      "the choice survives a reload",
    );
    await openTab(page, "Validate");
    text = await page.locator("body").innerText();
    check(/\b20 species on line/i.test(text), "the reloaded table is the one as loaded (20 species on the line)", (text.match(LINE) || ["none"])[0]);
    check(errors.length === 0, "no JS error around the low-abundance filter", errors[0] || "");
    await ctx.close();

    // The session file, imported in a fresh browser, restores it too.
    const fresh = await newPage(browser);
    if (sessionText) {
      await fresh.page
        .locator('input[accept=".json,application/json"]')
        .setInputFiles({ name: "crocodeel_curation_session.json", mimeType: "application/json", buffer: Buffer.from(sessionText) });
      await fresh.page.waitForTimeout(2500);
    }
    await openTab(fresh.page, "Overview");
    const freshToggle = fresh.page.getByRole("checkbox", { name: /low-abundance filter to the diagnostics/i });
    check(
      (await freshToggle.count()) === 1 && !(await freshToggle.isChecked()),
      "an imported session file keeps the filter off",
    );
    await openTab(fresh.page, "Validate");
    text = await fresh.page.locator("body").innerText();
    check(/\b20 species on line/i.test(text), "…and its diagnostics (20 species on the line)", (text.match(LINE) || ["none"])[0]);
    check(fresh.errors.length === 0, "no JS error importing the session", fresh.errors[0] || "");
    await fresh.ctx.close();
  }

  /* --------------------------- 5c. cascades follow the filter too
     The cascade of scenario 2, with the run's 20× filter: B holds C's
     markers at 1e-4 × C, its lowest values, so the filter zeroes four of
     the six and only two points stay above A → B's line — too few for a
     cascade (more than three are needed). Unfiltered, all six are
     there and C → A explains them. */
  {
    const { ctx, page, errors } = await newPage(browser);
    const markers = Array.from({ length: 6 }, (_, i) => `m_${i}`).join(",");
    const shared = Array.from({ length: 20 }, (_, i) => `s_${i}`).join(",");
    await loadFiles(
      page,
      tsvFile("contamination_events.tsv", [
        "# crocodeel version: 1.2.1 | species_ab_table: species_abundance.tsv | filtering_ab_thr_factor: 20.0 | probability_cutoff: 0.5 | rate_cutoff: 0.0",
        "source\ttarget\trate\tprobability\tcontamination_specific_species",
        `C\tA\t0.2\t0.9\t${markers}`,
        `A\tB\t0.05\t0.8\t${shared}`,
      ]),
      tsvFile("species_abundance.tsv", cascadeLines()),
    );
    await openTab(page, "Overview");
    let text = await page.locator("body").innerText();
    // The Overview shows the stat only when there is a cascade.
    check(!/Cascades detected/i.test(text), "with the filter, the cascade is not detected", (text.match(/Cascades detected\s*\d+/i) || ["no cascade"])[0]);
    const toggle = page.getByRole("checkbox", { name: /low-abundance filter to the diagnostics/i });
    if (await toggle.count()) await toggle.uncheck();
    await page.waitForTimeout(600);
    text = await page.locator("body").innerText();
    check(/Cascades detected\s*1\b/i.test(text), "without it, the cascade is detected", (text.match(/Cascades detected\s*\d+/i) || ["none"])[0]);
    check(errors.length === 0, "no JS error on the filtered cascade", errors[0] || "");
    await ctx.close();
  }

  /* ---------------- 5b. a run without the filter shows no such toggle */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadDemo(page); // its header says filtering_ab_thr_factor: None
    await openTab(page, "Overview");
    const text = await page.locator("body").innerText();
    check(!/Low-abundance filter/i.test(text), "a run with filtering_ab_thr_factor None shows no filter toggle");
    check(errors.length === 0, "no JS error on the demo", errors[0] || "");
    await ctx.close();
  }

  /* ------- 6. bulk dialog: biological similarity as Guided validation
     The dialog re-derived criterion 06 as ρ < 0.7 alone, so "✓ pass"
     skipped the strong cross-subject contaminations the panel ticks, and
     "✗ fail" took every high-ρ pair. It now reads the panel's own
     evaluation: high ρ passes between unrelated samples, fails within a
     subject or a group (a household), and is inconclusive — matched by
     neither pick — without metadata. */
  {
    const { ctx, page, errors } = await newPage(browser);
    const introduced = Array.from({ length: 20 }, (_, i) => `sp_${i}`).join(",");
    await loadFiles(
      page,
      tsvFile("contamination_events.tsv", [
        "source\ttarget\trate\tprobability\tcontamination_specific_species",
        ...BIOSIM_TARGETS.map((t, i) => `SRC\t${t}\t0.1\t${(0.95 - i * 0.05).toFixed(2)}\t${introduced}`),
      ]),
      tsvFile("species_abundance.tsv", biosimLines()),
      tsvFile("metadata.tsv", [
        "sample_id\tsubject_id\tgroup_id",
        "SRC\talice\tfamily1",
        "HIGH_UNRELATED\tbob\t",
        "HIGH_SAME_SUBJECT\talice\t",
        "HIGH_SAME_GROUP\tdave\tfamily1",
        "LOW\tcarol\t",
      ]),
    );
    // Guided validation opens on SRC → HIGH_UNRELATED (highest
    // probability) and ticks criterion 06.
    await openTab(page, "Validate");
    const text = await page.locator("body").innerText();
    check(
      /despite different subjects — consistent with strong contamination/i.test(text),
      "the panel passes high ρ between different subjects",
    );

    await openBulk(page);
    const label = "Biological similarity";
    const pass = await bulkPick(page, label, "pass");
    check(pass === 2, "bulk “✓ pass” selects the unrelated high-ρ pair and the low-ρ pair", `Apply to ${pass}`);
    const fail = await bulkPick(page, label, "fail");
    check(fail === 2, "bulk “✗ fail” selects the same-subject and same-group high-ρ pairs", `Apply to ${fail}`);
    const all = await bulkPick(page, label, "any");
    check(all === 5, "“any” keeps all five events", `Apply to ${all}`);
    const rowText = await page.evaluate(
      (label) =>
        [...document.querySelectorAll("span")].find((el) => el.textContent.startsWith(label))
          ?.textContent || "",
      label,
    );
    check(
      /ρ ≥ 0\.7 between unrelated samples \(different subjects, no shared group/.test(rowText),
      "the criterion's label states the same-group rule",
      rowText,
    );
    await closeBulk(page);
    check(errors.length === 0, "no JS error in the bulk dialog", errors[0] || "");
    await ctx.close();
  }

  /* ------------- 7. the in-browser runner's --filter-low-ab description
     Next to the factor it read "Drop species with median abundance below
     20× LOD", which is not what CroCoDeEL does (its tooltip, the Help and
     ab_table_utils.filter_low_ab agree on the per-sample rule). */
  {
    const { ctx, page, errors } = await newPage(browser);
    // The runner shows its parameters once it has a table to run on.
    await tsvInput(page, 1).setInputFiles(tsvFile("species_abundance.tsv", abundanceLines()));
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /Run CroCoDeEL in your browser/i }).first().click();
    const factor = page
      .locator('div[title^="Equivalent to the --filter-low-ab CLI flag"] input[type="number"]')
      .first();
    await factor.waitFor({ timeout: 20000 });
    await factor.fill("20");
    await page.waitForTimeout(300);
    const text = await page.locator("body").innerText();
    check(
      /In each sample, set to 0 every abundance up to 20× the sample's smallest one\./.test(text) &&
        !/median abundance/i.test(text),
      "the runner describes the per-sample low-abundance filter",
      (text.match(/[^\n]*20×[^\n]*/) || [""])[0],
    );
    check(errors.length === 0, "no JS error on the runner page", errors[0] || "");
    await ctx.close();
  }
} finally {
  await browser.close();
  stopServer();
}
finish();
