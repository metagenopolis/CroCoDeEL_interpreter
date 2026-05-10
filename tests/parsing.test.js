import { describe, it, expect } from "vitest";
import { parseAbundance, parseEvents } from "../src/App.jsx";

describe("parseAbundance", () => {
  it("normalises every column to a relative-abundance distribution", () => {
    const tsv = [
      "species\tS1\tS2",
      "sp_a\t40\t10",
      "sp_b\t60\t40",
      "sp_c\t0\t50",
    ].join("\n");
    const ab = parseAbundance(tsv);
    expect(ab.samples).toEqual(["S1", "S2"]);
    expect(ab.species).toEqual(["sp_a", "sp_b", "sp_c"]);
    // S1: 40/100, 60/100, 0
    expect(ab.matrix.sp_a.S1).toBeCloseTo(0.4, 10);
    expect(ab.matrix.sp_b.S1).toBeCloseTo(0.6, 10);
    expect(ab.matrix.sp_c.S1).toBe(0);
    // Each sample sums to 1.
    for (const s of ab.samples) {
      const sum = ab.species.reduce((acc, sp) => acc + ab.matrix[sp][s], 0);
      expect(sum).toBeCloseTo(1, 10);
    }
  });

  it("derives logRange from the non-zero values and clamps the upper bound at 0", () => {
    const tsv = [
      "species\tS1\tS2",
      "sp_a\t1\t1",      // 0.5 each → log10 = -0.301
      "sp_b\t1\t1",      // 0.5 each
      "sp_c\t0.001\t0",  // tiny floor in S1 → 0.0005 → log10 ≈ -3.3
    ].join("\n");
    const ab = parseAbundance(tsv);
    // Smallest non-zero is ~5e-4 → floor ≤ -3. Largest is 0.5 → ceil = 0.
    // Math.ceil(log10(0.5)) returns -0 (true in JS), and Math.min(0, -0)
    // keeps the negative sign; toBeCloseTo treats them as equal.
    expect(ab.logRange.min).toBeLessThanOrEqual(-3);
    expect(ab.logRange.max).toBeCloseTo(0, 10);
  });

  it("falls back to a sentinel range when the matrix is all-zero", () => {
    const tsv = ["species\tS1", "sp_a\t0", "sp_b\t0"].join("\n");
    const ab = parseAbundance(tsv);
    expect(ab.logRange).toEqual({ min: -8, max: 0 });
  });

  it("returns null when only a header is supplied (no sample columns)", () => {
    expect(parseAbundance("species")).toBeNull();
  });

  it("treats non-numeric cells as zero", () => {
    const tsv = ["species\tS1", "sp_a\tNA", "sp_b\t10"].join("\n");
    const ab = parseAbundance(tsv);
    expect(ab.matrix.sp_a.S1).toBe(0);
    expect(ab.matrix.sp_b.S1).toBeCloseTo(1, 10);
  });
});

describe("parseEvents", () => {
  it("parses a CroCoDeEL events file with the canonical column names", () => {
    const tsv = [
      "source\ttarget\trate\tprobability\tcontamination_specific_species",
      "S1\tS2\t0.05\t0.92\tsp_a,sp_b",
      "S3\tS4\t0.01\t0.55\tsp_c",
    ].join("\n");
    const { events } = parseEvents(tsv);
    expect(events).toHaveLength(2);
    expect(events[0].source).toBe("S1");
    expect(events[0].target).toBe("S2");
    expect(events[0].rate).toBeCloseTo(0.05, 10);
    expect(events[0].score).toBeCloseTo(0.92, 10);
    expect(events[0].introduced).toEqual(["sp_a", "sp_b"]);
    expect(events[0].verdict).toBe("pending");
    expect(events[0].id).toBe(0);
    expect(events[1].id).toBe(1);
  });

  it("accepts the legacy `score` column as a fallback for `probability`", () => {
    const tsv = [
      "source\ttarget\trate\tscore\tspecies",
      "A\tB\t0.1\t0.7\tsp_x",
    ].join("\n");
    const { events } = parseEvents(tsv);
    expect(events[0].score).toBeCloseTo(0.7, 10);
    expect(events[0].introduced).toEqual(["sp_x"]);
  });

  it("captures hash-prefixed run-metadata header lines", () => {
    const tsv = [
      "# crocodeel version: 1.2.3 | rate_cutoff: 0.0",
      "source\ttarget\trate\tprobability\tcontamination_specific_species",
      "A\tB\t0.05\t0.9\tsp_a",
    ].join("\n");
    const { runMetadata } = parseEvents(tsv);
    expect(runMetadata).toMatchObject({
      "crocodeel version": "1.2.3",
      rate_cutoff: "0.0",
    });
  });

  it("throws on missing source/target columns", () => {
    const tsv = ["foo\tbar", "1\t2"].join("\n");
    expect(() => parseEvents(tsv)).toThrow(/source\/target/);
  });

  it("throws on an empty file", () => {
    expect(() => parseEvents("source\ttarget\trate")).toThrow(/empty/i);
  });
});
