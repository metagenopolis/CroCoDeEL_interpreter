/* Browser checks for the exports: what a curator downloads must be what
   the next tool reads.

     - B2.1  the curated events TSV of the demo starts with CroCoDeEL's
             five columns, its numbers written as CroCoDeEL writes them,
             under the run's "#" line; a reader built like CroCoDeEL's
             (read_tsv) gets every event back, and so does the events card,
             with the verdicts and the notes; the events card's own
             Download stays CroCoDeEL's file;
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
  loadDemo,
  openTab,
  overviewStats,
  tsvInput,
  check,
  finish,
} from "./harness.mjs";

const demo = (name) => readFileSync(`public/demo/${name}`, "utf8");
const demoEvents = parseEvents(demo("contamination_events.tsv"));
const CROCODEEL_COLUMNS = ["source", "target", "rate", "probability", "contamination_specific_species"];

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

/** The file a button of the Export tab downloads, by the button's name. */
async function exportFile(page, name) {
  await openTab(page, "Export");
  return downloadVia(page, page.getByRole("button", { name }).first());
}

/** Upload `text` through the i-th upload card (0 events, 1 abundance,
    2 metadata, 3 plate map). */
async function upload(page, i, name, text) {
  await tsvInput(page, i).setInputFiles({
    name,
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from(text),
  });
  await page.waitForTimeout(2000);
}

/** Read an events TSV the way CroCoDeEL's ContaminationEventIO.read_tsv
    does: skip the leading "#" lines, look the five columns up by name,
    float() the rate and the probability. Returns { events } or { error }
    (read_tsv raises a KeyError on a missing column). */
function readLikeCroCoDeEL(text) {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].startsWith("#")) i++;
  const header = lines[i].split("\t");
  const missing = CROCODEEL_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) return { error: `KeyError: '${missing[0]}'` };
  const col = Object.fromEntries(header.map((h, j) => [h, j]));
  const float = (s) =>
    /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) ? Number(s) : NaN;
  const events = lines
    .slice(i + 1)
    .filter((l) => l.length > 0)
    .map((l) => {
      const c = l.split("\t");
      return {
        source: c[col.source],
        target: c[col.target],
        rate: float(c[col.rate]),
        probability: float(c[col.probability]),
        species: c[col.contamination_specific_species].split(","),
      };
    });
  return { events };
}

/** True when `events` (read like CroCoDeEL) are the demo's events, every
    rate and probability equal as a number. */
