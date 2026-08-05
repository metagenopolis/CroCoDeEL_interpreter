import { describe, it, expect } from "vitest";
import {
  parseAbundance,
  buildCuratedAbundance,
  abundanceToTSV,
} from "../src/App.jsx";

const TSV = [
  "species\tS1\tS2\tS3",
  "sp_shared\t10\t10\t10",
  "sp_only_s2\t0\t10\t0",
  "sp_s1_s3\t10\t0\t10",
].join("\n");

describe("buildCuratedAbundance", () => {
  it("drops the samples flagged suppress and keeps everything else", () => {
    const ab = parseAbundance(TSV);
    const cur = buildCuratedAbundance(ab, {
      S2: { action: "suppress" },
      S1: { action: "keep" },
    });
    expect(cur.samples).toEqual(["S1", "S3"]);
    expect(cur.droppedSamples).toEqual(["S2"]);
  });

  it("leaves the surviving columns bit-for-bit identical", () => {
    // The point of not renormalising: each column of a relative-abundance
    // table is closed on its own, so removing a whole column cannot change
    // another one. A regression here would silently rescale the data.
    const ab = parseAbundance(TSV);
    const cur = buildCuratedAbundance(ab, { S2: { action: "suppress" } });
    for (const sp of cur.species) {
      for (const s of cur.samples) {
        expect(cur.matrix[sp][s]).toBe(ab.matrix[sp][s]);
      }
    }
    for (const s of cur.samples) {
      const sum = cur.species.reduce((acc, sp) => acc + cur.matrix[sp][s], 0);
      expect(sum).toBeCloseTo(1, 10);
    }
  });

  it("drops species left at zero everywhere, by default", () => {
    const ab = parseAbundance(TSV);
    const cur = buildCuratedAbundance(ab, { S2: { action: "suppress" } });
    expect(cur.droppedSpecies).toEqual(["sp_only_s2"]);
    expect(cur.species).toEqual(["sp_shared", "sp_s1_s3"]);
  });

  it("keeps the full species list when asked to", () => {
    const ab = parseAbundance(TSV);
    const cur = buildCuratedAbundance(ab, { S2: { action: "suppress" } }, {
      dropEmptySpecies: false,
    });
    expect(cur.species).toEqual(ab.species);
    expect(cur.droppedSpecies).toEqual([]);
    expect(cur.matrix.sp_only_s2.S1).toBe(0);
  });

  it("matches sample ids case-insensitively, like every other join", () => {
    const ab = parseAbundance(TSV);
    const cur = buildCuratedAbundance(ab, { " s2 ": { action: "suppress" } });
    expect(cur.droppedSamples).toEqual(["S2"]);
  });

  it("is a no-op when nothing is flagged", () => {
    const ab = parseAbundance(TSV);
    const cur = buildCuratedAbundance(ab, { S1: { action: "keep" } });
    expect(cur.samples).toEqual(ab.samples);
    expect(cur.species).toEqual(ab.species);
    expect(cur.droppedSamples).toEqual([]);
  });

  it("ignores curation entries for samples absent from the table", () => {
    const ab = parseAbundance(TSV);
    const cur = buildCuratedAbundance(ab, { NOT_HERE: { action: "suppress" } });
    expect(cur.samples).toEqual(ab.samples);
  });

  it("survives suppressing every sample", () => {
    const ab = parseAbundance(TSV);
    const cur = buildCuratedAbundance(ab, {
      S1: { action: "suppress" },
      S2: { action: "suppress" },
      S3: { action: "suppress" },
    });
    expect(cur.samples).toEqual([]);
    expect(cur.species).toEqual([]);
    expect(abundanceToTSV(cur)).toBe("species");
  });

  it("returns null without an abundance table", () => {
    expect(buildCuratedAbundance(null, {})).toBeNull();
  });

  it("round-trips through abundanceToTSV and parseAbundance", () => {
    const ab = parseAbundance(TSV);
    const cur = buildCuratedAbundance(ab, { S2: { action: "suppress" } });
    const reparsed = parseAbundance(abundanceToTSV(cur));
    expect(reparsed.samples).toEqual(["S1", "S3"]);
    expect(reparsed.species).toEqual(["sp_shared", "sp_s1_s3"]);
    for (const sp of reparsed.species) {
      for (const s of reparsed.samples) {
        expect(reparsed.matrix[sp][s]).toBeCloseTo(cur.matrix[sp][s], 10);
      }
    }
  });
});
