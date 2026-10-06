import { describe, it, expect } from "vitest";
import { parseAbundance, missingAbundantFromSource } from "../src/App.jsx";

/* A2.6 — the target's limit of detection falls back to 1e-5 when its
   column has FEWER THAN TWO non-zero entries, as the Help tab documents.

   The LOD is estimated as the smallest non-zero relative abundance of the
   target. A column with a single species normalises that species to
   exactly 1, so the "estimate" is 1: a depth of one read, under which
   every source species is expected to be missed and any number of misses
   is "within Poisson noise". The code used to fall back only for an empty
   column, so a one-species target missing 29 of the 30 source species
   passed criterion 04 with p ≈ 0.999. */

function table(rows) {
  return parseAbundance(
    ["species\tSRC\tTGT", ...rows.map((r) => r.join("\t"))].join("\n"),
  );
}

// 30 source species spread over three decades; the target holds only sp_0.
const thirty = Array.from({ length: 30 }, (_, i) => [
  `sp_${i}`,
  (10 ** (-3 * (i / 29))).toPrecision(6),
  i === 0 ? "1" : "0",
]);

describe("missingAbundantFromSource — LOD fallback", () => {
  it("falls back to 1e-5 for a single-species target, which then fails", () => {
    const ab = table(thirty);
    const r = missingAbundantFromSource(ab, "SRC", "TGT", 0.1);
    expect(r.targetLOD).toBe(1e-5);
    expect(r.evaluated).toBe(30);
    expect(r.count).toBe(29);
    // 29 misses out of 30 species expected at λ = 0.1 × src / 1e-5 ≥ 10:
    // far beyond Poisson noise.
    expect(r.pValue).toBeLessThan(0.05);
  });

  it("still falls back for an empty target column", () => {
    const ab = table([
      ["sp_a", "1", "0"],
      ["sp_b", "1", "0"],
      ["other", "0", "0"],
    ]);
    // An all-zero column stays all-zero after normalisation.
    const r = missingAbundantFromSource(ab, "SRC", "TGT", 0.1);
    expect(r.targetLOD).toBe(1e-5);
  });

  it("uses the target's own minimum from two non-zero entries on", () => {
    // TGT: sp_0 = 3, own = 1 → 0.75 / 0.25 after normalisation.
    const ab = table([
      ["sp_0", "1", "3"],
      ["sp_1", "1", "0"],
      ["own", "0", "1"],
    ]);
    const r = missingAbundantFromSource(ab, "SRC", "TGT", 0.1);
    expect(r.targetLOD).toBeCloseTo(0.25, 12);
  });
});
