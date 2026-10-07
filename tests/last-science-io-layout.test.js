import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbundance, abundanceColumnsLine } from "../src/parsing.js";
import { abundanceToTSV } from "../src/exports.js";

/* Tabs at the end of the lines of an abundance table, read as CroCoDeEL
   reads it: pandas, read_csv(sep="\t", header=0, index_col=0,
   comment="#") (crocodeel/ab_table_utils.py).

   pandas takes a first row with one cell more than the header for a
   header without a cell above the species (R's write.table layout). When
   that extra cell was an empty one, the parser took it for a tab the
   header line does not have — pandas then makes the species column's
   title a sample and shifts every sample one column — and read the table
   as its header says, with a warning. But R's layout with a tab at the
   end of every line, header included (a spreadsheet's empty last
   column), has that same first row, and pandas reads it right: the
   parser read it with the first sample as the species column and every
   sample holding the values of the one before it, and blamed CroCoDeEL
   for it. */

/** Each value as the table held it: fraction × column sum. */
const value = (ab, sp, s) => Math.round(ab.matrix[sp][s] * ab.colSums[s] * 1e9) / 1e9;
const SHIFT = /^The first row \(line 2\) has one cell more than the header/;

/* Every variant: a header layout — "species" or "empty" (R's col.names=NA)
   above the species column, "none" (R's default: the header names the
   samples only), or "none" whose first sample is named like a column
   title ("sample_id") — then the tabs at the end of the header line
   (h0-h2) and of the rows (r0-r2): all of them, the first one only, or
   all but the first ("later"). */
const LAYOUTS = {
  species: ["species", "S1", "S2", "S3"],
  empty: ["", "S1", "S2", "S3"],
  none: ["S1", "S2", "S3"],
  sample_id: ["sample_id", "S2", "S3"],
};
const VALUES = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9],
];
function variant(key) {
  const [layout, h, r, rows = "all"] = key.split(" ");
  const tabs = (n) => "\t".repeat(Number(n.slice(1)));
  const lines = [LAYOUTS[layout].join("\t") + tabs(h)];
  VALUES.forEach((v, i) => {
    const tabbed = rows === "all" || (rows === "first" ? i === 0 : i > 0);
    lines.push([`sp${i + 1}`, ...v].join("\t") + (tabbed ? tabs(r) : ""));
  });
  return lines.join("\n") + "\n";
}
/** The samples the table holds, and its first row. */
const written = (key) => {
  const layout = LAYOUTS[key.split(" ")[0]];
  return [layout.length === 4 ? layout.slice(1) : layout, VALUES[0]];
};

/* ab_table_utils.read's reading of each variant (crocodeel, pandas 2.2):
   its columns and its first row (null: NaN), an all-empty "Unnamed: k"
   column left out — pandas keeps one at the end of a line that ends with
   a tab, which the parser drops — or "index" / "fields" when pandas
   refuses the table ("Could not construct index…", "Expected N fields in
   line L, saw M"). */
