import { describe, it, expect } from "vitest";
import {
  neverTargetedSamples,
  buildEffectiveSampleCuration,
  sampleActionCounts,
  migrateSampleCuration,
  withManualVerdict,
  SAMPLE_CURATION_VERSION,
} from "../src/curation.js";

/* A sample no event targets has nothing calling it contaminated: every
   reader shows it Not contaminated + Keep. That default is DERIVED — never
   stored — and automatic, so it neither counts as a decision nor blocks
   one. It used to be written by the Samples tab, as manual values, and
   only while that tab was mounted. */

const events = [
  { id: 0, source: "A", target: "T", verdict: "pending" },
  { id: 1, source: "B", target: "T", verdict: "pending" },
  { id: 2, source: "T", target: "U", verdict: "true_positive" },
];

describe("neverTargetedSamples", () => {
  it("lists the sources that are never a target and the untouched table columns", () => {
    expect(neverTargetedSamples(events, ["A", "T", "Z", "U"])).toEqual(["A", "B", "Z"]);
    expect(neverTargetedSamples(events)).toEqual(["A", "B"]);
    expect(neverTargetedSamples([], undefined)).toEqual([]);
  });
});

describe("buildEffectiveSampleCuration", () => {
  const never = neverTargetedSamples(events, ["Z"]);

  it("gives a never-targeted sample an automatic Not contaminated + Keep", () => {
    const eff = buildEffectiveSampleCuration({}, never);
    for (const id of ["A", "B", "Z"]) {
      expect(eff[id], id).toEqual({
        verdict: "correct",
        verdictAuto: true,
        action: "keep",
        actionAuto: true,
      });
    }
    expect(eff.T).toBeUndefined();
    expect(eff.U).toBeUndefined();
  });

  it("leaves targeted samples exactly as stored", () => {
    const stored = { T: { notes: "x" }, U: { verdict: "uncertain" } };
    const eff = buildEffectiveSampleCuration(stored, never);
    expect(eff.T).toBe(stored.T);
    expect(eff.U).toBe(stored.U);
  });

  it("lets the curator's own values replace the defaults", () => {
    const eff = buildEffectiveSampleCuration(
      {
        A: { verdict: "uncertain" },
        B: { action: "suppress" },
        Z: { verdict: "correct", notes: "checked" },
      },
      never,
    );
    expect(eff.A).toEqual({ verdict: "uncertain" }); // no Keep without Not contaminated
    expect(eff.B).toEqual({ action: "suppress", verdict: "correct", verdictAuto: true });
    expect(eff.Z).toEqual({ verdict: "correct", notes: "checked", action: "keep", actionAuto: true });
  });

  it("does not let the default Keep block Contaminated → Suppress (63D250)", () => {
    // Marking a source-only sample Contaminated by hand pairs it with
    // Suppress, as for any sample: the default Keep is not stored.
    const stored = withManualVerdict({}, "A", "contaminated", events);
    expect(stored.A).toEqual({ verdict: "contaminated", action: "suppress", actionAuto: true });
    expect(buildEffectiveSampleCuration(stored, never).A).toEqual(stored.A);
  });

  it("returns the stored map itself when there is nothing to add", () => {
    const stored = { T: { verdict: "uncertain" } };
    expect(buildEffectiveSampleCuration(stored, [])).toBe(stored);
    const full = { A: { verdict: "contaminated", action: "suppress" } };
    expect(buildEffectiveSampleCuration(full, ["A"])).toBe(full);
  });
});

describe("sampleActionCounts", () => {
  it("does not count the never-targeted default as a Keep decision", () => {
    const eff = buildEffectiveSampleCuration({}, ["A", "B", "Z"]);
    expect(sampleActionCounts(eff)).toEqual({ keep: 0, suppress: 0 });
  });

  it("counts Keep set by hand and every Suppress, automatic or not", () => {
    const eff = buildEffectiveSampleCuration(
      {
        T: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true },
        U: { verdict: "contaminated", action: "keep" },
        A: { action: "keep" },
        B: { action: "suppress" },
      },
      ["A", "B", "Z"],
    );
    expect(sampleActionCounts(eff)).toEqual({ keep: 2, suppress: 2 });
  });

  it("can be restricted to some samples", () => {
    const eff = { T: { action: "suppress" }, U: { action: "keep" } };
    expect(sampleActionCounts(eff, ["T", "nope"])).toEqual({ keep: 0, suppress: 1 });
  });
});

describe("migrateSampleCuration — stamps of never-targeted samples", () => {
  const stamp = { verdict: "correct", action: "keep" };

  it("drops them: the default is derived now", () => {
    const { sampleCuration, touched } = migrateSampleCuration(events, {
      A: { ...stamp },
      B: { ...stamp, notes: "" },
      U: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true },
    });
    expect(sampleCuration.A).toBeUndefined();
    expect(sampleCuration.B).toBeUndefined();
    expect(sampleCuration.U).toBeDefined();
    expect(touched).toBe(true);
  });

  it("keeps what is not the stamp: the notes added to it, a targeted sample's values", () => {
    // The stamp's values go also from an entry changed since (a note);
    // a Not contaminated alone is the stamp's verdict too: a click on it
    // only repeated it (tests/final-state-migration.test.js).
    const kept = {
      A: { ...stamp, notes: "checked by hand" },
      B: { verdict: "correct" },
      T: { ...stamp }, // T is targeted: a manual decision, not a stamp
      U: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true },
    };
    const { sampleCuration, touched } = migrateSampleCuration(events, kept);
    expect(sampleCuration).toEqual({ A: { notes: "checked by hand" }, T: kept.T, U: kept.U });
    expect(touched).toBe(true);
    // In a session of the current model, every one of them is a decision.
    expect(migrateSampleCuration(events, kept, SAMPLE_CURATION_VERSION).sampleCuration).toEqual(kept);
  });
});
