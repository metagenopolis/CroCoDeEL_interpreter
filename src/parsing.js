/* ============================================================================
   CroCoDeEL Interpretation Interface — input-file parsers
   --------------------------------------------------------------------------
   Reading the four TSV inputs (contamination events, species abundance,
   sample metadata, plate map) and writing the metadata and plate map back.
   Plain functions without React, so the unit tests can import every one of
   them: App.jsx is a component module, where each non-component export is
   a react-refresh/only-export-components lint problem.
   ============================================================================ */

/** Strip a single layer of CSV/TSV-style surrounding double quotes from a
    cell. Some upstream tools (notably R's write.table and Meteor's MSP
    profiles) wrap every string cell in `"..."`; without unquoting, the
    species name `"msp_0001"` parsed from the abundance file would never
    match the bare `msp_0001` listed in contamination_events.tsv. */
function unquoteCell(s) {
  if (typeof s !== "string") return s;
  if (s.length >= 2 && s.charCodeAt(0) === 34 && s.charCodeAt(s.length - 1) === 34) {
    return s.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}

/** Flatten a value into a single TSV cell.

    Both curated exports used to strip only `\t` from free-text fields while
    stripping `[\t\n\r]` from the study title. Curator notes are multi-line
    textareas AND the bulk-apply actions prepend `${tag}\n\n${notes}`
    themselves, so one event could emit three physical lines — enough to
    make `pandas.read_csv(sep='\t')` either raise or invent rows. Every
    field of every writer goes through here. */
export function tsvCell(v) {
  return String(v ?? "").replace(/[\t\r\n]+/g, " ");
}

/** Split a TSV text into its header cells, its rows (objects keyed by
    header cell) and the `#` lines before the header. `lineNumbers[i]` is
    the 1-based file line of `rows[i]`, so a message can point the user at
    the cell to fix. */
export function parseTSV(text) {
  const allLines = text.replace(/\r/g, "").split("\n");
  // Separate hash-prefixed header lines (e.g. CroCoDeEL run params) from data
  const headerComments = [];
  let header = null;
  const rows = [];
  const lineNumbers = [];
  for (let n = 0; n < allLines.length; n++) {
    const line = allLines[n];
    // Blank lines carry no record, and neither do lines of spaces or tabs
    // only — what a spreadsheet leaves of a cleared row, which used to
    // become an event with an empty source or a sample named "  ".
    if (!/\S/.test(line)) continue;
    if (header === null) {
      if (line.startsWith("#")) {
        headerComments.push(line.replace(/^#\s*/, ""));
      } else {
        header = line.split("\t").map(unquoteCell);
        // Trailing tabs on the header line (cleared trailing columns) made
        // phantom "" columns: an empty sample in the abundance table, a ""
        // key in every metadata row. Drop the empty trailing header cells;
        // the row cells under them are then ignored like any cell past
        // the last column.
        while (header.length > 0 && header[header.length - 1].trim() === "") {
          header.pop();
        }
      }
      continue;
    }
    const cells = line.split("\t");
    const obj = {};
    header.forEach((h, i) => (obj[h] = unquoteCell(cells[i] ?? "")));
    rows.push(obj);
    lineNumbers.push(n + 1);
  }
  return { header: header || [], rows, headerComments, lineNumbers };
}

/** Parse a CroCoDeEL-style "key: value | key: value | ..." metadata header. */
function parseRunMetadata(headerComments) {
  if (!headerComments || headerComments.length === 0) return null;
  const meta = {};
  headerComments.forEach((line) => {
    line.split("|").forEach((kv) => {
      const idx = kv.indexOf(":");
      if (idx < 0) return;
      const key = kv.slice(0, idx).trim();
      const val = kv.slice(idx + 1).trim();
      if (key) meta[key] = val;
    });
  });
  return Object.keys(meta).length > 0 ? meta : null;
}

function pickCol(header, candidates) {
  const lc = header.map((h) => h.toLowerCase());
  for (const c of candidates) {
    const i = lc.indexOf(c.toLowerCase());
    if (i >= 0) return header[i];
  }
  for (const c of candidates) {
    const i = lc.findIndex((h) => h.includes(c.toLowerCase()));
    if (i >= 0) return header[i];
  }
  return null;
}

/* ---------- numeric cells ----------
   parseFloat reads the longest numeric PREFIX of a cell, so a table saved
   by a French-locale spreadsheet loaded without a word: "7,41E-01" read as
   7, "0,87" as 0, "1,23E-05" as 1. Every number of the input files is read
   here instead, and the whole cell has to be a number. */

/** Cells that mean "no value", compared trimmed and lower-cased. */
const NA_TOKENS = new Set(["", "na", "n/a", "nan", "null", "none", "-", "#n/a"]);

/** Read one numeric cell strictly. Returns the number; `null` when the
    cell is empty or an NA token (NA, N/A, NaN, null, None, -, #N/A, in any
    case); `NaN` when it holds anything else — "0,87", "12 %", "0x1F",
    "Infinity".

    Number() does the reading, not a regex per cell: an abundance table is
    millions of cells. Number() already trims and refuses trailing text,
    but it also accepts what a decimal number is not, which the guards
    below reject: "" and blanks (read as 0), the 0x / 0o / 0b integer
    literals, and ±Infinity, spelled out or overflowing from an exponent. */
export function parseStrictNumber(cell) {
  if (cell == null) return null;
  const s = typeof cell === "string" ? cell : String(cell);
  const v = Number(s);
  if (Number.isFinite(v)) {
    const c0 = s.charCodeAt(0);
    // 1-9 first: only a decimal number gets past Number() from there.
    if (c0 >= 49 && c0 <= 57) return v;
    if (c0 === 48) {
      // "0x1F", "0o17", "0b101" (the prefix letter lower-cased by | 32)
      const x = s.charCodeAt(1) | 32;
      return x === 120 || x === 111 || x === 98 ? NaN : v;
    }
    // A sign or a dot cannot start a non-decimal literal: "-0x1F" is NaN.
    if (c0 === 43 || c0 === 45 || c0 === 46) return v;
    // Blank, or blanks around a number: judge the trimmed cell.
    const t = s.trim();
    return t === "" ? null : parseStrictNumber(t);
  }
  return NA_TOKENS.has(s.trim().toLowerCase()) ? null : NaN;
}

/** True when a cell refused by parseStrictNumber reads as a number once its
    one comma becomes a dot: "0,87", "7,41E-01", "-1,5". */
function looksLikeDecimalComma(cell) {
  const s = String(cell ?? "").trim();
  const i = s.indexOf(",");
  if (i < 0 || s.indexOf(",", i + 1) >= 0) return false;
  return Number.isFinite(parseStrictNumber(s.slice(0, i) + "." + s.slice(i + 1)));
}

/* ---------- contamination_events.tsv ---------- */
const EVENT_COLS = {
  source: ["source", "contamination_source", "source_sample"],
  target: ["target", "contaminated_sample", "target_sample", "contaminated"],
  rate: ["rate", "contamination_rate", "estimated_rate"],
  // Canonical column is `probability`. Older CroCoDeEL outputs write the
  // model's probability into a column named `score` instead — accept it
  // as a fallback alias. The value is shown as "probability" in the UI.
  score: ["probability", "score", "rf_score", "proba"],
  species: [
    "contamination_specific_species",
    "introduced_species",
    "species_specifically_introduced",
    "species",
  ],
};

/** Split the introduced-species cell into taxon names.

    The separator is `,`. `;` used to be accepted as an alternative, but it
    is ALSO the rank separator inside GTDB/SILVA-style lineages
    (`d__Bacteria;p__Bacteroidota;...;s__Phocaeicola vulgatus`), and
    splitting on it shreds every name into fragments that match nothing in
    the abundance table — silently, since a shredded event simply ends up
    with zero on-line points. So: split on `,` when the cell has one, and
    only fall back to `;` for a cell that has neither a comma nor the
    `x__` rank prefixes that mark a lineage. */
export function splitSpeciesList(cell) {
  const s = String(cell ?? "").trim();
  if (!s) return [];
  const isLineage = /[a-z]__/i.test(s);
  const sep = s.includes(",") || isLineage ? /,\s*/ : /;\s*/;
  return s
    .split(sep)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/** The rate or the probability of one events row, read strictly from the
    first of `keys` whose cell holds a value: `value` is null when none
    does (empty or NA everywhere), NaN when that cell is not a number, and
    `key` names the column it came from. */
function eventNumber(raw, keys) {
  for (const key of keys) {
    if (!key) continue;
    const value = parseStrictNumber(raw[key]);
    if (value !== null) return { value, key };
  }
  return { value: null, key: null };
}

function normalizeEvent(raw, cols, idx, rate, score) {
  const species = splitSpeciesList(raw[cols.species]);
  return {
    id: idx,
    source: raw[cols.source] || "",
    target: raw[cols.target] || "",
    // A missing rate or probability reads as 0, as it always has.
    rate: rate ?? 0,
    score: score ?? 0,
    introduced: species,
    verdict: "pending",
    notes: "",
  };
}

export function parseEvents(text) {
  const { header, rows, headerComments, lineNumbers } = parseTSV(text);
  if (rows.length === 0) throw new Error("Empty file or no rows");
  const cols = {
    source: pickCol(header, EVENT_COLS.source),
    target: pickCol(header, EVENT_COLS.target),
    rate: pickCol(header, EVENT_COLS.rate),
    score: pickCol(header, EVENT_COLS.score),
    species: pickCol(header, EVENT_COLS.species),
  };
  if (!cols.source || !cols.target) {
    throw new Error(
      "Could not find source/target columns. Expected headers like 'source' and 'target' (or 'contaminated_sample').",
    );
  }
  // A missing rate column is not fatal — source/target alone still make a
  // browsable event list — but every rate silently becomes 0, which means
  // no contamination line is drawn and several diagnostics quietly go
  // uninformative. Say so rather than letting the user wonder.
  const warnings = [];
  if (!cols.rate) {
    warnings.push(
      "No contamination-rate column found (expected 'rate' or 'contamination_rate'). " +
        "Every rate reads as 0, so no contamination line can be drawn.",
    );
  }
  if (!cols.species) {
    warnings.push(
      "No introduced-species column found (expected 'contamination_specific_species'). " +
        "Scatterplots will show no highlighted species.",
    );
  }

  // Rates and probabilities are read strictly (see parseStrictNumber). One
  // that is present but is not a number fails the whole file, as it fails
  // CroCoDeEL: read leniently, a file whose decimal separator is a comma
  // loaded with every rate at 7 or 0 and no warning at all.
  const invalid = [];
  const rateOutOfRange = [];
  const probOutOfRange = [];
  // A row without a source or a target is not an event (a stray note, a
  // half-cleared row): skip it, counted, before reading its numbers.
  const skipped = [];
  const events = [];
  rows.forEach((r, i) => {
    if (!String(r[cols.source] ?? "").trim() || !String(r[cols.target] ?? "").trim()) {
      skipped.push(i);
      return;
    }
    const rate = eventNumber(r, [cols.rate]);
    // Probability resolution: prefer the column pickCol actually resolved in
    // this file's header (which matches case-insensitively), then fall back
    // to the literal aliases for files that carry several score columns and
    // leave the canonical one empty (or NA) on some rows.
    const prob = eventNumber(r, [cols.score, ...EVENT_COLS.score]);
    for (const n of [rate, prob]) {
      if (Number.isNaN(n.value)) invalid.push({ i, key: n.key });
    }
    if (rate.value !== null && !(rate.value > 0 && rate.value <= 1)) {
      rateOutOfRange.push({ i, value: rate.value });
    }
    if (prob.value !== null && !(prob.value >= 0 && prob.value <= 1)) {
      probOutOfRange.push({ i, value: prob.value });
    }
    events.push(normalizeEvent(r, cols, events.length, rate.value, prob.value));
  });
  if (events.length === 0) {
    throw new Error("No events: no row has both a source and a target.");
  }
  if (skipped.length > 0) {
    const n = skipped.length;
    warnings.push(
      `${n} row${n > 1 ? "s" : ""} with an empty source or target ${n > 1 ? "were" : "was"} ` +
        `skipped (first on line ${lineNumbers[skipped[0]]}).`,
    );
  }
  if (invalid.length > 0) {
    const { i, key } = invalid[0];
    const cell = String(rows[i][key]).trim();
    const more = invalid.length - 1;
    throw new Error(
      `Row ${i + 1} (line ${lineNumbers[i]}), column "${key}": "${cell}" is not a number` +
        (looksLikeDecimalComma(cell)
          ? " — looks like a decimal comma — re-export the file with '.' as decimal separator"
          : "") +
        "." +
        (more > 0
          ? ` ${more} more rate / probability cell${more > 1 ? "s are" : " is"} not a number either.`
          : ""),
    );
  }
  // Out of range is suspicious rather than unreadable: keep the value as
  // read, and say how many and where the first one is.
  const rangeWarning = (list, what, range) => {
    if (list.length === 0) return;
    const { i, value } = list[0];
    warnings.push(
      `${list.length} event${list.length > 1 ? "s have" : " has"} a ${what} outside ${range}` +
        ` — first on line ${lineNumbers[i]} (${rows[i][cols.source]} → ${rows[i][cols.target]}): ${value}.`,
    );
  };
  rangeWarning(rateOutOfRange, "rate", "(0, 1]");
  rangeWarning(probOutOfRange, "probability", "[0, 1]");

  return {
    events,
    runMetadata: parseRunMetadata(headerComments),
    warnings,
  };
}

/* ---------- species_abundance.tsv ---------- */

/** Report the first repeated entry in a list, or null. Duplicates are a
    silent-corruption hazard here: parseTSV keys rows by header name, so a
    repeated sample column makes two samples share one profile, and a
    repeated species row makes the last one win while the lost row's counts
    still leave the column total alone — which the renormalisation below
    then spreads over every OTHER species. */
function firstDuplicate(names) {
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) return n;
    seen.add(n);
  }
  return null;
}

export function parseAbundance(text) {
  const { header, rows } = parseTSV(text);
  if (header.length < 2) return null;
  const speciesCol = header[0];
  const samples = header.slice(1);

  const dupSample = firstDuplicate(samples);
  if (dupSample) {
    throw new Error(
      `Duplicate sample column "${dupSample}" in the abundance table. ` +
        `Each sample must appear exactly once — merge or rename the columns and reload.`,
    );
  }
  const speciesNames = rows.map((r) => r[speciesCol]).filter(Boolean);
  const dupSpecies = firstDuplicate(speciesNames);
  if (dupSpecies) {
    throw new Error(
      `Duplicate species row "${dupSpecies}" in the abundance table. ` +
        `Each species must appear exactly once — aggregate the rows and reload.`,
    );
  }

  // Cells are read strictly (see parseStrictNumber). Empty and NA cells are
  // a legitimate absence and read as 0 silently. A cell that is not a
  // number, or is negative, also reads as 0 but is counted, with the first
  // one kept as an example for the warning.
  const matrix = {};
  let nonNumericCells = 0;
  let commaCells = 0;
  let negativeCells = 0;
  let firstNonNumeric = null;
  let firstComma = null;
  let firstNegative = null;
  rows.forEach((r) => {
    const sp = r[speciesCol];
    if (!sp) return;
    const row = {};
    for (let j = 0; j < samples.length; j++) {
      const s = samples[j];
      const raw = r[s];
      let v = parseStrictNumber(raw);
      if (v === null) {
        v = 0;
      } else if (Number.isNaN(v)) {
        nonNumericCells++;
        if (!firstNonNumeric) firstNonNumeric = { cell: raw, sp, s };
        if (looksLikeDecimalComma(raw)) {
          commaCells++;
          if (!firstComma) firstComma = raw;
        }
        v = 0;
      } else if (v < 0) {
        negativeCells++;
        if (!firstNegative) firstNegative = { cell: raw, sp, s };
        v = 0;
      }
      row[s] = v;
    }
    matrix[sp] = row;
  });

  // Hoisted once: this used to rebuild Object.keys(matrix) twice per
  // sample, which on a 2000 x 1000 table is the bulk of the parse time.
  const speciesKeys = Object.keys(matrix);

  // normalize to relative abundances per sample, and collect the log10
  // extremes in the same pass
  let minVal = Infinity;
  let maxVal = -Infinity;
  let emptySamples = 0;
  samples.forEach((s) => {
    let total = 0;
    for (const sp of speciesKeys) total += matrix[sp][s] || 0;
    if (total > 0) {
      for (const sp of speciesKeys) {
        const v = (matrix[sp][s] || 0) / total;
        matrix[sp][s] = v;
        if (v > 0) {
          if (v < minVal) minVal = v;
          if (v > maxVal) maxVal = v;
        }
      }
    } else {
      emptySamples++;
    }
  });

  // Per-dataset log10 range, computed from non-zero relative abundances.
  // Used as the axis bounds for every scatterplot in this dataset (gallery
  // thumbnails AND the big validation/explore plots) so events are
  // visually comparable and the points aren't squashed into a corner.
  const logRange =
    Number.isFinite(minVal) && Number.isFinite(maxVal)
      ? {
          min: Math.floor(Math.log10(minVal)),
          // Clamp upper bound at 0: relative abundances are bounded by 1.
          max: Math.min(0, Math.ceil(Math.log10(maxVal))),
        }
      : { min: -8, max: 0 };

  // Non-numeric cells are coerced to 0 by design (NA / empty are legitimate
  // in these tables). But a table whose decimal separator is a comma parses
  // "successfully" into a near-empty matrix with the right species and
  // sample counts and blank plots everywhere, so surface the tally instead
  // of failing silently — and say when the cells look like decimal commas.
  const warnings = [];
  if (emptySamples === samples.length) {
    warnings.push(
      `Every sample column sums to 0 — no abundance could be read. ` +
        `Check the decimal separator (a comma is not recognised) and that the ` +
        `first column holds species names.`,
    );
  } else if (emptySamples > 0) {
    warnings.push(
      `${emptySamples} of ${samples.length} sample columns sum to 0 and were left empty.`,
    );
  }
  const where = (f) => `"${String(f.cell).trim()}" for ${f.sp} in ${f.s}`;
  if (nonNumericCells > 0) {
    const n = nonNumericCells;
    let comma = "";
    if (commaCells > 0) {
      const who =
        commaCells === n
          ? n > 1 ? "they look" : "it looks"
          : `${commaCells.toLocaleString()} of them ${commaCells > 1 ? "look" : "looks"}`;
      comma =
        ` — ${who} like a decimal comma (e.g. "${String(firstComma).trim()}"):` +
        ` re-export the table with '.' as decimal separator`;
    }
    warnings.push(
      `${n.toLocaleString()} non-empty cell${n > 1 ? "s were" : " was"} not numeric and ` +
        `${n > 1 ? "were" : "was"} read as 0 (first: ${where(firstNonNumeric)})${comma}.`,
    );
  }
  if (negativeCells > 0) {
    const n = negativeCells;
    warnings.push(
      `${n.toLocaleString()} cell${n > 1 ? "s hold" : " holds"} a negative value and ` +
        `${n > 1 ? "were" : "was"} read as 0 (first: ${where(firstNegative)}) — ` +
        `an abundance cannot be negative.`,
    );
  }

  return { samples, species: speciesKeys, matrix, logRange, warnings };
}

/* ---------- metadata.tsv ---------- */
const METADATA_COLS = {
  sample: ["sample_id", "sample", "sampleid", "id"],
  // Optional human-readable name for the sample. When present, the UI
  // renders it as a muted secondary label next to the canonical
  // sample_id (table rows, scatter plots, guided-validation header,
  // network nodes, plate cells).
  sampleName: [
    "sample_name",
    "name",
    "display_name",
    "displayname",
    "label",
    "alias",
  ],
  subject: [
    "subject_id",
    "subject",
    "subjectid",
    "patient_id",
    "patient",
    "host",
    "individual",
  ],
  timepoint: [
    "timepoint",
    "time_point",
    "time",
    "day",
    "week",
    "visit",
  ],
  biome: [
    "biome",
    "body_site",
    "bodysite",
    "tissue",
    "sample_site",
  ],
  lowBiomass: ["low_biomass", "is_low_biomass", "lowbiomass"],
  lowSequencingDepth: [
    "low_sequencing_depth",
    "is_low_sequencing_depth",
    "lowsequencingdepth",
    "low_seq_depth",
    "low_depth",
  ],
  groupId: [
    // Canonical name first
    "group_id",
    "group",
    // Aliases for various study contexts (humans, animal cages, etc.)
    "related_group_id",
    "related_group",
    "family_id",
    "family",
    "cage_id",
    "cage",
    "household_id",
    "household",
  ],
};

/** Truthy-ish parsing: accepts true/false, 1/0, yes/no, t/f. Returns a
    boolean or null if the value is empty/unrecognized. */
function parseBool(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).toLowerCase().trim();
  if (["1", "true", "t", "yes", "y"].includes(s)) return true;
  if (["0", "false", "f", "no", "n"].includes(s)) return false;
  return null;
}

export function parseMetadata(text) {
  const { header, rows } = parseTSV(text);
  if (header.length < 2) {
    throw new Error("At least 2 columns required (sample_id and subject_id)");
  }
  const cols = {
    sample: pickCol(header, METADATA_COLS.sample),
    sampleName: pickCol(header, METADATA_COLS.sampleName),
    subject: pickCol(header, METADATA_COLS.subject),
    timepoint: pickCol(header, METADATA_COLS.timepoint),
    biome: pickCol(header, METADATA_COLS.biome),
    lowBiomass: pickCol(header, METADATA_COLS.lowBiomass),
    lowSequencingDepth: pickCol(header, METADATA_COLS.lowSequencingDepth),
    groupId: pickCol(header, METADATA_COLS.groupId),
  };
  if (!cols.sample) throw new Error("sample_id column not found");
  if (!cols.subject) throw new Error("subject_id column not found");
  const bySample = {};
  rows.forEach((r) => {
    const id = r[cols.sample];
    if (!id) return;
    const biomeVal = cols.biome ? r[cols.biome] || "" : "";
    // Control detection: solely from the biome column. Any biome value
    // matching "control", "blank" or "negative" (case-insensitive) flags
    // the sample as a negative control.
    const isControl = /control|blank|negative/i.test(biomeVal);
    bySample[id] = {
      sampleName: cols.sampleName ? r[cols.sampleName] || "" : "",
      subject: r[cols.subject] || "",
      timepoint: cols.timepoint ? r[cols.timepoint] || "" : "",
      biome: biomeVal,
      isControl,
      lowBiomassExplicit: parseBool(
        cols.lowBiomass ? r[cols.lowBiomass] : null,
      ),
      lowSequencingDepthExplicit: parseBool(
        cols.lowSequencingDepth ? r[cols.lowSequencingDepth] : null,
      ),
      groupId: cols.groupId ? r[cols.groupId] || "" : "",
      extra: { ...r },
    };
  });

  return {
    cols,
    bySample,
    nSamples: Object.keys(bySample).length,
    hasSampleNameCol: !!cols.sampleName,
    hasBiomeCol: !!cols.biome,
    hasLowBiomassCol: !!cols.lowBiomass,
    hasLowSequencingDepthCol: !!cols.lowSequencingDepth,
    hasGroupIdCol: !!cols.groupId,
  };
}

/** Serialize metadata back to TSV using whatever extra columns were present
    in the original upload. */
export function metadataToTSV(metadata) {
  if (!metadata) return "";
  const sampleIds = Object.keys(metadata.bySample);
  if (sampleIds.length === 0) return "";
  // Collect the union of all extra keys from the original rows
  const allKeys = new Set();
  sampleIds.forEach((id) => {
    const extras = metadata.bySample[id].extra || {};
    Object.keys(extras).forEach((k) => allKeys.add(k));
  });
  // Ensure sample_id and subject_id are first if present
  const ordered = ["sample_id", "subject_id"];
  Array.from(allKeys).forEach((k) => {
    if (!ordered.includes(k)) ordered.push(k);
  });
  const lines = [ordered.join("\t")];
  sampleIds.forEach((id) => {
    const extras = metadata.bySample[id].extra || {};
    const cells = ordered.map((k) => {
      if (k === "sample_id") return extras.sample_id || id;
      return extras[k] ?? "";
    });
    lines.push(cells.join("\t"));
  });
  return lines.join("\n");
}

/* ---------- plate_map.tsv ---------- */
const PLATE_COLS = {
  sample: ["sample_id", "sample", "id"],
  plate: ["plate", "plate_id", "plateid"],
  well: ["well", "position", "well_id", "pos"],
};

/** "A01" / "A1" / "H12" / "P24" → {row: 0..15, col: 0..23} */
function parseWell(w) {
  if (!w) return null;
  const s = String(w).trim().toUpperCase();
  const m = s.match(/^([A-P])\s*(\d{1,2})$/);
  if (!m) return null;
  const row = m[1].charCodeAt(0) - 65;
  const col = parseInt(m[2], 10) - 1;
  if (row < 0 || row > 15 || col < 0 || col > 23) return null;
  return { row, col };
}

export function wellLabel(row, col) {
  return String.fromCharCode(65 + row) + String(col + 1).padStart(2, "0");
}

export function parsePlateMap(text) {
  const { header, rows } = parseTSV(text);
  const cols = {
    sample: pickCol(header, PLATE_COLS.sample),
    plate: pickCol(header, PLATE_COLS.plate),
    well: pickCol(header, PLATE_COLS.well),
  };
  if (!cols.sample || !cols.well) {
    throw new Error(
      "Missing columns: sample_id and well are required (plate optional).",
    );
  }
  const bySample = {};
  let maxRow = 7;
  let maxCol = 11;
  rows.forEach((r) => {
    const id = r[cols.sample];
    if (!id) return;
    const w = parseWell(r[cols.well]);
    if (!w) return;
    bySample[id] = {
      plate: cols.plate ? r[cols.plate] || "P1" : "P1",
      row: w.row,
      col: w.col,
    };
    maxRow = Math.max(maxRow, w.row);
    maxCol = Math.max(maxCol, w.col);
  });
  const format =
    maxRow > 7 || maxCol > 11 ? { rows: 16, cols: 24 } : { rows: 8, cols: 12 };
  return { bySample, format };
}

export function plateMapToTSV(plateMap) {
  const lines = ["sample_id\tplate\twell"];
  Object.entries(plateMap.bySample).forEach(([sid, p]) => {
    lines.push(`${sid}\t${p.plate}\t${wellLabel(p.row, p.col)}`);
  });
  return lines.join("\n");
}
