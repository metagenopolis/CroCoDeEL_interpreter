import { describe, it, expect } from "vitest";
import { parseAbundance, buildScatter, lineDiagnostics } from "../src/App.jsx";
import {
  applyLowAbundanceFilter,
  lowAbundanceFilterFactor,
} from "../src/diagnostics.js";

/* A2.1 — CroCoDeEL's low-abundance filter, applied to the diagnostics.

   With --filter-low-ab F, CroCoDeEL zeroes, in each sample, every value
   ≤ F × that sample's smallest positive value, then rescales each sample
   to sum to 1, before fitting anything (ab_table_utils.filter_low_ab, then
   normalize). The interpreter displayed F and computed every diagnostic
   on the unfiltered table.

   GOLDEN is upstream's output on RAW_TSV — raw counts and raw floats, not
   fractions — obtained with CroCoDeEL's own functions (pandas 2.2.2):

     raw  = ab_table_utils.read(fh)
     filt = ab_table_utils.filter_low_ab(raw, F)
     frac = filt.div(filt.sum(axis=0), axis=1)   # normalize() minus log10

   (cross-checked: 10 ** read_filter_normalize(fh, F) gives the same
   numbers to 1e-14). The interpreter only holds per-sample FRACTIONS,
   and applies the filter to those. The threshold is relative to each
   sample's own minimum, so dividing a column by its total moves the
   values and the threshold together: only exact ties — a value equal to
   F × the minimum — can come out differently, through rounding. The
   table is built to hit them where upstream zeroes them: S1 20 vs
   20 × 1, S2 60 vs 20 × 3, S3 5 vs 20 × 0.25, and S6 the MetaPhlAn-style
   0.0002 vs 20 × 0.00001. The decimal ties upstream KEEPS are a known
   divergence, pinned below. */
const RAW_TSV = [
  "species\tS1\tS2\tS3\tS4\tS5\tS6",
  "sp_a\t1\t0\t0.5\t100\t7\t0.00001",
  "sp_b\t20\t3\t5\t0\t7\t0.0002",
  "sp_c\t21\t60\t10.5\t2000\t7\t0.00021",
  "sp_d\t400\t61\t300\t1999\t0\t0.5",
  "sp_e\t0\t1000\t0\t50000\t0\t12.3456",
  "sp_f\t5\t0\t0.25\t1\t0\t0.00019",
].join("\n");

// S5 (three equal values) is all NaN upstream: everything is ≤ 20 × 7,
// and 0 / 0 follows. See the dedicated test below.
const GOLDEN = {
  20: {
    S1: { sp_a: 0.0, sp_b: 0.0, sp_c: 0.0498812351543943, sp_d: 0.9501187648456056, sp_e: 0.0, sp_f: 0.0 },
    S2: { sp_a: 0.0, sp_b: 0.0, sp_c: 0.0, sp_d: 0.057492931196983975, sp_e: 0.942507068803016, sp_f: 0.0 },
    S3: { sp_a: 0.0, sp_b: 0.0, sp_c: 0.033816425120772944, sp_d: 0.966183574879227, sp_e: 0.0, sp_f: 0.0 },
    S4: { sp_a: 0.0018484630030129946, sp_b: 0.0, sp_c: 0.03696926006025989, sp_d: 0.03695077543022977, sp_e: 0.9242315015064974, sp_f: 0.0 },
    S6: { sp_a: 0.0, sp_b: 0.0, sp_c: 1.634774296054511e-5, sp_d: 0.03892319752510741, sp_e: 0.961060454731932, sp_f: 0.0 },
  },
  2.5: {
    S1: { sp_a: 0.0, sp_b: 0.04484304932735426, sp_c: 0.04708520179372197, sp_d: 0.8968609865470852, sp_e: 0.0, sp_f: 0.011210762331838564 },
    S2: { sp_a: 0.0, sp_b: 0.0, sp_c: 0.05352363960749331, sp_d: 0.054415700267618196, sp_e: 0.8920606601248885, sp_f: 0.0 },
    S3: { sp_a: 0.0, sp_b: 0.01584786053882726, sp_c: 0.03328050713153724, sp_d: 0.9508716323296355, sp_e: 0.0, sp_f: 0.0 },
    S4: { sp_a: 0.0018484630030129946, sp_b: 0.0, sp_c: 0.03696926006025989, sp_d: 0.03695077543022977, sp_e: 0.9242315015064974, sp_f: 0.0 },
    S6: { sp_a: 0.0, sp_b: 1.5568806339617944e-5, sp_c: 1.634724665659884e-5, sp_d: 0.03892201584904485, sp_e: 0.9610312777319363, sp_f: 1.4790366022637046e-5 },
  },
};

