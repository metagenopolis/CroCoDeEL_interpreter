import { describe, it, expect } from "vitest";
import {
  DEFAULT_CURATION_RULES,
  syncSampleCuration,
  neverTargetedSamples,
  buildEffectiveSampleCuration,
  sampleActionCounts,
  hasManualVerdict,
  hasManualAction,
  ruleValues,
  clearRuleValues,
  keepRuleValues,
  applyRule,
} from "../src/curation.js";
import { curationOrigin } from "../src/exports.js";

/* Switching an automatic rule off, then on again (src/curation.js).

   Off, a rule must leave none of its values behind; the curator chooses,
   when the session holds some (ruleValues), to clear them
   (clearRuleValues: Pending / no action) or to keep them as their own
   (keepRuleValues: the same values, set by hand — for the defaults of the
   samples no event targets, written as Not contaminated + Keep). On, it is
   applied to every sample again (applyRule). Values set by hand are never
   touched: off → keep → on and off → clear → on neither duplicate nor lose
   one. */

const TP = "true_positive";
const FP = "false_positive";
const U = "uncertain";

const events = [
  { id: 0, source: "A", target: "T1", verdict: TP },
  { id: 1, source: "B", target: "T1", verdict: FP },
  { id: 2, source: "A", target: "T2", verdict: FP },
  { id: 3, source: "B", target: "T3", verdict: U },
  { id: 4, source: "C", target: "T4", verdict: "pending" },
  { id: 5, source: "A", target: "T5", verdict: TP },
  { id: 6, source: "A", target: "T6", verdict: TP },
  { id: 7, source: "B", target: "T7", verdict: TP },
];
// The curator's own values: a Keep on a TP target (T5), a verdict against
// the events (T6), a Suppress set by hand (T7), and on samples no event
// targets a Contaminated (M), notes (N) and an Uncertain (K).
const manual = {
  T5: { action: "keep" },
  T6: { verdict: "correct" },
  T7: { action: "suppress" },
  M: { verdict: "contaminated" },
  N: { notes: "blank well" },
  K: { verdict: "uncertain" },
};
const ALL_ON = DEFAULT_CURATION_RULES;
const off = (rule) => ({ ...ALL_ON, [rule]: false });
// The session as every rule on leaves it.
const stored = syncSampleCuration(manual, events);
const never = neverTargetedSamples(events, ["Z", "M", "N", "K"]);

/** The curator's own part of every entry: what no switch may change. */
function manualParts(curation) {
  const out = {};
  for (const [id, c] of Object.entries(curation)) {
    const part = {};
    if (hasManualVerdict(c)) part.verdict = c.verdict;
    if (hasManualAction(c)) part.action = c.action;
    if (c.notes) part.notes = c.notes;
    if (Object.keys(part).length) out[id] = part;
  }
  return out;
}

describe("the fixture, every rule on", () => {
  it("holds automatic and manual values", () => {
    expect(stored.T1).toEqual({
      verdict: "contaminated",
      verdictAuto: true,
      action: "suppress",
      actionAuto: true,
    });
    expect(stored.T5).toEqual({ verdict: "contaminated", verdictAuto: true, action: "keep" });
    expect(stored.T6).toEqual({ verdict: "correct" });
    expect(stored.M).toEqual({ verdict: "contaminated", action: "suppress", actionAuto: true });
    expect(never).toEqual(["A", "B", "C", "K", "M", "N", "Z"]);
  });
});

