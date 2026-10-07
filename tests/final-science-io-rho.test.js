import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbundance, parseEvents, parseMetadata } from "../src/parsing.js";
import {
  applyLowAbundanceFilter,
  automaticScore,
  buildScatter,
  lineDiagnostics,
  lowAbundanceFilterFactor,
  spearmanRho,
} from "../src/diagnostics.js";
import { areRelated } from "../src/App.jsx";

/* The Spearman ρ of criterion 06, the scatter's badge and the HTML report
   is CroCoDeEL's: over every species of the table, those absent from both
   samples tied below the others, on the table the diagnostics use. It
   ranked only the species present in either sample: for the demo's
   63D29 → 63D40 (one infant, days 29 and 40) 0.50 where CroCoDeEL says
   0.75, so criterion 06 passed a same-subject pair it fails.

   The expected values are CroCoDeEL's own, computed by its code on the
   bundled files (crocodeel 1.2.1, pandas 2.2): the rho plot_conta prints
   above each plot, species_ab_table[target].corr(species_ab_table[source],
   method="spearman") on read_filter_normalize's table with the absences at
   its pseudo-zero — the same, to 1e-12, as feature 5 of its random forest
   (scipy.stats.spearmanr over every species, -inf for an absence). */

const root = join(import.meta.dirname, "..", "public");
const read = (p) => readFileSync(join(root, p), "utf8");

const DEMO_RHO = [
  ["63D250", "63D9", 0.699579658647],
  ["63D29", "63D40", 0.747091668418],
  ["58M", "58D7", 0.882885214276],
  ["58D43", "58D47", 0.707844397524],
  ["69D15", "69D24", 0.760046008786],
  ["83D88", "NC3", 0.495771801702],
  ["58D256", "63D9", 0.700752496403],
  ["60D38", "63D9", 0.630896088496],
  ["83D239", "NC3", 0.487359267453],
  ["82D361", "NC3", 0.514980086396],
  ["63D23", "63D40", 0.655299814696],
  ["58D256", "60D38", 0.608473890634],
  ["60D144", "60D13", 0.711608162943],
  ["58D256", "58D28", 0.58305149196],
  ["82D243", "72D17", 0.618024352047],
  ["82D243", "72D123", 0.535738252243],
  ["63D250", "68D368", 0.579903651273],
  ["79M", "63D9", 0.369839267871],
  ["82D361", "82D243", 0.702354798021],
  ["58D7", "58D28", 0.286084399697],
  ["63D250", "69D49", 0.425652217446],
  ["58M", "58D28", 0.216716544537],
  ["69M", "63D23", 0.080921782707],
  ["79M", "72D362", 0.273834911617],
];
const METAPHLAN4_RHO = [
  ["conta_target_case_010_0.5_1.metaphlan4", "conta_target_case_010_0.5_5_before_conta.metaphlan4", 0.470344780351],
  ["conta_target_case_022_5_1.metaphlan4", "conta_target_case_022_5_10.metaphlan4", 0.527929370345],
  ["conta_target_case_022_0.5_1.metaphlan4", "conta_target_case_022_0.5_5.metaphlan4", 0.655160985662],
  ["conta_target_case_018_0.5_5_before_conta.metaphlan4", "conta_target_case_018_0.5_5.metaphlan4", 0.782128328758],
  ["conta_target_case_016_2_5.metaphlan4", "conta_target_case_016_0.5_5.metaphlan4", 0.884897266384],
  ["conta_target_case_002_0.5_5.metaphlan4", "conta_target_case_002_2_5.metaphlan4", 0.946813788751],
  ["conta_source_case_011_0.5_1.metaphlan4", "conta_source_case_011_2_1.metaphlan4", 1.0],
];

/** The events of a bundled study and its table as the diagnostics see it
    (the low-abundance filter of the run header applied). */
function study(dir) {
  const ev = parseEvents(read(`${dir}/contamination_events.tsv`));
  const ab = parseAbundance(read(`${dir}/species_abundance.tsv`));
  const factor = lowAbundanceFilterFactor(ev.runMetadata);
  return { ev, ab: factor ? applyLowAbundanceFilter(ab, factor) : ab, factor };
}
const rhoOf = (ab, source, target) => spearmanRho(buildScatter(ab, { source, target, rate: 0.1, introduced: [] }));

