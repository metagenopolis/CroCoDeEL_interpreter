import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMetadata, metadataToTSV } from "../src/parsing.js";
import { flagSample, sampleName, areRelated } from "../src/App.jsx";

/* A1.9 — the metadata download. metadataToTSV forced empty sample_id and
   subject_id columns in front of the original ones, so a file that said
   SampleID / patient came back with an empty subject_id: reloading it lost
   every relatedness. It now writes the canonical names, carrying the
   values of the columns they were read from. */

const tsv = (rows) => rows.map((r) => r.join("\t")).join("\n");

/** Everything the app derives from a metadata table, per sample and per
    pair, so two parses can be compared as a curator would see them. */
function derived(md) {
  const ids = Object.keys(md.bySample).sort();
  const flags = Object.fromEntries(
    ids.map((id) => [id, { ...flagSample(id, md), name: sampleName(md, id) }]),
  );
  const pairs = {};
  for (const a of ids) for (const b of ids) if (a !== b) pairs[`${a}>${b}`] = areRelated(md, a, b);
  return { ids, flags, pairs };
}

const ALIASED = tsv([
  ["SampleID", "display_name", "patient", "visit", "Body Site", "is_low_biomass", "low_depth", "family", "cohort", "age_group"],
  ["S1", "Sample one", "p1", "D0", "gut", "yes", "0", "f1", "A", "adult"],
  ["S2", "", "p1", "D7", "gut", "no", "1", "f1", "A", "adult"],
  ["S3", "Blank 1", "NC1", "D0", "negative control", "1", "", "", "B", ""],
  ["S4", "S4", "p2", "D0", "gut", "", "", "f1", "B", "child"],
]);

describe("metadataToTSV", () => {
  const md = parseMetadata(ALIASED);
  const out = metadataToTSV(md);
  const lines = out.split("\n");

  it("writes canonical names for the recognised columns, then the other columns", () => {
    expect(lines[0].split("\t")).toEqual([
      "sample_id",
      "sample_name",
      "subject_id",
      "timepoint",
      "biome",
      "low_biomass",
      "low_sequencing_depth",
      "group_id",
      "cohort",
      "age_group",
    ]);
  });

  it("carries the values of the columns they were read from, as written", () => {
    expect(lines[1].split("\t")).toEqual(["S1", "Sample one", "p1", "D0", "gut", "yes", "0", "f1", "A", "adult"]);
    expect(lines[3].split("\t")).toEqual(["S3", "Blank 1", "NC1", "D0", "negative control", "1", "", "", "B", ""]);
  });

  it("round-trips: parse → metadataToTSV → parse gives the same relatedness and flags", () => {
    const back = parseMetadata(out);
    expect(derived(back)).toEqual(derived(md));
    // The comparison is not vacuous: the pairs it covers include related
    // ones of both kinds, and the flags a control and a low-biomass sample.
    const d = derived(back);
    expect(d.pairs["S1>S2"]).toMatchObject({ related: true, kind: "subject" });
    expect(d.pairs["S1>S4"]).toMatchObject({ related: true, kind: "group" });
    expect(d.pairs["S2>S3"]).toEqual({ related: false });
    expect(d.flags.S3).toMatchObject({ isControl: true, isLowBiomass: true });
    expect(d.flags.S2).toMatchObject({ isLowSequencingDepth: true });
    expect(d.flags.S1.other).toEqual({ cohort: "A", age_group: "adult" });
  });

  it("round-trips the bundled metadata files unchanged in meaning", () => {
    const root = join(import.meta.dirname, "..", "public");
    for (const p of ["demo/metadata.tsv", "datasets/PRJEB33500/metadata.tsv", "datasets/PRJEB6337/metadata.tsv"]) {
      const first = parseMetadata(readFileSync(join(root, p), "utf8"));
      expect(derived(parseMetadata(metadataToTSV(first))), p).toEqual(derived(first));
    }
  });

  it("keeps a second column that would collide with a canonical name", () => {
    const m = parseMetadata(
      tsv([["sample_id", "Subject ID", "subject_id"], ["S1", "p1", "other"], ["S2", "p1", "x"]]),
    );
    expect(m.cols.subject).toBe("Subject ID");
    const text = metadataToTSV(m);
    expect(text.split("\n")[0]).toBe("sample_id\tsubject_id\tsubject_id.1");
    expect(derived(parseMetadata(text)).pairs).toEqual(derived(m).pairs);
  });

  it("rebuilds the mapping of a session saved without one", () => {
    const m = parseMetadata(ALIASED);
    const { cols: _drop, ...noCols } = m;
    const back = parseMetadata(metadataToTSV(noCols));
    expect(derived(back).pairs).toEqual(derived(m).pairs);
    expect(back.cols.subject).toBe("subject_id");
  });
});
