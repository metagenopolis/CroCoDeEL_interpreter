/* ============================================================================
   CroCoDeEL Interpretation Interface — export builders
   --------------------------------------------------------------------------
   The text of the files the Export tab and the file cards write. Plain
   functions without React, so the unit tests can import every one of them
   (App.jsx is a component module, where each non-component export is a
   react-refresh/only-export-components lint problem).

   Each file must load, unchanged, in the tool it is meant for:
     - an events TSV in CroCoDeEL itself (ContaminationEventIO.read_tsv,
       crocodeel/conta_event.py) and in this interface;
     - an abundance table in CroCoDeEL (ab_table_utils.read), pandas
       (read_csv(path, sep="\t", index_col=0)) and R (read.delim), with
       their default options, holding the values of the table it came
       from.
   ============================================================================ */

import { tsvCell } from "./parsing.js";
import { resolveSample } from "./diagnostics.js";
import { isManualEvent } from "./carryOver.js";
import { isSet } from "./curation.js";

/** Text put into the HTML reports, escaped. */
export function escapeHTML(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------- contamination events ---------- */

/** The columns of CroCoDeEL's contamination_events.tsv, in its order
    (ContaminationEventIO.write_tsv). Its reader looks each one up by this
    exact name: a file that renames one is refused. */
export const CROCODEEL_EVENT_COLUMNS = [
  "source",
  "target",
  "rate",
  "probability",
  "contamination_specific_species",
];

/** The curated events TSV: CroCoDeEL's columns first, under CroCoDeEL's
    names, then what the curation adds. */
export const CURATED_EVENT_COLUMNS = [
  ...CROCODEEL_EVENT_COLUMNS,
  "introduced_pct",
  "verdict",
  "action",
  "notes",
  // Added after the columns of the first curated layout, so that a reader
  // of that layout finds them where they were.
  "sample_verdict",
  "origin",
];

/** A number written the way Python's str() writes a float, which is how
    CroCoDeEL writes the rate and the probability (`str(conta_event.rate)`).

    The digits are the shortest that read back to the same double, as
    JavaScript's own String() gives them; only the layout differs. Python
    keeps a fixed notation for decimal exponents -4..15 and always shows a
    fractional part there ("1.0", "100.0"), and otherwise switches to an
    exponent of at least two digits with its sign ("1e-05", "1.5e+16"),
    where JavaScript writes "1", "100", "0.00001" and "1.5e+16". A rate
    CroCoDeEL wrote therefore comes back as the very same text. */
export function pythonFloat(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  if (x === 0) return `${sign}0.0`;
  // "d.ddde±x": the shortest round-trip digits and the decimal exponent.
  const [mantissa, exp] = Math.abs(x).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const e = Number(exp);
  if (e < -4 || e >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  if (e < 0) return `${sign}0.${"0".repeat(-e - 1)}${digits}`;
  const whole = digits.slice(0, e + 1).padEnd(e + 1, "0");
  return `${sign}${whole}.${digits.slice(e + 1) || "0"}`;
}

/** A rate or a probability cell: Python's notation, or an empty cell for
    a value that is not a number (only a hand-edited session has one). */
const numberCell = (x) => (Number.isFinite(x) ? pythonFloat(x) : "");

/** A "#" line's text, on one line and without "|". The reader splits
    every "#" line on "|" into "key: value" pairs (parseRunMetadata), so a
    study titled "Lou 2023 | plate: 3" came back as the study "Lou 2023"
    plus a run parameter "plate: 3", which the next export appended to
    the run line. "|" is written "/" instead; CroCoDeEL's own keys and
    values never hold one. */
const flatten = (v) =>
  String(v ?? "")
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\|/g, "/");

/** The "#" lines in front of an events table.

    First the CroCoDeEL run's header line ("# crocodeel version: 1.2.1 |
    rf_model: … | filtering_ab_thr_factor: None | …"), rebuilt from the run
    metadata parsed out of the loaded file — the run parameters the
    Overview shows, and the low-abundance factor the diagnostics apply on
    a reload. Then the study, on its own "# study:" line: `study` (the
    session's title) or else the `study` the run metadata carries — the
    parser merges every "#" line into the run metadata, so a reloaded
    curated file leaves its study there, which a session without a title
    then writes back. Keeping it off the run line keeps that line as
    CroCoDeEL wrote it, reload after reload.

    Both CroCoDeEL (read_tsv skips the leading "#" lines) and this
    interface read the table under them. */
export function eventsHeaderLines(runMetadata, study) {
  const meta = runMetadata && typeof runMetadata === "object" ? runMetadata : {};
  const lines = [];
  const run = Object.entries(meta).filter(([k]) => k !== "study");
  if (run.length > 0) {
    lines.push(`# ${run.map(([k, v]) => `${flatten(k)}: ${flatten(v)}`).join(" | ")}`);
  }
  const title = study || meta.study;
  if (title) lines.push(`# study: ${tsvCell(flatten(title))}`);
  return lines;
}

/** CroCoDeEL's five cells of one event, in CROCODEEL_EVENT_COLUMNS order. */
function crocodeelCells(e) {
  return [
    e.source,
    e.target,
    numberCell(e.rate),
    numberCell(e.score),
    Array.isArray(e.introduced) ? e.introduced.join(",") : (e.species ?? ""),
  ];
}

/** The loaded events written back as CroCoDeEL writes them (the events
    card's Download): its "#" header line, its five columns, its numbers. */
export function eventsToTSV(rawEvents, runMetadata) {
  const lines = eventsHeaderLines(runMetadata);
  lines.push(CROCODEEL_EVENT_COLUMNS.join("\t"));
  for (const e of rawEvents || []) lines.push(crocodeelCells(e).map(tsvCell).join("\t"));
  return lines.join("\n");
}

/** The curated events TSV of the Export tab.

    It used to rename two of CroCoDeEL's columns (contamination_rate,
    introduced_species) and to put introduced_pct between them, so the file
    the curation produced could not go back into CroCoDeEL: read_tsv looks
    its columns up by name and failed on "rate". Now CroCoDeEL's five
    columns come first, under its names and written with its numbers, then
    the curation:

      introduced_pct  the share of the target's species that the event
                      lists as introduced, in percent (61.54, not 0.6154:
                      the unit of every other export and of the screen),
                      empty when the target is not in the abundance
                      table;
      verdict         the event's evaluation: true_positive,
                      false_positive, uncertain or pending;
      action          the target sample's keep / suppress (from
                      `sampleCuration`, empty when none);
      notes           the event's notes, on one line;
      sample_verdict  the target sample's verdict (from `sampleCuration`:
                      contaminated, correct — Not contaminated — or
                      uncertain; empty when none);
      origin          "manual" for an event the curator added by hand
                      (Explore new pairs), empty for CroCoDeEL's.

    The run's "#" header line and the "# study:" line come first
    (eventsHeaderLines). CroCoDeEL reads the file like its own output and
    ignores the extra columns; this interface reads it back with its
    verdicts, notes, target verdicts and actions and the events added by
    hand (parseEvents, replaceEvents), and still reads the files of the
    earlier layout. Without sample_verdict, a target whose verdict the
    curator set against its events (Not contaminated, Uncertain, with a
    true positive among them) came back Contaminated + Suppress, and the
    reloaded curated table lost it; without origin, an event added by
    hand came back as CroCoDeEL's, and the next rerun's carry-over
    dropped it. */
export function curatedEventsToTSV(events, { runMetadata, study, sampleCuration } = {}) {
  const lines = eventsHeaderLines(runMetadata, study);
  lines.push(CURATED_EVENT_COLUMNS.join("\t"));
  for (const e of events || []) {
    // The verdict and the action belong to the target sample; the event
    // row repeats them so a tool reading this file alone can filter on
    // them, and so that a reload gives the target back.
    const target = sampleCuration?.[e.target];
    const sampleVerdict = target?.verdict;
    const cells = [
      ...crocodeelCells(e),
      Number.isFinite(e.introducedPct) ? e.introducedPct.toFixed(2) : "",
      e.verdict || "pending",
      target?.action || "",
      e.notes || "",
      sampleVerdict && sampleVerdict !== "pending" ? sampleVerdict : "",
      isManualEvent(e) ? "manual" : "",
    ];
    lines.push(cells.map(tsvCell).join("\t"));
  }
  return lines.join("\n");
}

/* ---------- species abundance ---------- */

/** True when a parsed abundance table carries what it takes to write the
    input's own values back — parseAbundance's firstHeader, colSums and
    integerCols, a column sum and an integer flag for every sample. A
    session saved before the parser kept them has only the fractions. */
export function hasInputValues(ab) {
  if (!ab || typeof ab.firstHeader !== "string") return false;
  const sums = ab.colSums;
  const ints = ab.integerCols;
  if (!sums || typeof sums !== "object" || !ints || typeof ints !== "object") return false;
  return (ab.samples || []).every(
    (s) => Number.isFinite(sums[s]) && sums[s] >= 0 && typeof ints[s] === "boolean",
  );
}

// The two 32-bit halves of a double, to step to its neighbours.
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const LOW = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 0 : 1;
const HIGH = 1 - LOW;

/** The double next to a positive finite `x`, upwards (dir 1) or
    downwards (dir -1). */
function nextDouble(x, dir) {
  f64[0] = x;
  if (dir > 0) {
    if (u32[LOW] === 0xffffffff) {
      u32[LOW] = 0;
      u32[HIGH] += 1;
    } else u32[LOW] += 1;
  } else if (u32[LOW] === 0) {
    u32[LOW] = 0xffffffff;
    u32[HIGH] -= 1;
  } else u32[LOW] -= 1;
  return f64[0];
}

/** Significant digits of the shortest decimal that reads back as `x`. */
const significantDigits = (x) => x.toExponential().split("e")[0].replace(".", "").length;

/** The value the input table held, from the parser's fraction of it
    (`fraction` = value / colSum, rounded once) and its column's sum.

    fraction × colSum is the value up to the last bit or two, which is
    enough to print 0.30000000000000004 for a 0.3: so the product is
    turned back into the input's value, not printed as is.
      - A column of integers (counts): the nearest integer, exactly.
      - A value written with at most 15 significant digits (R writes 15,
        MetaPhlAn and sylph far fewer) is the product rounded to 15
        digits, exactly: the product is within 4e-16 of it (relative),
        and two 15-digit decimals are at least 1e-15 apart.
      - Otherwise the value is one of the doubles a few steps from the
        product that divide back to the very same fraction: the one with
        the fewest significant digits, then the nearest. A value written
        with 16 or 17 significant digits, more than a double holds, comes
        back as the same double, perhaps in fewer digits
        (0.099030000000000007 is the double of 0.09903, and is written
        so); or, when the double next to it divides to the same fraction
        and nothing tells the two apart, as that neighbour: a relative
        difference of about 2e-16, which can change the last one or two
        digits (8.5807690018676415e-09 comes back as
        8.58076900186764e-9). Over the bundled tables, 582 of the 10,058
        values written with 16 or 17 digits come back one double off
        (relative difference at most 2.02e-16), none further.
    A cell the parser read as 0 (empty, NA, not a number, negative) is 0. */
export function inputValue(fraction, colSum, integer) {
  if (!(fraction > 0) || !(colSum > 0)) return 0;
  const x = fraction * colSum;
  if (integer) return Math.round(x);
  const y = Number(x.toPrecision(15));
  if (y / colSum === fraction) return y;
  let best = x;
  let bestDigits = Infinity;
  let bestSteps = Infinity;
  let c = x;
  for (let k = 0; k < 4; k++) c = nextDouble(c, -1);
  for (let k = -4; k <= 4; k++, c = nextDouble(c, 1)) {
    if (c / colSum !== fraction) continue;
    const digits = significantDigits(c);
    const steps = Math.abs(k);
    if (digits < bestDigits || (digits === bestDigits && steps < bestSteps)) {
      best = c;
      bestDigits = digits;
      bestSteps = steps;
    }
  }
  return best;
}

/** A number for an abundance cell: the shortest digits that read back to
    it (String()), in fixed notation when that takes at most 17 digits and
    in exponent notation otherwise. pandas' default float reader keeps 17
    digits, the zeros after the point included: written by String() as
    0.0000010630384344999, a value read back 1e-10 off in pandas (exactly
    in R and in Python's float()); as 1.0630384344999e-6 it reads back to
    its last digit everywhere. */
function cellNumber(v) {
  // An integer below 1e17 has at most 17 digits, all of them in String's
  // fixed notation: no need to look (a count table is all integers).
  if (Number.isInteger(v) && v < 1e17 && v > -1e17) return String(v);
  const s = String(v);
  if (s.indexOf("e") < 0) {
    // The digits: the text without its sign and its point.
    const digits = s.length - (s.charCodeAt(0) === 45 ? 1 : 0) - (s.indexOf(".") >= 0 ? 1 : 0);
    if (digits <= 17) return s;
  }
  return v.toExponential();
}

/** An abundance table as TSV: the species in the table's order, then one
    column per sample.

    The parser keeps fractions of each sample's total (every diagnostic
    works on those), and this used to write them as they were, under a
    "species" header: a count table of 1500 / 500 came back as 0.75 /
    0.25, its first header ("id_mgs", "clade_name") renamed. With the
    parser's column sums (hasInputValues) each value is the input's own
    again (inputValue): counts stay integers, percentages stay
    percentages, and the first header is the input's. A table saved
    without them — a session of an earlier version — is written as
    fractions under "species", as before. A header that had no cell above
    the species (implicitIndex: R's write.table) is written without one
    again, which pandas, R and CroCoDeEL read as the input was read.

    No "#" line: pandas' read_csv(sep="\t", index_col=0) and R's
    read.delim read one as a data row (pandas refuses the file, R reports
    duplicate row names).

    Only the samples and species `ab` lists are written, so `ab.matrix`
    may hold more: the curated table is written from the input's own rows
    (buildCuratedAbundance's `matrix: false`), without a copy of them.
    Writing the input's values made the Meteor benchmark's export take
    0.46 s instead of 0.24 s; a zero, a count and a value written with up
    to 15 digits now take the short paths of inputValue and cellNumber. */
export function abundanceToTSV(ab) {
  if (!ab) return "";
  const input = hasInputValues(ab);
  const header =
    input && ab.implicitIndex === true
      ? [...ab.samples]
      : [input ? ab.firstHeader : "species", ...ab.samples];
  const samples = ab.samples;
  const sums = samples.map((s) => (input ? ab.colSums[s] : 0));
  const ints = samples.map((s) => input && ab.integerCols[s] === true);
  const lines = [header.map(tsvCell).join("\t")];
  for (const sp of ab.species) {
    const row = ab.matrix[sp] || {};
    let line = tsvCell(sp);
    for (let j = 0; j < samples.length; j++) {
      const v = row[samples[j]];
      // A fraction is ≥ 0: a zero, an empty cell of a sparse row, or a
      // value that is not a number is a 0.
      if (!(v > 0)) line += "\t0";
      else if (!input) line += `\t${cellNumber(v)}`;
      else if (ints[j]) line += `\t${cellNumber(Math.round(v * sums[j]))}`;
      else line += `\t${cellNumber(inputValue(v, sums[j], false))}`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Apply the sample-level curation to the abundance table.

    Samples the curator flagged `suppress` are removed entirely — that is
    what the action means: the sample carries too much contamination to be
    usable. Everything else passes through untouched, including samples
    flagged `keep` and samples never reviewed.

    No renormalisation happens, and none is needed: in a relative-abundance
    table each column is closed independently, so removing a whole column
    leaves every other column summing to exactly what it did before. (This
    is the opposite of subtracting contamination WITHIN a column, which does
    break the closure.) The result keeps the table's firstHeader,
    implicitIndex, colSums and integerCols, so abundanceToTSV writes each
    remaining column with the input's own values, under its header.

    `dropEmptySpecies` additionally removes the species observed only in
    the suppressed samples — rows the suppression leaves at zero
    everywhere. Off by default would keep the row count comparable with the
    input; on by default keeps the output clean. Both are defensible, so it
    is exposed to the user rather than decided here. A row already at zero
    in every sample of the input stays: it used to go too, so a Meteor
    table of 1,990 catalogue species lost its 1,078 empty rows with nothing
    suppressed at all, while the card counted them as "observed only in
    the suppressed samples". */
export function buildCuratedAbundance(ab, sampleCuration, opts = {}) {
  if (!ab) return null;
  const dropEmptySpecies = opts.dropEmptySpecies ?? true;

  // Curation is keyed by the sample names that appear in the events file;
  // map them onto the abundance table's own keys the way every other join
  // in this file does, so a case or whitespace difference does not silently
  // fail to suppress a sample.
  const suppressed = new Set();
  if (sampleCuration) {
    for (const name of Object.keys(sampleCuration)) {
      if (sampleCuration[name]?.action !== "suppress") continue;
      const key = resolveSample(ab, name);
      if (key) suppressed.add(key);
    }
  }

  const samples = ab.samples.filter((s) => !suppressed.has(s));
  const droppedSamples = ab.samples.filter((s) => suppressed.has(s));

  let species = ab.species;
  const droppedSpecies = [];
  if (dropEmptySpecies && droppedSamples.length > 0) {
    const kept = [];
    const held = (row, list) => list.some((s) => (row[s] || 0) > 0);
    for (const sp of ab.species) {
      const row = ab.matrix[sp] || {};
      // The suppressed samples first: there are few, and a species none
      // of them holds stays without looking any further.
      if (held(row, droppedSamples) && !held(row, samples)) droppedSpecies.push(sp);
      else kept.push(sp);
    }
    species = kept;
  }

  // `matrix: false` skips the table itself, for a caller that only counts
  // (the Export card, recomputed on every curation change).
  let matrix = null;
  if (opts.matrix !== false) {
    matrix = {};
    for (const sp of species) {
      const row = {};
      for (const s of samples) row[s] = ab.matrix[sp]?.[s] ?? 0;
      matrix[sp] = row;
    }
  }

  return {
    samples,
    species,
    matrix,
    logRange: ab.logRange,
    droppedSamples,
    droppedSpecies,
    firstHeader: ab.firstHeader,
    implicitIndex: ab.implicitIndex,
    colSums: ab.colSums,
    integerCols: ab.integerCols,
  };
}

/** The provenance of a curated abundance table, as a text file to keep
    next to it: which samples were suppressed, which species went with
    them, when, for which study, and what the values are.

    It used to be "#" lines at the top of the table. CroCoDeEL reads those
    (read_csv(comment="#")), but pandas' and R's default readers do not, so
    the table itself now holds the data only and this goes to its own file.
    `cur` is buildCuratedAbundance's result for `ab`; `opts` gives the
    `study` title, the `curated` date, the interface `build` and the
    table's `file` name. */
export function curatedAbundanceProvenance(ab, cur, opts = {}) {
  const { study, curated, build, file = "species_abundance_curated.tsv" } = opts;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  // A plain text file: each value on one line, as written. tsvCell's
  // quoting (a quote doubled, the value wrapped in quotes) is for a TSV
  // reader; here it wrote the study '"Lou" 2023' as '"""Lou"" 2023"'.
  const oneLine = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ");
  const lines = [`Provenance of ${file}, the curated abundance table.`, ""];
  if (study) lines.push(`Study: ${oneLine(study)}`);
  if (curated) lines.push(`Curated: ${curated}`);
  if (build) lines.push(`Interface: CroCoDeEL Interpretation Interface, build ${build}`);
  lines.push(
    `Input table: ${plural(ab.species.length, "species row")} × ${plural(ab.samples.length, "sample")}.`,
    `This table: ${plural(cur.species.length, "species row")} × ${plural(cur.samples.length, "sample")}.`,
    "",
  );
  if (hasInputValues(cur) && cur.implicitIndex === true) {
    lines.push(
      "Values: each remaining column holds the input table's own values (counts stay",
      "integers), under a header without a cell above the species, as the input's",
      "(R's write.table layout), and with the species in its order. Cells the",
      "interface read as 0 (empty, NA, not a number, negative) are 0.",
    );
  } else if (hasInputValues(cur)) {
    lines.push(
      "Values: each remaining column holds the input table's own values (counts stay",
      `integers), under its first header ("${cur.firstHeader}") and with the species in its`,
      "order. Cells the interface read as 0 (empty, NA, not a number, negative) are 0.",
    );
  } else {
    lines.push(
      "Values: relative abundances, each sample's fraction of its own total, under a",
      '"species" header. The session was saved before the interface kept the input',
      "table's column totals: load the abundance table again to export its own values.",
    );
  }
  lines.push(
    "No column was renormalised: removing a sample does not change any other one.",
    "",
    `Suppressed samples (${cur.droppedSamples.length}), removed because their action is Suppress:`,
    ...(cur.droppedSamples.length > 0 ? cur.droppedSamples.map(oneLine) : ["none — every sample is kept"]),
  );
  if (cur.droppedSpecies.length > 0) {
    lines.push(
      "",
      `Species removed because only the suppressed samples hold them (${cur.droppedSpecies.length}):`,
      ...cur.droppedSpecies.map(oneLine),
    );
  }
  return lines.join("\n") + "\n";
}

/* ---------- HTML reports ---------- */

/** The labels of the filter bar, by value. */
const EVENT_VERDICT_LABELS = {
  pending: "pending",
  true_positive: "true positive",
  false_positive: "false positive",
  uncertain: "uncertain",
};
const SAMPLE_VERDICT_LABELS = {
  pending: "pending",
  contaminated: "contaminated",
  correct: "not contaminated",
  uncertain: "uncertain",
};

/** The events HTML report's "Filter applied" line: one part for each
    field of the Export tab's filter that differs from its default, so
    the reader knows which subset the report covers, every value escaped
    (a session file can hold any text); null when none does.

    It used to leave out the sample-verdict filter, the sample scope (a
    Network drill-in) and the target-action filter: a report of the 8
    events whose target is Contaminated, or of the 4 events of one
    sample, said nothing of how they were chosen, only "Events in report
    8" next to "Total events loaded 24". */
export function reportFilterSummary(filter) {
  if (!filter || typeof filter !== "object") return null;
  const parts = [];
  const list = (values, labels) =>
    values.length > 0 ? values.map((v) => escapeHTML(labels[v] || v)).join(", ") : "none";
  const sideOf = (side) => (side === "source" || side === "target" ? side : null);
  if (typeof filter.q === "string" && filter.q.trim()) {
    parts.push(`search: "${escapeHTML(filter.q.trim())}"`);
  }
  const above = (v) => Number.isFinite(v) && v > 0;
  if (above(filter.minScore)) parts.push(`probability ≥ ${filter.minScore.toFixed(2)}`);
  if (above(filter.minRate)) parts.push(`rate ≥ ${(filter.minRate * 100).toFixed(2)}%`);
  if (above(filter.minIntroduced)) parts.push(`introduced ≥ ${filter.minIntroduced.toFixed(0)}%`);
  if (Array.isArray(filter.verdicts) && filter.verdicts.length < Object.keys(EVENT_VERDICT_LABELS).length) {
    parts.push(`verdict: ${list(filter.verdicts, EVENT_VERDICT_LABELS)}`);
  }
  if (
    Array.isArray(filter.sampleVerdicts) &&
    filter.sampleVerdicts.length < Object.keys(SAMPLE_VERDICT_LABELS).length
  ) {
    const side = sideOf(filter.sampleVerdictsSide);
    parts.push(
      `${side ? `${side} sample` : "source or target sample"} verdict: ` +
        list(filter.sampleVerdicts, SAMPLE_VERDICT_LABELS),
    );
  }
  if (Array.isArray(filter.scopeSamples) && filter.scopeSamples.length > 0) {
    const ids = filter.scopeSamples;
    const side = sideOf(filter.scopeSide);
    const shown = ids.slice(0, 5).map(escapeHTML).join(", ");
    const more = ids.length > 5 ? ` and ${ids.length - 5} more` : "";
    parts.push(
      `${side ? `${side} sample` : "source or target sample"}${ids.length > 1 ? "s" : ""} ` +
        `${shown}${more}`,
    );
  }
  if (filter.action === "keep" || filter.action === "suppress") {
    parts.push(`target action: ${filter.action}`);
  }
  if (filter.subject && filter.subject !== "any") parts.push(`subject: ${escapeHTML(filter.subject)}`);
  if (filter.group && filter.group !== "any") parts.push(`group: ${escapeHTML(filter.group)}`);
  if (filter.adjacent && filter.adjacent !== "any") parts.push(`plate: ${escapeHTML(filter.adjacent)}`);
  return parts.length ? parts.join(" · ") : null;
}

/* ---------- samples ---------- */

/** The samples of the samples TSV and its HTML report, one row each: the
    samples of the events and the abundance table's. A name the table
    holds under another spelling (case, whitespace: resolveSample, the
    matching the curated export makes) is that table sample, under the
    table's spelling: the events file's "s2" and the table's "S2" used to
    be two rows, the second reading Not contaminated + Keep while the
    curated table dropped the sample. Returns { ids, rowOf, names }: the
    row ids, sorted; the row of a name; the names of a row (its own
    first). */
export function samplesReportIndex(events, ab) {
  const rowOf = (name) => (ab ? resolveSample(ab, name) : null) || name;
  const names = new Map();
  const add = (name) => {
    if (!name) return;
    const id = rowOf(name);
    if (!names.has(id)) names.set(id, new Set([id]));
    names.get(id).add(name);
  };
  for (const e of events || []) {
    add(e?.source);
    add(e?.target);
  }
  for (const s of ab?.samples || []) add(s);
  return {
    ids: [...names.keys()].sort((a, b) => a.localeCompare(b)),
    rowOf,
    names: (id) => [...(names.get(id) || [id])],
  };
}

/** The curation a row of the samples TSV and report shows (`curation`:
    the effective one) for a sample written under several `names`: a
    Suppress wins, as the curated table drops the column whichever name
    says so; then a verdict, the curator's before the rule's; then
    whatever entry there is. The notes of every name are kept. */
export function samplesReportCuration(curation, names) {
  const entries = names.map((n) => curation?.[n]).filter(Boolean);
  if (entries.length <= 1) return entries[0] || {};
  const pick =
    entries.find((c) => c.action === "suppress") ||
    entries.find((c) => isSet(c.verdict) && !c.verdictAuto) ||
    entries.find((c) => isSet(c.verdict)) ||
    entries[0];
  const notes = [...new Set(entries.map((c) => c.notes).filter(Boolean))].join("\n\n");
  return notes ? { ...pick, notes } : pick;
}

/** The samples TSV's is_control, is_low_biomass and is_low_sequencing_depth
    cells of one sample: "true", "false", or empty when the metadata does
    not say — no metadata, no row for the sample, no column for the flag,
    or a cell left empty (a control is read from the biome cell). They
    used to read "false" in all of these cases, a negative nobody gave:
    with no metadata loaded, every sample of the TSV was "not a control,
    not low biomass". `entry` is the sample's metadata entry
    (parseMetadata), `metadata` the whole metadata (its column flags). */
export function sampleFlagCells(entry, metadata) {
  if (!entry || typeof entry !== "object") return ["", "", ""];
  const flag = (v) => (v === true ? "true" : v === false ? "false" : "");
  const biome = !!(metadata?.hasBiomeCol || metadata?.cols?.biome) && !!entry.biome;
  return [
    entry.isControl === true ? "true" : biome ? "false" : "",
    flag(entry.lowBiomassExplicit),
    flag(entry.lowSequencingDepthExplicit),
  ];
}

/** The samples TSV's max_target_rate cell: the rate in CroCoDeEL's own
    notation, every digit kept, as the events TSV writes it (pythonFloat).
    toFixed(6) wrote a rate below 5e-7 as 0.000000 and cut the others to
    six decimals. Empty when the sample is no event's target. */
export const rateCell = (x) => (x == null ? "" : numberCell(x));

/** The values buildEffectiveSampleCuration gives a sample no event
    targets: Not contaminated, and the Keep that goes with it. */
const DEFAULT_VALUE = { verdict: "correct", action: "keep" };

/** Where a sample's verdict or action (`field`) comes from, as the samples
    TSV writes it next to the value:
      manual     the curator set it;
      automatic  the rule set it (src/curation.js): a verdict from the
                 evaluations of the events that target the sample, or
                 the Suppress that goes with a Contaminated verdict —
                 also with one the curator set on a sample no event
                 targets;
      default    the Not contaminated + Keep of a sample no event targets
                 (buildEffectiveSampleCuration), which is not a decision;
      ""         no value.
    `entry` is the sample's effective curation; `targeted` says whether an
    event targets it. On a sample no event targets, an automatic value is
    the default only when it is that very value: the Suppress paired with
    a Contaminated set by hand is the rule's, and the curated table drops
    the sample. The samples HTML report tags the same values "auto" and
    "default", the Samples tab marks both "auto". The TSV used to write
    the three kinds alike, so a never-reviewed sample read as a curated
    Keep. */
export function curationOrigin(entry, field, targeted) {
  const value = entry?.[field];
  if (value == null || value === "" || value === "pending") return "";
  if (!entry[`${field}Auto`]) return "manual";
  return !targeted && value === DEFAULT_VALUE[field] ? "default" : "automatic";
}
