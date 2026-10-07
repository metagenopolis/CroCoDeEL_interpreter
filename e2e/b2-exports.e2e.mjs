/* Browser checks for the exports: what a curator downloads must be what
   the next tool reads.

     - B2.1  the curated events TSV of the demo starts with CroCoDeEL's
             five columns, its numbers written as CroCoDeEL writes them,
             under the run's "#" line; a reader built like CroCoDeEL's
             (read_tsv) gets every event back, and so does the events card,
             with the verdicts and the notes; the events card's own
             Download stays CroCoDeEL's file;
     - B2.2  the introduced share of each event and target is the same
             percentage in the events TSV, the samples TSV, the GraphML
             and the CSV pair;
     - B2.3  from a count table (integer-like species names first, a
             first header of its own), the curated abundance table is the
             input without the suppressed columns — same header, same
             species order, same values, no "#" line — and its provenance
             file names the suppressed samples; the abundance card's
             Download gives the input back as it was; a session saved
             before the column sums were kept exports fractions, and the
             card says so;
     - B2.6  a hand-edited session whose metadata entry keeps a string as
             its row: the metadata card does not list its characters as
             columns, the Validate panel shows no "0: a" pill, and the
             metadata download works.

   Usage:  npm run build && node e2e/b2-exports.e2e.mjs
           (or through e2e/run-all.mjs; BASE_URL skips the server,
           E2E_ONLY=<regex> runs only the matching scenarios) */

import { readFileSync } from "node:fs";
import { parseAbundance, parseEvents, parseMetadata } from "../src/parsing.js";
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

/** Click `button` and collect the `n` files it downloads (the graph's
    CSV pair comes as two downloads), { name: text }. */
async function downloadsVia(page, button, n) {
  const files = {};
  const seen = new Promise((resolve) => {
    page.on("download", async (d) => {
      files[d.suggestedFilename()] = readFileSync(await d.path(), "utf8");
      if (Object.keys(files).length === n) resolve();
    });
  });
  await button.click();
  await Promise.race([seen, page.waitForTimeout(30000)]);
  return files;
}

/** A TSV / CSV text as objects keyed by header, "#" lines skipped. */
function table(text, sep = "\t") {
  const lines = (text || "").split("\n").filter((l) => l && !l.startsWith("#"));
  const header = (lines[0] || "").split(sep);
  return lines.slice(1).map((l) => {
    const cells = l.split(sep);
    return Object.fromEntries(header.map((h, j) => [h, cells[j]]));
  });
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

/** The demo abundance table as counts (each relative abundance × 1e7,
    rounded), with the first two species renamed "20" and "3": integer-like
    names, which an export listing Object.keys() would move. */
function demoCounts() {
  return demo("species_abundance.tsv")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l, i) => {
      if (i === 0) return l;
      const cells = l.split("\t");
      if (i === 1) cells[0] = "20";
      if (i === 2) cells[0] = "3";
      return cells.map((c, j) => (j === 0 ? c : String(Math.round(Number(c) * 1e7)))).join("\t");
    })
    .join("\n");
}

/** Mark the first `n` samples of the Samples tab Contaminated, which sets
    their action to Suppress. */
async function suppressSamples(page, n) {
  await openTab(page, "Samples");
  const contaminated = page.locator('button[title="Verdict: Contaminated"]');
  await contaminated.first().waitFor({ state: "visible", timeout: 60000 });
  for (let i = 0; i < n; i++) {
    await contaminated.nth(i).click();
    await page.waitForTimeout(500);
  }
}

