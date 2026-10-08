import { describe, it, expect } from "vitest";
import {
  CURATION_RULES,
  DEFAULT_CURATION_RULES,
  normalizeCurationRules,
  ruleOn,
  syncSampleEntry,
  syncSampleCuration,
  withManualVerdict,
  withManualAction,
  applyTargetSideEffects,
  automaticAction,
  actionChipState,
  verdictChipState,
  neverTargetedSamples,
  buildEffectiveSampleCuration,
  sampleActionCounts,
  migrateSampleCuration,
  SAMPLE_CURATION_VERSION,
} from "../src/curation.js";
import { replaceEvents, replaceReportLines } from "../src/carryOver.js";
import { curationOrigin, curatedEventsToTSV } from "../src/exports.js";
import { parseEvents } from "../src/parsing.js";

/* The three automatic rules of src/curation.js as switches: each rule
   function takes the session's rules and applies only those that are on.

     verdictFromEvents     (R1) a sample's verdict follows its events
     suppressContaminated  (R2) Suppress goes with Contaminated
     neverTargetedDefault  (R3) Not contaminated + Keep for a sample no
                           event targets

   With a rule off, nothing derives its value: an evaluation never writes
   or clears a sample verdict (R1), Contaminated never adds or removes a
   Suppress (R2), a sample no event targets shows nothing (R3). Every rule
   on is today's model, and the default of every function. */

const TP = "true_positive";
const FP = "false_positive";
const U = "uncertain";

const rules = (off = []) => {
  const r = { ...DEFAULT_CURATION_RULES };
  for (const k of off) r[k] = false;
  return r;
};
const R1_OFF = rules(["verdictFromEvents"]);
const R2_OFF = rules(["suppressContaminated"]);
const R3_OFF = rules(["neverTargetedDefault"]);
const ALL_OFF = rules(CURATION_RULES);

const events = [
  { id: 0, source: "A", target: "T1", verdict: TP },
  { id: 1, source: "B", target: "T1", verdict: FP },
  { id: 2, source: "A", target: "T2", verdict: FP },
  { id: 3, source: "B", target: "T3", verdict: U },
  { id: 4, source: "C", target: "T4", verdict: "pending" },
];

describe("the rules setting", () => {
  it("has three rules, all on by default", () => {
    expect(CURATION_RULES).toEqual([
      "verdictFromEvents",
      "suppressContaminated",
      "neverTargetedDefault",
    ]);
    for (const r of CURATION_RULES) expect(DEFAULT_CURATION_RULES[r]).toBe(true);
    expect(Object.isFrozen(DEFAULT_CURATION_RULES)).toBe(true);
  });

  it("reads a session without rules — every earlier one — as all on", () => {
    for (const raw of [undefined, null, {}, [], "off", 3]) {
      expect(normalizeCurationRules(raw), String(raw)).toBe(DEFAULT_CURATION_RULES);
    }
  });

  it("keeps the object a session was saved with, and fills in a missing rule", () => {
    const saved = { verdictFromEvents: false, suppressContaminated: true, neverTargetedDefault: false };
    expect(normalizeCurationRules(saved)).toBe(saved);
    expect(normalizeCurationRules({ verdictFromEvents: false })).toEqual({
      verdictFromEvents: false,
      suppressContaminated: true,
      neverTargetedDefault: true,
    });
    // Only false switches a rule off.
    expect(normalizeCurationRules({ verdictFromEvents: "false", suppressContaminated: 0 })).toBe(
      DEFAULT_CURATION_RULES,
    );
  });

  it("leaves out a key that names no rule: the session keeps the three rules and nothing else", () => {
    // It used to keep the object as it was: the extra key stayed in the
    // session, its stored record and its next session JSON.
    const raw = { verdictFromEvents: false, suppressContaminated: false, neverTargetedDefault: false, extra: 1 };
    const rules = normalizeCurationRules(raw);
    expect(rules).not.toBe(raw);
    expect(rules).toEqual({ verdictFromEvents: false, suppressContaminated: false, neverTargetedDefault: false });
    expect(normalizeCurationRules({ ...DEFAULT_CURATION_RULES, note: "x" })).toBe(DEFAULT_CURATION_RULES);
  });

  it("counts a rule the object does not name as on", () => {
    expect(ruleOn(undefined, "verdictFromEvents")).toBe(true);
    expect(ruleOn({}, "suppressContaminated")).toBe(true);
    expect(ruleOn(R1_OFF, "verdictFromEvents")).toBe(false);
    expect(ruleOn(R1_OFF, "suppressContaminated")).toBe(true);
  });
});

