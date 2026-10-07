import { describe, it, expect } from "vitest";
import { poissonBinomialUpperTail } from "../src/App.jsx";

/* A2.5 — the upper tail must keep its RELATIVE precision when it is tiny.

   P(X ≥ k) used to come out of `1 − P(X ≤ k − 1)` whenever k was the
   short side of the DP. Once the true tail drops under ~1e-16 that
   difference is pure rounding noise: a tail of 2.5e-20 was displayed as
   8.9e-16 in the Validate panel. The complement branch had the mirror
   problem: it rebuilt q_i as `1 − (1 − p_i)`, which loses every digit of a
   p_i below ~1e-16 and half of them at 1e-8.

   The oracle sums the probability of every outcome with at least k
   successes. Every term is a product of non-negative factors and the sum
   has no cancellation, so it is accurate to a few ulps in relative terms —
   which is what the assertions below demand (absolute closeness would be
   satisfied by any number under 1e-12, including the old wrong ones). */
function bruteUpperTail(ps, k) {
  const n = ps.length;
  let total = 0;
  for (let mask = 0; mask < 1 << n; mask++) {
    let prob = 1;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        prob *= ps[i];
        cnt++;
      } else prob *= 1 - ps[i];
    }
    if (cnt >= k) total += prob;
  }
  return total;
}

const relErr = (got, want) =>
  want === 0 ? Math.abs(got) : Math.abs(got - want) / Math.abs(want);

describe("poissonBinomialUpperTail — relative precision", () => {
  const smallP = Array.from({ length: 12 }, (_, i) => 1e-6 * (i + 1));
  const mixed = [0.3, 0.2, 1e-7, 2e-7, 3e-7, 0.1, 1e-8, 5e-8, 0.05, 2e-9];
  const nearOne = [1 - 1e-9, 1 - 2e-9, 0.999999, 0.5, 1 - 1e-12];
  const tinyAll = [1e-10, 2e-10, 3e-10];
  const cases = [
    ["twelve p ≈ 1e-6", smallP],
    ["a few large p among tiny ones", mixed],
    ["p close to 1", nearOne],
    ["every p tiny (complement branch)", tinyAll],
  ];
  for (const [name, ps] of cases) {
    for (let k = 0; k <= ps.length; k++) {
      it(`${name}, k = ${k}`, () => {
        const want = bruteUpperTail(ps, k);
        const got = poissonBinomialUpperTail(ps, k);
        expect(relErr(got, want)).toBeLessThan(1e-12);
      });
    }
  }

  it("returns a 1e-20-scale tail instead of rounding noise", () => {
    // Four misses expected with probabilities around 6.5e-6 each: the
    // exact tail is ~1e-18 — far below what `1 − cdf` can resolve.
    const want = bruteUpperTail(smallP, 4);
    expect(want).toBeLessThan(1e-17);
    expect(want).toBeGreaterThan(0);
    expect(poissonBinomialUpperTail(smallP, 4)).toBeCloseTo(want, 30);
    expect(relErr(poissonBinomialUpperTail(smallP, 4), want)).toBeLessThan(1e-12);
  });

  it("keeps p_i below 1e-16 on the complement side", () => {
    // k = n takes the complement branch; the exact answer is the product.
    const ps = [1e-18, 1e-17, 2e-17];
    const want = 1e-18 * 1e-17 * 2e-17;
    expect(relErr(poissonBinomialUpperTail(ps, 3), want)).toBeLessThan(1e-12);
  });

  it("does not move any decision at the 0.05 threshold", () => {
    // Pass/fail (p ≥ 0.05) must be exactly what the oracle says, on a
    // spread of random problems whose tails straddle the threshold.
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let t = 0; t < 300; t++) {
      const n = 1 + Math.floor(rnd() * 14);
      const ps = Array.from({ length: n }, () =>
        rnd() < 0.3 ? rnd() * 1e-6 : rnd(),
      );
      const k = Math.floor(rnd() * (n + 1));
      const want = bruteUpperTail(ps, k);
      const got = poissonBinomialUpperTail(ps, k);
      expect(got >= 0.05).toBe(want >= 0.05);
      expect(relErr(got, want)).toBeLessThan(1e-11);
    }
  });
});