/** The "N of M samples" of the curated abundance card, and its text. */
async function curatedCard(page) {
  await openTab(page, "Export");
  const text = await page.locator("body").innerText();
  const m = text.match(/Curated abundance table — (\d+) of (\d+) samples/);
  return { kept: Number(m?.[1]), total: Number(m?.[2]), text };
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

  /* ---------------- B2.2 one unit for the introduced share
     The events TSV wrote 0.6154 where the samples TSV, the GraphML and
     the CSV pair write 61.54. */
  await scenario("B2.2", async (page) => {
    const events = table((await exportFile(page, /Download events TSV/i))?.text);
    const samples = table((await exportFile(page, /Download samples TSV/i))?.text);
    const graphml = (await exportFile(page, /Download GraphML/i))?.text || "";
    const csv = await downloadsVia(page, page.getByRole("button", { name: /node \+ edge CSV pair/i }), 2);
    const edges = table(csv["contamination_graph_edges.csv"], ",");
    const nodes = table(csv["contamination_graph_nodes.csv"], ",");
    const pair = (r) => `${r.source}→${r.target}`;
    const edgeOf = new Map(edges.map((r) => [pair(r), r]));
    const close = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
    const known = events.filter((r) => r.introduced_pct !== "");
    check(
      known.length === events.length && known.some((r) => Number(r.introduced_pct) > 1),
      "B2.2 the events TSV writes the introduced share as a percentage",
      known.slice(0, 3).map((r) => r.introduced_pct).join(", "),
    );
    check(
      edges.length === events.length &&
        known.every((r) => close(r.introduced_pct, edgeOf.get(pair(r))?.introduced_pct)),
      "B2.2 each event's introduced_pct is the edge's introduced_pct of the CSV pair",
    );
    const graphmlValues = [...graphml.matchAll(/<data key="e(\d+)">([^<]*)<\/data>/g)];
    const keyId = graphml.match(/<key id="(e\d+)" for="edge" attr.name="introduced_pct"/)?.[1];
    const inGraphml = graphmlValues.filter((m) => `e${m[1]}` === keyId).map((m) => Number(m[2]));
    check(
      inGraphml.length === events.length &&
        known.every((r) => inGraphml.some((v) => close(v, r.introduced_pct))),
      "B2.2 and the GraphML's",
    );
    const nodeOf = new Map(nodes.map((r) => [r.id, r]));
    const targets = new Set(known.map((r) => r.target));
    const maxOf = (t) => Math.max(...known.filter((r) => r.target === t).map((r) => Number(r.introduced_pct)));
    check(
      [...targets].every((t) => {
        const row = samples.find((r) => r.sample_id === t);
        return close(row?.max_target_introduced_pct, maxOf(t)) && close(nodeOf.get(t)?.max_introduced_pct, maxOf(t));
      }),
      "B2.2 each target's max_target_introduced_pct (samples TSV) and max_introduced_pct (graph) is its events' highest",
    );
  });

  /* ---------------- B2.3 the curated abundance table is the input table
     It wrote fractions (1500 / 500 came out 0.75 / 0.25) under a "species"
     header, behind "#" lines that pandas and R read as data. */
  await scenario("B2.3 counts", async (page) => {
    const input = demoCounts();
    await upload(page, 1, "species_abundance.tsv", input);
    await suppressSamples(page, 2);
    const card = await curatedCard(page);
    const file = await exportFile(page, /Download curated abundance TSV/i);
    const rows = (file?.text || "").split("\n").map((l) => l.split("\t"));
    const inRows = input.split("\n").map((l) => l.split("\t"));
    const header = rows[0] || [];
    const dropped = inRows[0].slice(1).filter((c) => !header.includes(c));
    check(
      header[0] === "id_mgs" && dropped.length === 2 && card.total - card.kept === 2,
      "B2.3 the curated table keeps the input's first header, without the 2 suppressed columns the card counts",
      `${header[0]}; without ${dropped.join(", ")}; card ${card.kept} of ${card.total}`,
    );
    check(
      !(file?.text || "").split("\n").some((l) => l.startsWith("#")),
      "B2.3 it has no # line (pandas and R would read one as data)",
    );
    // The same table, column by column, as text: counts stay counts. Only
    // the species observed in the suppressed samples alone go (the box is
    // ticked by default); rows at zero everywhere in the input stay.
    const keep = inRows[0].map((c, j) => j === 0 || header.includes(c));
    const onlyDropped = (r) =>
      r.slice(1).every((c, j) => c === "0" || !keep[j + 1]) &&
      r.slice(1).some((c, j) => c !== "0" && !keep[j + 1]);
    const expected = inRows
      .filter((r, i) => i === 0 || !onlyDropped(r))
      .map((r) => r.filter((_, j) => keep[j]));
    check(
      file?.text === expected.map((r) => r.join("\t")).join("\n"),
      "B2.3 every remaining column equals the input column, species in the input's order (20 and 3 first)",
      rows.slice(1, 3).map((r) => r.slice(0, 3).join(" ")).join(" | "),
    );
    const empty = inRows.slice(1).filter((r) => r.slice(1).every((c) => c === "0")).length;
    check(
      empty > 0 &&
        rows.length === expected.length &&
        card.text.includes(
          `Drop species observed only in the suppressed samples (${inRows.length - expected.length})`,
        ),
      "B2.3 the species rows at zero in the whole input stay; the card counts only those the suppression empties",
      `${empty} empty input rows kept; ${inRows.length - expected.length} dropped`,
    );
    check(
      /holds the input file's own\s+values/.test(card.text) && !/Written as relative abundances/.test(card.text),
      "B2.3 the card says the values are the input's own",
    );
    const provenance = await downloadVia(page, page.getByRole("button", { name: /Download its provenance/i }).first());
    const plines = (provenance?.text || "").split("\n");
    check(
      provenance?.name === "species_abundance_curated.provenance.txt" &&
        plines.includes("Suppressed samples (2), removed because their action is Suppress:") &&
        dropped.every((id) => plines.includes(id)) &&
        /own values/.test(provenance.text),
      "B2.3 the provenance file names the suppressed samples and the values",
      plines.slice(0, 3).join(" / "),
    );
    // The abundance card's own Download: the input as it was.
    await openTab(page, "Overview");
    const own = await downloadVia(page, page.locator('button[title="Download this file"]').nth(1));
    check(
      own?.name === "species_abundance.tsv" && own.text === input,
      "B2.3 the abundance card's Download gives the uploaded count table back as it was",
      (own?.text || "").split("\n")[1]?.slice(0, 60) || "",
    );
  });

  /* A session saved before the parser kept the column sums: the export
     can only write fractions, and the card says so. */
  await scenario("B2.3 earlier session", async (page) => {
    const { samples, species, matrix, logRange } = parseAbundance(demo("species_abundance.tsv"));
    await importSession(page, sessionJSON({ abundance: { samples, species, matrix, logRange } }));
    const card = await curatedCard(page);
    check(
      /Written as relative abundances/.test(card.text),
      "B2.3 the card says an earlier session's table is written as relative abundances",
    );
    const file = await exportFile(page, /Download curated abundance TSV/i);
    const rows = (file?.text || "").split("\n").map((l) => l.split("\t"));
    const sums = rows[0].slice(1).map((_, j) => rows.slice(1).reduce((t, r) => t + Number(r[j + 1]), 0));
    check(
      rows[0][0] === "species" && sums.every((t) => Math.abs(t - 1) < 1e-9 || t === 0),
      "B2.3 and writes fractions summing to 1 under a species header",
      `${rows[0][0]}; ${sums.slice(0, 3).map((t) => t.toFixed(12)).join(", ")}`,
    );
  }, { demo: false });

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
