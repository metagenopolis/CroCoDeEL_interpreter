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
    expect(message).toMatch(/Remove the "#" at the start of line 2 and load the file again\.$/);
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

describe("an empty header cell between named ones", () => {
  it("names it Unnamed: <column>, as pandas does, and keeps its values", () => {
    const ab = parseAbundance(
      ["species\tS1\t\tS3", "sp1\t10\t20\t5", "sp2\t30\t40\t5"].join("\n"),
    );
    expect(ab.samples).toEqual(["S1", "Unnamed: 2", "S3"]);
    expect(ab.colSums["Unnamed: 2"]).toBe(60);
    expect(ab.matrix.sp1["Unnamed: 2"]).toBeCloseTo(20 / 60, 12);
    expect(ab.warnings).toEqual([]);
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
