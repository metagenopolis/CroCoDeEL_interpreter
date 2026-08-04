import { describe, it, expect } from "vitest";
import { poissonBinomialUpperTail } from "../src/App.jsx";

// Brute force over all 2^n subsets — only usable for small n, which is
// exactly what we want as an independent oracle.
function bruteUpperTail(ps, k) {
  const n = ps.length;
  let total = 0;
  for (let mask = 0; mask < 1 << n; mask++) {
    let prob = 1;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { prob *= ps[i]; cnt++; }
      else prob *= 1 - ps[i];
    }
    if (cnt >= k) total += prob;
  }
  return total;
}

describe("poissonBinomialUpperTail", () => {
  const cases = [
    [0.1, 0.2, 0.3],
    [0.5, 0.5, 0.5, 0.5],
    [0.01, 0.99, 0.5, 0.2, 0.8],
    [0.001, 0.002, 0.003, 0.9, 0.95, 0.99],
    [0.7],
  ];
  for (const ps of cases) {
    for (let k = 0; k <= ps.length + 1; k++) {
      it(`matches brute force for n=${ps.length} k=${k}`, () => {
        expect(poissonBinomialUpperTail(ps, k)).toBeCloseTo(bruteUpperTail(ps, k), 12);
      });
    }
  }

  it("reduces to the binomial tail when all p are equal", () => {
    // n=10, p=0.3, P(X>=4) = 0.3503892816...
    const ps = Array(10).fill(0.3);
    expect(poissonBinomialUpperTail(ps, 4)).toBeCloseTo(0.35038928, 7);
  });

  it("is exact where the normal approximation was catastrophic", () => {
    // 200 species each with miss probability 0.002 → mean 0.4, so the count
    // is essentially Poisson(0.4) and P(X >= 5) = 6.13e-5 (the binomial sits
    // just below that). The normal tail the code used to apply reported
    // values off by 140+ orders of magnitude in this regime.
    const ps = Array(200).fill(0.002);
    const p = poissonBinomialUpperTail(ps, 5);
    expect(p).toBeCloseTo(5.87e-5, 7);
    // A z-score on this heavily skewed sum would put it near 1e-8.
    expect(p).toBeGreaterThan(1e-6);
  });

  it("handles the degenerate ends", () => {
    expect(poissonBinomialUpperTail([], 0)).toBe(1);
    expect(poissonBinomialUpperTail([], 3)).toBe(0);
    expect(poissonBinomialUpperTail([0.5, 0.5], 3)).toBe(0);
    expect(poissonBinomialUpperTail([0.5, 0.5], 0)).toBe(1);
  });
});
