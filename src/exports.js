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

/** A "#" line's text, on one line. */
const flatten = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ");

/** The "#" lines in front of an events table.

    First the CroCoDeEL run's header line ("# crocodeel version: 1.2.1 |
    rf_model: … | filtering_ab_thr_factor: None | …"), rebuilt from the run
    metadata parsed out of the loaded file — the run parameters the
    Overview shows, and the low-abundance factor the diagnostics apply on
    a reload. Then the study, on its own "# study:" line: `study` (the
    session's title) or else the `study` the run metadata carries, which
    is where a reloaded curated file leaves it, since the parser merges
    every "#" line into the run metadata. Keeping it off the run line
    keeps that line as CroCoDeEL wrote it, reload after reload.

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
      notes           the event's notes, on one line.

    The run's "#" header line and the "# study:" line come first
    (eventsHeaderLines). CroCoDeEL reads the file like its own output and
    ignores the extra columns; this interface reads it back with its
    verdicts and notes (parseEvents), and still reads the files of the
    earlier layout. */
export function curatedEventsToTSV(events, { runMetadata, study, sampleCuration } = {}) {
  const lines = eventsHeaderLines(runMetadata, study);
  lines.push(CURATED_EVENT_COLUMNS.join("\t"));
  for (const e of events || []) {
    const cells = [
      ...crocodeelCells(e),
      Number.isFinite(e.introducedPct) ? e.introducedPct.toFixed(2) : "",
      e.verdict || "pending",
      // The action belongs to the target sample; the event row repeats it
      // so a tool reading this file alone can filter on it.
      sampleCuration?.[e.target]?.action || "",
      e.notes || "",
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
        the fewest significant digits, then the nearest. Two doubles can
        divide to one fraction, and nothing then tells them apart: such a
        value, written with 16 or 17 significant digits, may come back
        one unit off in its last digit.
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
  const s = String(v);
  if (!s.includes("e") && s.replace(/^-/, "").replace(".", "").length <= 17) return s;
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
    fractions under "species", as before.

    No "#" line: pandas' read_csv(sep="\t", index_col=0) and R's
    read.delim read one as a data row (pandas refuses the file, R reports
    duplicate row names). */
export function abundanceToTSV(ab) {
  if (!ab) return "";
  const input = hasInputValues(ab);
  const header = [input ? ab.firstHeader : "species", ...ab.samples];
  const sums = ab.samples.map((s) => (input ? ab.colSums[s] : 0));
  const ints = ab.samples.map((s) => input && ab.integerCols[s] === true);
  const lines = [header.map(tsvCell).join("\t")];
  for (const sp of ab.species) {
    const row = ab.matrix[sp] || {};
    const cells = [tsvCell(sp)];
    for (let j = 0; j < ab.samples.length; j++) {
      const v = row[ab.samples[j]];
      if (!Number.isFinite(v)) cells.push("0");
      else cells.push(cellNumber(input ? inputValue(v, sums[j], ints[j]) : v));
    }
    lines.push(cells.join("\t"));
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
    break the closure.) The result keeps the table's firstHeader, colSums
    and integerCols, so abundanceToTSV writes each remaining column with
    the input's own values.

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
  const lines = [`Provenance of ${file}, the curated abundance table.`, ""];
  if (study) lines.push(`Study: ${tsvCell(study)}`);
  if (curated) lines.push(`Curated: ${curated}`);
  if (build) lines.push(`Interface: CroCoDeEL Interpretation Interface, build ${build}`);
  lines.push(
    `Input table: ${plural(ab.species.length, "species row")} × ${plural(ab.samples.length, "sample")}.`,
    `This table: ${plural(cur.species.length, "species row")} × ${plural(cur.samples.length, "sample")}.`,
    "",
  );
  if (hasInputValues(cur)) {
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
    ...(cur.droppedSamples.length > 0 ? cur.droppedSamples.map(tsvCell) : ["none — every sample is kept"]),
  );
  if (cur.droppedSpecies.length > 0) {
    lines.push(
      "",
      `Species removed because only the suppressed samples hold them (${cur.droppedSpecies.length}):`,
      ...cur.droppedSpecies.map(tsvCell),
    );
  }
  return lines.join("\n") + "\n";
}