describe("R1 — sample verdict from the events", () => {
  const rule = "verdictFromEvents";
  const after = off(rule);

  it("counts the automatic verdicts, and the Suppress paired with them", () => {
    expect(ruleValues(rule, stored, never)).toEqual({
      samples: ["T1", "T2", "T3", "T5", "T7"],
      contaminated: 3,
      correct: 1,
      uncertain: 1,
      // T1's; T5 is kept and T7's Suppress is the curator's.
      suppress: 1,
      keep: 0,
    });
  });

  it("off → clear: the verdicts go, and the Suppress paired with an automatic Contaminated with them", () => {
    const cleared = clearRuleValues(rule, stored, after);
    expect(cleared.T1).toBeUndefined();
    expect(cleared.T2).toBeUndefined();
    expect(cleared.T3).toBeUndefined();
    expect(cleared.T5).toEqual({ action: "keep" });
    expect(cleared.T7).toEqual({ action: "suppress" });
    expect(manualParts(cleared)).toEqual(manualParts(stored));
    expect(ruleValues(rule, cleared, never).samples).toEqual([]);
    // T1 is back in the curated table; T7 and M are still dropped.
    expect(sampleActionCounts(cleared).suppress).toBe(2);
    expect(sampleActionCounts(stored).suppress).toBe(3);
  });

  it("off → clear with R2 off too: there was no paired Suppress to take", () => {
    const r2off = syncSampleCuration(manual, events, undefined, off("suppressContaminated"));
    const cleared = clearRuleValues(rule, r2off, { ...after, suppressContaminated: false });
    expect(cleared.T1).toBeUndefined();
    expect(cleared.M).toEqual({ verdict: "contaminated" });
  });

  it("off → keep: the same verdicts, set by hand; the paired Suppress stays the rule's", () => {
    const kept = keepRuleValues(rule, stored, never);
    expect(kept.T1).toEqual({ verdict: "contaminated", action: "suppress", actionAuto: true });
    expect(kept.T2).toEqual({ verdict: "correct" });
    expect(kept.T3).toEqual({ verdict: "uncertain" });
    expect(kept.T5).toEqual({ verdict: "contaminated", action: "keep" });
    expect(ruleValues(rule, kept, never).samples).toEqual([]);
    expect(sampleActionCounts(kept)).toEqual(sampleActionCounts(stored));
    for (const id of ["T1", "T2", "T3"]) {
      expect(curationOrigin(kept[id], "verdict", true), id).toBe("manual");
    }
  });

  it("off → keep → on: nothing changes, nothing is duplicated", () => {
    const kept = keepRuleValues(rule, stored, never);
    expect(applyRule(rule, kept, events, ALL_ON)).toBe(kept);
  });

  it("off → clear → on: the automatic verdicts come back as they were", () => {
    const cleared = clearRuleValues(rule, stored, after);
    expect(applyRule(rule, cleared, events, ALL_ON)).toEqual(stored);
  });

  it("on recomputes over every sample, leaving the verdicts set by hand", () => {
    // Curated while R1 was off: a verdict set by hand on T2, none on T1.
    const curated = { ...clearRuleValues(rule, stored, after), T2: { verdict: "contaminated" } };
    const on = applyRule(rule, curated, events, ALL_ON);
    expect(on.T1).toEqual(stored.T1);
    expect(on.T2).toEqual({ verdict: "contaminated", action: "suppress", actionAuto: true });
    expect(on.T6).toEqual({ verdict: "correct" });
    expect(ruleValues(rule, on, never)).toMatchObject({
      samples: ["T1", "T3", "T5", "T7"],
      contaminated: 3,
      uncertain: 1,
    });
  });
});

