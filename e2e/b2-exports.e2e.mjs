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
             species order, same values, no "#" line — and the same click
             writes its provenance file, which names the suppressed
             samples of that very table (also after the curation
             changes); the abundance card's Download gives the input back
             as it was; a session saved before the column sums were kept
             exports fractions, and both the Export card and the abundance
             card say so;
     - B2.4  the samples TSV writes every sample's verdict and action as
             the views show them, each with its origin (manual, automatic,
             default) — the Suppress paired with a Contaminated set by
             hand on a sample no event targets is automatic, not default —
             and the samples HTML report's "auto" and "default" tags say
             the same; the file starts with its header (no "#" line, the
             study in a column), so pandas and R read it as it is;
     - B2.5  the events and samples HTML reports, of the demo (filtered
             or not) and of a session with a cascade, an event whose
             target and one whose source are not in the abundance table,
             metadata, a plate map and notes with HTML characters, tabs
             and line breaks, print no NaN, undefined, null or Infinity,
             escape the notes, and give the introduced share in percent,
             as the events TSV does;
     - B2.6  a hand-edited session whose metadata entry keeps a string as
             its row: the metadata card does not list its characters as
             columns, the Validate panel shows no "0: a" pill, and the
             metadata download works; the plate map card warns about a
             missing plate column exactly when the Help says it does.

   Also: the curated count table through a reload and a session file
   imported in another browser, a table of decimals, percentages,
   counts and NA / empty / negative cells with the "Drop species" box
   ticked and not, and the events TSV of a filtered subset.

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
    CSV pair, the curated abundance table and its provenance come as two
    downloads), { name: text }. */
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

/** The two files of the curated abundance card's one click: { table,
    provenance } (texts, undefined when missing). */
async function curatedDownload(page) {
  await openTab(page, "Export");
  const files = await downloadsVia(
    page,
    page.getByRole("button", { name: /Download curated abundance TSV/i }).first(),
    2,
  );
  return {
    table: files["species_abundance_curated.tsv"],
    provenance: files["species_abundance_curated.provenance.txt"],
  };
}

/** Does a provenance text describe `table` (a curated abundance TSV
    text), given the input's samples? Its "This table:" sizes and its
    list of suppressed samples must be the table's. */
