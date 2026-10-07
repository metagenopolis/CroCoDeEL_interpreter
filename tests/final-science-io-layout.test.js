import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbundance, parseTSV, parseMetadata, abundanceColumnsLine } from "../src/parsing.js";
import {
  abundanceToTSV,
  buildCuratedAbundance,
  curatedAbundanceProvenance,
} from "../src/exports.js";

/* The abundance table read as CroCoDeEL reads it: pandas,
   read_csv(sep="\t", header=0, index_col=0, comment="#")
   (crocodeel/ab_table_utils.py). Every expected reading below is the one
   ab_table_utils.read gives for the same text (pandas 2.2). */

const root = join(import.meta.dirname, "..", "public");

/** Each value as the table held it: fraction × column sum. */
const values = (ab) =>
  ab.species.map((sp) => ab.samples.map((s) => Math.round(ab.matrix[sp][s] * ab.colSums[s] * 1e9) / 1e9));

/* R's write.table writes the row names without a cell above them, unless
   col.names=NA. These are its outputs, verbatim, for
     x <- data.frame(S1=c(1500L,0L,7L), S2=c(0.25,0.5,NA), S3=c(3L,12L,0L),
                     row.names=c("msp_1","sp 2","10"))
   ab_table_utils.read gives, for each of them: columns ['S1', 'S2', 'S3'],
   index ['msp_1', 'sp 2', '10'], values [[1500, 0.25, 3], [0, 0.5, 12],
   [7, nan, 0]]. */
const R_OUTPUTS = {
  'write.table(x, f, sep="\\t", quote=FALSE)':
    "S1\tS2\tS3\nmsp_1\t1500\t0.25\t3\nsp 2\t0\t0.5\t12\n10\t7\tNA\t0\n",
  'write.table(x, f, sep="\\t")':
    '"S1"\t"S2"\t"S3"\n"msp_1"\t1500\t0.25\t3\n"sp 2"\t0\t0.5\t12\n"10"\t7\tNA\t0\n',
  'write.table(x, f, sep="\\t", quote=FALSE, na="")':
    "S1\tS2\tS3\nmsp_1\t1500\t0.25\t3\nsp 2\t0\t0.5\t12\n10\t7\t\t0\n",
  'write.table(x, f, sep="\\t", quote=FALSE, col.names=NA)':
    "\tS1\tS2\tS3\nmsp_1\t1500\t0.25\t3\nsp 2\t0\t0.5\t12\n10\t7\tNA\t0\n",
  'write.table(x, f, sep="\\t", col.names=NA)':
    '""\t"S1"\t"S2"\t"S3"\n"msp_1"\t1500\t0.25\t3\n"sp 2"\t0\t0.5\t12\n"10"\t7\tNA\t0\n',
};
const R_VALUES = [
  [1500, 0.25, 3],
  [0, 0.5, 12],
  [7, 0, 0],
];

