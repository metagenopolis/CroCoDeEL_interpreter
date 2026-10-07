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
    field of every writer goes through here.

    A cell that starts with a double quote is quoted the CSV way (wrapped
    in quotes, inner quotes doubled). Read back, unquoteCell strips one
    layer of quotes from a cell that starts and ends with one, so a note
    such as `"Quoted" ... "end"` came back as `Quoted" ... "end`; pandas
    and R, whose quote character is `"` too, misread such a cell as well.
    Quoted, all three give back the text as written. */
export function tsvCell(v) {
  const s = String(v ?? "").replace(/[\t\r\n]+/g, " ");
  return s.charCodeAt(0) === 34 ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Split a TSV text into its header cells, its rows (objects keyed by
    header cell) and the `#` lines before the header. `lineNumbers[i]` is
    the 1-based file line of `rows[i]`, so a message can point the user at
    the cell to fix. `headerLine` is the file line of the header,
    `headerCells` its cells as written (before the cleaning below), and
    `commentLines` the `#` lines above it, as { line, cells }: what
    commentedHeaderError reads.

    A line that starts with "#" is a comment wherever it is, as in
    CroCoDeEL, which reads its tables with pandas, comment="#": above the
    header, run metadata or notes; below it, a row commented out. That row
    used to be read as data: a species "#sp2" in the abundance table's
    column sums, which CroCoDeEL leaves out, or a sample "#q2:types" in a
    QIIME 2 metadata file.

    `options` asks for the rest of what pandas does there, which only the
    abundance table needs — CroCoDeEL reads it with read_csv(sep="\t",
    header=0, index_col=0, comment="#"), while its events reader
    (csv.DictReader) and the metadata and plate map, which only this
    interface reads, take a "#" inside a line as text ("well #3"):
      inlineComments  a "#" inside a line ends it, as comment="#" does
                      (one inside a quoted cell is text). `inlineComment`
                      then gives the first line cut, as { line, text },
                      and `inlineComments` how many were;
      indexCol        when the first data row has one cell more than the
                      header, the header has no cell above the species
                      column — R's write.table writes it so — and each
                      of its cells names a sample, as pandas reads it
                      (an implicit index): `implicitIndex` is then true
                      and `header` starts with "", the species column.
                      When that cell is an empty one at the end of the
                      row instead, under no header cell in any row (each
                      line ends with a tab), pandas still reads it so and
                      shifts every sample name one column: the table is
                      read as its header says, and `shiftedByPandas` is
                      true for the parser to say so. */
export function parseTSV(text, options = {}) {
  const { inlineComments = false, indexCol = false } = options;
  const allLines = text.replace(/\r/g, "").split("\n");
  // Separate hash-prefixed header lines (e.g. CroCoDeEL run params) from data
  const headerComments = [];
  const commentLines = [];
  let headerCells = null;
  let headerLine = 0;
  // The cells of each data line, as split, and the file line of each.
  const data = [];
  const lineNumbers = [];
  // Past the last non-blank cell of any data line.
  let width = 0;
  let inlineComment = null;
  let cutLines = 0;
  for (let n = 0; n < allLines.length; n++) {
    let line = allLines[n];
    // Blank lines carry no record, and neither do lines of spaces or tabs
    // only — what a spreadsheet leaves of a cleared row, which used to
    // become an event with an empty source or a sample named "  ".
    if (!/\S/.test(line)) continue;
    if (line.startsWith("#")) {
      if (headerCells === null) {
        headerComments.push(line.replace(/^#\s*/, ""));
        commentLines.push({ line: n + 1, cells: line.split("\t").map(unquoteCell) });
      }
      continue;
    }
    if (inlineComments && line.includes("#")) {
      const kept = beforeComment(line);
      if (kept.length < line.length) {
        cutLines++;
        if (!inlineComment) inlineComment = { line: n + 1, text: line.slice(kept.length) };
        line = kept;
        if (!/\S/.test(line)) continue;
      }
    }
    const cells = line.split("\t");
    if (headerCells === null) {
      headerCells = cells.map(unquoteCell);
      headerLine = n + 1;
      continue;
    }
    data.push(cells);
    lineNumbers.push(n + 1);
    for (let i = cells.length - 1; i >= width; i--) {
      if (!isBlankCell(cells[i])) {
        width = i + 1;
        break;
      }
    }
  }
  if (headerCells === null) {
    return {
      header: [],
      rows: [],
      headerComments,
      lineNumbers,
      headerLine,
      headerCells: [],
      commentLines,
      implicitIndex: false,
      shiftedByPandas: false,
      unnamed: [],
      inlineComment,
      inlineComments: cutLines,
    };
  }

  // pandas' implicit index (see `indexCol` above).
  let implicitIndex = false;
  let shiftedByPandas = false;
  if (indexCol && data.length > 0 && data[0].length === headerCells.length + 1) {
    if (isBlankCell(data[0][headerCells.length]) && width <= headerCells.length) {
      shiftedByPandas = true;
    } else {
      implicitIndex = true;
    }
  }
  const offset = implicitIndex ? 1 : 0;
  const header = implicitIndex ? ["", ...headerCells] : [...headerCells];
  // Empty cells at the end of the header line (cleared trailing columns)
  // made phantom "" columns: an empty sample in the abundance table, a ""
  // key in every metadata row. One with no value under it in any row is
  // dropped. One with values is a column whose name is missing: dropping
  // it lost them — a sample CroCoDeEL reads, as "Unnamed: 3", gone from
  // every view and export — so it is named as the ones below are.
  while (header.length > 0 && header[header.length - 1].trim() === "" && header.length > width) {
    header.pop();
  }
  // An empty (or blank) header cell between two named ones made a ""
  // column — a sample without a name, a "" key in every metadata row.
  // pandas, so CroCoDeEL, names it "Unnamed: <0-based column of the
  // header line>", the name CroCoDeEL's events give that sample: so does
  // this. The first cell is left as it is: R's write.table with
  // col.names=NA writes "" above the row names, the species column here.
  const unnamed = [];
  for (let i = 1; i < header.length; i++) {
    if (header[i].trim() === "") {
      header[i] = `Unnamed: ${i - offset}`;
      unnamed.push(header[i]);
    }
  }
  const rows = new Array(data.length);
  for (let k = 0; k < data.length; k++) {
    const cells = data[k];
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = unquoteCell(cells[i] ?? "");
    rows[k] = obj;
    data[k] = null;
  }
  return {
    header,
    rows,
    headerComments,
    lineNumbers,
    headerLine,
    headerCells,
    commentLines,
    implicitIndex,
    shiftedByPandas,
    unnamed,
    inlineComment,
    inlineComments: cutLines,
  };
}

/** True when a cell as split holds nothing once unquoted and trimmed. */
function isBlankCell(cell) {
  return cell === undefined || unquoteCell(cell).trim() === "";
}

/** A line up to the "#" that starts a comment in it, as pandas'
    comment="#" cuts it: the first one that is not inside a quoted cell (a
    cell that starts and ends with a double quote, as unquoteCell reads
    it). The line itself when it has none. */
function beforeComment(line) {
  let start = 0;
  while (start <= line.length) {
    let end = line.indexOf("\t", start);
    if (end < 0) end = line.length;
    const cell = line.slice(start, end);
    const quoted = cell.length >= 2 && cell.charCodeAt(0) === 34 && cell.charCodeAt(cell.length - 1) === 34;
    const hash = quoted ? -1 : cell.indexOf("#");
    if (hash >= 0) return line.slice(0, start + hash);
    start = end + 1;
  }
  return line;
}

/** The cells of a header line without its empty trailing ones. */
function withoutTrailingBlanks(cells) {
  const out = [...cells];
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

/* ---------- a header written as a comment ----------
   `biom convert --to-tsv` writes its header as "#OTU ID\tS1\tS2…", a QIIME
   mapping file as "#SampleID\t…" (QIIME 2 may add a "#q2:types" line under
   it), mOTUs as "#consensus_taxonomy\t…". A "#" line is a comment, so that
   line was skipped and the first data row read as the header: the species
   of that row vanished and the samples were named after its values, or a
   metadata file failed on "sample_id column not found" listing a row of
   values. CroCoDeEL reads the abundance table with pandas, comment="#",
   and misreads it the same way, so the file is refused, naming the line
   to fix, rather than read otherwise than CroCoDeEL read it.

   Refused only when the line read as the header is not one for this file
   (each parser says when: a row of numbers in the abundance table, no
   sample id column in the metadata or the plate map, no source and target
   in the events) AND a "#" line above it is. A "#" line above a header
   that is one is a comment, whatever it holds — "#group\tcase\tcase…" or
   "#unit\trelab\t…" above "species\tS1\tS2…", as CroCoDeEL reads it. */

/** The "#" line above the header whose cells (its "#" taken off) name
    this file's columns — `isHeader(cells)` says whether they do — as
    { line, cells }, or null. The lines are tried from the closest one up,
    QIIME 2 directives ("#q2:types") aside. */
function headerAsComment(tsv, isHeader) {
  for (let k = tsv.commentLines.length - 1; k >= 0; k--) {
    const { cells } = tsv.commentLines[k];
    const first = cells[0].replace(/^#\s*/, "");
    if (/^q2:/i.test(first)) continue;
    if (isHeader([first, ...cells.slice(1)])) return tsv.commentLines[k];
  }
  return null;
}

/** The first three cells of a line, quoted, for a message. */
function showCells(cells) {
  return cells.slice(0, 3).map((c) => `"${clip(c, 30)}"`).join(", ") + (cells.length > 3 ? ", …" : "");
}

/** The error for a header line written as a comment, or null (see
    headerAsComment for `isHeader`). `after` ends the advice, `otherwise`
    follows it. */
function commentedHeaderError(tsv, isHeader, after = "", otherwise = () => "") {
  const found = headerAsComment(tsv, isHeader);
  if (!found) return null;
  const { line, cells } = found;
  return (
    `Line ${line} looks like the header (${showCells(cells)}) but starts with "#", ` +
    `which marks a comment line, here as in CroCoDeEL: it would be skipped, and ` +
    `line ${tsv.headerLine} (${showCells(tsv.headerCells)}) read as the header. ` +
    `Remove the "#" at the start of line ${line} and load the file again${after}.${otherwise(line)}`
  );
}

/** True when the cells after the first are mostly numbers (or empty /
    NA), at least one a number: a data row of the abundance table, not its
    header — a biom table may end its rows with a taxonomy text. (A table
    whose sample ids are numbers reads so too: see namesSpeciesColumn.) */
function looksLikeAbundanceRow(cells) {
  let numbers = 0;
  let blanks = 0;
  let texts = 0;
  for (const c of withoutTrailingBlanks(cells).slice(1)) {
    const v = parseStrictNumber(c);
    if (Number.isNaN(v)) texts++;
    else if (v === null) blanks++;
    else numbers++;
  }
  return numbers > 0 && texts <= numbers + blanks;
}

/* Words of the species column's title in the usual abundance tables:
   id_mgs and id_msp (Meteor), species_name (CroCoDeEL's README),
   clade_name (MetaPhlAn), gtdb_classification (sylph), OTU ID (biom),
   Feature ID (QIIME 2), consensus_taxonomy (mOTUs), OTU_ID, Taxon, … */
const SPECIES_TITLE_WORDS = new Set([
  "species", "strain", "taxon", "taxa", "taxonomy", "otu", "asv", "feature", "clade",
  "lineage", "classification", "msp", "mgs", "motu", "sgb", "genome", "mag", "organism",
  "name", "id",
]);

/* Words of a taxon's name that no column title holds: SILVA's and GTDB's
   "uncultured organism", "unclassified Bacteria", "gut metagenome", … A
   title word among them ("organism") does not make such a name a title. */
const TAXON_NAME_WORDS = new Set([
  "uncultured", "unclassified", "unidentified", "unknown", "metagenome", "bacterium",
  "bacteria", "archaea", "archaeon", "candidatus", "incertae", "sedis", "environmental",
]);

/** True when `cell`, the first cell of the line read as the header, names
    the species column, so that the line is the header and its sample ids
    are numbers ("species\t1\t2\t3", Qiita's "OTU_ID\t10317.000001\t…"):
    the cell is empty (R's write.table writes "" above the row names), or
    words without a digit, one of them a usual title word and none a word
    of a taxon's name, or it repeats the first cell of a "#" line above
    (an old header commented out above the renamed one). A data row starts
    with a species or an OTU instead: "sp1", "otu1", a hash, "k__Bacteria",
    "Bacteroides vulgatus", a lineage. A lineage holds title words too —
    "d__Bacteria;…;s__uncultured_organism", MetaPhlAn's "k__Bacteria|…|
    s__…_organism" — and was taken for a title: a biom table whose header
    is a "#" line then loaded with its first row's values for sample ids
    and only a warning. A rank prefix ("s__") or a lineage separator
    (";", "|") now marks a taxon, as splitSpeciesList reads them. */
function namesSpeciesColumn(cell, tsv) {
  const t = cell.trim().toLowerCase();
  if (t === "") return true;
  const commented = (cells) => cells[0].replace(/^#\s*/, "").trim().toLowerCase();
  if (tsv.commentLines.some(({ cells }) => commented(cells) === t)) return true;
  if (/\d/.test(t) || /[a-z]__|[;|]/i.test(t)) return false;
  // Words split on what is not a letter and inside camel case
  // ("FeatureID"); no lookbehind, which Safari reads only from 16.4.
  const words = cell
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .map((w) => w.toLowerCase());
  return (
    words.some((w) => SPECIES_TITLE_WORDS.has(w)) && !words.some((w) => TAXON_NAME_WORDS.has(w))
  );
}

/** The commented-header check of an abundance table: { error } when its
    header line reads as a data row and a "#" line above has a column name
    for each of that row's cells — every one after the first named, none
    twice, as many as the row's cells up to its last value or as all of
    them (a MetaPhlAn row ends with an empty cell); { warning } when such a
    "#" line is above a header whose sample ids are numbers
    (namesSpeciesColumn), which CroCoDeEL reads as it is, so this reads it
    so too; else null.

    The first version refused such a header as well, and its advice,
    removing the "#", would have made the comment the header: "#species\tS1
    \tS2\tS3" above "species\t1\t2\t3", an old header commented out above
    the renamed one, or a "#sample_name" line of Qiita sample names above
    "OTU_ID\t10317.000001\t…". The refusal now also says how to load the
    table when the line read as the header is one after all. */
function abundanceHeaderCheck(tsv) {
  // A header with one cell fewer than the rows under it (R's write.table)
  // is one: pandas reads it so, and a data row is as wide as the next.
  if (tsv.implicitIndex || !looksLikeAbundanceRow(tsv.headerCells)) return null;
  const width = withoutTrailingBlanks(tsv.headerCells).length;
  const linesUp = (cells) => {
    const named = withoutTrailingBlanks(cells);
    if (named.length < 2 || named.length < width || named.length > tsv.headerCells.length) {
      return false;
    }
    const samples = named.slice(1);
    return samples.every((c) => c.trim() !== "") && new Set(samples).size === samples.length;
  };
  const header = tsv.headerLine;
  if (namesSpeciesColumn(tsv.headerCells[0], tsv)) {
    const found = headerAsComment(tsv, linesUp);
    if (!found) return null;
    return {
      warning:
        `Line ${found.line} (${showCells(found.cells)}) starts with "#": it is read as a comment, ` +
        `as CroCoDeEL reads it, and line ${header} (${showCells(tsv.headerCells)}) as the header ` +
        `(its sample ids are numbers). If line ${found.line} is the header, remove its "#", ` +
        `load the file again and run CroCoDeEL again on the fixed table.`,
    };
  }
  const error = commentedHeaderError(
    tsv,
    linesUp,
    " (if CroCoDeEL ran on this table, run it again on the fixed one: it misread it the same way)",
    (line) => ` If line ${header} is the header after all (its sample ids are numbers), delete line ${line} instead.`,
  );
  return error ? { error } : null;
}

/** The commented-header error of a file keyed by a column the header line
    does not name and a "#" line above does (pickColExact on `aliases`;
    every list of `aliases` must be found), or null. */
function missingColumnsHeaderError(tsv, ...aliases) {
  const names = (cells) => aliases.every((a) => pickColExact(cells, a));
  return names(tsv.header) ? null : commentedHeaderError(tsv, names);
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
      // Unquoted like any cell: the curated exports write "# study: …"
      // through tsvCell, which quotes a title that starts with a quote.
      const val = unquoteCell(kv.slice(idx + 1).trim());
      if (key) meta[key] = val;
    });
  });
  return Object.keys(meta).length > 0 ? meta : null;
}

/** Pick the events-file column for one field: an exact (case-insensitive)
    match on one of `candidates` first, then the first header containing
    one. CroCoDeEL's own headers all match exactly; the substring pass only
    rescues hand-made ones such as "Source sample". The metadata and the
    plate map use pickColExact instead. */
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

/** A header reduced for matching: lower case, without spaces, underscores,
    hyphens or dots, so "Subject ID", "subject-id", "SubjectID" and
    "subject_id" are one header. */
function headerKey(h) {
  return String(h ?? "").toLowerCase().replace(/[\s_.-]+/g, "");
}

/** Pick the column for one field by exact match only, up to case and
    separators (see headerKey). The metadata and the plate map use this:
    pickCol's substring pass invented relatedness there — age_group and
    treatment_group became the group_id (alias "group"), host_age the
    subject ("host"), birthday the timepoint ("day"), family_history the
    group ("family") — and two different subjects of the same age band
    then counted as related. */
function pickColExact(header, candidates) {
  const keys = header.map(headerKey);
  for (const c of candidates) {
    const i = keys.indexOf(headerKey(c));
    if (i >= 0) return header[i];
  }
  return null;
}

/** A cell or a header quoted in a message, cut to `max` characters. */
function clip(s, max = 60) {
  const t = String(s ?? "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The end of an error about a column pickColExact did not find: the
    matching rule, and the headers the file does have — without them the
    message cannot tell "Subject" from "subject_name". */
function headerHint(header) {
  const shown = header.slice(0, 12).map((h) => clip(h, 40)).join(", ");
  const more = header.length > 12 ? `, … (${header.length} in all)` : "";
  return (
    "Headers are matched exactly, ignoring case, spaces, _ - and . " +
    `— this file has: ${shown || "no header"}${more}.`
  );
}

/** The error for a file that is not tab-separated — a CSV, whose whole
    header line reads as one cell holding commas or semicolons — or null.
    Without it each parser fails on whatever it looks for first, quoting
    the whole header as a column name and a whole row as a value. */
function notTabSeparated(header) {
  if (header.length !== 1) return null;
  const sep = /,/.test(header[0]) ? "commas" : /;/.test(header[0]) ? "semicolons" : null;
  if (!sep) return null;
  return (
    `The file is not tab-separated: its header line is a single column holding ${sep} ` +
    `("${clip(header[0], 50)}"). Save it as tab-separated values (TSV) and load it again.`
  );
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

/* ---------- duplicated ids ----------
   One rule for the three tables keyed by sample: a repeated id is always
   reported, never resolved in silence.
   - Abundance table: refused, for sample columns and species rows alike.
     parseTSV keys a row by header name, so a repeated sample column made
     two samples share one profile; a repeated species row lost one row's
     counts while the column total still held them, which the
     normalisation then spread over every other species. No row is the
     right one to keep.
   - Metadata and plate map: the first row of an id is used, the later ones
     are ignored, and a warning names them. These used to keep the last
     row without a word. First, as pandas' drop_duplicates, dplyr's
     distinct() and a spreadsheet's "remove duplicates" do by default, and
     as lookupBySample (App.jsx) already does for ids that differ only by
     case or blanks. */

/** The values found more than once in `names`, each listed once, in the
    order of their first repeat. */
function findDuplicates(names) {
  const seen = new Set();
  const dups = new Set();
  for (const n of names) {
    if (seen.has(n)) dups.add(n);
    else seen.add(n);
  }
  return [...dups];
}

/** `2 sample ids appear on more than one row ("S1", "S2")`, naming at most
    three. `what` is singular, `where` ends the clause. */
function describeDuplicates(dups, what, where) {
  const n = dups.length;
  const shown = dups.slice(0, 3).map((d) => `"${clip(d, 40)}"`).join(", ");
  const more = n > 3 ? ` and ${n - 3} more` : "";
  return `${n} ${what}${n > 1 ? "s appear" : " appears"} ${where} (${shown}${more})`;
}

/** The warning of the metadata and the plate map, from the ids of the rows
    they ignored (an id ignored twice is named once). */
function duplicateIdsWarning(ignoredIds) {
  return (
    describeDuplicates([...new Set(ignoredIds)], "sample id", "on more than one row") +
    ": the first row of each is used, the later ones are ignored."
  );
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

/* The curation columns of the interpreter's own curated-events export, so
   that reloading that file restores the evaluations instead of resetting
   every event to pending. Matched by pickColExact, never by substring:
   "action" is a substring of "extraction_batch" and of
   "contamination_fraction". */
const EVENT_CURATION_COLS = {
  verdict: ["verdict", "evaluation"],
  notes: ["notes", "note", "comment", "comments"],
  action: ["action"],
};

/** Event verdicts by spelling: lower case, blanks / hyphens / underscores
    reduced to one "_" ("True positive", "TRUE-POSITIVE", "tp"). */
const VERDICT_SPELLINGS = new Map([
  ["true_positive", "true_positive"],
  ["tp", "true_positive"],
  ["false_positive", "false_positive"],
  ["fp", "false_positive"],
  ["uncertain", "uncertain"],
  ["u", "uncertain"],
  ["pending", "pending"],
]);

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
  const tsv = parseTSV(text);
  const { header, rows, headerComments, lineNumbers } = tsv;
  const commented = missingColumnsHeaderError(tsv, EVENT_COLS.source, EVENT_COLS.target);
  if (commented) throw new Error(commented);
  if (rows.length === 0) throw new Error("Empty file or no rows");
  const csv = notTabSeparated(header);
  if (csv) throw new Error(csv);
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
  const cur = {
    verdict: pickColExact(header, EVENT_CURATION_COLS.verdict),
    notes: pickColExact(header, EVENT_CURATION_COLS.notes),
    action: pickColExact(header, EVENT_CURATION_COLS.action),
  };
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
  const badVerdicts = [];
  const badActions = [];
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
    const ev = normalizeEvent(r, cols, events.length, rate.value, prob.value);
    // Curation read back from the file (see EVENT_CURATION_COLS). The
    // action belongs to the target sample, not to the event: it is kept as
    // `fileAction` for the caller to offer, never applied here — and not
    // as `action`, which AppMain's legacy-session migration would move
    // onto the sample.
    if (cur.verdict) {
      const cell = String(r[cur.verdict] ?? "").trim();
      const verdict = cell
        ? VERDICT_SPELLINGS.get(cell.toLowerCase().replace(/[\s_-]+/g, "_"))
        : "pending";
      if (verdict) ev.verdict = verdict;
      else badVerdicts.push({ i, cell });
    }
    if (cur.notes) ev.notes = String(r[cur.notes] ?? "").trim();
    if (cur.action) {
      const cell = String(r[cur.action] ?? "").trim();
      const action = cell.toLowerCase();
      if (action === "keep" || action === "suppress") ev.fileAction = action;
      else if (cell) badActions.push({ i, cell });
    }
    events.push(ev);
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
  if (badVerdicts.length > 0) {
    const n = badVerdicts.length;
    const { i, cell } = badVerdicts[0];
    warnings.push(
      `${n} row${n > 1 ? "s have" : " has"} an unrecognised verdict and ${n > 1 ? "were" : "was"} ` +
        `read as pending (first on line ${lineNumbers[i]}: "${clip(cell)}").`,
    );
  }
  if (badActions.length > 0) {
    const n = badActions.length;
    const { i, cell } = badActions[0];
    warnings.push(
      `${n} row${n > 1 ? "s have" : " has"} an unrecognised action, ignored: expected keep or ` +
        `suppress (first on line ${lineNumbers[i]}: "${clip(cell)}").`,
    );
  }
  if (invalid.length > 0) {
    const { i, key } = invalid[0];
    const cell = String(rows[i][key]).trim();
    const more = invalid.length - 1;
    throw new Error(
      `Row ${i + 1} (line ${lineNumbers[i]}), column "${clip(key, 40)}": "${clip(cell)}" is not a number` +
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
        ` — first on line ${lineNumbers[i]} (${clip(rows[i][cols.source], 40)} → ` +
        `${clip(rows[i][cols.target], 40)}): ${value}.`,
    );
  };
  rangeWarning(rateOutOfRange, "rate", "(0, 1]");
  rangeWarning(probOutOfRange, "probability", "[0, 1]");

  // What the file carried, for the caller to tell the user: events with a
  // verdict other than pending, with notes, with a keep / suppress action.
  // Null when the file has none of these columns (a CroCoDeEL output).
  const curation =
    cur.verdict || cur.notes || cur.action
      ? {
          verdicts: events.filter((e) => e.verdict !== "pending").length,
          notes: events.filter((e) => e.notes).length,
          actions: events.filter((e) => e.fileAction).length,
        }
      : null;

  return {
    events,
    runMetadata: parseRunMetadata(headerComments),
    warnings,
    curation,
  };
}

/* ---------- species_abundance.tsv ---------- */

/** Parse the species × sample table into relative abundances.

    Returns { samples, species, matrix, logRange, warnings }, where
    matrix[sp][s] is a fraction and every non-empty column sums to 1 (null
    when the file has no sample column). The fractions are what every
    diagnostic uses, but they cannot give the user's table back: counts
    1500 / 500 become 0.75 / 0.25. So the result also keeps what an export
    needs to rebuild it:
      firstHeader  the first header cell as written ("id_mgs",
                   "clade_name"), which an export would otherwise call
                   "species"; "" when the header has none (below);
      implicitIndex  true when the header has no cell above the species
                   column, as R's write.table writes it: each header cell
                   names a sample and the first cell of each row is its
                   species, as pandas, hence CroCoDeEL, reads such a
                   table (see parseTSV's indexCol). Read as a usual
                   header, every sample took the name of the one before
                   it and the last one was lost — no warning, and the
                   diagnostics of every event computed on other samples
                   than the ones it names. An export writes the header so
                   again;
      colSums      { sample: the sum of its column as read, before
                   normalisation }; matrix[sp][s] * colSums[s] is the value
                   read (an all-zero column keeps fractions of 0 and a sum
                   of 0);
      integerCols  { sample: true when every value read in that column is
                   an integer, i.e. counts }: rounding the product then
                   gives them back exactly;
      species      in file order — Object.keys(matrix) would list
                   integer-like names ("1", "2", …) first.
    Cells read as 0 (empty, NA, not a number, negative) come back as 0. */
export function parseAbundance(text) {
  // Read as CroCoDeEL reads it: pandas, index_col=0, comment="#".
  const tsv = parseTSV(text, { inlineComments: true, indexCol: true });
  const { header, rows } = tsv;
  const commented = abundanceHeaderCheck(tsv);
  if (commented?.error) throw new Error(commented.error);
  if (header.length < 2) {
    const csv = notTabSeparated(header);
    if (csv) throw new Error(csv);
    return null;
  }
  const speciesCol = header[0];
  const samples = header.slice(1);

  // Duplicates are refused here (see "duplicated ids" above).
  const dupSamples = findDuplicates(samples);
  if (dupSamples.length > 0) {
    throw new Error(
      `${describeDuplicates(dupSamples, "sample column", "more than once in the abundance table")}. ` +
        `Each sample must appear exactly once — merge or rename the columns and reload.`,
    );
  }
  const speciesNames = rows.map((r) => r[speciesCol]).filter(Boolean);
  // A header with nothing under it used to load as a table of empty
  // samples, with a warning blaming the decimal separator.
  if (speciesNames.length === 0) {
    const n = samples.length;
    throw new Error(
      "The abundance table has no species rows: " +
        (rows.length === 0
          ? `only its header line (${n} sample column${n > 1 ? "s" : ""}) was found.`
          : `none of its ${rows.length} rows has a species name in the first column.`),
    );
  }
  const dupSpecies = findDuplicates(speciesNames);
  if (dupSpecies.length > 0) {
    throw new Error(
      `${describeDuplicates(dupSpecies, "species row", "more than once in the abundance table")}. ` +
        `Each species must appear exactly once — aggregate the rows and reload.`,
    );
  }

  // Cells are read strictly (see parseStrictNumber). Empty and NA cells are
  // a legitimate absence and read as 0 silently. A cell that is not a
  // number, or is negative, also reads as 0 but is counted, with the first
  // one kept as an example for the warning.
  const matrix = {};
  // Built here, in file order (see the doc comment): duplicates are refused
  // above, so each species is pushed once.
  const speciesKeys = [];
  const integerCol = new Array(samples.length).fill(true);
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
      if (integerCol[j] && !Number.isInteger(v)) integerCol[j] = false;
      row[s] = v;
    }
    matrix[sp] = row;
    speciesKeys.push(sp);
  });

  // normalize to relative abundances per sample, and collect the log10
  // extremes in the same pass
  let minVal = Infinity;
  let maxVal = -Infinity;
  let emptySamples = 0;
  const colSums = {};
  const integerCols = {};
  samples.forEach((s, j) => {
    let total = 0;
    for (const sp of speciesKeys) total += matrix[sp][s] || 0;
    colSums[s] = total;
    integerCols[s] = integerCol[j];
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
  const warnings = commented?.warning ? [commented.warning] : [];
  warnings.push(...layoutWarnings(tsv));
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
  const where = (f) => `"${clip(String(f.cell).trim())}" for ${clip(f.sp, 40)} in ${clip(f.s, 40)}`;
  if (nonNumericCells > 0) {
    const n = nonNumericCells;
    let comma = "";
    if (commaCells > 0) {
      const who =
        commaCells === n
          ? n > 1 ? "they look" : "it looks"
          : `${commaCells.toLocaleString()} of them ${commaCells > 1 ? "look" : "looks"}`;
      comma =
        ` — ${who} like a decimal comma (e.g. "${clip(String(firstComma).trim())}"):` +
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

  return {
    samples,
    species: speciesKeys,
    matrix,
    logRange,
    warnings,
    firstHeader: speciesCol,
    implicitIndex: tsv.implicitIndex,
    colSums,
    integerCols,
  };
}

/** What parseTSV read otherwise than the header line says, or than a
    reader that knows no comments would, in an abundance table: each a
    warning, since CroCoDeEL (pandas) read the table so. */
function layoutWarnings(tsv) {
  const out = [];
  const { header, unnamed, inlineComment, inlineComments: cut } = tsv;
  if (tsv.shiftedByPandas) {
    const first = header[0].trim() ? ` ("${clip(header[0], 30)}")` : "";
    out.push(
      `The first row (line ${tsv.lineNumbers[0]}) has one cell more than the header, an empty ` +
        `one at its end (the line ends with a tab). CroCoDeEL reads such a table with pandas, ` +
        `which then takes every header cell, the first one${first} included, for a sample ` +
        `holding the values of the column after it: its events name the samples one column ` +
        `off. This reads the table as its header says. Remove the tabs at the end of the ` +
        `lines and run CroCoDeEL again on the fixed table.`,
    );
  }
  if (unnamed.length > 0) {
    const n = unnamed.length;
    const names = unnamed.slice(0, 3).map((u) => `"${u}"`).join(", ") + (n > 3 ? ", …" : "");
    out.push(
      `${n} sample column${n > 1 ? "s have" : " has"} no name in the header: read as ` +
        `${names}, the name${n > 1 ? "s" : ""} CroCoDeEL (pandas) gives ${n > 1 ? "them" : "it"}.`,
    );
  }
  if (cut > 0) {
    out.push(
      `${cut} line${cut > 1 ? "s hold" : " holds"} a "#" after ${cut > 1 ? "their" : "its"} start ` +
        `(first: line ${inlineComment.line}, "${clip(inlineComment.text.replace(/\t/g, " "), 40)}"). CroCoDeEL reads ` +
        `the table with pandas, comment="#", which ignores a line from its "#" on, and so ` +
        `does this. If a "#" belongs to a name or a value, remove it and run CroCoDeEL again ` +
        `on the fixed table.`,
    );
  }
  return out;
}

/** The abundance table's columns in one line, for its card, when its
    header is not the usual one: species from the first cell of each row
    under a header without a cell above them (implicitIndex). Null for a
    usual table, and for a session saved without the flag. */
export function abundanceColumnsLine(ab) {
  if (ab?.implicitIndex !== true) return null;
  return (
    "species from the first cell of each row — the header has no cell above them " +
    "(R's write.table), so each of its cells names a sample, as CroCoDeEL (pandas) reads it"
  );
}

/* ---------- metadata.tsv ----------
   Headers are matched by pickColExact, so each list only needs the names
   that differ by more than case and separators ("sampleid", "Sample ID" and
   "sample-id" all match "sample_id"). The canonical name comes first: it is
   the one shown on the upload card and written by metadataToTSV. */
const METADATA_COLS = {
  sample: ["sample_id", "sample", "id"],
  // Optional human-readable name for the sample. When present, the UI
  // renders it as a muted secondary label next to the canonical
  // sample_id (table rows, scatter plots, guided-validation header,
  // network nodes, plate cells).
  sampleName: [
    "sample_name",
    "name",
    "display_name",
    "label",
    "alias",
  ],
  // Two samples sharing a subject count as related. Not `host`: in MIxS /
  // NCBI BioSample metadata that is the host ORGANISM ("Homo sapiens"),
  // which made every pair of samples "the same subject"; the subject id
  // there is host_subject_id.
  subject: [
    "subject_id",
    "subject",
    "host_subject_id",
    "patient_id",
    "patient",
    "individual_id",
    "individual",
    "participant_id",
    "participant",
    "host_id",
  ],
  timepoint: [
    "timepoint",
    "time",
    "day",
    "week",
    "visit",
  ],
  biome: [
    "biome",
    "body_site",
    "tissue",
    "sample_site",
  ],
  lowBiomass: ["low_biomass", "is_low_biomass"],
  lowSequencingDepth: [
    "low_sequencing_depth",
    "is_low_sequencing_depth",
    "low_seq_depth",
    "low_depth",
  ],
  // Two samples sharing a group count as related too. Not a bare `group`:
  // in study metadata that is the experimental arm (case / control, diet),
  // and every pair within an arm became "related".
  groupId: [
    // Canonical name first
    "group_id",
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

/** The header read for each metadata field (field → header, or null). */
function metadataCols(header) {
  const cols = {};
  for (const [field, names] of Object.entries(METADATA_COLS)) {
    cols[field] = pickColExact(header, names);
  }
  return cols;
}

/** What the app reads of one sample, from its row `r` (cells keyed by
    header) and the column mapping. */
function metadataEntry(r, cols) {
  const cell = (field) => {
    const v = cols[field] ? r[cols[field]] : null;
    return v == null ? "" : String(v);
  };
  const biome = cell("biome");
  return {
    sampleName: cell("sampleName"),
    subject: cell("subject"),
    timepoint: cell("timepoint"),
    biome,
    // Control detection: solely from the biome column. Any biome value
    // matching "control", "blank" or "negative" (case-insensitive) flags
    // the sample as a negative control.
    isControl: /control|blank|negative/i.test(biome),
    lowBiomassExplicit: parseBool(cols.lowBiomass ? r[cols.lowBiomass] : null),
    lowSequencingDepthExplicit: parseBool(
      cols.lowSequencingDepth ? r[cols.lowSequencingDepth] : null,
    ),
    groupId: cell("groupId"),
    extra: { ...r },
  };
}

/** The metadata object the app keeps, around a mapping and its entries. */
function metadataResult(cols, bySample, warnings) {
  return {
    cols,
    bySample,
    warnings,
    nSamples: Object.keys(bySample).length,
    hasSampleNameCol: !!cols.sampleName,
    hasBiomeCol: !!cols.biome,
    hasLowBiomassCol: !!cols.lowBiomass,
    hasLowSequencingDepthCol: !!cols.lowSequencingDepth,
    hasGroupIdCol: !!cols.groupId,
  };
}

export function parseMetadata(text) {
  const tsv = parseTSV(text);
  const { header, rows } = tsv;
  const commented = missingColumnsHeaderError(tsv, METADATA_COLS.sample);
  if (commented) throw new Error(commented);
  if (header.length < 2) {
    throw new Error(
      notTabSeparated(header) || "At least 2 columns required (sample_id and subject_id)",
    );
  }
  // The resolved mapping (field → header, or null) is returned as `cols`
  // and shown on the upload card, so a curator can see which column was
  // taken for the subject and the group.
  const cols = metadataCols(header);
  for (const field of ["sample", "subject"]) {
    if (cols[field]) continue;
    const names = METADATA_COLS[field];
    const expected = `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
    throw new Error(
      `${names[0]} column not found: expected ${expected}. ${headerHint(header)}`,
    );
  }
  const bySample = {};
  // A repeated id keeps its first row (see "duplicated ids" above).
  const seen = new Set();
  const dups = [];
  rows.forEach((r) => {
    const id = r[cols.sample];
    if (!id) return;
    if (seen.has(id)) {
      dups.push(id);
      return;
    }
    seen.add(id);
    bySample[id] = metadataEntry(r, cols);
  });

  const warnings = [];
  if (dups.length > 0) warnings.push(duplicateIdsWarning(dups));
  return metadataResult(cols, bySample, warnings);
}

/** The row a metadata entry keeps (`extra`: its cells keyed by header), or
    null when it keeps none. A session file can be edited by hand, and an
    `extra` that is not a plain object is not a row: a string made
    metadataToTSV throw (`col in "abc"`) and the metadata card list its
    characters as columns ("other: 0, 1, 2"); a list was read as a row
    whose headers are "0", "1", … and lost the entry's subject. */
function entryRow(entry) {
  const extra = entry?.extra;
  return extra && typeof extra === "object" && !Array.isArray(extra) ? extra : null;
}

/** The values of a metadata entry that the app reads. */
const ENTRY_FIELDS = [
  "sampleName",
  "subject",
  "timepoint",
  "biome",
  "isControl",
  "lowBiomassExplicit",
  "lowSequencingDepthExplicit",
  "groupId",
];

/** Metadata kept by a session (IndexedDB, session JSON), read again with
    the current header rules.

    A session stores the parsed metadata, not the file. One saved before
    headers were matched exactly still holds the substring mapping of
    that time — age_group read as the group_id, host_age as the subject —
    and the relatedness it invented, which the new rules would otherwise
    only remove for a curator who uploads the file again; the metadata
    download even wrote it back under the canonical names. Every entry
    keeps its row (`extra`), so the mapping is resolved again from those
    headers and each entry derived again; the sample ids stay what they
    were. A field that changes column is named in a warning, shown on the
    metadata card.

    Returns `metadata` itself when nothing changes, which is the case for
    whatever this version parsed, and anything without rows to read again
    as it is. */
export function remapMetadata(metadata) {
  const bySample = metadata?.bySample;
  if (!bySample || typeof bySample !== "object") return metadata;
  const ids = Object.keys(bySample);
  const rowOf = (id) => entryRow(bySample[id]);
  // The file's header, from the rows the entries keep.
  const headerSet = new Set();
  for (const id of ids) Object.keys(rowOf(id) || {}).forEach((k) => headerSet.add(k));
  if (headerSet.size === 0) return metadata;
  const old = metadata.cols && typeof metadata.cols === "object" ? metadata.cols : null;
  const cols = metadataCols([...headerSet]);
  // The ids were read from the stored sample column: it stays the one.
  if (old?.sample && headerSet.has(old.sample)) cols.sample = old.sample;

  const colsChanged = !old || Object.keys(cols).some((k) => (old[k] || null) !== cols[k]);
  let entriesChanged = false;
  const next = {};
  for (const id of ids) {
    const m = bySample[id];
    const r = rowOf(id);
    const e = r && metadataEntry(r, cols);
    if (!e || ENTRY_FIELDS.every((f) => m[f] === e[f])) {
      next[id] = m;
    } else {
      next[id] = { ...m, ...e, extra: m.extra };
      entriesChanged = true;
    }
  }
  if (!colsChanged && !entriesChanged) return metadata;

  const warnings = Array.isArray(metadata.warnings) ? [...metadata.warnings] : [];
  const moves = [];
  for (const [field, names] of Object.entries(METADATA_COLS)) {
    if (field === "sample" || !old) continue;
    const was = old[field] || null;
    const now = cols[field];
    if (was === now) continue;
    if (!now) moves.push(`${names[0]} is no longer read from ${was}`);
    else if (!was) moves.push(`${names[0]} is now read from ${now}`);
    else moves.push(`${names[0]} is now read from ${now}, not ${was}`);
  }
  if (moves.length > 0 || entriesChanged) {
    warnings.push(
      "Saved by an earlier version, which matched headers more loosely; read again with " +
        "the current rules" +
        (moves.length > 0 ? `: ${moves.join("; ")}.` : ".") +
        (cols.subject
          ? ""
          : " No column is recognised as the subject, so no two samples count as the same " +
            "subject: name the subject column subject_id and upload the file again."),
    );
  }
  return { ...metadata, ...metadataResult(cols, next, warnings) };
}

/** Serialize metadata back to a TSV that parseMetadata reads to the same
    samples, subjects, groups and flags.

    Each recognised field is written under its canonical name (sample_id,
    subject_id, …) with the values of the column it was read from, then
    every other column of the upload as it was. The previous writer put
    empty sample_id / subject_id columns in front of the original ones, so
    a file that said SampleID / patient came back with an empty subject_id,
    and reloading it lost every relatedness. Values keep their spelling
    ("yes" stays "yes"); the canonical columns come first, so a reload
    picks them over any other column matching the same name.

    The mapping written is always the current one (remapMetadata): a
    session saved by an earlier version may still hold a substring
    mapping, which this writer would otherwise make permanent — age_group
    written out as group_id. */
export function metadataToTSV(stored) {
  const metadata = remapMetadata(stored);
  if (!metadata?.bySample || typeof metadata.bySample !== "object") return "";
  const sampleIds = Object.keys(metadata.bySample);
  if (sampleIds.length === 0) return "";
  // Collect the union of all extra keys from the original rows (an entry
  // without a readable row contributes none: see entryRow).
  const allKeys = new Set();
  sampleIds.forEach((id) => {
    const extras = entryRow(metadata.bySample[id]) || {};
    Object.keys(extras).forEach((k) => allKeys.add(k));
  });
  const header = [...allKeys];
  // The header each field was read from.
  const colOf = {};
  for (const k of Object.keys(METADATA_COLS)) colOf[k] = metadata.cols?.[k] || null;
  // The value parseMetadata derived, for a row without the original cell.
  const boolText = (b) => (b === true ? "true" : b === false ? "false" : "");
  const parsedValue = {
    sample: (m, id) => id,
    sampleName: (m) => m.sampleName,
    subject: (m) => m.subject,
    timepoint: (m) => m.timepoint,
    biome: (m) => m.biome,
    lowBiomass: (m) => boolText(m.lowBiomassExplicit),
    lowSequencingDepth: (m) => boolText(m.lowSequencingDepthExplicit),
    groupId: (m) => m.groupId,
  };
  const valueOf = (k, id) => {
    const m = metadata.bySample[id] || {};
    const row = entryRow(m);
    const col = colOf[k];
    if (k !== "sample" && col && row && col in row) return row[col] ?? "";
    return parsedValue[k](m, id) ?? "";
  };
  // sample_id and subject_id always (parseMetadata requires both), the
  // other fields when the upload had them.
  const fields = Object.keys(METADATA_COLS).filter(
    (k) =>
      k === "sample" ||
      k === "subject" ||
      colOf[k] ||
      sampleIds.some((id) => valueOf(k, id) !== ""),
  );
  const names = fields.map((k) => METADATA_COLS[k][0]);
  // The other columns, as they were; one whose name is now taken by a
  // canonical column gets a ".1"-style suffix rather than shadowing it.
  const mapped = new Set(fields.map((k) => colOf[k]).filter(Boolean));
  const extras = header.filter((k) => !mapped.has(k));
  const taken = new Set(names);
  const extraNames = extras.map((k) => {
    let name = k;
    for (let n = 1; taken.has(name); n++) name = `${k}.${n}`;
    taken.add(name);
    return name;
  });
  const lines = [[...names, ...extraNames].map(tsvCell).join("\t")];
  sampleIds.forEach((id) => {
    const extra = entryRow(metadata.bySample[id]) || {};
    const cells = [
      ...fields.map((k) => valueOf(k, id)),
      ...extras.map((k) => extra[k] ?? ""),
    ];
    lines.push(cells.map(tsvCell).join("\t"));
  });
  return lines.join("\n");
}

/* ---------- plate_map.tsv ----------
   Matched like the metadata (pickColExact); canonical name first. */
const PLATE_COLS = {
  sample: ["sample_id", "sample", "id"],
  // The usual plate headers that the substring pass used to catch: without
  // a plate column every sample lands on one plate, and samples of two
  // plates then look adjacent, or share a well.
  plate: ["plate", "plate_id", "plate_name", "plate_number", "plate_no", "plate_barcode"],
  well: ["well", "well_position", "position", "well_id", "pos"],
  // Without a well column, the well may come as two coordinates.
  row: ["row", "well_row"],
  col: ["column", "col", "well_column", "well_col"],
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

/** Row "A".."P" (or its 1-based number "1".."16") and 1-based column
    "1".."24" → {row: 0..15, col: 0..23}, like parseWell; null when either
    is unreadable or off a 384-well plate. */
function parseRowCol(r, c) {
  const rs = String(r ?? "").trim().toUpperCase();
  // 1-based numbers: "A" is row 1
  const rowNo = /^[A-P]$/.test(rs) ? rs.charCodeAt(0) - 64 : parseStrictNumber(rs);
  const colNo = parseStrictNumber(c);
  if (!Number.isInteger(rowNo) || !Number.isInteger(colNo)) return null;
  if (rowNo < 1 || rowNo > 16 || colNo < 1 || colNo > 24) return null;
  return { row: rowNo - 1, col: colNo - 1 };
}

export function wellLabel(row, col) {
  return String.fromCharCode(65 + row) + String(col + 1).padStart(2, "0");
}

export function parsePlateMap(text) {
  const tsv = parseTSV(text);
  const { header, rows, lineNumbers } = tsv;
  const commented = missingColumnsHeaderError(tsv, PLATE_COLS.sample);
  if (commented) throw new Error(commented);
  const csv = notTabSeparated(header);
  if (csv) throw new Error(csv);
  // Returned as `cols`, like the metadata's, for the upload card.
  const cols = {
    sample: pickColExact(header, PLATE_COLS.sample),
    plate: pickColExact(header, PLATE_COLS.plate),
    well: pickColExact(header, PLATE_COLS.well),
    row: pickColExact(header, PLATE_COLS.row),
    col: pickColExact(header, PLATE_COLS.col),
  };
  // The README and the Help have always offered row + column instead of a
  // well column. They count as a pair, and a well column wins: they are
  // read for a row whose well cell is empty, or when there is no well
  // column at all.
  if (!(cols.row && cols.col)) {
    cols.row = null;
    cols.col = null;
  }
  if (!cols.sample || !(cols.well || cols.row)) {
    const names = ["sample", "well", "row", "col", "plate"].map((f) => PLATE_COLS[f].join(", "));
    throw new Error(
      "Missing columns: sample_id and either well or row + column are required (plate " +
        `optional). Accepted names: ${names.join("; ")}. ${headerHint(header)}`,
    );
  }
  const bySample = {};
  let maxRow = 7;
  let maxCol = 11;
  // A repeated id keeps its first placed row (see "duplicated ids" above).
  const seen = new Set();
  const dups = [];
  // A row whose well cannot be read is skipped, and counted unless it was
  // left empty (a sample listed but not plated).
  const unreadable = [];
  rows.forEach((r, i) => {
    const id = r[cols.sample];
    if (!id) return;
    const useWell = cols.well && (String(r[cols.well] ?? "").trim() !== "" || !cols.row);
    const cells = useWell ? [r[cols.well]] : [r[cols.row], r[cols.col]];
    const w = useWell ? parseWell(cells[0]) : parseRowCol(cells[0], cells[1]);
    if (!w) {
      if (cells.some((c) => String(c ?? "").trim() !== "")) {
        unreadable.push({ i, cell: cells.map((c) => String(c ?? "").trim()).join(" / ") });
      }
      return;
    }
    if (seen.has(id)) {
      dups.push(id);
      return;
    }
    seen.add(id);
    bySample[id] = {
      plate: cols.plate ? r[cols.plate] || "P1" : "P1",
      row: w.row,
      col: w.col,
    };
    maxRow = Math.max(maxRow, w.row);
    maxCol = Math.max(maxCol, w.col);
  });
  // A plate map that places no sample would load as an empty plate.
  if (seen.size === 0) {
    const listed = rows.filter((r) => r[cols.sample]).length;
    const first = unreadable[0];
    const none = (n, has, hasNo) => (n === 1 ? `its only row ${hasNo}` : `none of its ${n} rows ${has}`);
    throw new Error(
      listed === 0
        ? "The plate map has no sample rows: " +
            (rows.length === 0
              ? "only its header line was found."
              : `${none(rows.length, "has a sample id", "has no sample id")}.`)
        : `No sample could be placed: ${none(listed, "gives a readable well", "gives no readable well")}` +
            (first
              ? ` (${listed > 1 ? "first " : ""}on line ${lineNumbers[first.i]}: "${clip(first.cell)}").`
              : ` — ${listed > 1 ? "the well cells are" : "its well cell is"} empty.`),
    );
  }
  const format =
    maxRow > 7 || maxCol > 11 ? { rows: 16, cols: 24 } : { rows: 8, cols: 12 };
  const warnings = [];
  if (unreadable.length > 0) {
    const n = unreadable.length;
    const { i, cell } = unreadable[0];
    warnings.push(
      `${n} row${n > 1 ? "s" : ""} with no readable well ${n > 1 ? "were" : "was"} skipped ` +
        `(first on line ${lineNumbers[i]}: "${clip(cell)}").`,
    );
  }
  if (dups.length > 0) warnings.push(duplicateIdsWarning(dups));

  // A well holds one sample. Two in one well is a broken placement — most
  // often a plate column that was not recognised, which puts every sample
  // on one plate — and the "Proximity on plate" criterion would read them
  // as distance 0.
  const byWell = new Map();
  for (const [id, p] of Object.entries(bySample)) {
    const key = `${p.plate}\t${p.row}\t${p.col}`;
    if (!byWell.has(key)) byWell.set(key, []);
    byWell.get(key).push(id);
  }
  const shared = [...byWell.values()].filter((ids) => ids.length > 1);
  if (shared.length > 0) {
    const n = shared.length;
    const ids = shared[0];
    const p = bySample[ids[0]];
    const named =
      ids.slice(0, 3).map((id) => `"${clip(id, 40)}"`).join(", ") + (ids.length > 3 ? ", …" : "");
    // About the file, so it stays true once the Plate tab edits the map.
    warnings.push(
      `The file places more than one sample in ${n > 1 ? `${n} wells (first: ` : "one well ("}` +
        `${wellLabel(p.row, p.col)} on plate ${clip(p.plate, 40)}: ${named}). A well holds one sample: ` +
        "check the well and plate columns.",
    );
  }
  if (!cols.plate) {
    const used = new Set(Object.values(cols).filter(Boolean));
    const plateLike = header.find((h) => !used.has(h) && headerKey(h).includes("plate"));
    if (plateLike || shared.length > 0) {
      warnings.push(
        "No plate column was recognised, so every sample was put on one plate (P1)" +
          (plateLike
            ? `: if "${clip(plateLike, 40)}" names the plate, rename it plate and upload the file again.`
            : "."),
      );
    }
  }
  return { bySample, format, cols, warnings };
}

export function plateMapToTSV(plateMap) {
  const lines = ["sample_id\tplate\twell"];
  Object.entries(plateMap.bySample).forEach(([sid, p]) => {
    lines.push(`${sid}\t${p.plate}\t${wellLabel(p.row, p.col)}`);
  });
  return lines.join("\n");
}

/* ---------- column mapping, for the upload cards ---------- */

/** One entry per recognised field: its canonical name, followed by the
    header it was read from when that is a different name
    ("subject_id ← patient"). */
function mappedFields(cols, aliases) {
  const out = [];
  for (const [key, names] of Object.entries(aliases)) {
    const h = cols[key];
    if (!h) continue;
    out.push(headerKey(h) === headerKey(names[0]) ? names[0] : `${names[0]} ← ${h}`);
  }
  return out;
}

/** The metadata's column mapping in one line: each recognised field with
    the header it was read from, then the columns kept as context only.
    Null without a mapping (no file, or a session saved without one). */
export function metadataColumnsLine(metadata) {
  const cols = metadata?.cols;
  if (!cols) return null;
  const parts = mappedFields(cols, METADATA_COLS);
  const used = new Set(Object.values(cols).filter(Boolean));
  // The header, from the first entry that keeps a row (see entryRow).
  let row = null;
  for (const entry of Object.values(metadata.bySample || {})) {
    row = entryRow(entry);
    if (row) break;
  }
  const other = Object.keys(row || {}).filter((k) => !used.has(k));
  if (other.length > 0) {
    const more = other.length > 4 ? `, +${other.length - 4}` : "";
    parts.push(`other: ${other.slice(0, 4).join(", ")}${more}`);
  }
  return parts.join(" · ");
}

/** The plate map's column mapping in one line, or null. */
export function plateColumnsLine(plateMap) {
  const cols = plateMap?.cols;
  return cols ? mappedFields(cols, PLATE_COLS).join(" · ") : null;
}