describe("R1 off: evaluations never write or clear a sample verdict", () => {
  it("writes no verdict for a TP, an FP or an Uncertain", () => {
    const sc = syncSampleCuration({}, events, undefined, R1_OFF);
    expect(sc).toEqual({});
    for (const t of ["T1", "T2", "T3"]) {
      expect(withManualAction({}, t, null, events, R1_OFF)[t], t).toBeUndefined();
    }
  });

  it("leaves a verdict as it is when the events change", () => {
    const own = { T1: { verdict: "uncertain" } };
    expect(syncSampleCuration(own, events, undefined, R1_OFF)).toBe(own);
    // An evaluation that would have called for another verdict.
    expect(syncSampleEntry({ verdict: "correct" }, "contaminated", R1_OFF)).toEqual({
      verdict: "correct",
    });
  });

  it("Pending on the curator's verdict leaves the sample with none", () => {
    let sc = withManualVerdict({}, "T1", "uncertain", events, R1_OFF);
    expect(sc.T1).toEqual({ verdict: "uncertain" });
    sc = withManualVerdict(sc, "T1", "pending", events, R1_OFF);
    // All on, the TP targeting T1 would make it Contaminated + Suppress.
    expect(sc.T1).toBeUndefined();
    expect(withManualVerdict({}, "T1", "pending", events).T1).toMatchObject({
      verdict: "contaminated",
      verdictAuto: true,
    });
  });

  it("still pairs a Contaminated set by hand with Suppress while R2 is on", () => {
    let sc = withManualVerdict({}, "T2", "contaminated", events, R1_OFF);
    expect(sc.T2).toEqual({ verdict: "contaminated", action: "suppress", actionAuto: true });
    // Its verdict removed: the Suppress paired with it goes, no verdict
    // comes back from the events.
    sc = withManualVerdict(sc, "T2", "pending", events, R1_OFF);
    expect(sc.T2).toBeUndefined();
  });
});

describe("R2 off: Contaminated never adds or removes a Suppress", () => {
  it("gives a TP target an automatic Contaminated and no action", () => {
    const sc = syncSampleCuration({}, events, undefined, R2_OFF);
    expect(sc.T1).toEqual({ verdict: "contaminated", verdictAuto: true });
    expect(sc.T2).toEqual({ verdict: "correct", verdictAuto: true });
  });

  it("adds no Suppress to a Contaminated set by hand", () => {
    const sc = withManualVerdict({}, "T4", "contaminated", events, R2_OFF);
    expect(sc.T4).toEqual({ verdict: "contaminated" });
  });

  it("removes no Suppress when the sample stops being Contaminated", () => {
    // A Suppress the curator set, then a verdict that is not Contaminated.
    let sc = withManualAction({}, "T1", "suppress", events, R2_OFF);
    sc = withManualVerdict(sc, "T1", "correct", events, R2_OFF);
    expect(sc.T1).toEqual({ verdict: "correct", action: "suppress" });
  });

  it("leaves a Contaminated sample with no action once the curator's is cleared", () => {
    let sc = withManualAction({}, "T1", "keep", events, R2_OFF);
    sc = withManualAction(sc, "T1", null, events, R2_OFF);
    expect(sc.T1).toEqual({ verdict: "contaminated", verdictAuto: true });
    // All on, it gets its automatic Suppress back.
    expect(withManualAction(sc, "T1", null, events).T1.action).toBe("suppress");
  });
});

describe("every rule off: nothing is derived", () => {
  it("returns the curation itself, whatever the events say", () => {
    const own = { T1: { notes: "look again" }, T2: { verdict: "uncertain" } };
    expect(syncSampleCuration(own, events, undefined, ALL_OFF)).toBe(own);
  });

  it("writes only what the curator chose", () => {
    let sc = withManualVerdict({}, "T1", "contaminated", events, ALL_OFF);
    expect(sc.T1).toEqual({ verdict: "contaminated" });
    sc = withManualAction(sc, "T1", "keep", events, ALL_OFF);
    expect(sc.T1).toEqual({ verdict: "contaminated", action: "keep" });
  });
});

