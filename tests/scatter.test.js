import { describe, it, expect } from "vitest";
import { parseAbundance, buildScatter } from "../src/App.jsx";

const ABUNDANCE_TSV = [
  "species\tA\tB\tC",
  "sp_a\t100\t10\t0",   // shared, source-dominant
  "sp_b\t50\t50\t0",    // shared
  "sp_c\t10\t0\t0",     // source-only — should appear missing in target
  "sp_d\t0\t100\t0",    // target-only — should still appear in scatter
  "sp_e\t1\t1\t100",    // unrelated to the A→B pair
].join("\n");

describe("buildScatter", () => {
  it("returns null when the abundance table is missing", () => {
    expect(buildScatter(null, { source: "A", target: "B", rate: 0.1 })).toBeNull();
  });

  it("flags an error when either sample is not in the matrix", () => {
    const ab = parseAbundance(ABUNDANCE_TSV);
    const sc = buildScatter(ab, {
      source: "Z",
      target: "B",
      rate: 0.1,
      introduced: [],
    });
    expect(sc.error).toMatch(/Source sample.*Z.*not found/);
    expect(sc.points).toEqual([]);
  });

  it("emits one point per species present in either sample (skips both-zero)", () => {
    const ab = parseAbundance(ABUNDANCE_TSV);
    const sc = buildScatter(ab, {
      source: "A",
      target: "B",
      rate: 0.1,
      introduced: ["sp_a", "sp_b"],
    });
    // sp_e present in A and B (1 each, normalised), sp_c source-only, sp_d
    // target-only — all four should be present. sp_a / sp_b too.
    const seen = new Set(sc.points.map((p) => p.species));
    expect(seen).toEqual(new Set(["sp_a", "sp_b", "sp_c", "sp_d", "sp_e"]));
  });

  it("marks the introduced species as `onLine`", () => {
    const ab = parseAbundance(ABUNDANCE_TSV);
    const sc = buildScatter(ab, {
      source: "A",
      target: "B",
      rate: 0.1,
      introduced: ["sp_a", "sp_b"],
    });
    const onLine = sc.points.filter((p) => p.onLine).map((p) => p.species);
    expect(onLine.sort()).toEqual(["sp_a", "sp_b"]);
  });

  it("encodes the contamination line as logC = log10(rate); null when rate is 0", () => {
    const ab = parseAbundance(ABUNDANCE_TSV);
    const sc = buildScatter(ab, {
      source: "A",
      target: "B",
      rate: 0.05,
      introduced: [],
    });
    expect(sc.logC).toBeCloseTo(Math.log10(0.05), 10);

    const scNoRate = buildScatter(ab, {
      source: "A",
      target: "B",
      rate: 0,
      introduced: [],
    });
    expect(scNoRate.logC).toBeNull();
  });

  it("places the target abundance on x and the source on y", () => {
    const ab = parseAbundance(ABUNDANCE_TSV);
    const sc = buildScatter(ab, {
      source: "A",
      target: "B",
      rate: 0.1,
      introduced: [],
    });
    const sp_d = sc.points.find((p) => p.species === "sp_d");
    // sp_d only exists in B (the target). x is target → should be > 0;
    // y is source → should be 0.
    expect(sp_d.x).toBeGreaterThan(0);
    expect(sp_d.y).toBe(0);
  });
});
