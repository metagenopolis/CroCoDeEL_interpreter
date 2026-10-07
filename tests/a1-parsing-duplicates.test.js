import { describe, it, expect } from "vitest";
import {
  parseMetadata,
  parsePlateMap,
  parseAbundance,
} from "../src/parsing.js";

/* A1.4 — duplicated ids. The metadata and the plate map silently kept the
   LAST row of a repeated sample id; the abundance table refused a repeat
   but named only the first one. One rule now: a duplicate is always
   reported; the abundance table refuses it, the metadata and the plate map
   use the first row of each id. */

const tsv = (rows) => rows.map((r) => r.join("\t")).join("\n");

describe("parseMetadata — duplicated sample ids", () => {
  const md = parseMetadata(
    tsv([
      ["sample_id", "subject_id"],
      ["S1", "p1"],
      ["S2", "p2"],
      ["S1", "p9"],
      ["S1", "p8"],
      ["S2", "p7"],
      ["S3", "p3"],
    ]),
  );

  it("keeps the first row of each id", () => {
    expect(md.nSamples).toBe(3);
    expect(md.bySample.S1.subject).toBe("p1");
    expect(md.bySample.S2.subject).toBe("p2");
    expect(md.bySample.S1.extra.subject_id).toBe("p1");
  });

  it("warns, naming the count and the duplicated ids", () => {
    expect(md.warnings).toEqual([
      '2 sample ids appear on more than one row ("S1", "S2"): the first row of each is used, the later ones are ignored.',
    ]);
  });

  it("has no warning for a clean file", () => {
    expect(parseMetadata(tsv([["sample_id", "subject_id"], ["S1", "p1"]])).warnings).toEqual([]);
  });

  it("names at most three ids", () => {
    const rows = [["sample_id", "subject_id"]];
    for (const id of ["A", "B", "C", "D", "E"]) rows.push([id, "p"], [id, "q"]);
    expect(parseMetadata(tsv(rows)).warnings[0]).toMatch(
      /^5 sample ids appear on more than one row \("A", "B", "C" and 2 more\)/,
    );
  });

  // An id such as `constructor` is refused now, named, rather than read
  // as an ordinary id: the app keys its tables by id in plain objects,
  // where it reads as present everywhere (tests/final-science-io-ids.test.js).
  it("refuses an id such as `constructor`, which no plain object can key", () => {
    expect(() =>
      parseMetadata(tsv([["sample_id", "subject_id"], ["constructor", "p1"], ["toString", "p2"]])),
    ).toThrow(/^The sample "constructor" \(line 2 of the metadata\) cannot be read/);
  });
});

describe("parsePlateMap — duplicated sample ids", () => {
  it("keeps the first well of each id and warns", () => {
    const pm = parsePlateMap(
      tsv([
        ["sample_id", "plate", "well"],
        ["S1", "P1", "A01"],
        ["S1", "P1", "B02"],
        ["S2", "P1", "C03"],
      ]),
    );
    expect(pm.bySample.S1).toEqual({ plate: "P1", row: 0, col: 0 });
    expect(pm.warnings).toEqual([
      '1 sample id appears on more than one row ("S1"): the first row of each is used, the later ones are ignored.',
    ]);
  });

  it("does not count as duplicate a row whose well could not be read", () => {
    const pm = parsePlateMap(
      tsv([
        ["sample_id", "plate", "well"],
        ["S1", "P1", "Z99"],
        ["S1", "P1", "B02"],
      ]),
    );
    expect(pm.bySample.S1).toEqual({ plate: "P1", row: 1, col: 1 });
    expect(pm.warnings.some((w) => /more than one row/.test(w))).toBe(false);
  });
});

describe("parseAbundance — duplicated samples and species are refused, all named", () => {
  it("names every repeated sample column", () => {
    expect(() =>
      parseAbundance(tsv([["species", "S1", "S2", "S1", "S2", "S3"], ["sp_a", "1", "2", "3", "4", "5"]])),
    ).toThrow(
      '2 sample columns appear more than once in the abundance table ("S1", "S2"). Each sample must appear exactly once',
    );
  });

  it("names every repeated species row", () => {
    expect(() =>
      parseAbundance(tsv([["species", "S1"], ["sp_a", "1"], ["sp_b", "2"], ["sp_a", "3"]])),
    ).toThrow(
      '1 species row appears more than once in the abundance table ("sp_a"). Each species must appear exactly once',
    );
  });
});