describe("applyTargetSideEffects — the bulk evaluation's sample side", () => {
  it("treats Automatic as (no change) while R1 and R2 are off", () => {
    const own = { T3: { verdict: "correct" } };
    const sc = applyTargetSideEffects(own, events, ["T1", "T2", "T3"], {}, ALL_OFF);
    expect(sc).toBe(own);
  });

  it("writes the explicit choices as the curator's, and derives nothing else", () => {
    const sc = applyTargetSideEffects(
      {},
      events,
      ["T1", "T2"],
      { targetVerdict: "contaminated" },
      R2_OFF,
    );
    expect(sc.T1).toEqual({ verdict: "contaminated" });
    expect(sc.T2).toEqual({ verdict: "contaminated" });
  });

  it("with R1 off and R2 on, pairs the Contaminated it writes with Suppress", () => {
    const sc = applyTargetSideEffects({}, events, ["T2", "T3"], { targetVerdict: "contaminated" }, R1_OFF);
    expect(sc.T2).toEqual({ verdict: "contaminated", action: "suppress", actionAuto: true });
    // Automatic: T1's TP writes nothing.
    expect(applyTargetSideEffects({}, events, ["T1"], {}, R1_OFF)).toEqual({});
  });

  it("all on, is unchanged: Automatic follows the events", () => {
    const sc = applyTargetSideEffects({}, events, ["T1"], {});
    expect(sc.T1).toEqual({
      verdict: "contaminated",
      verdictAuto: true,
      action: "suppress",
      actionAuto: true,
    });
  });
});

describe("R3 off: a sample no event targets shows nothing by default", () => {
  const never = neverTargetedSamples(events, ["Z"]);

  it("adds no default to the effective curation", () => {
    const stored = { Z: { notes: "blank" } };
    expect(buildEffectiveSampleCuration(stored, never, R3_OFF)).toBe(stored);
    const eff = buildEffectiveSampleCuration(stored, never);
    expect(eff.Z).toMatchObject({ verdict: "correct", action: "keep", notes: "blank" });
  });

  it("counts no Keep, and the curated table keeps such a sample", () => {
    const eff = buildEffectiveSampleCuration({}, never, R3_OFF);
    expect(sampleActionCounts(eff)).toEqual({ keep: 0, suppress: 0 });
  });

  it("names no origin 'default'", () => {
    const eff = buildEffectiveSampleCuration({ C: { verdict: "correct" } }, never, R3_OFF);
    for (const id of never) {
      expect(curationOrigin(eff[id], "verdict", false), id).not.toBe("default");
      expect(curationOrigin(eff[id], "action", false), id).not.toBe("default");
    }
    expect(curationOrigin(eff.C, "verdict", false)).toBe("manual");
    expect(curationOrigin(eff.C, "action", false)).toBe("");
  });

  it("still pairs a Contaminated set by hand on such a sample with Suppress (R2)", () => {
    const sc = withManualVerdict({}, "Z", "contaminated", events, R3_OFF);
    const eff = buildEffectiveSampleCuration(sc, never, R3_OFF);
    expect(eff.Z).toEqual({ verdict: "contaminated", action: "suppress", actionAuto: true });
    expect(curationOrigin(eff.Z, "action", false)).toBe("automatic");
  });
});

describe("origins under the rules", () => {
  it("names no automatic verdict when R1 is off", () => {
    const never = neverTargetedSamples(events, ["Z"]);
    let sc = syncSampleCuration({}, events, undefined, R1_OFF);
    sc = withManualVerdict(sc, "T1", "contaminated", events, R1_OFF);
    const eff = buildEffectiveSampleCuration(sc, never, R1_OFF);
    for (const [id, entry] of Object.entries(eff)) {
      const targeted = !never.includes(id);
      if (targeted) expect(curationOrigin(entry, "verdict", true), id).not.toBe("automatic");
    }
    expect(curationOrigin(eff.T1, "verdict", true)).toBe("manual");
    expect(curationOrigin(eff.T1, "action", true)).toBe("automatic");
  });
});

