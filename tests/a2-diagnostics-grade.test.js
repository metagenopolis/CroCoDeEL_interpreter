import { describe, it, expect } from "vitest";
import { areRelated } from "../src/App.jsx";
import { parseAbundance } from "../src/parsing.js";
import {
  buildScatter,
  lineDiagnostics,
  pointsAboveLine,
  missingAbundantFromSource,
  automaticScore,
  scoreGrade,
} from "../src/diagnostics.js";

/* A2.2 — an event whose source or target is not in the abundance table
   cannot be scored, and must say so.

   That is the normal situation after a CroCoDeEL `-s2` run (sources from
   one table, targets from another) when only one table is loaded. The
   scatter carries an `error`, but lineDiagnostics still returned
   `{ n: 0 }` for it, automaticScore turned that into "Only 0 species on
   line" — a FAIL — and the event was graded 0 / 1, PROBABLY NOT
   CONTAMINATED. */

const TSV = [
  "species\tSRC\tTGT\tOTHER",
  ...Array.from({ length: 20 }, (_, i) => {
    const src = 10 ** (-4 * (i / 19));
    return `sp_${i}\t${src}\t${0.1 * src}\t${i % 3}`;
  }),
].join("\n");
const metadata = {
  bySample: {
    SRC: { subject: "s1" },
    TGT: { subject: "s2" },
    MISSING: { subject: "s3" },
  },
};

/** The chain the Validate panel runs on the selected event (AppMain). */
function validateScore(ab, event, meta = null) {
  const sc = buildScatter(ab, event);
  const di = lineDiagnostics(sc);
  const above = pointsAboveLine(sc);
  const mi = missingAbundantFromSource(ab, event.source, event.target, event.rate);
  const rel = areRelated(meta, event.source, event.target);
  return { sc, di, above, mi, score: automaticScore(di, above, mi, event.cascade, rel) };
}

describe("an event with a sample missing from the abundance table", () => {
  const ab = parseAbundance(TSV);
  const introduced = ab.species.slice(0, 15);

  for (const [what, event] of [
    ["target", { source: "SRC", target: "MISSING", rate: 0.1, introduced }],
    ["source", { source: "MISSING", target: "TGT", rate: 0.1, introduced }],
    ["source and target", { source: "GONE", target: "MISSING", rate: 0.1, introduced }],
  ]) {
    it(`is not evaluable when the ${what} is missing`, () => {
      const { sc, di, above, mi, score } = validateScore(ab, event, metadata);
      expect(sc.error).toBeTruthy();
      // Diagnostics of an error scatter do not exist — not "0 species".
      expect(di).toBeNull();
      expect(above).toBeNull();
      expect(mi).toBeNull();
      expect(score.grade).toBe("not_evaluable");
      expect(score.total).toBe(0);
      expect(score.reasons.some((r) => r.ok === false)).toBe(false);
    });
  }

  it("still grades a resolvable event of the same table", () => {
    const { score } = validateScore(
      ab,
      { source: "SRC", target: "TGT", rate: 0.1, introduced },
      metadata,
    );
    expect(score.total).toBeGreaterThan(0);
    expect(score.grade).not.toBe("not_evaluable");
  });
});

describe("scoreGrade", () => {
  it("maps the pass count onto the four outcomes", () => {
    expect(scoreGrade(0, 0)).toBe("not_evaluable");
    expect(scoreGrade(6, 6)).toBe("contaminated");
    expect(scoreGrade(4, 6)).toBe("possibly_not"); // ≥ ⌈0.6 × 6⌉ = 4
    expect(scoreGrade(3, 6)).toBe("probably_not");
    expect(scoreGrade(0, 1)).toBe("probably_not");
  });

  it("is what automaticScore reports", () => {
    expect(automaticScore(null, null, null, null, null)).toMatchObject({
      good: 0,
      total: 0,
      reasons: [],
      grade: "not_evaluable",
    });
    const s = automaticScore(
      { n: 3, r2: 0.95, slope: 1, decadeRange: 2, spearman: 0.2 },
      { count: 0, maxDist: 0, farAbove: 0 },
      null,
      null,
      null,
    );
    // r2 ✓, n ✗ (3 ≤ 10), decade ✓, above ✓, biosim ✓ → 4 / 5.
    expect(s.good).toBe(4);
    expect(s.total).toBe(5);
    expect(s.grade).toBe("possibly_not");
  });
});
