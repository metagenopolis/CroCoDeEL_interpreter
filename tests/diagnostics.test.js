import { describe, it, expect } from "vitest";
import {
  parseAbundance,
  buildScatter,
  lineDiagnostics,
  pointsAboveLine,
  missingAbundantFromSource,
} from "../src/App.jsx";

/* Build a synthetic source/target pair where the target holds `rate` ×
   source for a known set of species, so we can reason about the expected
   slope, R² and decade range analytically.

   Note the ratio is only nominally `rate`: parseAbundance closes every
   column to sum 1, and the target carries five extra "noise" species the
   source does not, so the two columns are scaled by different totals. At
   the defaults the realised ratio is 0.0575, not 0.05. That does not
   affect slope or R² (a constant factor is an intercept shift in log
   space), but any test that pins the intercept must use the realised
   value. */
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
    // With count === 0 the upper tail P(X >= 0) is exactly 1 — asserting
    // `> 0.05` here would pass no matter what the test computed, which is
    // what made this assertion vacuous.
    expect(result.pValue).toBe(1);
  });

  it("pins expectedMissing and sigma against hand-computed values", () => {
    // Two source species, equal abundance, so after normalisation each is
    // 0.5 in SRC. TGT holds one of them plus its own species.
    //   TGT column: sp_a 1, own 1  → both 0.5 after normalisation.
    //   target LOD = smallest positive value in TGT = 0.5
    //   rate = 0.5 → expected_i = 0.5 * 0.5 = 0.25 for each source species
    //   lambda_i = 0.25 / 0.5 = 0.5   → p_miss = e^-0.5 = 0.6065306597
    // Two evaluable species, so:
    //   expectedMissing = 2 * 0.6065306597 = 1.2130613194
    //   variance = 2 * p(1-p) = 2 * 0.6065306597 * 0.3934693403 = 0.4773
    const tsv = [
      "species\tSRC\tTGT",
      "sp_a\t1\t1",
      "sp_b\t1\t0",
      "own\t0\t1",
    ].join("\n");
    const ab = parseAbundance(tsv);
    const r = missingAbundantFromSource(ab, "SRC", "TGT", 0.5);
    expect(r.targetLOD).toBeCloseTo(0.5, 12);
    expect(r.evaluated).toBe(2);
    const pMiss = Math.exp(-0.5);
    expect(r.expectedMissing).toBeCloseTo(2 * pMiss, 10);
    expect(r.sigma).toBeCloseTo(Math.sqrt(2 * pMiss * (1 - pMiss)), 10);
    // One of the two source species is actually absent from the target.
    expect(r.count).toBe(1);
    // Exact Poisson-binomial: P(X >= 1) = 1 - P(X = 0) = 1 - (1-p)^2.
    expect(r.pValue).toBeCloseTo(1 - (1 - pMiss) ** 2, 12);
  });

  it("separates one miss from zero misses", () => {
    // Same shape as above but with BOTH source species present in the
    // target: the count drops to 0 and the p-value to its ceiling. If the
    // miss counting were off by one, these two tests could not both pass.
    const tsv = [
      "species\tSRC\tTGT",
      "sp_a\t1\t1",
      "sp_b\t1\t1",
      "own\t0\t1",
    ].join("\n");
    const ab = parseAbundance(tsv);
    const r = missingAbundantFromSource(ab, "SRC", "TGT", 0.5);
    expect(r.evaluated).toBe(2);
    expect(r.count).toBe(0);
    expect(r.pValue).toBe(1);
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
    expect(result.count).toBe(4);
    expect(result.evaluated).toBe(5);
    expect(result.zScore).toBeGreaterThan(2);
    // The p-value must be small but REAL. The normal tail this used to use
    // underflowed to exactly 0 here, so `toBeLessThan(0.05)` was satisfied
    // by a number that carried no information.
    expect(result.pValue).toBeLessThan(0.05);
    expect(result.pValue).toBeGreaterThan(0);
  });
});

describe("buildScatter orientation", () => {
  it("puts the target on x and the source on y", () => {
    // This is the axis convention every downstream sign depends on:
    // pointsAboveLine's `dist > 0` means target < rate × source, the
    // half-plane additive contamination cannot reach. A silent flip here
    // would invert criterion 05 without breaking any other assertion.
    const ab = parseAbundance(
      ["species\tSRC\tTGT", "sp_a\t3\t1", "sp_b\t1\t1"].join("\n"),
    );
    const sc = buildScatter(ab, {
      source: "SRC",
      target: "TGT",
      rate: 0.5,
      introduced: ["sp_a"],
    });
    const a = sc.points.find((p) => p.species === "sp_a");
    // SRC column normalises to 0.75 / 0.25, TGT to 0.5 / 0.5.
    expect(a.y).toBeCloseTo(0.75, 12); // source
    expect(a.x).toBeCloseTo(0.5, 12); // target
    expect(sc.logC).toBeCloseTo(Math.log10(0.5), 12);
  });

  it("counts the model-impossible half-plane, where target < rate × source", () => {
    // rate = 0.5. sp_low sits at target 0.1 with source 1.0, so
    // rate × source = 0.5 > 0.1 — impossible under additive contamination
    // and therefore counted. sp_high has target 0.9 with source 0.1, i.e.
    // far MORE than contamination delivers: that is an ordinary native
    // species and must NOT be counted.
    const sc = {
      logC: Math.log10(0.5),
      points: [
        { x: 0.1, y: 1.0, onLine: false },
        { x: 0.9, y: 0.1, onLine: false },
      ],
    };
    const out = pointsAboveLine(sc);
    expect(out.count).toBe(1);
    // log10(0.5 * 1.0 / 0.1) = log10(5) ≈ 0.699
    expect(out.maxDist).toBeCloseTo(Math.log10(5), 10);
  });
});
