import { describe, it, expect } from "vitest";
import {
  buildEffectiveSampleCuration,
  migrateSampleCuration,
  neverTargetedSamples,
  sampleActionCounts,
  syncSampleCuration,
  SAMPLE_CURATION_VERSION,
} from "../src/curation.js";

/* Sessions saved by the previous version (no sample-curation version).
   Its Samples tab stamped Not contaminated + Keep, as if set by hand, on
   every sample no event targets, and showed the action chips on
   Contaminated samples only. The migration dropped the exact stamps, but
   kept the stamp as the curator's own decision as soon as the curator
   had touched the entry since: a note, another verdict, a verdict
   cleared to Pending. Those samples then counted as "Samples to keep",
   the samples TSV called their Keep manual, and a true positive added
   later on such a sample did not suppress it. */

const tp = (id, source, target) => ({ id, source, target, verdict: "true_positive" });
const EVENTS = [tp(0, "58M", "58D7"), tp(1, "63D9", "60D38")];

/** What the previous version stored for these never-targeted samples
    (their entries as probed in its IndexedDB), and a targeted one. */
const PREVIOUS = {
  // Stamp, then a note.
  "63D250": { verdict: "correct", action: "keep", notes: "possible source, high biomass" },
  // Stamp, then Uncertain.
  "82D361": { verdict: "uncertain", action: "keep" },
  // Stamp, then the verdict cleared to Pending.
  "69M": { action: "keep" },
  // The exact stamp.
  "79M": { verdict: "correct", action: "keep" },
  // Stamp, then Contaminated: the Keep chip showed, the curated table kept it.
  "63D29": { verdict: "contaminated", action: "keep", notes: "edge well" },
  // Contaminated, its Suppress chosen, then Not contaminated again.
  "NC3": { verdict: "correct", action: "suppress" },
  // Targets: their values are the curator's or the rule's.
  "58D7": { verdict: "correct", action: "keep" },
  "60D38": { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true },
};

describe("migrateSampleCuration — the stamp in an entry changed since", () => {
  const { sampleCuration, touched, changes } = migrateSampleCuration(EVENTS, PREVIOUS, undefined);

  it("keeps the notes and the other verdicts, drops the stamp's values", () => {
    expect(touched).toBe(true);
    expect(sampleCuration["63D250"]).toEqual({ notes: "possible source, high biomass" });
    expect(sampleCuration["82D361"]).toEqual({ verdict: "uncertain" });
    expect(sampleCuration["69M"]).toBeUndefined();
    expect(sampleCuration["79M"]).toBeUndefined();
  });

  it("keeps what the curator could see and choose: a Keep on a Contaminated sample, a Suppress", () => {
    expect(sampleCuration["63D29"]).toEqual(PREVIOUS["63D29"]);
    expect(sampleCuration.NC3).toEqual({ action: "suppress" });
    // A targeted sample is not a stamp.
    expect(sampleCuration["58D7"]).toEqual(PREVIOUS["58D7"]);
  });

  it("reads like the defaults: Not contaminated + Keep, automatic, and no Keep decision", () => {
    const ids = Object.keys(PREVIOUS);
    const eff = buildEffectiveSampleCuration(sampleCuration, neverTargetedSamples(EVENTS, ids));
    expect(eff["63D250"]).toMatchObject({ verdict: "correct", verdictAuto: true, action: "keep", actionAuto: true });
    expect(eff["69M"]).toMatchObject({ verdict: "correct", verdictAuto: true, action: "keep", actionAuto: true });
    // Uncertain by hand: no default Keep goes with it.
    expect(eff["82D361"]).toEqual({ verdict: "uncertain" });
    // The Keep decisions left: 63D29's (Contaminated) and the target's.
    expect(sampleActionCounts(eff, ids)).toEqual({ keep: 2, suppress: 2 });
    // The curated table drops the same samples as before.
    expect(changes).toBeNull();
  });

  it("a true positive added later on such a sample suppresses it", () => {
    const events = [...EVENTS, tp(2, "58D36", "63D250"), tp(3, "58D36", "69M")];
    const sc = syncSampleCuration(sampleCuration, events);
    expect(sc["63D250"]).toEqual({
      notes: "possible source, high biomass",
      verdict: "contaminated",
      verdictAuto: true,
      action: "suppress",
      actionAuto: true,
    });
    expect(sc["69M"]).toMatchObject({ verdict: "contaminated", action: "suppress", actionAuto: true });
  });

  it("leaves a session of the current model alone: there, these are the curator's decisions", () => {
    const current = migrateSampleCuration(EVENTS, PREVIOUS, SAMPLE_CURATION_VERSION);
    for (const id of ["63D250", "82D361", "69M", "79M"]) {
      expect(current.sampleCuration[id]).toEqual(PREVIOUS[id]);
    }
  });
});