describe("an abundance table written by R's write.table", () => {
  for (const [call, text] of Object.entries(R_OUTPUTS)) {
    it(`reads ${call} as CroCoDeEL does`, () => {
      const ab = parseAbundance(text);
      expect(ab.samples).toEqual(["S1", "S2", "S3"]);
      expect(ab.species).toEqual(["msp_1", "sp 2", "10"]);
      expect(values(ab)).toEqual(R_VALUES);
      expect(ab.warnings).toEqual([]);
      // Without col.names=NA the header has no cell above the row names.
      expect(ab.implicitIndex).toBe(!call.includes("col.names=NA"));
      expect(ab.firstHeader).toBe("");
    });
  }

  it("no longer shifts every sample one column and loses the last one", () => {
    // What the parser read before: samples ['S2', 'S3'], S1's values under
    // S2 and S2's under S3, S3's lost; colSums { S2: 1507, S3: 0.75 }.
    const ab = parseAbundance(R_OUTPUTS['write.table(x, f, sep="\\t", quote=FALSE)']);
    expect(ab.colSums).toEqual({ S1: 1507, S2: 0.75, S3: 15 });
  });

  it("is named on the abundance card", () => {
    const ab = parseAbundance(R_OUTPUTS['write.table(x, f, sep="\\t", quote=FALSE)']);
    expect(abundanceColumnsLine(ab)).toMatch(/^species from the first cell of each row — the header has no cell above them \(R's write.table\)/);
    expect(abundanceColumnsLine(parseAbundance("species\tS1\nsp1\t1"))).toBeNull();
    // A session saved before the flag existed.
    expect(abundanceColumnsLine({ samples: ["S1"] })).toBeNull();
  });

  it("is written back in the same layout, which pandas, R and CroCoDeEL read the same way", () => {
    const text = R_OUTPUTS['write.table(x, f, sep="\\t", quote=FALSE)'];
    const ab = parseAbundance(text);
    // The NA cell is read as 0, and written so (as for any table).
    expect(abundanceToTSV(ab)).toBe(text.trimEnd().replace("\tNA\t", "\t0\t"));
    const back = parseAbundance(abundanceToTSV(ab));
    expect(back.samples).toEqual(ab.samples);
    expect(back.species).toEqual(ab.species);
    expect(values(back)).toEqual(R_VALUES);
    expect(back.implicitIndex).toBe(true);
  });

  it("keeps the layout in the curated table and says so in its provenance", () => {
    const ab = parseAbundance(R_OUTPUTS['write.table(x, f, sep="\\t")']);
    const cur = buildCuratedAbundance(ab, { S2: { action: "suppress" } });
    expect(abundanceToTSV(cur)).toBe("S1\tS3\nmsp_1\t1500\t3\nsp 2\t0\t12\n10\t7\t0");
    const prov = curatedAbundanceProvenance(ab, cur);
    expect(prov).toContain("under a header without a cell above the species, as the input's");
    expect(prov).not.toContain("under its first header");
  });

  it("keeps an empty first header cell (col.names=NA) as written", () => {
    const ab = parseAbundance(R_OUTPUTS['write.table(x, f, sep="\\t", quote=FALSE, col.names=NA)']);
    expect(abundanceToTSV(ab).split("\n")[0]).toBe("\tS1\tS2\tS3");
  });

  it("reads the demo table rewritten without its first header cell as the demo table", () => {
    const text = readFileSync(join(root, "demo/species_abundance.tsv"), "utf8");
    const lines = text.split("\n");
    const rText = [lines[0].split("\t").slice(1).join("\t"), ...lines.slice(1)].join("\n");
    const ab = parseAbundance(text);
    const r = parseAbundance(rText);
    expect(r.samples).toHaveLength(91);
    expect(r.samples).toEqual(ab.samples);
    expect(r.species).toEqual(ab.species);
    expect(r.colSums).toEqual(ab.colSums);
    expect(r.matrix).toEqual(ab.matrix);
    expect(r.implicitIndex).toBe(true);
    expect(r.warnings).toEqual(ab.warnings);
    // Its downloads keep the layout: the header without the species cell.
    expect(abundanceToTSV(r).split("\n")[0]).toBe(rText.split("\n")[0]);
    expect(abundanceToTSV(r).split("\n").slice(1)).toEqual(abundanceToTSV(ab).split("\n").slice(1));
  });

  it("a session saved before the layout flag still exports its first header", () => {
    const ab = parseAbundance("id_mgs\tS1\tS2\nsp1\t1\t2\nsp2\t3\t4");
    const { implicitIndex: _drop, ...saved } = ab;
    expect(abundanceToTSV(saved).split("\n")[0]).toBe("id_mgs\tS1\tS2");
  });
});

/* A row with one tab more than the header at its end (a spreadsheet that
   added an empty column to every row): pandas reads that as a header
   without a cell above the species too, and shifts every sample name —
   ab_table_utils.read gives columns ['species', 'S1', 'S2'] for
   "species\tS1\tS2" over "sp1\t1\t2\t": CroCoDeEL's events name the
   samples one column off. The table is read as its header says, and the
   shift is named. */
describe("rows ending with a tab the header does not have", () => {
  const text = "species\tS1\tS2\nsp1\t1\t2\t\nsp2\t3\t4\t\n";

  it("are read as the header says, with a warning about CroCoDeEL's reading", () => {
    const ab = parseAbundance(text);
    expect(ab.samples).toEqual(["S1", "S2"]);
    expect(values(ab)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(ab.implicitIndex).toBe(false);
    expect(ab.firstHeader).toBe("species");
    expect(ab.warnings).toEqual([
      'The first row (line 2) has one cell more than the header, an empty one at its end (the line ends with a tab). CroCoDeEL reads such a table with pandas, which then takes every header cell, the first one ("species") included, for a sample holding the values of the column after it: its events name the samples one column off. This reads the table as its header says. Remove the tabs at the end of the lines and run CroCoDeEL again on the fixed table.',
    ]);
  });

  it("are a header without a species cell when a later row has a value there", () => {
    // R with na="": the first row's last value is missing, not a stray tab.
    const ab = parseAbundance("S1\tS2\tS3\nsp1\t1\t2\t\nsp2\t3\t4\t5\n");
    expect(ab.samples).toEqual(["S1", "S2", "S3"]);
    expect(values(ab)).toEqual([
      [1, 2, 0],
      [3, 4, 5],
    ]);
    expect(ab.implicitIndex).toBe(true);
    expect(ab.warnings).toEqual([]);
  });

  it("only matter in the abundance table: the other files ignore the extra cell", () => {
    const md = parseMetadata("sample_id\tsubject_id\nA\tp1\t\nB\tp2\t\n");
    expect(md.bySample.A.subject).toBe("p1");
    expect(parseTSV("a\tb\n1\t2\t\n").implicitIndex).toBe(false);
  });
});

/* An empty cell at the end of the header line was dropped with every
   value under it; CroCoDeEL reads that column as a sample, "Unnamed: N"
   (ab_table_utils.read on "species\tS1\tS2\t" over "sp1\t1\t2\t5":
   columns ['S1', 'S2', 'Unnamed: 3'], values 5, 6, 1). */
describe("an empty last header cell", () => {
  it("is a sample named Unnamed: N when values sit under it", () => {
    const ab = parseAbundance("species\tS1\tS2\t\nsp1\t1\t2\t5\nsp2\t3\t4\t6\nsp3\t1\t1\t1\n");
    expect(ab.samples).toEqual(["S1", "S2", "Unnamed: 3"]);
    expect(ab.colSums["Unnamed: 3"]).toBe(12);
    expect(values(ab).map((r) => r[2])).toEqual([5, 6, 1]);
    expect(ab.warnings).toEqual([
      '1 sample column has no name in the header: read as "Unnamed: 3", the name CroCoDeEL (pandas) gives it.',
    ]);
    // The exports keep it.
    expect(abundanceToTSV(buildCuratedAbundance(ab, {})).split("\n")[0]).toBe("species\tS1\tS2\tUnnamed: 3");
  });

  it("is still dropped when nothing is under it", () => {
    for (const text of ["species\tS1\tS2\t\nsp1\t1\t2\nsp2\t3\t4\n", "species\tS1\tS2\t\t\nsp1\t1\t2\t\t\nsp2\t3\t4\t\n"]) {
      const ab = parseAbundance(text);
      expect(ab.samples, JSON.stringify(text)).toEqual(["S1", "S2"]);
      expect(ab.warnings).toEqual([]);
    }
  });

  it("names two of them, and keeps the metadata cells under one", () => {
    const ab = parseAbundance("species\tS1\t\t\nsp1\t1\t2\t3\n");
    expect(ab.samples).toEqual(["S1", "Unnamed: 2", "Unnamed: 3"]);
    expect(ab.warnings[0]).toMatch(/^2 sample columns have no name in the header: read as "Unnamed: 2", "Unnamed: 3", the names CroCoDeEL/);
    const md = parseMetadata("sample_id\tsubject_id\t\nA\tp1\tnote\n");
    expect(md.bySample.A.extra["Unnamed: 2"]).toBe("note");
  });
});

/* pandas' comment="#" ends a line at a "#" anywhere in it, outside a
   quoted cell: ab_table_utils.read gives 'S' for a header cell "S#1",
   reads "2 # x" as 2 and keeps "sp#1" quoted. The events, the metadata and
   the plate map keep a "#" inside a line as text: CroCoDeEL's events
   reader does not cut it, and only this interface reads the other two. */
describe("a '#' inside a line of the abundance table", () => {
  it("ends the line, as in CroCoDeEL, with a warning", () => {
    const ab = parseAbundance("species\tS1\tS2\nsp1\t1\t2 # x\nsp2\t3\t4\n");
    expect(values(ab)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(ab.warnings).toEqual([
      '1 line holds a "#" after its start (first: line 2, "# x"). CroCoDeEL reads the table with pandas, comment="#", which ignores a line from its "#" on, and so does this. If a "#" belongs to a name or a value, remove it and run CroCoDeEL again on the fixed table.',
    ]);
  });

  it("cuts a header cell as CroCoDeEL does", () => {
    // The header is then one cell short: pandas takes it for one without
    // a species cell, so "species" becomes a sample, as in CroCoDeEL.
    const ab = parseAbundance("species\tS#1\tS2\nsp1\t1\t2\nsp2\t3\t4\n");
    expect(ab.samples).toEqual(["species", "S"]);
    expect(ab.warnings[0]).toMatch(/^1 line holds a "#" after its start \(first: line 1, "#1 S2"\)/);
  });

  it("is text inside a quoted cell", () => {
    const ab = parseAbundance('species\tS1\tS2\n"sp#1"\t1\t2\nsp2\t3\t4\n');
    expect(ab.species).toEqual(["sp#1", "sp2"]);
    expect(ab.warnings).toEqual([]);
  });

  it("is text in the other files", () => {
    const md = parseMetadata("sample_id\tsubject_id\tnote\nA\tp1\twell #3\n");
    expect(md.bySample.A.extra.note).toBe("well #3");
    expect(parseTSV("a\tb\n1\tx # y\n").rows[0].b).toBe("x # y");
  });
});
