import { describe, it, expect } from "vitest";
import { parseAbundance, buildCuratedAbundance } from "../src/App.jsx";
import {
  neverTargetedSamples,
  buildEffectiveSampleCuration,
  sampleActionCounts,
  syncSampleCuration,
  withManualVerdict,
  withManualAction,
} from "../src/curation.js";

/* Overview, the Samples tab, Export and both HTML reports count samples to
   keep / suppress with sampleActionCounts over the effective curation.
   "To suppress" must be exactly what the curated abundance table drops;
   "to keep" counts Keep decisions, not the default of a never-targeted
   sample. */

const TSV = [
  "species\tA\tB\tC\tT\tU\tV",
  "sp1\t10\t10\t10\t10\t10\t10",
  "sp2\t0\t5\t0\t5\t0\t5",
].join("\n");

// A, B and C are sources only; T, U and V are targets.
const events = [
  { id: 0, source: "A", target: "T", verdict: "true_positive" },
  { id: 1, source: "B", target: "U", verdict: "false_positive" },
  { id: 2, source: "C", target: "V", verdict: "pending" },
];

function curation() {
  let sc = syncSampleCuration({}, events); // T: automatic Contaminated + Suppress
  sc = withManualAction(sc, "U", "suppress", events); // Suppress kept by hand on a FP target
  sc = withManualAction(sc, "B", "keep", events); // a Keep decision on a source
  sc = withManualVerdict(sc, "C", "contaminated", events); // C: Contaminated + automatic Suppress
  sc = withManualAction(sc, "V", "keep", events); // Keep on a pending target
  return sc;
}

describe("sampleActionCounts against the curated abundance export", () => {
  const ab = parseAbundance(TSV);
  const stored = curation();
  const effective = buildEffectiveSampleCuration(
    stored,
    neverTargetedSamples(events, ab.samples),
  );

  it("counts as 'to suppress' exactly the samples the export drops", () => {
    const counts = sampleActionCounts(effective);
    const curated = buildCuratedAbundance(ab, effective);
    expect(curated.droppedSamples.sort()).toEqual(["C", "T", "U"]);
    expect(counts.suppress).toBe(curated.droppedSamples.length);
    // The stored map drops the same columns: the default adds no Suppress.
    expect(buildCuratedAbundance(ab, stored).droppedSamples.sort()).toEqual(["C", "T", "U"]);
  });

  it("counts Keep decisions only, not the default of a never-targeted sample", () => {
    expect(effective.A).toMatchObject({ action: "keep", actionAuto: true }); // default
    expect(sampleActionCounts(effective).keep).toBe(2); // B and V
  });

  it("reads 0 / 0 right after loading", () => {
    const fresh = buildEffectiveSampleCuration(
      syncSampleCuration({}, events.map((e) => ({ ...e, verdict: "pending" }))),
      neverTargetedSamples(events, ab.samples),
    );
    expect(sampleActionCounts(fresh)).toEqual({ keep: 0, suppress: 0 });
    expect(buildCuratedAbundance(ab, fresh).droppedSamples).toEqual([]);
  });

  it("gives the same totals whatever subset of events is on screen", () => {
    // Export and the HTML report used to count only the targets of the
    // filtered events; the counts are per sample now.
    const counts = sampleActionCounts(effective);
    expect(sampleActionCounts(effective, Object.keys(effective))).toEqual(counts);
  });
});
