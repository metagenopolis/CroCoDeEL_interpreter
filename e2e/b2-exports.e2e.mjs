/* Browser checks for the exports: what a curator downloads must be what
   the next tool reads.

     - B2.6  a hand-edited session whose metadata entry keeps a string as
             its row: the metadata card does not list its characters as
             columns, the Validate panel shows no "0: a" pill, and the
             metadata download works.

   Usage:  npm run build && node e2e/b2-exports.e2e.mjs
           (or through e2e/run-all.mjs; BASE_URL skips the server,
           E2E_ONLY=<regex> runs only the matching scenarios) */

import { readFileSync } from "node:fs";
import { parseEvents, parseMetadata } from "../src/parsing.js";
import {
  startServer,
  stopServer,
  launchBrowser,
  newPage,
  openTab,
  check,
  finish,
} from "./harness.mjs";

const demo = (name) => readFileSync(`public/demo/${name}`, "utf8");

/* ------------------------------------------------------------ helpers */

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

/** Import a session JSON through the files bar. */
async function importSession(page, json) {
  await page.locator('input[accept*="json"]').first().setInputFiles({
    name: "session.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(json)),
  });
  await page.waitForTimeout(3000);
}

/** A session JSON as exportJSON writes it: the demo events, plus `extra`
    (metadata, plate_map, …). */
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

/** The metadata (or plate map) upload card. */
function card(page, label) {
  return page
    .locator("div.rounded-sm")
    .filter({ has: page.getByText(label, { exact: true }) })
    .filter({ has: page.getByRole("button", { name: /^(Replace|Select file)$/ }) })
    .last();
}

await startServer();
const browser = await launchBrowser();

/* One fresh page per scenario. A scenario that throws is reported as a
   failed check and the others still run. */
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
async function scenario(name, run) {
  if (ONLY && !ONLY.test(name)) return;
  const { ctx, page, errors } = await newPage(browser);
  try {
    await run(page);
  } catch (e) {
    check(false, `${name} runs to the end`, String(e).split("\n")[0]);
  }
  check(errors.length === 0, `${name} no JS error`, errors[0] || "");
  await ctx.close();
}

try {
  /* ---------------- B2.6 metadata entries whose row is not a row
     Every entry but the last keeps the string "abc" as its row, as a
     hand-edited session file can. The download threw ("Cannot use 'in'
     operator"), the card read "other: 0, 1, 2" and the Validate panel
     showed "0: a" pills. */
  await scenario("B2.6", async (page) => {
    const metadata = parseMetadata(demo("metadata.tsv"));
    const ids = Object.keys(metadata.bySample);
    for (const id of ids.slice(0, -1)) metadata.bySample[id].extra = "abc";
    await importSession(page, sessionJSON({ metadata }));
    const text = await card(page, "metadata.tsv").innerText();
    check(
      /other: ncbi_code/.test(text) && !/other: 0, 1, 2/.test(text),
      "B2.6 the metadata card lists the columns of the one readable row, not a string's characters",
      text.replace(/\s+/g, " ").slice(0, 200),
    );
    const file = await downloadVia(
      page,
      card(page, "metadata.tsv").locator('button[title="Download this file"]'),
    );
    const rows = (file?.text || "").split("\n").map((l) => l.split("\t"));
    const back = file ? parseMetadata(file.text) : null;
    check(
      rows[0]?.join(",") === "sample_id,subject_id,timepoint,biome,low_biomass,group_id,ncbi_code" &&
        rows.length === ids.length + 1 &&
        ids.every((id) => back.bySample[id]?.subject === metadata.bySample[id].subject),
      "B2.6 the metadata download works and keeps every subject",
      JSON.stringify(rows[0]),
    );
    await openTab(page, "Validate");
    await page.getByText(/plate position & sample context/i).first().click();
    await page.waitForTimeout(500);
    const panel = await page.locator("body").innerText();
    check(
      /subject/i.test(panel) && !/(^|\s)[012]:\s*[abc](\s|$)/m.test(panel),
      "B2.6 the Validate panel's sample context shows no pill made of a string's characters",
      (panel.match(/(^|\s)[012]:\s*[abc](\s|$)/m) || [""])[0].replace(/\s+/g, " ").trim(),
    );
  });
} finally {
  await browser.close();
  stopServer();
}
finish();
