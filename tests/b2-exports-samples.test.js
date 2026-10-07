import { describe, it, expect } from "vitest";
import {
  syncSampleCuration,
  withManualVerdict,
  withManualAction,
  neverTargetedSamples,
  buildEffectiveSampleCuration,
} from "../src/curation.js";
import { curationOrigin } from "../src/exports.js";

/* B2.4 — the samples TSV says where each verdict and action comes from.

   It writes the effective curation — what every view shows: the
   curator's values, the automatic ones the events decide, and the Not
   contaminated + Keep default of a sample no event targets — but wrote
   the three kinds alike: a sample nobody reviewed read as a curated
   "correct / keep". Each value is now followed by its origin, manual /
   automatic / default, as the samples HTML report marks it ("auto",
   "default").

   "default" is a value, not a kind of sample: on a sample no event
   targets, a Contaminated verdict set by hand brings the automatic
   Suppress, which the first version of the column called "default" — a
   downstream filter on action_origin == "default" (no decision) then
   missed a suppressed sample. */

const events = [
  { id: 0, source: "S", target: "T", verdict: "true_positive" },
  { id: 1, source: "S", target: "F", verdict: "false_positive" },
  { id: 2, source: "S", target: "P", verdict: "pending" },
  { id: 3, source: "S", target: "M", verdict: "true_positive" },
];
const tableSamples = ["S", "T", "F", "P", "M", "N", "K", "C", "CK", "R", "U"];

// The rule for every target, then the curator's own decisions: M is
// Contaminated (automatic) but kept by hand; K, which no event targets,
// is Uncertain by hand. No event targets C, CK, R or U either: C is
// Contaminated by hand, CK too and then kept by hand, R is Not
// contaminated by hand, U is suppressed by hand.
let stored = syncSampleCuration({}, events);
stored = withManualAction(stored, "M", "keep", events);
stored = withManualVerdict(stored, "K", "uncertain", events);
stored = withManualVerdict(stored, "C", "contaminated", events);
stored = withManualVerdict(stored, "CK", "contaminated", events);
stored = withManualAction(stored, "CK", "keep", events);
stored = withManualVerdict(stored, "R", "correct", events);
stored = withManualAction(stored, "U", "suppress", events);
const never = new Set(neverTargetedSamples(events, tableSamples));
const effective = buildEffectiveSampleCuration(stored, never);
const targeted = (id) => events.some((e) => e.target === id);
const origins = (id) => [
  effective[id]?.verdict || "",
  curationOrigin(effective[id], "verdict", targeted(id)),
  effective[id]?.action || "",
  curationOrigin(effective[id], "action", targeted(id)),
];

describe("curationOrigin — the samples TSV's verdict_origin / action_origin", () => {
  it("marks what the events decide as automatic", () => {
    expect(origins("T")).toEqual(["contaminated", "automatic", "suppress", "automatic"]);
    expect(origins("F")).toEqual(["correct", "automatic", "", ""]);
  });

  it("marks the curator's own values as manual, next to automatic ones", () => {
    expect(origins("M")).toEqual(["contaminated", "automatic", "keep", "manual"]);
    expect(origins("K")).toEqual(["uncertain", "manual", "", ""]);
  });

  it("marks the Not contaminated + Keep of a sample no event targets as default", () => {
    expect(never.has("N")).toBe(true);
    expect(origins("N")).toEqual(["correct", "default", "keep", "default"]);
    expect(origins("S")).toEqual(["correct", "default", "keep", "default"]);
    // The default Keep goes with a Not contaminated set by hand too, and
    // the default verdict with a Suppress set by hand.
    expect(origins("R")).toEqual(["correct", "manual", "keep", "default"]);
    expect(origins("U")).toEqual(["correct", "default", "suppress", "manual"]);
  });

  it("marks the Suppress paired with a Contaminated set by hand as automatic, targeted or not", () => {
    expect(never.has("C")).toBe(true);
    // Stored by the rule, with its automatic flag: the Samples tab marks
    // it AUTO, the Overview and the curated table count it as a Suppress.
    expect(stored.C).toEqual({ verdict: "contaminated", action: "suppress", actionAuto: true });
    expect(origins("C")).toEqual(["contaminated", "manual", "suppress", "automatic"]);
    expect(origins("CK")).toEqual(["contaminated", "manual", "keep", "manual"]);
  });

  it("leaves the origin empty without a value", () => {
    expect(origins("P")).toEqual(["", "", "", ""]);
    expect(curationOrigin(undefined, "verdict", true)).toBe("");
    expect(curationOrigin({ verdict: "pending" }, "verdict", true)).toBe("");
  });
});

describe("curationOrigin on every combination", () => {
  // default: exactly the values buildEffectiveSampleCuration adds and
  // never stores; automatic: values the rule stores, flagged; manual:
  // values stored without the flag. Targeted or not, each evaluation of
  // the event, each verdict and each action set by hand.
  it("says where each effective value comes from", () => {
    let n = 0;
    for (const isTargeted of [true, false]) {
      for (const ev of ["pending", "true_positive", "false_positive", "uncertain"]) {
        for (const verdict of [null, "contaminated", "correct", "uncertain"]) {
          for (const action of [null, "keep", "suppress"]) {
            const evs = [{ id: 0, source: "S", target: isTargeted ? "X" : "T", verdict: ev }];
            let st = syncSampleCuration({}, evs);
            if (verdict) st = withManualVerdict(st, "X", verdict, evs);
            if (action) st = withManualAction(st, "X", action, evs);
            const eff = buildEffectiveSampleCuration(
              st,
              new Set(neverTargetedSamples(evs, ["S", "T", "X"])),
            );
            for (const field of ["verdict", "action"]) {
              const expected =
                eff.X?.[field] == null
                  ? ""
                  : st.X?.[field] == null
                    ? "default"
                    : st.X[`${field}Auto`]
                      ? "automatic"
                      : "manual";
              expect(
                curationOrigin(eff.X, field, isTargeted),
                `${isTargeted ? "targeted" : "never targeted"}, ${ev}, verdict ${verdict}, action ${action}: ${field}`,
              ).toBe(expected);
              n++;
            }
          }
        }
      }
    }
    expect(n).toBe(192);
  });
});