function sameAsDemo(events) {
  const key = (e) => `${e.source}→${e.target}`;
  const byPair = new Map(demoEvents.events.map((e) => [key(e), e]));
  return (
    events.length === demoEvents.events.length &&
    events.every((e) => {
      const d = byPair.get(key(e));
      return (
        d &&
        e.rate === d.rate &&
        e.probability === d.score &&
        e.species.join(",") === d.introduced.join(",")
      );
    })
  );
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

/* One fresh page per scenario (with the demo loaded unless `demo` is
   false). A scenario that throws is reported as a failed check and the
   others still run. */
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
async function scenario(name, run, { demo = true } = {}) {
  if (ONLY && !ONLY.test(name)) return;
  const { ctx, page, errors } = await newPage(browser);
  try {
    if (demo) await loadDemo(page);
    await run(page);
  } catch (e) {
    check(false, `${name} runs to the end`, String(e).split("\n")[0]);
  }
  check(errors.length === 0, `${name} no JS error`, errors[0] || "");
  await ctx.close();
}

try {
  /* ---------------- B2.1 the curated events TSV goes back into CroCoDeEL
     It renamed rate and contamination_specific_species, so CroCoDeEL's
     read_tsv failed on it (KeyError: 'rate'). */
  await scenario("B2.1", async (page) => {
    await openTab(page, "Events");
    const mark = (title) => page.locator(`button[title="mark as ${title}"]`);
    for (const [title, i] of [
      ["true positive", 0],
      ["true positive", 1],
      ["false positive", 3],
      ["uncertain", 5],
    ]) {
      await mark(title).nth(i).click();
      await page.waitForTimeout(300);
    }
    await openTab(page, "Validate");
    const note = '<b>"Quoted"</b> & co\twith a tab\nand a second line';
    await page.locator('textarea[placeholder^="Notes: related samples"]').fill(note);
    await page.waitForTimeout(1500);
    const marked = await overviewStats(page);

    const file = await exportFile(page, /Download events TSV/i);
    const lines = (file?.text || "").split("\n");
    check(
      lines[0] === demo("contamination_events.tsv").split("\n")[0] &&
        /^# study: Demo/.test(lines[1]) &&
        lines[2] ===
          [...CROCODEEL_COLUMNS, "introduced_pct", "verdict", "action", "notes"].join("\t"),
      "B2.1 the curated events TSV keeps the run's # line and the study, then CroCoDeEL's five columns",
      JSON.stringify(lines.slice(1, 3)),
    );
    const read = readLikeCroCoDeEL(file?.text || "");
    check(
      !read.error && sameAsDemo(read.events),
      "B2.1 read like CroCoDeEL's read_tsv, it gives every demo event back, rates and probabilities exactly",
      read.error || "",
    );
    const rows = lines.slice(3).filter(Boolean).map((l) => l.split("\t"));
    const row = (s, t) => rows.find((c) => c[0] === s && c[1] === t) || [];
    check(
      row("63D250", "63D9")[2] === "0.704" && row("58M", "58D7")[3] === "1.0",
      "B2.1 its numbers are written as CroCoDeEL writes them (0.704, 1.0)",
      JSON.stringify([row("63D250", "63D9")[2], row("58M", "58D7")[3]]),
    );
    const verdicts = rows.map((c) => c[6]);
    check(
      verdicts.filter((v) => v === "true_positive").length === marked.tp &&
        verdicts.filter((v) => v === "false_positive").length === marked.fp &&
        verdicts.filter((v) => v === "uncertain").length === 1,
      "B2.1 its verdict column holds the evaluations",
      `TP ${marked.tp}, FP ${marked.fp}`,
    );
    check(
      rows.some((c) => c[8] === '<b>"Quoted"</b> & co with a tab and a second line'),
      "B2.1 the note is on one line, in the notes column",
    );

    // Back through the events card: same evaluations, same notes.
    await upload(page, 0, "contamination_events_curated.tsv", file.text);
    const reloaded = await overviewStats(page);
    check(
      reloaded.tp === marked.tp && reloaded.fp === marked.fp,
      "B2.1 reloaded on the events card, it restores the evaluations",
      `TP ${reloaded.tp}, FP ${reloaded.fp}`,
    );
    const again = await exportFile(page, /Download events TSV/i);
    const curation = (t) =>
      (t || "")
        .split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.split("\t"))
        .map((c) => [c[0], c[1], c[2], c[3], c[6], c[8]].join(" | "))
        .sort();
    check(
      JSON.stringify(curation(again?.text)) === JSON.stringify(curation(file.text)) &&
        again.text.split("\n")[0] === lines[0],
      "B2.1 exported again after the reload, it gives the same events, verdicts and notes",
    );

    // The events card's own Download: CroCoDeEL's file, as read (the
    // study the curated file carried stays on its own "#" line).
    const own = await downloadVia(page, page.locator('button[title="Download this file"]').first());
    const ownLines = (own?.text || "").split("\n");
    const ownRead = readLikeCroCoDeEL(own?.text || "");
    check(
      own?.name === "contamination_events.tsv" &&
        ownLines[0] === lines[0] &&
        ownLines[1] === lines[1] &&
        ownLines[2] === CROCODEEL_COLUMNS.join("\t") &&
        !ownRead.error &&
        sameAsDemo(ownRead.events),
      "B2.1 the events card's Download is CroCoDeEL's five columns, every event as read",
      JSON.stringify(ownLines.slice(0, 3)).slice(0, 300),
    );
  });

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
  }, { demo: false });
} finally {
  await browser.close();
  stopServer();
}
finish();