const cell = (ab, sp, s) => ab.matrix[sp]?.[s] || 0;

describe("applyLowAbundanceFilter — matches upstream CroCoDeEL", () => {
  const ab = parseAbundance(RAW_TSV);

  for (const factor of [20, 2.5]) {
    it(`reproduces filter_low_ab + normalize at ${factor}×, ties included`, () => {
      const f = applyLowAbundanceFilter(ab, factor);
      for (const [s, col] of Object.entries(GOLDEN[factor])) {
        for (const [sp, want] of Object.entries(col)) {
          const got = cell(f, sp, s);
          if (want === 0) expect([s, sp, got]).toEqual([s, sp, 0]);
          else expect(Math.abs(got - want) / want).toBeLessThan(1e-12);
        }
      }
    });
  }

  it("needs its tie tolerance: dividing by the total alone breaks a raw tie", () => {
    // S1: 20 reads against a minimum of 1, column total 447. In the raw
    // counts 20 ≤ 20 × 1; as fractions 20/447 > 20 × (1/447) by one ulp.
    expect(20 / 447 > 20 * (1 / 447)).toBe(true);
    expect(cell(applyLowAbundanceFilter(ab, 20), "sp_b", "S1")).toBe(0);
  });

  it("empties a sample whose values all fall under the threshold", () => {
    // Upstream divides 0 by 0 there (NaN); an empty column is what the
    // rest of the interpreter already handles.
    const f = applyLowAbundanceFilter(ab, 20);
    for (const sp of f.species) expect(cell(f, sp, "S5")).toBe(0);
  });

  it("keeps every surviving sample summing to 1", () => {
    const f = applyLowAbundanceFilter(ab, 20);
    for (const s of ["S1", "S2", "S3", "S4", "S6"]) {
      const sum = f.species.reduce((acc, sp) => acc + cell(f, sp, s), 0);
      expect(sum).toBeCloseTo(1, 12);
    }
  });

  it("returns a new table and leaves the loaded one untouched", () => {
    const before = JSON.stringify(ab.matrix);
    const f = applyLowAbundanceFilter(ab, 20);
    expect(f).not.toBe(ab);
    expect(f.samples).toBe(ab.samples);
    expect(f.species).toBe(ab.species);
    expect(f.unfiltered).toBe(ab);
    expect(f.lowAbFilter).toBe(20);
    expect(JSON.stringify(ab.matrix)).toBe(before);
    // Axes stay those of the loaded table, so toggling the filter does
    // not rescale every plot.
    expect(f.logRange.min).toBeLessThanOrEqual(ab.logRange.min);
    expect(f.logRange.max).toBeGreaterThanOrEqual(ab.logRange.max);
  });

  it("is a no-op without a positive factor", () => {
    expect(applyLowAbundanceFilter(ab, null)).toBe(ab);
    expect(applyLowAbundanceFilter(ab, 0)).toBe(ab);
    expect(applyLowAbundanceFilter(null, 20)).toBeNull();
  });

  it("reads a sparse table (as restored from storage) the same way", () => {
    const sparse = {
      ...ab,
      matrix: Object.fromEntries(
        Object.entries(ab.matrix).map(([sp, row]) => [
          sp,
          Object.fromEntries(Object.entries(row).filter(([, v]) => v !== 0)),
        ]),
      ),
    };
    const a = applyLowAbundanceFilter(ab, 20);
    const b = applyLowAbundanceFilter(sparse, 20);
    for (const sp of ab.species)
      for (const s of ab.samples) expect(cell(b, sp, s)).toBe(cell(a, sp, s));
  });
});