describe("what a click on a chip does, under the rules", () => {
  it("automaticAction: no Suppress with R2 off, no default Keep with R3 off", () => {
    expect(automaticAction("contaminated")).toBe("suppress");
    expect(automaticAction("contaminated", false, R2_OFF)).toBe(null);
    expect(automaticAction("correct", true)).toBe("keep");
    expect(automaticAction("correct", true, R3_OFF)).toBe(null);
    expect(automaticAction("contaminated", true, R3_OFF)).toBe("suppress");
  });

  it("actionChipState: clearing the curator's Keep says what is left", () => {
    const own = { verdict: "contaminated", action: "keep" };
    expect(actionChipState(own, "keep").returnsTo).toBe("suppress");
    expect(actionChipState(own, "keep", { rules: R2_OFF }).returnsTo).toBe(null);
    const kept = { verdict: "correct", action: "keep" };
    expect(actionChipState(kept, "keep", { neverTargeted: true }).returnsTo).toBe("keep");
    expect(actionChipState(kept, "keep", { neverTargeted: true, rules: R3_OFF }).returnsTo).toBe(null);
  });

  it("verdictChipState: Pending on the curator's verdict goes back to the events, the default, or nothing", () => {
    const own = { verdict: "uncertain" };
    expect(verdictChipState(own, "pending")).toMatchObject({ changes: true, returnsTo: "events" });
    expect(verdictChipState(own, "pending", { rules: R1_OFF })).toMatchObject({
      changes: true,
      returnsTo: null,
    });
    expect(verdictChipState(own, "pending", { neverTargeted: true })).toMatchObject({
      returnsTo: "default",
    });
    expect(verdictChipState(own, "pending", { neverTargeted: true, rules: R3_OFF })).toMatchObject({
      returnsTo: null,
    });
    // R1 is about the events: it says nothing of a sample no event targets.
    expect(verdictChipState(own, "pending", { neverTargeted: true, rules: R1_OFF })).toMatchObject({
      returnsTo: "default",
    });
  });
});

describe("carry-over (replaceEvents) under the session's rules", () => {
  const next = events.map((e) => ({ ...e }));

  it("derives no sample verdict from the new events while R1 is off", () => {
    const out = replaceEvents({
      oldEvents: events,
      oldSampleCuration: { T3: { verdict: "contaminated" } },
      newEvents: next,
      carryOver: true,
      rules: R1_OFF,
    });
    expect(out.sampleCuration.T1).toBeUndefined();
    expect(out.sampleCuration.T2).toBeUndefined();
    // The curator's own verdict is carried over, paired with Suppress (R2).
    expect(out.sampleCuration.T3).toEqual({
      verdict: "contaminated",
      action: "suppress",
      actionAuto: true,
    });
  });

  it("restores a curated file's target verdicts as the curator's own", () => {
    const file = next.map((e) =>
      e.target === "T1" ? { ...e, fileSampleVerdict: "contaminated", fileAction: "suppress" } : e,
    );
    const out = replaceEvents({ newEvents: file, carryOver: false, fileHasCuration: true, rules: ALL_OFF });
    expect(out.sampleCuration.T1).toEqual({ verdict: "contaminated", action: "suppress" });
    expect(out.sampleCuration.T2).toBeUndefined();
  });

  it("all on, is unchanged", () => {
    const out = replaceEvents({ newEvents: next, carryOver: false });
    expect(out.sampleCuration.T1).toMatchObject({ verdict: "contaminated", verdictAuto: true });
  });
});

