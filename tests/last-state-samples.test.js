import { describe, it, expect } from "vitest";
import {
  buildEffectiveSampleCuration,
  neverTargetedSamples,
  sampleActionCounts,
  sampleCurationKeys,
  syncSampleCuration,
  withManualAction,
  withManualVerdict,
} from "../src/curation.js";
import { buildCuratedAbundance, samplesReportCuration, samplesReportIndex } from "../src/exports.js";
import { resolveSample } from "../src/diagnostics.js";

/* An event targets "s2", the abundance table names the sample "S2". The
   samples TSV and report have one row for it (samplesReportIndex), with
   the curation of both names; the Samples tab listed both: "s2" with its
   event and its automatic Suppress, and "S2" with no verdict and no
   action, while the curated table dropped S2. The tab now builds its rows
   the same way, and a decision made on a row is written where the
   sample's curation lives (sampleCurationKeys). */

const ab = {
  samples: ["S1", "S2", "S3", "S4", "S5"],
  species: ["sp_A", "sp_B"],
  matrix: {
    sp_A: { S1: 0.5, S2: 0.5, S3: 0.5, S4: 0.5, S5: 1 },
    sp_B: { S1: 0.5, S2: 0.5, S3: 0.5, S4: 0.5 },
  },
};
const ev = (id, source, target, verdict = "pending") => ({
  id,
  source,
  target,
  rate: 0.1,
  score: 0.9,
  introduced: ["sp_A"],
  verdict,
  notes: "",
});
const tableSample = (id) => resolveSample(ab, id);

/** The curation every view shows, as AppMain builds it. */
function effective(events, stored) {
  const never = new Set(neverTargetedSamples(events, ab.samples, tableSample));
  return buildEffectiveSampleCuration(stored, never);
}

/** A decision on the row of `id`, as the Samples tab writes it. */
function onRow(events, stored, id, write) {
  const index = samplesReportIndex(events, ab);
  let next = stored;
  for (const key of sampleCurationKeys(index.names(id), effective(events, stored), events)) {
    next = write(next, key);
  }
  return next;
}

/** What the row of `id` shows. */
function row(events, stored, id) {
  const index = samplesReportIndex(events, ab);
  return samplesReportCuration(effective(events, stored), index.names(id));
}

describe("a sample the events file writes in another case than the abundance table", () => {
  const events = [ev(0, "S1", "s2", "true_positive"), ev(1, "S3", "S4")];
  const stored = syncSampleCuration({}, events);

  it("is one row, the table's, with the event's curation", () => {
    const index = samplesReportIndex(events, ab);
    expect(index.rowOf("s2")).toBe("S2");
    expect(index.names("S2")).toEqual(["S2", "s2"]);
    expect(row(events, stored, "S2")).toEqual({ verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true });
  });

  it("takes its decisions where the rule wrote the Suppress: the event's spelling, once", () => {
    const names = samplesReportIndex(events, ab).names("S2");
    expect(sampleCurationKeys(names, effective(events, stored), events)).toEqual(["s2"]);
    const kept = onRow(events, stored, "S2", (sc, key) => withManualAction(sc, key, "keep", events));
    expect(kept.s2).toEqual({ verdict: "contaminated", verdictAuto: true, action: "keep" });
    expect("S2" in kept).toBe(false);
    expect(row(events, kept, "S2").action).toBe("keep");
    expect(buildCuratedAbundance(ab, kept).samples).toContain("S2");
    expect(sampleActionCounts(effective(events, kept), names, tableSample)).toEqual({ keep: 1, suppress: 0 });
  });

  it("writes a decision to every name holding one of the curator's, so that none hides it", () => {
    // A Suppress set by hand on the table's spelling (on the Plate tab,
    // or the Samples tab before), next to the rule's on the event's.
    const both = withManualAction(stored, "S2", "suppress", events);
    const names = samplesReportIndex(events, ab).names("S2");
    expect(sampleCurationKeys(names, effective(events, both), events)).toEqual(["S2", "s2"]);
    const kept = onRow(events, both, "S2", (sc, key) => withManualAction(sc, key, "keep", events));
    expect(row(events, kept, "S2").action).toBe("keep");
    expect(buildCuratedAbundance(ab, kept).samples).toContain("S2");
    // Written to the table's spelling alone, the event's Suppress stayed,
    // and the row still read Suppress.
    const one = withManualAction(both, "S2", "keep", events);
    expect(row(events, one, "S2").action).toBe("suppress");
  });

  it("hands the sample back to the rule when the curator's verdict is removed", () => {
    const names = samplesReportIndex(events, ab).names("S2");
    const mine = onRow(events, stored, "S2", (sc, key) => withManualVerdict(sc, key, "correct", events));
    expect(row(events, mine, "S2")).toMatchObject({ verdict: "correct" });
    expect(row(events, mine, "S2").action).toBeUndefined();
    const back = onRow(events, mine, "S2", (sc, key) => withManualVerdict(sc, key, "pending", events));
    expect(row(events, back, "S2")).toEqual({ verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true });
    expect(sampleCurationKeys(names, effective(events, back), events)).toEqual(["s2"]);
  });

  it("leaves every other sample as it was: one name, its own", () => {
    const eff = effective(events, stored);
    const index = samplesReportIndex(events, ab);
    for (const id of ["S1", "S3", "S4", "S5"]) {
      expect(index.names(id)).toEqual([id]);
      expect(sampleCurationKeys(index.names(id), eff, events)).toEqual([id]);
    }
  });
});