const UPSTREAM = {
  "species h0 r0": [["S1", "S2", "S3"], [1, 2, 3]],
  "species h0 r1 all": [["species", "S1", "S2", "S3"], [1, 2, 3, null]],
  "species h0 r1 first": [["species", "S1", "S2", "S3"], [1, 2, 3, null]],
  "species h0 r1 later": "fields",
  "species h0 r2 all": "index",
  "species h0 r2 first": "index",
  "species h0 r2 later": "fields",
  "species h1 r0": [["S1", "S2", "S3"], [1, 2, 3]],
  "species h1 r1 all": [["S1", "S2", "S3"], [1, 2, 3]],
  "species h1 r1 first": [["S1", "S2", "S3"], [1, 2, 3]],
  "species h1 r1 later": [["S1", "S2", "S3"], [1, 2, 3]],
  "species h1 r2 all": [["species", "S1", "S2", "S3"], [1, 2, 3, null]],
  "species h1 r2 first": [["species", "S1", "S2", "S3"], [1, 2, 3, null]],
  "species h1 r2 later": "fields",
  "species h2 r0": [["S1", "S2", "S3"], [1, 2, 3]],
  "species h2 r1 all": [["S1", "S2", "S3"], [1, 2, 3]],
  "species h2 r1 first": [["S1", "S2", "S3"], [1, 2, 3]],
  "species h2 r1 later": [["S1", "S2", "S3"], [1, 2, 3]],
  "species h2 r2 all": [["S1", "S2", "S3"], [1, 2, 3]],
  "species h2 r2 first": [["S1", "S2", "S3"], [1, 2, 3]],
  "species h2 r2 later": [["S1", "S2", "S3"], [1, 2, 3]],
  "empty h0 r0": [["S1", "S2", "S3"], [1, 2, 3]],
  "empty h0 r1 all": [["Unnamed: 0", "S1", "S2", "S3"], [1, 2, 3, null]],
  "empty h0 r1 first": [["Unnamed: 0", "S1", "S2", "S3"], [1, 2, 3, null]],
  "empty h0 r1 later": "fields",
  "empty h0 r2 all": "index",
  "empty h0 r2 first": "index",
  "empty h0 r2 later": "fields",
  "empty h1 r0": [["S1", "S2", "S3"], [1, 2, 3]],
  "empty h1 r1 all": [["S1", "S2", "S3"], [1, 2, 3]],
  "empty h1 r1 first": [["S1", "S2", "S3"], [1, 2, 3]],
  "empty h1 r1 later": [["S1", "S2", "S3"], [1, 2, 3]],
  "empty h1 r2 all": [["Unnamed: 0", "S1", "S2", "S3"], [1, 2, 3, null]],
  "empty h1 r2 first": [["Unnamed: 0", "S1", "S2", "S3"], [1, 2, 3, null]],
  "empty h1 r2 later": "fields",
  "empty h2 r0": [["S1", "S2", "S3"], [1, 2, 3]],
  "empty h2 r1 all": [["S1", "S2", "S3"], [1, 2, 3]],
  "empty h2 r1 first": [["S1", "S2", "S3"], [1, 2, 3]],
  "empty h2 r1 later": [["S1", "S2", "S3"], [1, 2, 3]],
  "empty h2 r2 all": [["S1", "S2", "S3"], [1, 2, 3]],
  "empty h2 r2 first": [["S1", "S2", "S3"], [1, 2, 3]],
  "empty h2 r2 later": [["S1", "S2", "S3"], [1, 2, 3]],
  "none h0 r0": [["S1", "S2", "S3"], [1, 2, 3]],
  "none h0 r1 all": "index",
  "none h0 r1 first": "index",
  "none h0 r1 later": "fields",
  "none h0 r2 all": "index",
  "none h0 r2 first": "index",
  "none h0 r2 later": "fields",
  "none h1 r0": [["S2", "S3", "Unnamed: 3"], [1, 2, 3]],
  "none h1 r1 all": [["S1", "S2", "S3"], [1, 2, 3]],
  "none h1 r1 first": [["S1", "S2", "S3"], [1, 2, 3]],
  "none h1 r1 later": "fields",
  "none h1 r2 all": "index",
  "none h1 r2 first": "index",
  "none h1 r2 later": "fields",
  "none h2 r0": [["S2", "S3", "Unnamed: 3"], [1, 2, 3]],
  "none h2 r1 all": [["S2", "S3", "Unnamed: 3"], [1, 2, 3]],
  "none h2 r1 first": [["S2", "S3", "Unnamed: 3"], [1, 2, 3]],
  "none h2 r1 later": [["S2", "S3", "Unnamed: 3"], [1, 2, 3]],
  "none h2 r2 all": [["S1", "S2", "S3"], [1, 2, 3]],
  "none h2 r2 first": [["S1", "S2", "S3"], [1, 2, 3]],
  "none h2 r2 later": "fields",
  "sample_id h0 r0": [["sample_id", "S2", "S3"], [1, 2, 3]],
  "sample_id h0 r1 all": "index",
  "sample_id h0 r1 first": "index",
  "sample_id h0 r1 later": "fields",
  "sample_id h0 r2 all": "index",
  "sample_id h0 r2 first": "index",
  "sample_id h0 r2 later": "fields",
  "sample_id h1 r0": [["S2", "S3", "Unnamed: 3"], [1, 2, 3]],
  "sample_id h1 r1 all": [["sample_id", "S2", "S3"], [1, 2, 3]],
  "sample_id h1 r1 first": [["sample_id", "S2", "S3"], [1, 2, 3]],
  "sample_id h1 r1 later": "fields",
  "sample_id h1 r2 all": "index",
  "sample_id h1 r2 first": "index",
  "sample_id h1 r2 later": "fields",
  "sample_id h2 r0": [["S2", "S3", "Unnamed: 3"], [1, 2, 3]],
  "sample_id h2 r1 all": [["S2", "S3", "Unnamed: 3"], [1, 2, 3]],
  "sample_id h2 r1 first": [["S2", "S3", "Unnamed: 3"], [1, 2, 3]],
  "sample_id h2 r1 later": [["S2", "S3", "Unnamed: 3"], [1, 2, 3]],
  "sample_id h2 r2 all": [["sample_id", "S2", "S3"], [1, 2, 3]],
  "sample_id h2 r2 first": [["sample_id", "S2", "S3"], [1, 2, 3]],
  "sample_id h2 r2 later": "fields",
};