function describes(provenance, table, inputSamples) {
  const lines = (provenance || "").split("\n");
  const rows = (table || "").split("\n").filter(Boolean);
  const header = (rows[0] || "").split("\t");
  const dropped = inputSamples.filter((id) => !header.includes(id));
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const at = lines.findIndex((l) => l.startsWith("Suppressed samples ("));
  const listed = [];
  for (let i = at + 1; at >= 0 && i < lines.length && lines[i]; i++) listed.push(lines[i]);
  return (
    lines.includes(
      `This table: ${plural(rows.length - 1, "species row")} × ${plural(header.length - 1, "sample")}.`,
    ) &&
    lines[at] === `Suppressed samples (${dropped.length}), removed because their action is Suppress:` &&
    JSON.stringify([...listed].sort()) === JSON.stringify([...dropped].sort())
  );
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

/** The samples HTML report's rows: { id: [verdict tag, action tag] },
    a tag being "auto", "default" or "" (a value set by hand, or none). */
function htmlReportTags(html) {
  const tags = {};
  for (const row of (html || "").split("<tr>").slice(1)) {
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    const id = tds[0]?.match(/>([^<]*)<\/div>/)?.[1];
    if (!id || tds.length < 10) continue;
    const tag = (td) => td.match(/>(auto|default)<\/span>/)?.[1] || "";
    tags[id] = [tag(tds[8]), tag(tds[9])];
  }
  return tags;
}

/** The words a report must never print: a value that went missing. */
const MISSING = /\b(NaN|undefined|null|Infinity)\b/;

/** Where `MISSING` occurs in an HTML report, with its context. */
function missingIn(html) {
  const m = MISSING.exec(html || "");
  return m ? html.slice(Math.max(0, m.index - 80), m.index + 20).replace(/\s+/g, " ") : null;
}

/** The overview table of the events HTML report: { "src→tgt": the
    introduced % cell }. */
function reportIntroduced(html) {
  const out = {};
  const re =
    /<td class="num">\d+<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td class="num">[^<]*<\/td>\s*<td class="num">[^<]*<\/td>\s*<td class="num">([^<]*)<\/td>/g;
  for (const m of (html || "").matchAll(re)) out[`${m[1]}→${m[2]}`] = m[3];
  return out;
}

/** The overview table of the events HTML report: { "src→tgt": the
    rate cell }. */
function reportRates(html) {
  const out = {};
  const re = /<td class="num">\d+<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td class="num">([^<]*)<\/td>/g;
  for (const m of (html || "").matchAll(re)) out[`${m[1]}→${m[2]}`] = m[3];
  return out;
}

/** A note with HTML special characters, a tab and a line break. */
const HTML_NOTE = `<b>"Quoted"</b> & 'single'\twith a tab\nsecond line`;

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
          [...CROCODEEL_COLUMNS, "introduced_pct", "verdict", "action", "notes", "sample_verdict", "origin"].join("\t"),
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
    // A cell holding a quote is quoted the CSV way (tsvCell): R's
    // read.delim took a quote inside an unquoted cell for the start of a
    // quoted field and swallowed the rows after it.
    check(
      rows.some((c) => c[8] === '"<b>""Quoted""</b> & co with a tab and a second line"'),
      "B2.1 the note is on one line, in the notes column, quoted the CSV way",
      rows.map((c) => c[8]).find((n) => /Quoted/.test(n || "")) || "(no note)",
    );

    // Back through the events card: same evaluations, same notes. The
    // session holds curation, so the card asks first; the file's own
    // verdict and notes columns win over what is carried over.
    await upload(page, 0, "contamination_events_curated.tsv", file.text);
    await page
      .getByRole("dialog", { name: "Replace the events file?" })
      .getByRole("button", { name: "Carry over" })
      .click();
    await page.waitForTimeout(1500);
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

    // The events card's own Download: CroCoDeEL's file, as read. The run
    // line comes first; the study names the session (its title), so a
    // "# study:" line, when written, stays on its own "#" line.
    const own = await downloadVia(page, page.locator('button[title="Download this file"]').first());
    const ownLines = (own?.text || "").split("\n");
    const ownRead = readLikeCroCoDeEL(own?.text || "");
    const header = ownLines[1]?.startsWith("# study:") ? ownLines[2] : ownLines[1];
    check(
      own?.name === "contamination_events.tsv" &&
        ownLines[0] === lines[0] &&
        header === CROCODEEL_COLUMNS.join("\t") &&
        !ownRead.error &&
        sameAsDemo(ownRead.events),
      "B2.1 the events card's Download is CroCoDeEL's five columns, every event as read",
      JSON.stringify(ownLines.slice(0, 3)).slice(0, 300),
    );
  });

  /* The curated file goes to a colleague, who loads it in a fresh
     browser and exports it again. A study titled "Lou 2023 | plate: 3"
     came back as a run parameter "plate: 3" on the run line CroCoDeEL
     wrote, since the reader splits every "#" line on "|". */
  await scenario("B2.1 fresh session", async (page) => {
    await openTab(page, "Events");
    const mark = (title) => page.locator(`button[title="mark as ${title}"]`);
    for (const [title, i] of [
      ["true positive", 0],
      ["false positive", 3],
      ["uncertain", 5],
    ]) {
      await mark(title).nth(i).click();
      await page.waitForTimeout(300);
    }
    await openTab(page, "Validate");
    await page.locator('textarea[placeholder^="Notes: related samples"]').fill(HTML_NOTE);
    await page.waitForTimeout(1500);
    await page.locator('button[title="Click to rename this study"]').first().click();
    await page.locator('input[placeholder="Study title"]').fill("Lou 2023 | plate: 3");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const file = (await exportFile(page, /Download events TSV/i))?.text || "";
    const lines = file.split("\n");
    const runLine = demo("contamination_events.tsv").split("\n")[0];
    check(
      lines[0] === runLine && lines[1] === "# study: Lou 2023 / plate: 3",
      "B2.1 a study title with '|' is written with '/', on its own line under the run line",
      JSON.stringify(lines.slice(1, 2)),
    );

    // A colleague's browser: the curated file and the abundance table.
    const fresh = await newPage(browser);
    try {
      await upload(fresh.page, 0, "contamination_events_curated.tsv", file);
      await upload(fresh.page, 1, "species_abundance.tsv", demo("species_abundance.tsv"));
      const again = (await exportFile(fresh.page, /Download events TSV/i))?.text || "";
      const againLines = again.split("\n");
      check(
        againLines[0] === runLine && !/plate/.test(againLines[0]),
        "B2.1 exported again from a fresh session, the run line is still CroCoDeEL's",
        againLines[0].slice(-60),
      );
      // Every event with its numbers, introduced_pct, evaluation and note.
      // (The study line and the action column depend on how the events
      // card's loader titles the session and derives the sample curation,
      // which this check leaves out.)
      const body = (t) =>
        t
          .split("\n")
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => l.split("\t"))
          .map((c) => [...c.slice(0, 7), c[8]].join(" | "));
      check(
        JSON.stringify(body(again)) === JSON.stringify(body(file)) && body(file).length === 25,
        "B2.1 and every event comes back with its numbers, introduced_pct, evaluation and note, in order",
      );
      check(fresh.errors.length === 0, "B2.1 the colleague's session: no JS error", fresh.errors[0] || "");
    } finally {
      await fresh.ctx.close();
    }
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
    // A node no event targets has no incoming rate and no introduced
    // share: -1 in both graph files, never 0, which reads as a measurement.
    const graphmlKey = (name) =>
      graphml.match(new RegExp(`<key id="(n\\d+)" for="node" attr.name="${name}"`))?.[1];
    const graphmlNodes = new Map(
      [...graphml.matchAll(/<node id="([^"]*)">([\s\S]*?)<\/node>/g)].map((m) => [
        m[1],
        Object.fromEntries([...m[2].matchAll(/<data key="(n\d+)">([^<]*)<\/data>/g)].map((d) => [d[1], d[2]])),
      ]),
    );
    const inGraphmlNode = (id, name) => graphmlNodes.get(id)?.[graphmlKey(name)];
    const untargeted = nodes.filter((r) => r.events_as_target === "0");
    check(
      untargeted.length > 0 &&
        untargeted.every(
          (r) =>
            r.max_incoming_rate === "-1" &&
            r.max_introduced_pct === "-1" &&
            inGraphmlNode(r.id, "max_incoming_rate") === "-1" &&
            inGraphmlNode(r.id, "max_introduced_pct") === "-1",
        ) &&
        nodes.filter((r) => r.events_as_target !== "0").every((r) => Number(r.max_incoming_rate) > 0),
      "B2.2 a node no event targets has max_incoming_rate and max_introduced_pct -1 in the CSV and the GraphML",
      untargeted.slice(0, 2).map((r) => `${r.id}: ${r.max_incoming_rate} / ${r.max_introduced_pct}`).join("; "),
    );
  });

  /* ---------------- B2.3 the curated abundance table is the input table
     It wrote fractions (1500 / 500 came out 0.75 / 0.25) under a "species"
     header, behind "#" lines that pandas and R read as data. */
  await scenario("B2.3 counts", async (page) => {
    const input = demoCounts();
    await upload(page, 1, "species_abundance.tsv", input);
    await suppressSamples(page, 2);
    const exportCard = await curatedCard(page);
    const pair = await curatedDownload(page);
    const file = pair.table == null ? null : { text: pair.table };
    const rows = (file?.text || "").split("\n").map((l) => l.split("\t"));
    const inRows = input.split("\n").map((l) => l.split("\t"));
    const header = rows[0] || [];
    const dropped = inRows[0].slice(1).filter((c) => !header.includes(c));
    check(
      header[0] === "id_mgs" && dropped.length === 2 && exportCard.total - exportCard.kept === 2,
      "B2.3 the curated table keeps the input's first header, without the 2 suppressed columns the card counts",
      `${header[0]}; without ${dropped.join(", ")}; card ${exportCard.kept} of ${exportCard.total}`,
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
        exportCard.text.includes(
          `Drop species observed only in the suppressed samples (${inRows.length - expected.length})`,
        ),
      "B2.3 the species rows at zero in the whole input stay; the card counts only those the suppression empties",
      `${empty} empty input rows kept; ${inRows.length - expected.length} dropped`,
    );
    check(
      /holds the input file's own\s+values/.test(exportCard.text) && !/Written as relative abundances/.test(exportCard.text),
      "B2.3 the card says the values are the input's own",
    );
    // The same click wrote the provenance, of that very table.
    const plines = (pair.provenance || "").split("\n");
    check(
      plines.includes("Suppressed samples (2), removed because their action is Suppress:") &&
        dropped.every((id) => plines.includes(id)) &&
        /own values/.test(pair.provenance) &&
        describes(pair.provenance, pair.table, inRows[0].slice(1)),
      "B2.3 the same click writes the provenance file, which names the suppressed samples and the values",
      plines.slice(0, 3).join(" / ") || "no provenance file",
    );
    // The abundance card's own Download: the input as it was, and no
    // notice about relative abundances on the card.
    await openTab(page, "Overview");
    const own = await downloadVia(page, page.locator('button[title="Download this file"]').nth(1));
    check(
      own?.name === "species_abundance.tsv" && own.text === input,
      "B2.3 the abundance card's Download gives the uploaded count table back as it was",
      (own?.text || "").split("\n")[1]?.slice(0, 60) || "",
    );
    check(
      !/relative abundances/.test(await card(page, "species_abundance.tsv").innerText()),
      "B2.3 and that card has no relative-abundance notice",
    );
  });

  /* The curated table and its provenance came from two clicks: a
     provenance downloaded after the curation changed described a table
     that was never downloaded, and a curator who never clicked the link
     kept no record of the suppressed samples. */
  await scenario("B2.3 provenance", async (page) => {
    const inputSamples = demo("species_abundance.tsv")
      .split("\n")
      .find((l) => l && !l.startsWith("#"))
      .split("\t")
      .slice(1);
    await suppressSamples(page, 2);
    const first = await curatedDownload(page);
    check(
      !!first.table && !!first.provenance && describes(first.provenance, first.table, inputSamples),
      "B2.3 one click writes the curated table and its provenance, which describes that table (2 suppressed)",
      (first.provenance || "no provenance file").split("\n").find((l) => l.startsWith("This table")) || "",
    );
    // A third sample: the next click's two files describe the new table.
    await openTab(page, "Samples");
    await page.locator('button[title="Verdict: Contaminated"]').nth(2).click();
    await page.waitForTimeout(800);
    const second = await curatedDownload(page);
    const columns = (t) => (t || "").split("\n")[0].split("\t").length - 1;
    check(
      columns(second.table) === columns(first.table) - 1 &&
        describes(second.provenance, second.table, inputSamples) &&
        /^Suppressed samples \(3\)/m.test(second.provenance || ""),
      "B2.3 after a third suppression, the next click's provenance describes the new table (3 suppressed)",
      `${columns(first.table)} then ${columns(second.table)} columns`,
    );
    check(
      (await page.getByRole("button", { name: /provenance/i }).count()) === 0,
      "B2.3 no separate provenance button is left to describe another table",
    );
  });

  /* The parser's firstHeader, colSums and integerCols must live through
     what a session goes through — the browser's autosave and a reload,
     the session file imported in another browser — or the export falls
     back to fractions. */
  await scenario("B2.3 persistence", async (page) => {
    await upload(page, 1, "species_abundance.tsv", demoCounts());
    await suppressSamples(page, 2);
    const before = (await curatedDownload(page)).table;
    // The autosave is debounced by a second.
    await page.waitForTimeout(2500);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    const reloaded = (await curatedDownload(page)).table;
    check(
      !!before && /^id_mgs\t/.test(before) && reloaded === before,
      "B2.3 after a reload, the curated count table is the same file",
      (reloaded || "none").split("\n")[0].slice(0, 40),
    );
    const session = await downloadVia(page, page.getByRole("button", { name: /^Download session$/ }).first());
    const other = await newPage(browser);
    try {
      await importSession(other.page, JSON.parse(session?.text || "{}"));
      const imported = (await curatedDownload(other.page)).table;
      check(
        !!before && imported === before,
        "B2.3 imported from the session file in another browser, it is the same file too",
        (imported || "none").split("\n")[0].slice(0, 40),
      );
      check(other.errors.length === 0, "B2.3 the other browser: no JS error", other.errors[0] || "");
    } finally {
      await other.ctx.close();
    }
  });

  /* Decimals, exponent notation, percentages, counts and cells the parser
     reads as 0 (NA, empty, negative) in one table; the "Drop species" box
     ticked, then not. */
  await scenario("B2.3 mixed table", async (page) => {
    const input = [
      "clade_name\tD1\tD2\tP1\tM1\tC1",
      "sp_a\t0.25\t1.5e-3\t45.5\t12\t10",
      "sp_b\t0.75\tNA\t54.5\t-3\t0",
      "sp_c\t0\t0.0015\t0\t\t5",
      "sp_d\t0\t0.997\t0\t7.25\t1",
      "sp_e\t0\t0\t0\t5\t0",
    ].join("\n");
    await upload(page, 0, "contamination_events.tsv", [
      "source\ttarget\trate\tprobability\tcontamination_specific_species",
      "C1\tM1\t0.1\t0.9\tsp_e",
    ].join("\n"));
    await upload(page, 1, "species_abundance.tsv", input);
    await openTab(page, "Events");
    await page.locator('button[title="mark as true positive"]').first().click();
    await page.waitForTimeout(800);
    const inRows = input.split("\n").map((l) => l.split("\t"));
    // What pandas or R reads in the input: a number, or 0 for a cell the
    // interface reads as 0 (NA, empty, negative).
    const inputNumber = (c) => (c === "" || c === "NA" || Number(c) < 0 ? 0 : Number(c));
    const sameAsInput = (text) => {
      const rows = (text || "").split("\n").map((l) => l.split("\t"));
      const col = new Map(inRows[0].map((h, j) => [h, j]));
      const byName = new Map(inRows.slice(1).map((r) => [r[0], r]));
      return (
        rows[0].join() === "clade_name,D1,D2,P1,C1" &&
        rows.slice(1).every((r) => r.slice(1).every((c, j) => Number(c) === inputNumber(byName.get(r[0])[col.get(rows[0][j + 1])])))
      );
    };
    const ticked = (await curatedDownload(page)).table;
    check(
      sameAsInput(ticked) &&
        ticked.split("\n").map((l) => l.split("\t")[0]).join() === "clade_name,sp_a,sp_b,sp_c,sp_d",
      "B2.3 a mixed table comes back without M1, each value the input's (NA, empty, negative as 0), sp_e (only in M1) dropped",
      (ticked || "none").replace(/\n/g, " / "),
    );
    check(
      /^sp_a\t0\.25\t0\.0015\t45\.5\t10$/m.test(ticked || "") && /^sp_b\t0\.75\t0\t54\.5\t0$/m.test(ticked || ""),
      "B2.3 decimals stay decimals, percentages percentages, counts integers",
    );
    await openTab(page, "Export");
    await page.getByText("Drop species observed only in the suppressed samples").click();
    await page.waitForTimeout(300);
    const unticked = (await curatedDownload(page)).table;
    check(
      sameAsInput(unticked) &&
        unticked.split("\n").map((l) => l.split("\t")[0]).join() === inRows.map((r) => r[0]).join(),
      "B2.3 with the box unticked, every species row stays, in the input's order",
      (unticked || "none").split("\n").map((l) => l.split("\t")[0]).join(","),
    );
  }, { demo: false });

  /* A session saved before the parser kept the column sums: the export
     can only write fractions, and the card says so. */
  await scenario("B2.3 earlier session", async (page) => {
    const { samples, species, matrix, logRange } = parseAbundance(demo("species_abundance.tsv"));
    await importSession(page, sessionJSON({ abundance: { samples, species, matrix, logRange } }));
    const exportCard = await curatedCard(page);
    check(
      /Written as relative abundances/.test(exportCard.text),
      "B2.3 the card says an earlier session's table is written as relative abundances",
    );
    const pair = await curatedDownload(page);
    const fractions = (text) => {
      const rows = (text || "").split("\n").map((l) => l.split("\t"));
      const sums = rows[0].slice(1).map((_, j) => rows.slice(1).reduce((t, r) => t + Number(r[j + 1]), 0));
      return {
        ok: rows[0][0] === "species" && sums.length > 0 && sums.every((t) => Math.abs(t - 1) < 1e-9 || t === 0),
        detail: `${rows[0][0]}; ${sums.slice(0, 3).map((t) => t.toFixed(12)).join(", ")}`,
      };
    };
    const curated = fractions(pair.table);
    check(curated.ok, "B2.3 and writes fractions summing to 1 under a species header", curated.detail);
    // The abundance card's own Download does the same: its card says so.
    await openTab(page, "Overview");
    const abCard = await card(page, "species_abundance.tsv").innerText();
    const own = await downloadVia(page, card(page, "species_abundance.tsv").locator('button[title="Download this file"]'));
    const ownFractions = fractions(own?.text);
    check(
      /Its Download writes relative abundances/.test(abCard) && own?.name === "species_abundance.tsv" && ownFractions.ok,
      "B2.3 the abundance card says its Download writes relative abundances, which it does",
      `${abCard.replace(/\s+/g, " ").slice(0, 160)}; ${ownFractions.detail}`,
    );
  }, { demo: false });

  /* ---------------- B2.4 the origin of each sample value
     The samples TSV wrote the curator's values, the automatic ones and
     the Not contaminated + Keep default of a sample no event targets
     alike: a sample nobody reviewed read as a curated "correct / keep". */
  await scenario("B2.4", async (page) => {
    await openTab(page, "Events");
    const mark = (title) => page.locator(`button[title="mark as ${title}"]`);
    for (const [title, i] of [
      ["true positive", 0],
      ["false positive", 1],
      ["uncertain", 2],
    ]) {
      await mark(title).nth(i).click();
      await page.waitForTimeout(300);
    }
    const events = table((await exportFile(page, /Download events TSV/i))?.text);
    const byTarget = new Map();
    for (const e of events) byTarget.set(e.target, [...(byTarget.get(e.target) || []), e.verdict]);
    const tpTarget = events.find((e) => e.verdict === "true_positive")?.target;
    const inNoEvent = (id) => demoEvents.events.every((e) => e.source !== id && e.target !== id);
    const untargeted = inNoEvent("40D89") ? "40D89" : null;
    const contaminatedByHand = inNoEvent("58D13") ? "58D13" : null;
    // By hand: Uncertain on a sample no event targets, Contaminated on
    // another (the rule pairs it with Suppress), Keep on the TP target.
    const row = (id) =>
      page
        .locator("tr")
        .filter({ has: page.locator('button[aria-label="Set verdict to Pending"]') })
        .filter({ has: page.getByText(id, { exact: true }) });
    await openTab(page, "Samples");
    await row(untargeted).locator('button[aria-label="Set verdict to Uncertain"]').click();
    await page.waitForTimeout(300);
    await row(contaminatedByHand).locator('button[aria-label="Set verdict to Contaminated"]').click();
    await page.waitForTimeout(300);
    await row(tpTarget).locator(`button[aria-label="Keep ${tpTarget}"]`).click();
    await page.waitForTimeout(800);
    const autoMark = await row(contaminatedByHand).getByTitle(/^Automatic action/).count();

    const samplesFile = await exportFile(page, /Download samples TSV/i);
    const samplesLines = (samplesFile?.text || "").split("\n");
    const header = samplesLines[0].split("\t");
    check(
      header.slice(-6).join(",") === "verdict,verdict_origin,action,action_origin,notes,study",
      "B2.4 the samples TSV has verdict_origin and action_origin next to the values, then the notes and the study",
      header.slice(-6).join(","),
    );
    // The header is the first line: a "# study:" line above it was a data
    // row to pandas and R (pandas made the 23 first columns an index, R
    // refused the file). Every row has the header's cells, and the study.
    const ragged = samplesLines.filter((l) => l.split("\t").length !== header.length);
    check(
      header[0] === "sample_id" &&
        !samplesLines.some((l) => l.startsWith("#")) &&
        ragged.length === 0 &&
        samplesLines.slice(1).every((l) => l.split("\t").at(-1) === "Demo — Lou et al. 2023 (early-life metagenomes, plate 3)"),
      "B2.4 the samples TSV starts with its header, no # line, the study in a column of its own",
      `${samplesLines[0].slice(0, 40)}; ${ragged.length} ragged lines`,
    );
    const expected = (id) => {
      if (id === untargeted) return ["uncertain", "manual", "", ""];
      if (id === contaminatedByHand) return ["contaminated", "manual", "suppress", "automatic"];
      if (id === tpTarget) return ["contaminated", "automatic", "keep", "manual"];
      const v = byTarget.get(id);
      if (!v) return ["correct", "default", "keep", "default"];
      if (v.includes("true_positive")) return ["contaminated", "automatic", "suppress", "automatic"];
      if (v.includes("uncertain")) return ["uncertain", "automatic", "", ""];
      if (v.includes("false_positive")) return ["correct", "automatic", "", ""];
      return ["", "", "", ""];
    };
    const rows = table(samplesFile?.text);
    const values = (r) => [r.verdict, r.verdict_origin, r.action, r.action_origin];
    const wrong = rows.filter((r) => values(r).join() !== expected(r.sample_id).join());
    const kinds = new Set(rows.flatMap((r) => [r.verdict_origin, r.action_origin]));
    check(
      rows.length === 91 && wrong.length === 0 && ["manual", "automatic", "default"].every((k) => kinds.has(k)),
      "B2.4 each sample's verdict and action carry their origin: manual, automatic (from the events) or default",
      wrong.slice(0, 3).map((r) => `${r.sample_id}: ${values(r).join("/")}`).join("; "),
    );
    // A sample no event targets, marked Contaminated by hand: its Suppress
    // is the rule's — the Samples tab marks it automatic, the curated
    // table drops the sample — not the default (Not contaminated + Keep).
    const byHand = rows.find((r) => r.sample_id === contaminatedByHand);
    check(
      byHand && values(byHand).join() === "contaminated,manual,suppress,automatic" && autoMark === 1,
      "B2.4 the Suppress paired with a Contaminated set by hand on a sample no event targets is automatic, as the Samples tab marks it",
      byHand ? `${values(byHand).join("/")}; Samples tab automatic mark: ${autoMark}` : "row missing",
    );
    // The samples HTML report's tags say the same, from the expected
    // origins above (not from the TSV, which shares the rule).
    const html = await exportFile(page, /Download samples HTML/i);
    const tags = htmlReportTags(html?.text);
    const tagOf = { automatic: "auto", default: "default", manual: "", "": "" };
    const expectedTags = (id) => {
      const [, verdictOrigin, , actionOrigin] = expected(id);
      return [tagOf[verdictOrigin], tagOf[actionOrigin]];
    };
    const disagree = rows.filter((r) => (tags[r.sample_id] || []).join() !== expectedTags(r.sample_id).join());
    check(
      Object.keys(tags).length === rows.length &&
        disagree.length === 0 &&
        tags[contaminatedByHand]?.join() === ",auto",
      "B2.4 the samples HTML report tags the same values auto and default",
      disagree.slice(0, 3).map((r) => `${r.sample_id}: ${JSON.stringify(tags[r.sample_id])}`).join("; "),
    );
  });

  /* ---------------- B2.5 HTML reports without a missing value
     Both reports of the demo, curated, with a note full of HTML
     characters, then the events report of a filtered subset. */
  await scenario("B2.5 demo", async (page) => {
    await openTab(page, "Events");
    const mark = (title) => page.locator(`button[title="mark as ${title}"]`);
    await mark("true positive").nth(0).click();
    await mark("false positive").nth(1).click();
    await mark("uncertain").nth(2).click();
    await openTab(page, "Validate");
    await page.locator('textarea[placeholder^="Notes: related samples"]').fill(HTML_NOTE);
    await page.waitForTimeout(1500);
    const eventsHtml = (await exportFile(page, /Download events HTML/i))?.text;
    const samplesHtml = (await exportFile(page, /Download samples HTML/i))?.text;
    const tsv = table((await exportFile(page, /Download events TSV/i))?.text);
    check(
      !!eventsHtml && !!samplesHtml && !missingIn(eventsHtml) && !missingIn(samplesHtml),
      "B2.5 the demo's events and samples HTML reports print no NaN / undefined / null",
      missingIn(eventsHtml) || missingIn(samplesHtml) || "",
    );
    check(
      eventsHtml?.includes("&lt;b&gt;&quot;Quoted&quot;&lt;/b&gt; &amp; 'single'") && !eventsHtml.includes('<b>"Quoted"'),
      "B2.5 the note is escaped, not markup",
    );
    const intro = reportIntroduced(eventsHtml);
    check(
      tsv.length === 24 &&
        tsv.every((r) => intro[`${r.source}→${r.target}`] === `${Number(r.introduced_pct).toFixed(1)}%`),
      "B2.5 its introduced % is the events TSV's introduced_pct, in percent",
      Object.entries(intro).slice(0, 2).map(([k, v]) => `${k} ${v}`).join("; "),
    );
    // Rates: a fraction in the TSV (CroCoDeEL's own number), a percentage
    // in the report, as the Help's Units paragraph says.
    const rates = reportRates(eventsHtml);
    check(
      tsv.every((r) => Number(r.rate) < 1 && rates[`${r.source}→${r.target}`] === `${(Number(r.rate) * 100).toFixed(2)}%`),
      "B2.5 its rate is the events TSV's fraction, as a percentage",
      Object.entries(rates).slice(0, 2).map(([k, v]) => `${k} ${v}`).join("; "),
    );
    // A filtered subset: the report names the filter.
    await page.locator('input[placeholder="sample id or name…"]').first().fill("63D");
    await page.waitForTimeout(800);
    const filtered = (await exportFile(page, /Download events HTML/i))?.text;
    check(
      /Filter applied:<\/strong> search: "63D"/.test(filtered || "") && !missingIn(filtered),
      "B2.5 the report of a filtered subset names the filter and prints no missing value",
      missingIn(filtered) || "",
    );
    // …and the events TSV of the same subset: the matched events only,
    // under the same "#" lines and CroCoDeEL's columns.
    const subsetText = (await exportFile(page, /Download events TSV/i))?.text || "";
    const subset = table(subsetText);
    const expectedSubset = tsv.filter((r) => /63D/.test(`${r.source} ${r.target}`));
    check(
      subset.length > 0 &&
        subset.length < tsv.length &&
        JSON.stringify(subset) === JSON.stringify(expectedSubset) &&
        subsetText.split("\n")[0] === demo("contamination_events.tsv").split("\n")[0],
      "B2.5 the events TSV of the filtered subset holds exactly its events, under the run's # line",
      `${subset.length} of ${tsv.length} events`,
    );
  });

  /* A cascade C → A → B, an event whose target and one whose source are
     not in the abundance table, metadata, a plate map, a note. */
  await scenario("B2.5 crafted", async (page) => {
    const ab = ["id_mgs\tC\tA\tB\tSRC"];
    for (let i = 0; i < 20; i++) {
      const a = 10 ** (-3 * (i / 19));
      ab.push(`s_${i}\t0\t${a.toPrecision(6)}\t${(0.05 * a).toPrecision(6)}\t${(i % 4) + 1}`);
    }
    for (let i = 0; i < 6; i++) {
      const c = 10 ** (-1 - i / 3);
      ab.push(`m_${i}\t${c.toPrecision(6)}\t${(0.2 * c).toPrecision(6)}\t${(1e-4 * c).toPrecision(6)}\t0`);
    }
    const list = (p, n) => Array.from({ length: n }, (_, i) => `${p}_${i}`).join(",");
    await upload(page, 0, "contamination_events.tsv", [
      "# crocodeel version: 1.2.1 | filtering_ab_thr_factor: None",
      "source\ttarget\trate\tprobability\tcontamination_specific_species",
      `C\tA\t0.2\t0.99\t${list("m", 6)}`,
      `A\tB\t0.05\t0.95\t${list("s", 20)}`,
      "SRC\tMISSING\t0.01\t0.6\ts_1,s_2",
      "GHOST\tB\t0.03\t0.7\ts_3",
    ].join("\n"));
    await upload(page, 1, "species_abundance.tsv", ab.join("\n"));
    await upload(page, 2, "metadata.tsv", [
      "sample_id\tsubject_id\tbiome",
      "C\tp1\tgut",
      "A\tp2\tgut",
      "B\tp3\tnegative control",
    ].join("\n"));
    await upload(page, 3, "plate_map.tsv", ["sample_id\tplate\twell", "C\tP1\tA01", "A\tP1\tA02", "B\tP1\tB02"].join("\n"));
    await openTab(page, "Events");
    const mark = (title) => page.locator(`button[title="mark as ${title}"]`);
    await mark("true positive").nth(0).click();
    await mark("false positive").nth(2).click();
    await openTab(page, "Validate");
    await page.locator('textarea[placeholder^="Notes: related samples"]').fill(HTML_NOTE);
    await page.waitForTimeout(1500);
    const eventsHtml = (await exportFile(page, /Download events HTML/i))?.text || "";
    const samplesHtml = (await exportFile(page, /Download samples HTML/i))?.text || "";
    check(
      eventsHtml.includes("Cascade detected") && (eventsHtml.match(/Not evaluable/g) || []).length >= 2,
      "B2.5 the crafted report holds a cascade and the two events the table cannot evaluate",
    );
    check(
      !missingIn(eventsHtml) && !missingIn(samplesHtml),
      "B2.5 and neither report prints NaN / undefined / null",
      missingIn(eventsHtml) || missingIn(samplesHtml) || "",
    );
    const intro = reportIntroduced(eventsHtml);
    check(
      intro["SRC→MISSING"] === "—" && /^\d+\.\d%$/.test(intro["A→B"] || ""),
      "B2.5 the introduced % is a percentage, and a dash for the target missing from the table",
      JSON.stringify(intro),
    );
  }, { demo: false });

  /* ---------------- B2.6 metadata entries whose row is not a row
     Every entry but the last keeps the string "abc" as its row, as a
     hand-edited session file can. The download threw ("Cannot use 'in'
     operator"), the card read "other: 0, 1, 2" and the Validate panel
     showed "0: a" pills. The session import now refuses such a file
     before anything changes (sessionFromPayload names the sample), and
     the metadata readers that met it are hardened as well (unit tests in
     tests/b2-exports-*.test.js) for sessions stored by older versions. */
  await scenario("B2.6", async (page) => {
    const metadata = parseMetadata(demo("metadata.tsv"));
    const ids = Object.keys(metadata.bySample);
    for (const id of ids.slice(0, -1)) metadata.bySample[id].extra = "abc";
    await importSession(page, sessionJSON({ metadata }));
    const body = await page.locator("body").innerText();
    check(
      /Failed to import session/i.test(body) && /annotations of \S+ are not an object/i.test(body),
      "B2.6 a session whose metadata rows are not rows is refused, naming the sample",
      (body.match(/Failed to import session[^\n]*\n?[^\n]*/i) || [""])[0].slice(0, 200),
    );
    const text = await card(page, "metadata.tsv").innerText();
    check(
      /Select file/i.test(text) && !/other: 0, 1, 2/.test(text),
      "B2.6 and nothing of it is loaded",
      text.replace(/\s+/g, " ").slice(0, 200),
    );
  }, { demo: false });

  /* The plate map card reports a missing plate column only when the
     file suggests several plates, as the Help says: a header containing
     "plate" that is not recognised, or two samples in one well. */
  await scenario("B2.6 plate warning", async (page) => {
    await upload(page, 0, "contamination_events.tsv", [
      "source\ttarget\trate\tprobability\tcontamination_specific_species",
      "S1\tS2\t0.1\t0.9\tsp_a",
    ].join("\n"));
    const warned = async (text) => {
      await upload(page, 3, "plate_map.tsv", text);
      return /No plate column was recognised/.test(await card(page, "plate_map.tsv").innerText());
    };
    check(
      !(await warned("sample_id\twell\nS1\tA01\nS2\tA02")),
      "B2.6 a one-plate map without a plate column loads without a warning",
    );
    check(
      await warned("sample_id\twell\tPlateLabel\nS1\tA01\tX\nS2\tA02\tY"),
      "B2.6 a map whose plate header is not recognised is reported on the card",
    );
    check(
      await warned("sample_id\twell\nS1\tA01\nS2\tA01"),
      "B2.6 so is one where two samples share a well",
    );
    check(
      !(await warned("sample_id\tplate\twell\nS1\tP1\tA01\nS2\tP2\tA01")),
      "B2.6 and not one whose plate column is recognised",
    );
  }, { demo: false });
} finally {
  await browser.close();
  stopServer();
}
finish();
