/* Browser checks for the last science and file fixes.

     - LS.1  the demo table written by R's write.table (no header cell
             above the row names) with a tab at the end of every line, the
             header's included, loads as the demo table — 91 samples, the
             card names the layout, no warning that CroCoDeEL reads it one
             column off — and Guided validation grades the first event as
             with the original table;
     - LS.2  the demo table as R's write.table writes it by default (ids
             quoted), with a sample and a species holding a "#", loads as
             written, and its card's Download and its curated export load
             back the same: the "#" ids are quoted.

   Usage:  npm run build && node e2e/last-science-io.e2e.mjs
           (or through e2e/run-all.mjs; BASE_URL skips the server,
           E2E_ONLY=<regex> runs only the matching scenarios) */

import { readFileSync } from "node:fs";
import {
  startServer,
  stopServer,
  launchBrowser,
  newPage,
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

/** Click `button` and collect the `n` files it downloads, { name: text }
    (the curated abundance table and its provenance come as two). */
async function downloadsVia(page, button, n) {
  const files = {};
  let listener;
  const seen = new Promise((resolve) => {
    listener = async (d) => {
      files[d.suggestedFilename()] = readFileSync(await d.path(), "utf8");
      if (Object.keys(files).length === n) resolve();
    };
    page.on("download", listener);
  });
  await button.click();
  await Promise.race([seen, page.waitForTimeout(30000)]);
  page.off("download", listener);
  return files;
}

/** The upload card of `label`. */
function card(page, label) {
  return page
    .locator("div.rounded-sm")
    .filter({ has: page.getByText(label, { exact: true }) })
    .filter({ has: page.getByRole("button", { name: /^(Replace|Select file)$/ }) })
    .last();
}

/** The demo table as R's write.table writes it (no cell above the row
    names), with a tab at the end of every line. */
const R_TABLE_TABBED = (() => {
  const lines = demo("species_abundance.tsv").replace(/\n$/, "").split("\n");
  return [lines[0].split("\t").slice(1).join("\t"), ...lines.slice(1)].map((l) => `${l}\t`).join("\n") + "\n";
})();

/** The demo table as R's write.table writes it by default — no cell
    above the row names, every id quoted — with the sample 40D89 and the
    species msp_0001, which no event names, given a "#". */
const R_QUOTED_HASH = (() => {
  const lines = demo("species_abundance.tsv").replace(/\n$/, "").split("\n");
  const q = (c) => `"${c === "40D89" ? "Plate#1_40D89" : c === "msp_0001" ? "msp#0001" : c}"`;
  return [
    lines[0].split("\t").slice(1).map(q).join("\t"),
    ...lines.slice(1).map((l) => l.split("\t").map((c, i) => (i === 0 ? q(c) : c)).join("\t")),
  ].join("\n") + "\n";
})();

await startServer();
const browser = await launchBrowser();

/* One fresh page per scenario. A scenario that throws is reported as a
   failed check and the others still run. */
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
async function scenario(name, run) {
  if (ONLY && !ONLY.test(name)) return;
  const { ctx, page, errors } = await newPage(browser, { acceptDownloads: true });
  try {
    await run(page, ctx);
  } catch (e) {
    check(false, `${name} runs to the end`, String(e).split("\n")[0]);
  }
  check(errors.length === 0, `${name} no JS error`, errors[0] || "");
  await ctx.close();
}

try {
  /* ---------------- LS.1 R's layout with a tab at the end of every line
     Taken for rows ending with a tab the header lacks: 40D89 read as the
     species column's title, every sample holding the values of the one
     before it ("Unnamed: 91" holding NC3's), the first event graded on
     those columns, and a warning that CroCoDeEL — which reads the file
     right — named the samples one column off. */
  await scenario("LS.1 R layout, tab-ended lines", async (page) => {
    await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
    await upload(page, 1, "species_abundance.tsv", R_TABLE_TABBED);
    const abCard = await card(page, "species_abundance.tsv").innerText();
    check(
      /91 samples × 927 species/.test(abCard),
      "LS.1 the tab-ended R table loads as 91 samples × 927 species",
      abCard.split("\n").find((l) => /samples ×/.test(l)) || "",
    );
    check(
      /Columns: species from the first cell of each row — the header has no cell above them \(R's write\.table\)/.test(abCard),
      "LS.1 its card names R's layout",
    );
    const body = await page.locator("body").innerText();
    check(!/one cell more than the header|one column off/.test(body), "LS.1 no warning that CroCoDeEL reads it one column off");
    check(!/Unnamed: 91/.test(body), "LS.1 no sample \"Unnamed: 91\"");
    check(!/Check the input files/.test(body), "LS.1 no warning banner");
    await openTab(page, "Validate");
    const v = await page.locator("body").innerText();
    check(/CONTAMINATED — CroCoDeEL is probably right/.test(v), "LS.1 the first event is graded as with the original table");
    check(/Straight line \(R² = 0\.99\)/.test(v), "LS.1 …its line R² is 0.99", (v.match(/R² = [\d.]+/) || [""])[0]);
  });

  /* ---------------- LS.2 ids holding a "#"
     Written bare, the downloads read back cut at the "#": a header of
     one sample, "Plate" — "Could not parse abundance table", the card
     keeping the table loaded before — and CroCoDeEL refused them. */
  await scenario("LS.2 # in ids", async (page) => {
    await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
    await upload(page, 1, "species_abundance.tsv", R_QUOTED_HASH);
    const loaded = async (what) => {
      const body = await page.locator("body").innerText();
      check(
        !/Abundance file:|Could not parse/.test(body),
        `LS.2 ${what} loads`,
        (body.match(/[^\n]*(?:Abundance file:|Could not parse)[^\n]*/) || [""])[0].slice(0, 160),
      );
      const abCard = await card(page, "species_abundance.tsv").innerText();
      check(
        /91 samples × 927 species/.test(abCard),
        `LS.2 …as 91 samples × 927 species`,
        abCard.split("\n").find((l) => /samples ×/.test(l)) || "",
      );
      check(!/holds? a "#"/.test(body), `LS.2 …without a "#" warning`, (body.match(/[^\n]*a "#"[^\n]*/) || [""])[0].slice(0, 160));
    };
    await loaded("the R table with # ids");

    const download = await downloadsVia(page, card(page, "species_abundance.tsv").locator('button[title="Download this file"]'), 1);
    const text = download["species_abundance.tsv"] || "";
    check(
      text.startsWith('"Plate#1_40D89"\t40M\t') && /\n"msp#0001"\t/.test(text),
      "LS.2 the card's Download quotes the ids holding a #",
      text.slice(0, 60),
    );
    await upload(page, 1, "species_abundance.tsv", text);
    await loaded("its card's Download");

    await openTab(page, "Export");
    const curated = await downloadsVia(
      page,
      page.getByRole("button", { name: /Download curated abundance TSV/i }).first(),
      2,
    );
    const table = curated["species_abundance_curated.tsv"] || "";
    check(table.startsWith('"Plate#1_40D89"\t') && /\n"msp#0001"\t/.test(table), "LS.2 the curated export quotes them too", table.slice(0, 60));
    await upload(page, 1, "species_abundance.tsv", table);
    await loaded("the curated export");
  });
} finally {
  await browser.close();
  stopServer();
}
finish();