describe("R2 — Suppress paired with Contaminated", () => {
  const rule = "suppressContaminated";
  const after = off(rule);

  it("counts the automatic Suppress", () => {
    expect(ruleValues(rule, stored, never)).toMatchObject({ samples: ["M", "T1"], suppress: 2 });
  });

  it("off → clear: the Suppress goes, the samples come back into the curated table", () => {
    const cleared = clearRuleValues(rule, stored, after);
    expect(cleared.T1).toEqual({ verdict: "contaminated", verdictAuto: true });
    expect(cleared.M).toEqual({ verdict: "contaminated" });
    expect(manualParts(cleared)).toEqual(manualParts(stored));
    expect(sampleActionCounts(cleared).suppress).toBe(1);
  });

  it("off → keep: the same Suppress, set by hand", () => {
    const kept = keepRuleValues(rule, stored, never);
    expect(kept.T1).toEqual({ verdict: "contaminated", verdictAuto: true, action: "suppress" });
    expect(kept.M).toEqual({ verdict: "contaminated", action: "suppress" });
    expect(sampleActionCounts(kept)).toEqual(sampleActionCounts(stored));
    expect(curationOrigin(kept.T1, "action", true)).toBe("manual");
  });

  it("off → keep → on and off → clear → on", () => {
    const kept = keepRuleValues(rule, stored, never);
    expect(applyRule(rule, kept, events, ALL_ON)).toBe(kept);
    const cleared = clearRuleValues(rule, stored, after);
    expect(applyRule(rule, cleared, events, ALL_ON)).toEqual(stored);
  });

  it("on pairs every Contaminated with no action of the curator's, the curator's own Contaminated included", () => {
    const curated = { T4: { verdict: "contaminated" }, T5: { verdict: "contaminated", action: "keep" } };
    const on = applyRule(rule, curated, events, { ...ALL_ON, verdictFromEvents: false });
    expect(on.T4).toEqual({ verdict: "contaminated", action: "suppress", actionAuto: true });
    expect(on.T5).toBe(curated.T5);
    // With R1 off, applying R2 writes no verdict from the events.
    expect(on.T1).toBeUndefined();
  });
});

describe("R3 — Not contaminated + Keep for a sample no event targets", () => {
  const rule = "neverTargetedDefault";
  const after = off(rule);

  it("counts the samples showing a default", () => {
    // K has a verdict of the curator's (no Keep goes with Uncertain), M is
    // Contaminated: neither shows a default.
    expect(ruleValues(rule, stored, never)).toMatchObject({
      samples: ["A", "B", "C", "N", "Z"],
      correct: 5,
      keep: 5,
    });
  });

  it("off → clear: nothing stored changes; the defaults are gone from what every view shows", () => {
    expect(clearRuleValues(rule, stored, after)).toBe(stored);
    const eff = buildEffectiveSampleCuration(stored, never, after);
    for (const id of ["A", "B", "C", "Z"]) expect(eff[id], id).toBeUndefined();
    expect(eff.N).toEqual({ notes: "blank well" });
    expect(sampleActionCounts(eff)).toEqual(sampleActionCounts(stored));
  });

  it("off → keep: written as Not contaminated + Keep set by hand, counted as Keep decisions", () => {
    const kept = keepRuleValues(rule, stored, never);
    for (const id of ["A", "B", "C", "Z"]) {
      expect(kept[id], id).toEqual({ verdict: "correct", action: "keep" });
    }
    expect(kept.N).toEqual({ notes: "blank well", verdict: "correct", action: "keep" });
    expect(kept.K).toBe(stored.K);
    expect(kept.M).toBe(stored.M);
    const eff = buildEffectiveSampleCuration(kept, never, after);
    expect(sampleActionCounts(eff).keep).toBe(sampleActionCounts(stored).keep + 5);
    for (const id of ["A", "N", "Z"]) {
      expect(curationOrigin(eff[id], "verdict", false), id).toBe("manual");
      expect(curationOrigin(eff[id], "action", false), id).toBe("manual");
    }
  });

  it("off → keep → on: no default is added on top of the kept values", () => {
    const kept = keepRuleValues(rule, stored, never);
    expect(applyRule(rule, kept, events, ALL_ON)).toBe(kept);
    expect(ruleValues(rule, kept, never).samples).toEqual([]);
    expect(buildEffectiveSampleCuration(kept, never, ALL_ON)).toEqual(kept);
  });

  it("off → clear → on: the defaults are shown again", () => {
    const cleared = clearRuleValues(rule, stored, after);
    expect(buildEffectiveSampleCuration(cleared, never, ALL_ON)).toEqual(
      buildEffectiveSampleCuration(stored, never),
    );
  });
});