describe("the carry-over banner under the session's rules", () => {
  // T1's two rows (a TP and an FP) give it different sample verdicts and
  // different actions.
  const conflicting = events.map((e) =>
    e.target !== "T1"
      ? { ...e }
      : e.verdict === TP
        ? { ...e, fileSampleVerdict: "contaminated", fileAction: "suppress" }
        : { ...e, fileSampleVerdict: "correct", fileAction: "keep" },
  );
  const linesUnder = (rules) => {
    const out = replaceEvents({
      newEvents: conflicting,
      carryOver: false,
      fileHasCuration: true,
      fileColumns: { action: true, sampleVerdict: true },
      rules,
    });
    return { out, text: replaceReportLines(out.report).join(" ") };
  };

  it("all on, leaves a target whose rows disagree to the automatic rule", () => {
    const { out, text } = linesUnder(DEFAULT_CURATION_RULES);
    expect(out.sampleCuration.T1).toMatchObject({ verdict: "contaminated", action: "suppress" });
    expect(text).toMatch(/1 target whose rows give different sample verdicts was left to the automatic rule\./);
    expect(text).toMatch(/1 target whose rows give different actions was left to the automatic rule\./);
  });

  it("with R1 off, says no rule gives such a target a verdict", () => {
    // It said "left to the automatic rule", which was off: T1 has none.
    const { out, text } = linesUnder(R1_OFF);
    expect(out.sampleCuration.T1).toBeUndefined();
    expect(text).not.toMatch(/sample verdicts was left to the automatic rule/);
    expect(text).toMatch(
      /1 target whose rows give different sample verdicts took none of them, and no rule sets one: the sample verdict from the events is switched off in Configuration/,
    );
  });

  it("with R2 off, says no rule gives such a target an action", () => {
    const { out, text } = linesUnder(R2_OFF);
    expect(out.sampleCuration.T1).toEqual({ verdict: "contaminated", verdictAuto: true });
    expect(text).not.toMatch(/actions was left to the automatic rule/);
    expect(text).toMatch(
      /1 target whose rows give different actions took none of them, and no rule sets one: Suppress paired with Contaminated is switched off in Configuration/,
    );
    // The verdict rule is on: that line is unchanged.
    expect(text).toMatch(/sample verdicts was left to the automatic rule/);
  });

  it("explains an empty action written while Suppress paired with Contaminated was off", () => {
    // A session with R2 off: T1 automatic Contaminated, no action. Its
    // curated events TSV gives T1 no action; reloaded into a new session
    // with every rule on, T1 is suppressed, and the banner used to blame
    // "a file written by an earlier version".
    const run = parseEvents(
      [
        "source\ttarget\trate\tprobability\tcontamination_specific_species",
        "S1\tT1\t0.1\t0.9\tsp_a",
        "S2\tT2\t0.2\t0.9\tsp_a",
      ].join("\n"),
    );
    const evs = run.events.map((e) => ({ ...e, verdict: e.target === "T1" ? TP : FP }));
    const sc = syncSampleCuration({}, evs, undefined, R2_OFF);
    expect(sc.T1).toEqual({ verdict: "contaminated", verdictAuto: true });
    const parsed = parseEvents(curatedEventsToTSV(evs, { sampleCuration: sc }));
    const reload = (rules) =>
      replaceEvents({
        newEvents: parsed.events,
        carryOver: false,
        fileHasCuration: !!parsed.curation,
        fileColumns: parsed.curationColumns,
        rules,
      });
    const allOn = reload(DEFAULT_CURATION_RULES);
    expect(allOn.report.suppressedWithoutAction).toEqual(["T1"]);
    const text = replaceReportLines(allOn.report).join(" ");
    expect(text).toMatch(/Now to suppress, although the file gives no action for it \(1\): T1 — it is Contaminated/);
    expect(text).toMatch(
      /A file exported while that rule, or the sample verdict from the events, was switched off in Configuration leaves such an action empty/,
    );
    // Under the rules it was written with, it comes back as it was.
    const same = reload(R2_OFF);
    expect(same.report.suppressedWithoutAction).toEqual([]);
    expect(same.sampleCuration.T1).toEqual({ verdict: "contaminated", verdictAuto: true });
  });
});

describe("migrateSampleCuration under the session's rules", () => {
  it("recomputes nothing a rule that is off would derive", () => {
    const stored = { T2: { verdict: "uncertain" } };
    const m = migrateSampleCuration(events, stored, SAMPLE_CURATION_VERSION, ALL_OFF);
    expect(m.touched).toBe(false);
    expect(m.sampleCuration).toBe(stored);
  });

  it("makes a value still flagged automatic for a rule that is off the curator's", () => {
    // Only a hand-edited file holds one: switching a rule off clears or
    // keeps its values.
    const stored = {
      T1: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true },
    };
    const m = migrateSampleCuration(events, stored, SAMPLE_CURATION_VERSION, R1_OFF);
    expect(m.sampleCuration.T1).toEqual({
      verdict: "contaminated",
      action: "suppress",
      actionAuto: true,
    });
    const both = migrateSampleCuration(events, stored, SAMPLE_CURATION_VERSION, ALL_OFF);
    expect(both.sampleCuration.T1).toEqual({ verdict: "contaminated", action: "suppress" });
  });

  it("all on, recomputes as before", () => {
    const m = migrateSampleCuration(events, {}, SAMPLE_CURATION_VERSION);
    expect(m.sampleCuration.T1).toMatchObject({ verdict: "contaminated", verdictAuto: true });
    expect(m.touched).toBe(true);
  });
});
