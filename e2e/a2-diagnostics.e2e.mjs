/* Browser checks for the diagnostics fixes (work package a2-diagnostics).

   Each scenario loads small crafted files through the upload cards, so the
   expected outcome is known exactly:

     1. an event whose target is missing from the abundance table is "not
        evaluable" in Guided validation — never PROBABLY NOT CONTAMINATED;
     2. the exported events HTML report prints a cascade's upstream rate,
        not "(NaN%)";
     3. species ids that CroCoDeEL rewrote as integers ("1" for the table's
        "001") still land on the contamination line;
     4. a target written in another case than the table's column ("tgt"
        for "TGT") gets its introduced % in the exported events TSV;
     5. a run whose header declares `filtering_ab_thr_factor: 20.0` shows
        the low-abundance filter and its toggle, the diagnostics follow
        the filter, switching it off changes them, and the choice survives
        a reload; a run with "None" shows no toggle;
     6. the bulk dialog's "Biological similarity" pass / fail picks select
        the events Guided validation ticks / crosses: high ρ between
        unrelated samples passes, high ρ within a subject or a group fails.

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
     line, so 10 of the 20 introduced species remain on it. The
     interpreter used to fit all 20. */
  {
    const { ctx, page, errors } = await newPage(browser);
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
    check(/Only 10 species on line/i.test(text), "the diagnostics use the filtered table (10 species on the line)", (text.match(/(Only )?\d+ species on line/i) || ["none"])[0]);
    check(/After CroCoDeEL's low-abundance filter \(20×\)/i.test(text), "Guided validation says the filter is applied");

    await openTab(page, "Export");
    const [report] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
      page.getByRole("button", { name: /Download events HTML/i }).first().click(),
    ]);
    const html = report ? readFileSync(await report.path(), "utf8") : "";
    check(
      /Low-abundance filter<\/div><div class="v">20× — applied to the diagnostics/.test(html) &&
        /Only 10 species on line/.test(html),
      "the HTML report states the filter and uses it",
    );

    await openTab(page, "Overview");
    // Guarded so that a build without the toggle reports the checks
    // below as failures instead of timing out here.
    if (await toggle.count()) await toggle.uncheck();
    await page.waitForTimeout(600);
    text = await page.locator("body").innerText();
    check(/Low-abundance filter 20×\s*— not applied/i.test(text), "switching it off is shown");
    await openTab(page, "Validate");
    text = await page.locator("body").innerText();
    check(/\b20 species on line/i.test(text) && !/Only 10 species on line/i.test(text), "switching it off changes the diagnostics (20 species on the line)", (text.match(/(Only )?\d+ species on line/i) || ["none"])[0]);

    // Saved with the session: the auto-save is debounced by a second.
    await page.waitForTimeout(2500);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    await openTab(page, "Overview");
    check(
      (await toggle.count()) === 1 && !(await toggle.isChecked()),
      "the choice survives a reload",
    );
    check(errors.length === 0, "no JS error around the low-abundance filter", errors[0] || "");
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
    await closeBulk(page);
    check(errors.length === 0, "no JS error in the bulk dialog", errors[0] || "");
    await ctx.close();
  }
} finally {
  await browser.close();
  stopServer();
}
finish();