/* The only variants read otherwise than pandas reads them: rows that end
   with a tab the header line does not have, under a header whose first
   cell is the species column's title — pandas makes that title a sample. */
const READ_AS_HEADER_SAYS = [
  "species h0 r1 all",
  "species h0 r1 first",
  "species h1 r2 all",
  "species h1 r2 first",
  "empty h0 r1 all",
  "empty h0 r1 first",
  "empty h1 r2 all",
  "empty h1 r2 first",
];

describe("tabs at the end of an abundance table's lines", () => {
  const readable = Object.entries(UPSTREAM).filter(([, up]) => typeof up !== "string");

  it("are read as CroCoDeEL reads them, except where its reading shifts the samples", () => {
    const warned = [];
    for (const [key, up] of readable) {
      const ab = parseAbundance(variant(key));
      const read = [ab.samples, ab.samples.map((s) => value(ab, "sp1", s))];
      const shift = ab.warnings.filter((w) => SHIFT.test(w));
      if (shift.length > 0) {
        warned.push(key);
        // Read as written, which CroCoDeEL does not.
        expect(read, key).toEqual(written(key));
        expect(up, key).not.toEqual(written(key));
      } else {
        expect(read, key).toEqual([up[0], up[1].map((v) => v ?? 0)]);
      }
    }
    expect(warned).toEqual(READ_AS_HEADER_SAYS);
  });

  it("read R's layout with a tab at the end of every line as pandas does", () => {
    // What the parser read before: samples ['S2', 'S3', 'Unnamed: 3'],
    // the species from the S1 column, 1 under S2, and a warning that
    // CroCoDeEL reads the table one column off.
    for (const key of ["none h1 r1 all", "none h2 r2 all", "none h1 r1 first"]) {
      const ab = parseAbundance(variant(key));
      expect(ab.samples, key).toEqual(["S1", "S2", "S3"]);
      expect(ab.species, key).toEqual(["sp1", "sp2", "sp3"]);
      expect(ab.colSums, key).toEqual({ S1: 12, S2: 15, S3: 18 });
      expect(ab.implicitIndex, key).toBe(true);
      expect(ab.warnings, key).toEqual([]);
    }
    // A first sample named like a column title: the values past the
    // header's last name make the header one cell short.
    const ab = parseAbundance(variant("sample_id h1 r1 all"));
    expect(ab.samples).toEqual(["sample_id", "S2", "S3"]);
    expect(ab.implicitIndex).toBe(true);
    expect(ab.warnings).toEqual([]);
  });

  it("are named where CroCoDeEL cannot read the table at all", () => {
    for (const [key, up] of Object.entries(UPSTREAM)) {
      const ab = parseAbundance(variant(key));
      const refusal = ab.warnings.filter((w) => /CroCoDeEL cannot read such a table/.test(w));
      expect(refusal, key).toHaveLength(typeof up === "string" ? 1 : 0);
      if (up === "index") {
        expect(refusal[0], key).toMatch(/^The first row \(line 2\) has [23] cells more than the header: CroCoDeEL cannot read such a table \(pandas: "Could not construct index"\)/);
      } else if (up === "fields") {
        expect(refusal[0], key).toMatch(/^Line 3 has \d cells, more than any line above it \(\d\): CroCoDeEL cannot read such a table \(pandas: "Expected \d fields in line …, saw \d"\)/);
      }
    }
  });

  it("read R's layout whose rows end with tabs its header line lacks without a cell above the species", () => {
    // pandas refuses it. The parser read it as its header says, without a
    // word: the species from the S1 column, S1's values under S2, S2's
    // under S3, S3's lost.
    for (const key of ["none h0 r1 all", "none h0 r2 first", "none h1 r2 all"]) {
      const ab = parseAbundance(variant(key));
      expect(ab.samples, key).toEqual(["S1", "S2", "S3"]);
      expect(ab.species, key).toEqual(["sp1", "sp2", "sp3"]);
      expect(ab.colSums, key).toEqual({ S1: 12, S2: 15, S3: 18 });
      expect(ab.implicitIndex, key).toBe(true);
    }
    expect(parseAbundance(variant("none h0 r1 all")).warnings).toEqual([
      'The first row (line 2) has 2 cells more than the header: CroCoDeEL cannot read such a table (pandas: "Could not construct index"). This reads it with the species in the first cell of each row, the header naming the samples only (R\'s layout). Remove the extra cells (often tabs at the end of the lines) before running CroCoDeEL on the table.',
    ]);
    // Under a species-column title, the same row is a stray tab or value.
    for (const text of ["species\tS1\tS2\nsp1\t1\t2\t\t\nsp2\t3\t4\t\t\n", "species\tS1\tS2\nsp1\t1\t2\t9\t\nsp2\t3\t4\n"]) {
      const ab = parseAbundance(text);
      expect(ab.samples, JSON.stringify(text)).toEqual(["S1", "S2"]);
      expect(ab.colSums, JSON.stringify(text)).toEqual({ S1: 4, S2: 6 });
      expect(ab.warnings[0], JSON.stringify(text)).toMatch(/cells more than the header: CroCoDeEL cannot read such a table .* This reads it as its header says\./);
    }
  });

  it("name a value past the header in a later row, which was dropped without a word", () => {
    // ab_table_utils.read: "Expected 3 fields in line 3, saw 4".
    const ab = parseAbundance("species\tS1\tS2\nsp1\t1\t2\nsp2\t3\t4\t9\nsp3\t5\t6\n");
    expect(ab.samples).toEqual(["S1", "S2"]);
    expect(ab.colSums).toEqual({ S1: 9, S2: 12 });
    expect(ab.warnings).toEqual([
      'Line 3 has 4 cells, more than any line above it (3): CroCoDeEL cannot read such a table (pandas: "Expected 3 fields in line …, saw 4"). This reads the cells under the header and leaves the others out. Remove the extra cells (often tabs at the end of the lines) before running CroCoDeEL on the table.',
    ]);
  });

  it("say only that CroCoDeEL cannot read a table it would otherwise read shifted", () => {
    // The first row reads as a shift, but pandas stops on line 3:
    // "Expected 4 fields in line 3, saw 5".
    const ab = parseAbundance("species\tS1\tS2\nsp1\t1\t2\t\nsp2\t3\t4\t\t\nsp3\t5\t6\n");
    expect(ab.samples).toEqual(["S1", "S2"]);
    expect(ab.warnings).toHaveLength(1);
    expect(ab.warnings[0]).toMatch(/^Line 3 has 5 cells, more than any line above it \(4\): CroCoDeEL cannot read such a table/);
  });

  it("still warn where CroCoDeEL shifts the samples", () => {
    const ab = parseAbundance(variant("species h1 r2 all"));
    expect(ab.samples).toEqual(["S1", "S2", "S3"]);
    expect(ab.implicitIndex).toBe(false);
    expect(ab.warnings).toEqual([
      'The first row (line 2) has one cell more than the header, an empty one at its end (the line ends with a tab). CroCoDeEL reads such a table with pandas, which then takes every header cell, the first one ("species") included, for a sample holding the values of the column after it: its events name the samples one column off. This reads the table as its header says. Remove the tabs at the end of the lines and run CroCoDeEL again on the fixed table.',
    ]);
  });
});

