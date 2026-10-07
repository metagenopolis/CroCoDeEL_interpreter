import { describe, it, expect } from "vitest";
import {
  parseTSV,
  parseEvents,
  parseAbundance,
  parseMetadata,
  parsePlateMap,
} from "../src/parsing.js";

/* B3.4 — header lines written as comments, and empty header cells.

   parseTSV skips every "#" line before the header, so the header of a
   table written by `biom convert --to-tsv` ("#OTU ID"), a QIIME mapping
   file ("#SampleID") or mOTUs ("#consensus_taxonomy") was dropped and the
   first data row became the header: species sp1 vanished and the samples
   were called "10", "20", "5". CroCoDeEL reads the table with pandas,
   comment="#", and misreads it the same way (checked with
   crocodeel.ab_table_utils.read: columns ['10', '20', '5'], index
   ['sp2', 'sp3']), so the file is refused, with the line to fix.

   An empty header cell between two named ones made a "" column. pandas,
   hence CroCoDeEL, names it "Unnamed: <0-based column>" (checked with
   ab_table_utils.read: ['S1', 'Unnamed: 2', 'S3']), and so does parseTSV
   now — the name CroCoDeEL's events would give that sample. Empty cells at
   the end of the header line are still dropped (tests/a1-parsing-blank-
   lines.test.js). */

const BIOM = [
  "# Constructed from biom file",
  "#OTU ID\tS1\tS2\tS3",
  "sp1\t10\t20\t5",
  "sp2\t30\t40\t6",
  "sp3\t1\t0\t7",
].join("\n");

