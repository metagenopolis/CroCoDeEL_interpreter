import { describe, it, expect } from "vitest";
import { applyTargetSideEffects, syncSampleCuration } from "../src/curation.js";

/* The bulk dialog applies the sample rule to every target of the matched
   events at once (applyTargetSideEffects). It copied the whole sample
   curation map once per target that changed, so a bulk apply was
   quadratic in the number of targets: 150 ms on the 900 targets of the
   Sylph benchmark, 3 s of frozen page for 5,000 targets, 18 s for
   10,000. */

/** `n` events, each the true positive of its own target. */
function study(n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push({
      id: i,
      source: `S${String(i).padStart(5, "0")}`,
      target: `S${String(i + 1).padStart(5, "0")}`,
      verdict: "true_positive",
    });
  }
  return { events, targets: events.map((e) => e.target) };
}

describe("applyTargetSideEffects — one copy of the map", () => {
  it("applies the rule to 10,000 targets in well under a second", () => {
    const { events, targets } = study(10000);
    const t0 = performance.now();
    const out = applyTargetSideEffects({}, events, targets);
    const ms = performance.now() - t0;
    expect(Object.keys(out)).toHaveLength(10000);
    expect(out[targets[0]]).toEqual({
      verdict: "contaminated",
      verdictAuto: true,
      action: "suppress",
      actionAuto: true,
    });
    // Linear: tens of milliseconds. The per-target copy took 18 s here.
    expect(ms).toBeLessThan(1500);
  });

  it("gives what the rule gives sample by sample, explicit choices included", () => {
    const { events, targets } = study(50);
    const start = { [targets[3]]: { verdict: "uncertain", notes: "by hand" } };
    // Automatic: the same as syncing every target.
    expect(applyTargetSideEffects(start, events, targets)).toEqual(syncSampleCuration(start, events));
    // An explicit Keep on every target, the curator's own Uncertain kept.
    const kept = applyTargetSideEffects(start, events, targets, {
      targetAction: "keep",
      targetVerdict: "uncertain",
      skipExistingTargetVerdict: true,
    });
    expect(kept[targets[3]]).toEqual({ verdict: "uncertain", notes: "by hand", action: "keep" });
    expect(kept[targets[4]]).toEqual({ verdict: "uncertain", action: "keep" });
  });

  it("returns the map itself when no target changes, and never touches it", () => {
    const { events, targets } = study(20);
    const synced = syncSampleCuration({}, events);
    const frozen = Object.freeze({ ...synced });
    expect(applyTargetSideEffects(frozen, events, targets)).toBe(frozen);
    const changed = applyTargetSideEffects(frozen, events, targets, { note: "bulk" });
    expect(changed).not.toBe(frozen);
    expect(frozen[targets[0]].notes).toBeUndefined();
    expect(changed[targets[0]].notes).toBe("bulk");
  });
});