describe("applyLowAbundanceFilter — known divergence on decimal ties", () => {
  /* Upstream compares the raw values, and its own product F × min can
     round below a tied value: 20 × 0.00007 = 0.0013999999999999998 in
     doubles, under 0.0014, so CroCoDeEL KEEPS sp_b in S1 and S2 — about
     13 % of exact ties between 5-decimal values go that way. The parsed
     table no longer holds the raw values that decide it, so the
     interpreter zeroes every tie, as upstream does for integer counts
     and for S3 here (20 × 0.00003 = 0.0006000000000000001).

     Upstream (same functions as GOLDEN, pandas 2.2.2) on this table: */
  const TIES_TSV = [
    "species\tS1\tS2\tS3",
    "sp_a\t0.00007\t0.00014\t0.00003",
    "sp_b\t0.0014\t0.0028\t0.0006",
    "sp_c\t50.0\t50.0\t50.0",
    "sp_d\t49.99853\t49.99706\t49.99937",
  ].join("\n");
  const UPSTREAM = {
    S1: { sp_a: 0, sp_b: 1.4000009800006858e-5, sp_c: 0.500000350000245, sp_d: 0.499985649989955 },
    S2: { sp_a: 0, sp_b: 2.800003920005488e-5, sp_c: 0.50000070000098, sp_d: 0.4999712999598199 },
    S3: { sp_a: 0, sp_b: 0, sp_c: 0.5000031500198451, sp_d: 0.49999684998015487 },
  };
  const f = applyLowAbundanceFilter(parseAbundance(TIES_TSV), 20);

  it("zeroes the decimal ties upstream keeps (S1, S2)", () => {
    expect(20.0 * 0.00007 < 0.0014).toBe(true); // why upstream keeps sp_b
    expect(UPSTREAM.S1.sp_b).toBeGreaterThan(0);
    expect(cell(f, "sp_b", "S1")).toBe(0);
    expect(cell(f, "sp_b", "S2")).toBe(0);
    // The rest of those samples is rescaled without it: off by the share
    // of the one species upstream kept (1.4e-5 and 2.8e-5).
    for (const s of ["S1", "S2"])
      for (const sp of ["sp_c", "sp_d"])
        expect(Math.abs(cell(f, sp, s) - UPSTREAM[s][sp])).toBeLessThan(3e-5);
  });

  it("matches upstream where its rounding zeroes the tie too (S3)", () => {
    expect(20.0 * 0.00003 < 0.0006).toBe(false);
    for (const [sp, want] of Object.entries(UPSTREAM.S3)) {
      const got = cell(f, sp, "S3");
      if (want === 0) expect([sp, got]).toEqual([sp, 0]);
      else expect(Math.abs(got - want) / want).toBeLessThan(1e-12);
    }
  });
});

describe("lowAbundanceFilterFactor", () => {
  it("reads the factor a CroCoDeEL run declares", () => {
    expect(lowAbundanceFilterFactor({ filtering_ab_thr_factor: "20.0" })).toBe(20);
    expect(lowAbundanceFilterFactor({ filtering_ab_thr_factor: "2.5" })).toBe(2.5);
  });

  it("is null when the run did not filter", () => {
    expect(lowAbundanceFilterFactor(null)).toBeNull();
    expect(lowAbundanceFilterFactor({})).toBeNull();
    expect(lowAbundanceFilterFactor({ filtering_ab_thr_factor: "None" })).toBeNull();
    expect(lowAbundanceFilterFactor({ filtering_ab_thr_factor: "0" })).toBeNull();
    expect(lowAbundanceFilterFactor({ filtering_ab_thr_factor: "" })).toBeNull();
  });
});

describe("the filtered table drives the diagnostics", () => {
  // TGT holds 10 % of SRC on sp_0..sp_19, spread over four decades: at
  // 20× the low half of that line falls under TGT's threshold.
  const lines = ["species\tSRC\tTGT"];
  for (let i = 0; i < 30; i++) {
    const src = 10 ** (-4 * (i / 29));
    lines.push(`sp_${i}\t${src}\t${i < 20 ? 0.1 * src : 0}`);
  }
  const ab = parseAbundance(lines.join("\n"));
  const event = {
    source: "SRC",
    target: "TGT",
    rate: 0.1,
    introduced: Array.from({ length: 20 }, (_, i) => `sp_${i}`),
  };

  it("fits the line on the species CroCoDeEL kept", () => {
    expect(lineDiagnostics(buildScatter(ab, event)).n).toBe(20);
    expect(lineDiagnostics(buildScatter(applyLowAbundanceFilter(ab, 20), event)).n).toBe(10);
  });

  it("keeps the richness of the table as loaded on the scatter", () => {
    const sc = buildScatter(applyLowAbundanceFilter(ab, 20), event);
    expect(sc.targetRichness).toBe(20);
    expect(sc.sourceRichness).toBe(30);
  });
});
