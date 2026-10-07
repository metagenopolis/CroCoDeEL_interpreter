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
   ============================================================================ */

import { tsvCell } from "./parsing.js";

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
                      lists as introduced (empty when the target is not
                      in the abundance table);
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
      e.introducedPct == null ? "" : (e.introducedPct / 100).toFixed(4),
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