describe("a header line written as a comment", () => {
  it("refuses a biom-style abundance table, naming the line and the fix", () => {
    let message = "";
    try {
      parseAbundance(BIOM);
    } catch (e) {
      message = e.message;
    }
    expect(message).toMatch(/^Line 2 looks like the header \("#OTU ID", "S1", "S2", …\)/);
    expect(message).toContain('starts with "#"');
    expect(message).toContain('line 3 ("sp1", "10", "20", …) read as the header');
    expect(message).toContain("which marks a comment line, here as in CroCoDeEL");
    expect(message).toMatch(
      /Remove the "#" at the start of line 2 and load the file again \(if CroCoDeEL ran on this table, run it again on the fixed one: it misread it the same way\)\. If line 3 is the header after all \(its sample ids are numbers\), delete line 2 instead\.$/,
    );
  });

  it("loads the same table once the # is removed", () => {
    const ab = parseAbundance(BIOM.replace("#OTU ID", "OTU ID"));
    expect(ab.firstHeader).toBe("OTU ID");
    expect(ab.samples).toEqual(["S1", "S2", "S3"]);
    expect(ab.species).toEqual(["sp1", "sp2", "sp3"]);
    expect(ab.colSums).toEqual({ S1: 41, S2: 60, S3: 18 });
  });

  it("refuses it without the biom comment line too, and with blank lines around", () => {
    expect(() => parseAbundance(BIOM.split("\n").slice(1).join("\n"))).toThrow(
      /^Line 1 looks like the header/,
    );
    expect(() => parseAbundance(`\n${BIOM.replace("\n#OTU", "\n\n#OTU")}`)).toThrow(
      /^Line 4 looks like the header .* line 5 \("sp1"/,
    );
  });

  it("refuses an mOTUs table and a MetaPhlAn profile whose rows end with an empty cell", () => {
    const motus = [
      "# motus version 3.0.3 | merge 3.0.3 | info none",
      "# call: python motus merge -d profiles -o merged.motus",
      "#consensus_taxonomy\tS1\tS2",
      "Abiotrophia defectiva [ref_mOTU_v3_00001]\t0.1\t0",
      "unassigned\t0.9\t1",
    ].join("\n");
    expect(() => parseAbundance(motus)).toThrow(/^Line 3 looks like the header \("#consensus_taxonomy"/);
    const metaphlan = [
      "#mpa_vJun23_CHOCOPhlAnSGB_202403",
      "#SampleID\tMetaphlan_Analysis",
      "#clade_name\tNCBI_tax_id\trelative_abundance\tadditional_species",
      "k__Bacteria\t2\t100.0\t",
      "k__Bacteria|p__Firmicutes\t2|1239\t60.0\t",
    ].join("\n");
    expect(() => parseAbundance(metaphlan)).toThrow(/^Line 3 looks like the header \("#clade_name"/);
  });

  it("refuses a QIIME mapping file as metadata, and the same plate map or events", () => {
    const qiime = [
      "#SampleID\tsubject_id\tBarcodeSequence\tDescription",
      "S1\tP1\tAGCTAGCT\tgut",
      "S2\tP1\tTCGATCGA\tgut",
    ].join("\n");
    expect(() => parseMetadata(qiime)).toThrow(
      /^Line 1 looks like the header \("#SampleID", "subject_id", "BarcodeSequence", …\)/,
    );
    expect(() => parsePlateMap("#sample_id\tplate\twell\nS1\tP1\tA01")).toThrow(/^Line 1 looks/);
    expect(() =>
      parseEvents("#source\ttarget\trate\tprobability\nS1\tS2\t0.1\t0.9"),
    ).toThrow(/^Line 1 looks/);
  });

  it("keeps reading comment lines that are not the header", () => {
    // CroCoDeEL's run header: one cell.
    const { events, runMetadata } = parseEvents(
      [
        "# crocodeel version: 1.2.1 | filtering_ab_thr_factor: None",
        "source\ttarget\trate\tprobability\tcontamination_specific_species",
        "S1\tS2\t0.1\t0.9\tsp_a",
      ].join("\n"),
    );
    expect(events).toHaveLength(1);
    expect(runMetadata).toMatchObject({ "crocodeel version": "1.2.1" });
    // A comment with tabs that is not as wide as the header.
    expect(parseTSV("#note\tabout\nspecies\tS1\tS2\nsp\t1\t2").header).toEqual([
      "species",
      "S1",
      "S2",
    ]);
    // A comment as wide as the header, but with an empty cell.
    expect(parseTSV("#\t\tx\nspecies\tS1\tS2\nsp\t1\t2").header).toEqual(["species", "S1", "S2"]);
    // The header commented out above the same header, uncommented.
    const t = parseTSV("#OTU ID\tS1\tS2\nOTU ID\tS1\tS2\nsp\t1\t2");
    expect(t.header).toEqual(["OTU ID", "S1", "S2"]);
    expect(t.rows).toEqual([{ "OTU ID": "sp", S1: "1", S2: "2" }]);
    expect(t.headerComments).toEqual(["OTU ID\tS1\tS2"]);
  });
});

/* Round 1 of the review: the first version refused any "#" line above
   the header as wide as it, all cells named — a comment above a real
   header too, which CroCoDeEL reads as a comment (crocodeel.ab_table_utils
   .read on "#group\tcase\tcase\tcontrol" above "species\tS1\tS2\tS3":
   columns ['S1', 'S2', 'S3']), and its advice, removing the "#", would
   have made that comment the header. A file is now refused only when the
   line read as its header is not one (a row of numbers in the abundance
   table, no sample id column in the metadata or the plate map, no source
   and target in the events) and a "#" line above it is. */
describe("a '#' line above a header that is one", () => {
  it("loads an abundance table with a comment as wide as its header, as CroCoDeEL does", () => {
    const rows = ["sp1\t1\t2\t3", "sp2\t4\t5\t6"];
    for (const comment of ["#group\tcase\tcase\tcontrol", "#unit\trelab\trelab\trelab", "#a\tb\tc\td"]) {
      const ab = parseAbundance([comment, "species\tS1\tS2\tS3", ...rows].join("\n"));
      expect(ab.samples).toEqual(["S1", "S2", "S3"]);
      expect(ab.species).toEqual(["sp1", "sp2"]);
      expect(ab.colSums).toEqual({ S1: 5, S2: 7, S3: 9 });
    }
    // An old header commented out above the renamed one.
    const renamed = parseAbundance("#OTU ID\tS1\tS2\nOTU_ID\tS1\tS2\nsp1\t1\t2\nsp2\t3\t4");
    expect(renamed.firstHeader).toBe("OTU_ID");
    expect(renamed.samples).toEqual(["S1", "S2"]);
  });

  it("loads a table whose sample ids are numbers when no '#' line lines up with them", () => {
    const ab = parseAbundance("# made by hand\nspecies\t1001\t1002\nsp1\t1\t2\nsp2\t3\t4");
    expect(ab.samples).toEqual(["1001", "1002"]);
    expect(ab.species).toEqual(["sp1", "sp2"]);
  });

  it("loads a metadata file, a plate map and an events file under a two-cell comment", () => {
    const md = parseMetadata("#exported by\tLIMS v2\nsample_id\tsubject_id\nS1\tP1\nS2\tP2");
    expect(Object.keys(md.bySample)).toEqual(["S1", "S2"]);
    const pm = parsePlateMap("#plate\tP1\nsample_id\twell\nS1\tA01\nS2\tA02");
    expect(Object.keys(pm.bySample)).toEqual(["S1", "S2"]);
    const { events } = parseEvents(
      "#note\tby\tthe\tlab\tteam\nsource\ttarget\trate\tprobability\tcontamination_specific_species\nS1\tS2\t0.1\t0.9\tsp1",
    );
    expect(events.map((e) => [e.source, e.target])).toEqual([["S1", "S2"]]);
  });
});

describe("a header written as a comment, in the layouts the review found", () => {
  it("refuses a header whose first cell is only '#', naming that line", () => {
    // pandas reads it like the biom table: columns ['10', '20', '5'].
    expect(() => parseAbundance("#\tS1\tS2\tS3\nsp1\t10\t20\t5\nsp2\t30\t40\t6\nsp3\t1\t0\t7")).toThrow(
      /^Line 1 looks like the header \("#", "S1", "S2", …\) but starts with "#".* line 2 \("sp1", "10", "20", …\) read as the header/,
    );
    // Without the "#", the first cell is empty, as R's write.table writes it.
    const ab = parseAbundance("\tS1\tS2\tS3\nsp1\t10\t20\t5\nsp2\t30\t40\t6\nsp3\t1\t0\t7");
    expect(ab.samples).toEqual(["S1", "S2", "S3"]);
    expect(ab.species).toEqual(["sp1", "sp2", "sp3"]);
  });

  it("refuses a biom table whose rows end with their taxonomy", () => {
    // `biom convert --to-tsv --header-key taxonomy`. CroCoDeEL reads the
    // first row as the header and stops on its taxonomy "sample": "not
    // numeric: k__Bacteria; p__Firmicutes".
    const biom = [
      "# Constructed from biom file",
      "#OTU ID\tS1\tS2\ttaxonomy",
      "otu1\t10\t20\tk__Bacteria; p__Firmicutes",
      "otu2\t30\t40\tk__Bacteria; p__Bacteroidetes",
    ].join("\n");
    expect(() => parseAbundance(biom)).toThrow(
      /^Line 2 looks like the header \("#OTU ID", "S1", "S2", …\).* line 3 \("otu1", "10", "20", …\) read as the header/,
    );
  });

  it("names the '#SampleID' line of a QIIME 2 metadata file, not its '#q2:types' line", () => {
    const qiime2 = [
      "#SampleID\tsubject_id\tbody-site",
      "#q2:types\tcategorical\tcategorical",
      "L1S8\tP1\tgut",
      "L1S57\tP2\tgut",
    ].join("\n");
    expect(() => parseMetadata(qiime2)).toThrow(
      /^Line 1 looks like the header \("#SampleID", "subject_id", "body-site"\) but starts with "#".* line 3 \("L1S8", "P1", "gut"\) read as the header\. Remove the "#" at the start of line 1 and load the file again\.$/,
    );
    // Fixed as the message says: the "#q2:types" line under the header is
    // a comment, not a sample.
    const md = parseMetadata(qiime2.replace(/^#SampleID/, "SampleID"));
    expect(Object.keys(md.bySample)).toEqual(["L1S8", "L1S57"]);
    expect(md.cols.sample).toBe("SampleID");
    expect(md.bySample.L1S57.subject).toBe("P2");
  });

  it("names the header of a QIIME 1 mapping file with a comment under it", () => {
    // The layout of QIIME 1's tutorial Fasting_Map.txt.
    const qiime1 = [
      "#SampleID\tBarcodeSequence\tLinkerPrimerSequence\tTreatment\tDOB\tDescription",
      "#Example mapping file for the QIIME analysis package.  These 9 samples are from a study.",
      "PC.354\tAGCACGAGCCTA\tYATGCTGCCTCCCGTAGGAGT\tControl\t20061218\tControl_mouse_I.D._354",
      "PC.355\tAACTCGTCGATG\tYATGCTGCCTCCCGTAGGAGT\tControl\t20061218\tControl_mouse_I.D._355",
    ].join("\n");
    expect(() => parseMetadata(qiime1)).toThrow(
      /^Line 1 looks like the header \("#SampleID", "BarcodeSequence", "LinkerPrimerSequence", …\).* line 3 \("PC\.354", "AGCACGAGCCTA", "YATGCTGCCTCCCGTAGGAGT", …\) read as the header/,
    );
    // Fixed, the file is read with its own headers: it has no subject
    // column, and the message now lists the right ones.
    expect(() => parseMetadata(qiime1.replace(/^#SampleID/, "SampleID"))).toThrow(
      /^subject_id column not found: .* this file has: SampleID, BarcodeSequence, LinkerPrimerSequence, Treatment, DOB, Description\.$/,
    );
    const md = parseMetadata(
      qiime1.replace(/^#SampleID/, "SampleID").replace("\tDescription", "\tsubject_id"),
    );
    expect(Object.keys(md.bySample)).toEqual(["PC.354", "PC.355"]);
  });
});

/* Round 2 of the review: a header whose sample ids are numbers reads as a
   row of numbers too, and the first version refused it whenever a "#" line
   above lined up with it, advising to remove the "#" — which would have
   made the comment the header. CroCoDeEL reads these tables as they are
   (crocodeel.ab_table_utils.read: columns ['1', '2', '3'], index ['sp1',
   'sp2']; columns ['10317.000001', '10317.000002', '10317.000003']), and so
   does the base parser. The line read as the header is one when its first
   cell names the species column: a usual title ("species", "OTU_ID",
   "clade_name", "id_mgs", …), the first cell of a "#" line above, or
   empty. */
describe("a header of numeric sample ids under a '#' line as wide as it", () => {
  it("reads an old header commented out above the one renamed to numbers, as CroCoDeEL does", () => {
    const ab = parseAbundance("#species\tS1\tS2\tS3\nspecies\t1\t2\t3\nsp1\t1\t2\t3\nsp2\t4\t5\t6");
    expect(ab.firstHeader).toBe("species");
    expect(ab.samples).toEqual(["1", "2", "3"]);
    expect(ab.species).toEqual(["sp1", "sp2"]);
    expect(ab.colSums).toEqual({ 1: 5, 2: 7, 3: 9 });
    // The "#" line is reported, with what to do if it is the header.
    expect(ab.warnings).toEqual([
      'Line 1 ("#species", "S1", "S2", …) starts with "#": it is read as a comment, as CroCoDeEL ' +
        'reads it, and line 2 ("species", "1", "2", …) as the header (its sample ids are numbers). ' +
        'If line 1 is the header, remove its "#", load the file again and run CroCoDeEL again on ' +
        "the fixed table.",
    ]);
  });

  it("reads Qiita sample ids under a '#sample_name' line", () => {
    const ab = parseAbundance(
      [
        "#sample_name\tgut_a\tgut_b\tgut_c",
        "OTU_ID\t10317.000001\t10317.000002\t10317.000003",
        "OTU1\t5\t0\t3",
        "OTU2\t1\t2\t3",
      ].join("\n"),
    );
    expect(ab.firstHeader).toBe("OTU_ID");
    expect(ab.samples).toEqual(["10317.000001", "10317.000002", "10317.000003"]);
    expect(ab.species).toEqual(["OTU1", "OTU2"]);
    expect(ab.warnings).toHaveLength(1);
    expect(ab.warnings[0]).toMatch(/^Line 1 \("#sample_name", "gut_a", "gut_b", …\) starts with "#"/);
  });

  it("knows the species column's title of the usual tables, and an empty or repeated one", () => {
    const comment = "#a\tS1\tS2";
    for (const title of [
      "id_mgs", "id_msp", "species_name", "clade_name", "gtdb_classification", "OTU ID",
      "Feature ID", "FeatureID", "consensus_taxonomy", "Taxon", "msp_name", "name", "",
    ]) {
      const ab = parseAbundance(`${comment}\n${title}\t1001\t1002\nsp1\t1\t2\nsp2\t3\t4`);
      expect(ab.firstHeader).toBe(title);
      expect(ab.samples).toEqual(["1001", "1002"]);
      expect(ab.warnings).toHaveLength(1);
    }
    // Not a usual title, but the one of the "#" line above.
    const bug = parseAbundance("#Bug\tS1\tS2\nBug\t1\t2\nsp1\t1\t2\nsp2\t3\t4");
    expect(bug.samples).toEqual(["1", "2"]);
  });

  it("still refuses a data row read as the header, and says how to load it if it is the header", () => {
    // A species or an OTU, not a title: digits, ranks, a binomial.
    for (const first of ["sp1", "otu1", "GG_OTU_1", "k__Bacteria", "Bacteroides vulgatus", "Bug"]) {
      expect(() => parseAbundance(`#OTU ID\tS1\tS2\n${first}\t10\t20\nsp2\t30\t40`)).toThrow(
        /^Line 1 looks like the header .* If line 2 is the header after all \(its sample ids are numbers\), delete line 1 instead\.$/,
      );
    }
    // Following that advice loads it.
    const ab = parseAbundance("Bug\t10\t20\nsp2\t30\t40");
    expect(ab.samples).toEqual(["10", "20"]);
    expect(ab.warnings).toEqual([]);
  });

  it("warns about nothing when no '#' line lines up with the header", () => {
    for (const comment of ["# made by hand", "#a\tS1", "#a\tS1\tS1"]) {
      const ab = parseAbundance(`${comment}\nspecies\t1\t2\nsp1\t1\t2\nsp2\t3\t4`);
      expect(ab.samples).toEqual(["1", "2"]);
      expect(ab.warnings).toEqual([]);
    }
  });
});

/* pandas (comment="#") skips a "#" line wherever it is; parseTSV skipped
   it above the header only, and read one below it as a row. */
describe("a '#' line under the header", () => {
  it("is a comment in the abundance table, as in CroCoDeEL: no species, no share of the sums", () => {
    // crocodeel.ab_table_utils.read: index ['sp1', 'sp3'].
    const ab = parseAbundance("species\tS1\tS2\nsp1\t1\t2\n#sp2\t3\t4\nsp3\t5\t6");
    expect(ab.species).toEqual(["sp1", "sp3"]);
    expect(ab.colSums).toEqual({ S1: 6, S2: 8 });
  });

  it("is a comment in the other inputs too", () => {
    const md = parseMetadata("sample_id\tsubject_id\nS1\tP1\n#S2\tP2\nS3\tP3");
    expect(Object.keys(md.bySample)).toEqual(["S1", "S3"]);
    const { events } = parseEvents(
      "source\ttarget\trate\tprobability\nS1\tS2\t0.1\t0.9\n# S3\tS4\t0.2\t0.8\nS5\tS6\t0.3\t0.7",
    );
    expect(events.map((e) => e.source)).toEqual(["S1", "S5"]);
    const { rows, lineNumbers } = parseTSV("a\tb\n1\t2\n#x\ty\n3\t4");
    expect(rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
    expect(lineNumbers).toEqual([2, 4]);
  });
});

describe("an empty header cell between named ones", () => {
  it("names it Unnamed: <column>, as pandas does, and keeps its values", () => {
    const ab = parseAbundance(
      ["species\tS1\t\tS3", "sp1\t10\t20\t5", "sp2\t30\t40\t5"].join("\n"),
    );
    expect(ab.samples).toEqual(["S1", "Unnamed: 2", "S3"]);
    expect(ab.colSums["Unnamed: 2"]).toBe(60);
    expect(ab.matrix.sp1["Unnamed: 2"]).toBeCloseTo(20 / 60, 12);
    // A sample whose name is made up is now named in a warning, as one at
    // the end of the header is (tests/final-science-io-layout.test.js).
    expect(ab.warnings).toEqual([
      '1 sample column has no name in the header: read as "Unnamed: 2", the name CroCoDeEL (pandas) gives it.',
    ]);
  });

  it("names a blank one and two in a row, and still drops the trailing ones", () => {
    const { header, rows } = parseTSV(
      ["species\tS1\t \t\tS4\t\t", "sp\t1\t2\t3\t4\t\t"].join("\n"),
    );
    expect(header).toEqual(["species", "S1", "Unnamed: 2", "Unnamed: 3", "S4"]);
    expect(rows).toEqual([
      { species: "sp", S1: "1", "Unnamed: 2": "2", "Unnamed: 3": "3", S4: "4" },
    ]);
  });

  it("leaves an empty first cell as it is (R's write.table with row names)", () => {
    const ab = parseAbundance(['""\tS1\tS2', "sp1\t1\t3", "sp2\t1\t1"].join("\n"));
    expect(ab.firstHeader).toBe("");
    expect(ab.samples).toEqual(["S1", "S2"]);
    expect(ab.species).toEqual(["sp1", "sp2"]);
  });

  it("gives the metadata rows a named column rather than a '' key", () => {
    const md = parseMetadata(
      ["sample_id\t\tsubject_id", "A\tx\tp1", "B\ty\tp2"].join("\n"),
    );
    expect(md.nSamples).toBe(2);
    expect(md.bySample.A.subject).toBe("p1");
    expect(Object.keys(md.bySample.A.extra)).toEqual(["sample_id", "Unnamed: 1", "subject_id"]);
    expect(md.bySample.A.extra["Unnamed: 1"]).toBe("x");
  });
});
