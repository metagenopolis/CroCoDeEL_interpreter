import { describe, it, expect } from "vitest";
import {
  parseAbundance,
  buildScatter,
  lineDiagnostics,
  pointsAboveLine,
  missingAbundantFromSource,
} from "../src/App.jsx";

/* Build a synthetic source/target pair where the target is exactly
   `rate` × source for a known set of species, so we can reason about
   the expected slope, R² and decade range analytically. */
function syntheticAb({ rate = 0.05, nOnLine = 30 } = {}) {
  // Source distribution spans 5 decades of relative abundance: each
  // species `sp_i` gets x_i = 10^(-i/(n-1) × 5) before normalisation.
  const lines = ["species\tSRC\tTGT"];
  const raw = [];
  for (let i = 0; i < nOnLine; i++) {
    const src = Math.pow(10, -(i / (nOnLine - 1)) * 5);
    raw.push({ sp: `sp_${i}`, src });
  }
  // Add a handful of "noise" species present only in TGT — represents
  // the target's own microbiome on top of the contamination line.
  for (let j = 0; j < 5; j++) {
    raw.push({ sp: `noise_${j}`, src: 0, tgt: 0.5 });
  }
  raw.forEach((r) => {
    if (r.tgt != null) {
      lines.push(`${r.sp}\t0\t${r.tgt}`);
    } else {
      const tgt = rate * r.src;
      lines.push(`${r.sp}\t${r.src}\t${tgt}`);
    }
  });
  return parseAbundance(lines.join("\n"));
}

describe("lineDiagnostics", () => {
  it("returns nulls for an empty / single-point line", () => {
    expect(lineDiagnostics({ points: [] })).toMatchObject({
      n: 0,
      r2: null,
      slope: null,
      decadeRange: null,
    });
    expect(
      lineDiagnostics({
        points: [{ x: 0.1, y: 0.01, onLine: true }],
      }),
    ).toMatchObject({ n: 1, r2: null });
  });

  it("recovers slope ≈ 1, R² ≈ 1 on a clean log-linear contamination line", () => {
    const ab = syntheticAb({ rate: 0.05, nOnLine: 30 });
    const introduced = ab.species.filter((s) => s.startsWith("sp_"));
    const sc = buildScatter(ab, {
      source: "SRC",
      target: "TGT",
      rate: 0.05,
      introduced,
    });
    const di = lineDiagnostics(sc);
    expect(di.n).toBe(introduced.length);
    expect(di.slope).toBeCloseTo(1, 2);
    expect(di.r2).toBeGreaterThan(0.99);
    // The synthetic source spans 5 decades, so the line should stretch
    // close to that.
    expect(di.decadeRange).toBeGreaterThan(4);
  });
});

describe("pointsAboveLine", () => {
  it("returns null when the scatter has no logC", () => {
    expect(pointsAboveLine({ points: [], logC: null })).toBeNull();
  });

  it("counts off-line points sitting > 0.1 decade above y = x / rate", () => {
    // points.x is target abundance, points.y is source abundance. The
    // contamination line is y = x / rate, i.e. log y = log x − logC. With
    // rate = 0.1 (logC = -1) and x = 0.01, the line predicts y = 0.1.
    const sc = {
      logC: Math.log10(0.1),
      points: [
        { x: 0.01, y: 1.0, onLine: false },   // 1 decade above → counted, far
        { x: 0.01, y: 0.1, onLine: false },   // exactly on the line → not counted
        { x: 0.01, y: 0.13, onLine: false },  // ~0.11 decade above → counted, near
        { x: 0.01, y: 1.0, onLine: true },    // on-line points are ignored
      ],
    };
    const out = pointsAboveLine(sc);
    expect(out.count).toBe(2);
    expect(out.farAbove).toBe(1); // only y = 1.0 is ≥ 0.5 decade above
    expect(out.maxDist).toBeGreaterThan(0.99);
    expect(out.maxDist).toBeLessThanOrEqual(1.0001);
  });
});

describe("missingAbundantFromSource", () => {
  it("returns null when either sample is missing", () => {
    const ab = parseAbundance(
      "species\tA\tB\nsp_a\t1\t1\nsp_b\t1\t1",
    );
    expect(missingAbundantFromSource(ab, "A", "Z", 0.1)).toBeNull();
    expect(missingAbundantFromSource(ab, null, "B", 0.1)).toBeNull();
  });

  it("expects ~zero misses on a clean synthetic contamination", () => {
    const ab = syntheticAb({ rate: 0.05, nOnLine: 30 });
    const result = missingAbundantFromSource(ab, "SRC", "TGT", 0.05);
    expect(result.evaluated).toBeGreaterThan(0);
    // Synthetic case: every source species is present in the target at
    // rate × src above the LOD, so we expect zero observed misses.
    expect(result.count).toBe(0);
    expect(result.pValue).toBeGreaterThan(0.05);
  });

  it("flags a strongly significant Z-score when most source-abundant species are absent", () => {
    // Source is rich, target shares only one species — the rest are
    // observed-missing, which is wildly more than the model predicts
    // under a real contamination at a high rate.
    const tsv = [
      "species\tSRC\tTGT",
      "sp_a\t100\t1",   // shared
      "sp_b\t100\t0",   // missed
      "sp_c\t100\t0",   // missed
      "sp_d\t100\t0",   // missed
      "sp_e\t100\t0",   // missed
      "noise\t0\t100",
    ].join("\n");
    const ab = parseAbundance(tsv);
    const result = missingAbundantFromSource(ab, "SRC", "TGT", 0.5);
    expect(result.count).toBeGreaterThan(2);
    expect(result.zScore).toBeGreaterThan(2);
    expect(result.pValue).toBeLessThan(0.05);
  });
});