describe("spearmanRho — CroCoDeEL's rho", () => {
  it("is the rho of CroCoDeEL's PDF for every demo event", () => {
    const { ev, ab, factor } = study("demo");
    expect(factor).toBeNull();
    expect(ev.events.map((e) => [e.source, e.target])).toEqual(DEMO_RHO.map(([s, t]) => [s, t]));
    for (const [s, t, rho] of DEMO_RHO) {
      expect(rhoOf(ab, s, t), `${s} → ${t}`).toBeCloseTo(rho, 10);
    }
  });

  it("is CroCoDeEL's rho on a table filtered by the run's low-abundance factor", () => {
    const { ab, factor } = study("datasets/PRJNA763023_PRJDB4176_metaphlan4");
    expect(factor).toBe(20);
    for (const [s, t, rho] of METAPHLAN4_RHO) {
      expect(rhoOf(ab, s, t), `${s} → ${t}`).toBeCloseTo(rho, 10);
    }
  });

  it("ranks the absences as one tie, as a full ranking of every species does", () => {
    // A full ranking (average ranks) of every species, zeros included.
    const rank = (a) => {
      const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
      const r = new Array(a.length);
      for (let i = 0; i < idx.length; ) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
        for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
        i = j + 1;
      }
      return r;
    };
    const pearson = (x, y) => {
      const mx = x.reduce((s, v) => s + v, 0) / x.length;
      const my = y.reduce((s, v) => s + v, 0) / y.length;
      let a = 0, b = 0, c = 0;
      x.forEach((_, i) => {
        a += (x[i] - mx) * (y[i] - my);
        b += (x[i] - mx) ** 2;
        c += (y[i] - my) ** 2;
      });
      return a / Math.sqrt(b * c);
    };
    let seed = 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 20; trial++) {
      const n = 40 + Math.floor(rnd() * 60);
      const both = Math.floor(rnd() * 200);
      // Present in at least one sample, ties among the positive values too.
      const points = Array.from({ length: n }, () => {
        const x = rnd() < 0.3 ? 0 : Math.round(rnd() * 20) / 1000;
        const y = x === 0 || rnd() < 0.3 ? Math.round(rnd() * 20 + 1) / 1000 : Math.round(rnd() * 20) / 1000;
        return { x, y };
      });
      const xs = [...points.map((p) => p.x), ...new Array(both).fill(0)];
      const ys = [...points.map((p) => p.y), ...new Array(both).fill(0)];
      expect(spearmanRho({ points, nSpecies: n + both })).toBeCloseTo(pearson(rank(xs), rank(ys)), 12);
    }
  });

  it("ranks a scatter built without the table's species count on its points", () => {
    const points = [
      { x: 0.1, y: 0.2 },
      { x: 0.2, y: 0.1 },
      { x: 0.3, y: 0.3 },
      { x: 0, y: 0.05 },
    ];
    // Ranks x 2 3 4 1, y 3 2 4 1: 1 - 6 × 2 / (4 × 15).
    expect(spearmanRho({ points })).toBeCloseTo(0.8, 12);
    expect(spearmanRho({ points: points.slice(0, 2), nSpecies: 100 })).toBeNull();
  });

  it("fails criterion 06 for 63D29 → 63D40, two samples of one infant, as CroCoDeEL's rho says", () => {
    const { ab } = study("demo");
    const metadata = parseMetadata(read("demo/metadata.tsv"));
    const e = { source: "63D29", target: "63D40", rate: 0.675, introduced: [] };
    const di = lineDiagnostics(buildScatter(ab, e));
    expect(di.spearman).toBeCloseTo(0.747091668418, 10);
    const biosim = automaticScore(di, null, null, false, areRelated(metadata, e.source, e.target)).reasons.find(
      (r) => r.key === "biosim",
    );
    expect(biosim.ok).toBe(false);
    expect(biosim.label).toBe("Profiles highly correlated (ρ = 0.75) AND same subject (63) — biological persistence, likely FP");
  });
});