/* The reviewers' case: the demo table as R's write.table writes it (the
   header without a cell above the row names), with a tab added at the end
   of every line. ab_table_utils.read gives the demo's 91 samples with
   their values, plus an empty "Unnamed: 91"; the parser gave 40D89 as the
   species column's title, 40M with 40D89's values, …, NC3 with 83D366's
   and "Unnamed: 91" with NC3's — "91 samples × 927 species" on the card,
   and every event graded on the columns of other samples. */
describe("the demo table written by R, with a tab at the end of every line", () => {
  const text = readFileSync(join(import.meta.dirname, "..", "public", "demo", "species_abundance.tsv"), "utf8");
  const lines = text.replace(/\n$/, "").split("\n");
  const rLines = [lines[0].split("\t").slice(1).join("\t"), ...lines.slice(1)];
  const ab = parseAbundance(text);

  it("reads as the demo table, quoted (R's default) or not", () => {
    const quote = (c) => `"${c}"`;
    const quoted = [
      rLines[0].split("\t").map(quote).join("\t"),
      ...rLines.slice(1).map((l) => l.split("\t").map((c, i) => (i === 0 ? quote(c) : c)).join("\t")),
    ];
    for (const r of [rLines, quoted]) {
      const tabbed = parseAbundance(r.map((l) => `${l}\t`).join("\n") + "\n");
      expect(tabbed.samples).toHaveLength(91);
      expect(tabbed.samples).toEqual(ab.samples);
      expect(tabbed.species).toEqual(ab.species);
      expect(tabbed.colSums).toEqual(ab.colSums);
      expect(tabbed.matrix).toEqual(ab.matrix);
      expect(tabbed.implicitIndex).toBe(true);
      expect(tabbed.warnings).toEqual(ab.warnings);
    }
  });

  it("is named on its card and written back in R's layout, without the tabs", () => {
    const tabbed = parseAbundance(rLines.map((l) => `${l}\t`).join("\n"));
    expect(abundanceColumnsLine(tabbed)).toMatch(/^species from the first cell of each row/);
    const out = abundanceToTSV(tabbed).split("\n");
    expect(out[0]).toBe(rLines[0]);
    expect(out.slice(1)).toEqual(abundanceToTSV(ab).split("\n").slice(1));
  });
});
