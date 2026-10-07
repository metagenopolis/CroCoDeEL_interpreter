/* Browser checks for the science and file fixes of the final review.

     - FS.1  an abundance table saved by R's write.table (no header cell
             above the row names) loads as the demo table: 91 samples,
             the card names the layout, Guided validation grades the
             first event as with the original table, and the card's
             Download keeps the layout; rows ending with one tab more than
             the header load as the header says, with a warning;
     - FS.2  a sample id that every JavaScript object already has
             ("__proto__") is refused, named, without a page error;
     - FS.3  a sample note with a double quote is quoted in the samples
             TSV, so R reads the file whole;
     - FS.4  a session whose filter holds HTML imports, and its events
             HTML report shows none of it and runs no script; the
             report's banner names a target sample-verdict filter; the
             target's automatic verdict and action are tagged "auto"; a
             study kept among a legacy session's run parameters is not
             listed as one;
     - FS.5  the samples TSV leaves the metadata flags empty without
             metadata and writes the rates in full; the graph's node CSV
             says where each verdict and action comes from;
     - FS.6  Spearman's rho is CroCoDeEL's: 0.75 for the demo's
             63D29 -> 63D40, and criterion 06 then fails that same-infant
             pair.

   Usage:  npm run build && node e2e/final-science-io.e2e.mjs
           (or through e2e/run-all.mjs; BASE_URL skips the server,
           E2E_ONLY=<regex> runs only the matching scenarios) */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvents } from "../src/parsing.js";
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

/** Upload `text` as a file through the i-th upload card (0 events,
    1 abundance, 2 metadata, 3 plate map). */
async function upload(page, i, name, text) {
  await tsvInput(page, i).setInputFiles({
    name,
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from(text),
  });
  await page.waitForTimeout(2000);
}

/** Click `button` and return the file it downloads, { name, text }, or
    null when nothing downloads. */
async function downloadVia(page, button) {
  const [file] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
    button.click(),
  ]);
  return file
    ? { name: file.suggestedFilename(), text: readFileSync(await file.path(), "utf8") }
    : null;
}

/** The file a button of the Export tab downloads, by the button's name. */
async function exportFile(page, name) {
  await openTab(page, "Export");
  return downloadVia(page, page.getByRole("button", { name }).first());
}

/** Import a session JSON through the files bar. */
async function importSession(page, json) {
  await page.locator('input[accept*="json"]').first().setInputFiles({
    name: "session.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(json)),
  });
  await page.waitForTimeout(3000);
}

/** A session JSON of the demo events, plus `extra`. */
function sessionJSON(extra) {
  const { events, runMetadata } = parseEvents(demo("contamination_events.tsv"));
  return {
    generated: new Date().toISOString(),
    schema_version: 2,
    analysis_title: "session",
    run_metadata: runMetadata,
    metadata: null,
    plate_map: null,
    abundance: null,
    sample_curation: {},
    ui_state: { tab: "overview" },
    events: events.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      contamination_rate: e.rate,
      probability: e.score,
      introduced_species: e.introduced,
      verdict: e.verdict,
      notes: e.notes,
    })),
    ...extra,
  };
}

/** The criterion cards of Guided validation, "01 …" to "06 …". */
async function criterionCards(page) {
  const texts = await page.locator("button[aria-expanded]").allInnerTexts();
  return texts.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => /^0[1-6] /.test(t));
}

/** The upload card of `label`. */
function card(page, label) {
  return page
    .locator("div.rounded-sm")
    .filter({ has: page.getByText(label, { exact: true }) })
    .filter({ has: page.getByRole("button", { name: /^(Replace|Select file)$/ }) })
    .last();
}

/** The demo table as R's write.table writes it: no cell above the row
    names. */
const R_TABLE = (() => {
  const lines = demo("species_abundance.tsv").split("\n");
  return [lines[0].split("\t").slice(1).join("\t"), ...lines.slice(1)].join("\n");
})();

await startServer();
const browser = await launchBrowser();

/* One fresh page per scenario (with the demo loaded unless `demo` is
   false). A scenario that throws is reported as a failed check and the
   others still run. */
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
async function scenario(name, run, { demo: withDemo = true } = {}) {
  if (ONLY && !ONLY.test(name)) return;
  const { ctx, page, errors } = await newPage(browser, { acceptDownloads: true });
  try {
    if (withDemo) await loadDemo(page);
    await run(page, ctx);
  } catch (e) {
    check(false, `${name} runs to the end`, String(e).split("\n")[0]);
  }
  check(errors.length === 0, `${name} no JS error`, errors[0] || "");
  await ctx.close();
}

