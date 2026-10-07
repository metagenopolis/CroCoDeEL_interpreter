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
   "default"). */

const events = [
  { id: 0, source: "S", target: "T", verdict: "true_positive" },
  { id: 1, source: "S", target: "F", verdict: "false_positive" },
  { id: 2, source: "S", target: "P", verdict: "pending" },
  { id: 3, source: "S", target: "M", verdict: "true_positive" },
];
const tableSamples = ["S", "T", "F", "P", "M", "N", "K"];

// The rule for every target, then the curator's own decisions: M is
// Contaminated (automatic) but kept by hand; K, which no event targets,
// is Uncertain by hand.
let stored = syncSampleCuration({}, events);
stored = withManualAction(stored, "M", "keep", events);
stored = withManualVerdict(stored, "K", "uncertain", events);
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
  });

  it("leaves the origin empty without a value", () => {
    expect(origins("P")).toEqual(["", "", "", ""]);
    expect(curationOrigin(undefined, "verdict", true)).toBe("");
    expect(curationOrigin({ verdict: "pending" }, "verdict", true)).toBe("");
  });
});