try {
  /* ---------------- FS.1 R's write.table layout
     Read as a usual header, every sample took the name of the one before
     it and the last one was lost: 90 samples, and the first event graded
     PROBABLY NOT CONTAMINATED (R² 0.06) instead of CONTAMINATED. */
  await scenario("FS.1 R layout", async (page) => {
    await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
    await upload(page, 1, "species_abundance.tsv", R_TABLE);
    const abCard = await card(page, "species_abundance.tsv").innerText();
    check(/91 samples × 927 species/.test(abCard), "FS.1 the R-written demo table loads as 91 samples × 927 species", abCard.split("\n").find((l) => /samples ×/.test(l)) || "");
    check(
      /Columns: species from the first cell of each row — the header has no cell above them \(R's write\.table\)/.test(abCard),
      "FS.1 its card names the layout",
    );
    const body = await page.locator("body").innerText();
    check(!/Check the input files/.test(body), "FS.1 no warning banner");
    await openTab(page, "Validate");
    const v = await page.locator("body").innerText();
    check(/CONTAMINATED — CroCoDeEL is probably right/.test(v), "FS.1 the first event is graded as with the original table");
    check(/Straight line \(R² = 0\.99\)/.test(v), "FS.1 …its line R² is 0.99", (v.match(/R² = [\d.]+/) || [""])[0]);
    const file = await downloadVia(page, card(page, "species_abundance.tsv").locator('button[title="Download this file"]'));
    check(
      !!file && file.text.split("\n")[0] === R_TABLE.split("\n")[0],
      "FS.1 the card's Download keeps the header without a species cell",
      file ? file.text.slice(0, 60) : "no download",
    );
  }, { demo: false });

  await scenario("FS.1 trailing tabs", async (page) => {
    await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
    const tabbed = demo("species_abundance.tsv")
      .split("\n")
      .map((l, i) => (i > 0 && l ? `${l}\t` : l))
      .join("\n");
    await upload(page, 1, "species_abundance.tsv", tabbed);
    const body = await page.locator("body").innerText();
    check(/91 samples × 927 species/.test(body), "FS.1 a table whose rows end with a tab loads as its header says");
    check(
      /The first row \(line 2\) has one cell more than the header/.test(body) && /its events name the samples one column off/.test(body),
      "FS.1 …with a warning that CroCoDeEL read it shifted",
    );
  }, { demo: false });

  /* ---------------- FS.2 ids every object has */
  await scenario("FS.2 reserved ids", async (page) => {
    await upload(
      page,
      0,
      "contamination_events.tsv",
      ["source\ttarget\trate\tprobability\tcontamination_specific_species", "S1\t__proto__\t0.1\t0.9\tsp1"].join("\n"),
    );
    const body = await page.locator("body").innerText();
    check(
      /The sample "__proto__" \(line 2, column "target"\) cannot be read/.test(body),
      "FS.2 an events file with a sample __proto__ is refused, naming it",
    );
    check(/Load demo/i.test(body), "FS.2 …and nothing of it is loaded");
  }, { demo: false });

  /* ---------------- FS.3 a quote inside a cell */
  await scenario("FS.3 quotes", async (page) => {
    await openTab(page, "Samples");
    await page.getByRole("button", { name: /\+ note/ }).nth(2).click();
    await page.waitForTimeout(300);
    await page.locator('textarea[placeholder^="Notes for "]').first().fill('tube labelled 2" short');
    await page.waitForTimeout(1200);
    const file = await exportFile(page, /Download samples TSV/i);
    const lines = (file?.text || "").split("\n");
    check(
      lines.some((l) => l.split("\t").includes('"tube labelled 2"" short"')),
      "FS.3 the samples TSV quotes the note, its quote doubled",
    );
    // Every line still has the header's cells: no quote swallows a row.
    const width = lines[0].split("\t").length;
    check(lines.length === 92 && lines.every((l) => l.split("\t").length === width), "FS.3 …and has its 91 rows of the header's width", `${lines.length} lines`);
  });

  /* ---------------- FS.4 the events HTML report */
  await scenario("FS.4 filter values", async (page, ctx) => {
    await importSession(
      page,
      sessionJSON({
        ui_state: {
          tab: "overview",
          filter: { minScore: 0.5, subject: "<img src=x onerror=alert(document.title)>", group: "<script>alert(2)</script>" },
        },
      }),
    );
    const file = await exportFile(page, /Download events HTML/i);
    const html = file?.text || "";
    const banner = (html.match(/Filter applied:<\/strong>[^<]*/) || [""])[0];
    check(/probability ≥ 0\.50/.test(banner) && !/subject|group/.test(banner), "FS.4 the imported filter keeps its probability, not its HTML", banner);
    check(!/<img src=x|<script>alert/.test(html), "FS.4 the report holds no tag of the filter");
    // Opened as the curator opens it: an .html file.
    const dir = mkdtempSync(join(tmpdir(), "fs4-"));
    const path = join(dir, "crocodeel_curation_report.html");
    writeFileSync(path, html);
    const p2 = await ctx.newPage();
    const dialogs = [];
    p2.on("dialog", async (d) => {
      dialogs.push(d.message());
      await d.dismiss();
    });
    await p2.goto(`file://${path}`);
    await p2.waitForTimeout(1000);
    rmSync(dir, { recursive: true, force: true });
    check(dialogs.length === 0, "FS.4 opening the report runs no script", dialogs.join(" | "));
  }, { demo: false });

  await scenario("FS.4 auto tags", async (page) => {
    await openTab(page, "Events");
    await page.locator('button[title="mark as true positive"]').first().click();
    await page.waitForTimeout(600);
    const html = (await exportFile(page, /Download events HTML/i))?.text || "";
    const row = html
      .split("<tr>")
      .find((r) => /58M<\/td>\s*<td>58D7/.test(r))
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ") || "";
    check(/Contaminated auto Suppress auto/.test(row), "FS.4 the true positive's target reads Contaminated auto, Suppress auto", row.slice(0, 160));
  });

  await scenario("FS.4 banner", async (page) => {
    // A target sample-verdict filter, through a session file: the demo's
    // third event (58M → 58D7) a true positive, its target Contaminated.
    const session = sessionJSON({
      sample_curation: { "58D7": { verdict: "contaminated", action: "suppress" } },
      ui_state: { tab: "export", filter: { sampleVerdicts: ["contaminated"], sampleVerdictsSide: "target" } },
    });
    session.events[2].verdict = "true_positive";
    await importSession(page, session);
    const html = (await exportFile(page, /Download events HTML/i))?.text || "";
    const banner = (html.match(/Filter applied:<\/strong>[^<]*/) || [""])[0];
    check(/target sample verdict: contaminated/.test(banner), "FS.4 the banner names the target sample-verdict filter", banner);
  }, { demo: false });

  await scenario("FS.4 run parameters", async (page) => {
    const session = sessionJSON({});
    session.run_metadata = { ...session.run_metadata, study: "Legacy study" };
    await importSession(page, session);
    const html = (await exportFile(page, /Download events HTML/i))?.text || "";
    const table = (html.match(/CroCoDeEL run parameters<\/h2>[\s\S]*?<\/table>/) || [""])[0];
    check(/crocodeel version/.test(table) && !/<th>study<\/th>/.test(table), "FS.4 a legacy study is not listed among the run parameters");
  }, { demo: false });

  /* ---------------- FS.5 samples TSV and graph files */
  await scenario("FS.5 samples TSV", async (page) => {
    await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
    await upload(page, 1, "species_abundance.tsv", demo("species_abundance.tsv"));
    const lines = ((await exportFile(page, /Download samples TSV/i))?.text || "").split("\n");
    const h = lines[0].split("\t");
    const col = (name) => lines.slice(1).map((l) => l.split("\t")[h.indexOf(name)]);
    check(
      ["is_control", "is_low_biomass", "is_low_sequencing_depth"].every((c) => col(c).every((v) => v === "")),
      "FS.5 without metadata the three flags are empty, not false",
    );
    const rates = col("max_target_rate").filter(Boolean);
    check(rates.includes("0.0167") && rates.includes("0.00915"), "FS.5 max_target_rate is written in full", rates.slice(0, 4).join(", "));
  }, { demo: false });

  await scenario("FS.5 graph origins", async (page) => {
    await openTab(page, "Events");
    await page.locator('button[title="mark as true positive"]').first().click();
    await page.waitForTimeout(600);
    await openTab(page, "Export");
    const files = {};
    const seen = new Promise((resolve) => {
      page.on("download", async (d) => {
        files[d.suggestedFilename()] = readFileSync(await d.path(), "utf8");
        if (Object.keys(files).length === 2) resolve();
      });
    });
    await page.getByRole("button", { name: /node \+ edge CSV pair/i }).first().click();
    await Promise.race([seen, page.waitForTimeout(15000)]);
    const nodes = (files["contamination_graph_nodes.csv"] || "").split("\n");
    const h = nodes[0].split(",");
    const at = (r, c) => r.split(",")[h.indexOf(c)];
    const never = nodes.slice(1).filter((r) => at(r, "events_as_target") === "0");
    check(
      never.length > 0 && never.every((r) => at(r, "sample_verdict") === "correct" && at(r, "sample_verdict_origin") === "default" && at(r, "sample_action_origin") === "default"),
      "FS.5 the samples no event targets carry the default origin",
      `${never.length} such nodes`,
    );
    const target = nodes.find((r) => r.startsWith("58D7,"));
    check(at(target || "", "sample_verdict_origin") === "automatic", "FS.5 the true positive's target carries the automatic origin");
  });

  /* ---------------- FS.6 CroCoDeEL's rho */
  await scenario("FS.6 rho", async (page) => {
    await openTab(page, "Events");
    await page.locator('tr[data-event-row="1"]').click();
    await page.waitForTimeout(1200);
    const text = await page.locator("body").innerText();
    check(/63D29/.test(text) && /63D40/.test(text), "FS.6 Guided validation shows 63D29 → 63D40");
    check(/Spearman ρ = 0\.75/.test(text), "FS.6 its badge reads CroCoDeEL's rho, 0.75", (text.match(/Spearman ρ = [-\d.]+/) || [""])[0]);
    const c06 = (await criterionCards(page)).find((t) => t.startsWith("06 ")) || "";
    check(
      /Profiles highly correlated \(ρ = 0\.75\) AND same subject \(63\)/.test(c06),
      "FS.6 criterion 06 fails the same-infant pair",
      c06.slice(0, 120),
    );
  });
} finally {
  await browser.close();
  stopServer();
}
finish();
