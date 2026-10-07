import { describe, it, expect } from "vitest";
import {
  autoSampleVerdict,
  autoVerdictFromCounts,
  syncSampleEntry,
  syncSampleCuration,
  withManualVerdict,
  withManualAction,
  applyTargetSideEffects,
  hasManualVerdict,
  hasManualAction,
  actionChipState,
  verdictChipState,
  automaticAction,
  buildEffectiveSampleCuration,
} from "../src/curation.js";

/* The event → sample rule (src/curation.js): every path that changes an
   event evaluation re-derives the automatic sample values from ALL the
   events that target the sample, and never touches a manual value. */

const TP = "true_positive";
const FP = "false_positive";
const U = "uncertain";
const P = "pending";
const VERDICTS = [TP, FP, U, P];

// The rule, written out independently of the implementation.
const expected = (evals) =>
  evals.includes(TP)
    ? "contaminated"
    : evals.includes(U)
      ? "uncertain"
      : evals.includes(FP)
        ? "correct"
        : null;

/** Every sequence of 0..3 evaluations over the four values. */
function sequences(maxLen) {
  const out = [[]];
  let frontier = [[]];
  for (let n = 1; n <= maxLen; n++) {
    const next = [];
    for (const s of frontier) for (const v of VERDICTS) next.push([...s, v]);
    out.push(...next);
    frontier = next;
  }
  return out;
}

const eventsOn = (target, evals, extra = []) => [
  ...evals.map((verdict, i) => ({ id: i, source: `S${i}`, target, verdict })),
  ...extra,
];

describe("autoSampleVerdict — the rule table", () => {
  it("follows TP > Uncertain > FP > nothing for every mix of evaluations", () => {
    const all = sequences(3);
    expect(all.length).toBe(1 + 4 + 16 + 64);
    for (const evals of all) {
      expect(autoSampleVerdict(evals), evals.join(",") || "(none)").toBe(
        expected(evals),
      );
    }
  });

  it("does not depend on the order of the evaluations", () => {
    for (const evals of sequences(3)) {
      const reversed = [...evals].reverse();
      expect(autoSampleVerdict(reversed)).toBe(autoSampleVerdict(evals));
    }
  });

  it("gives Uncertain, not Not contaminated, when FP and Uncertain mix", () => {
    // The previous rule called "every event resolved, none TP" correct
    // even when some were uncertain.
    expect(autoSampleVerdict([FP, U])).toBe("uncertain");
    expect(autoSampleVerdict([FP, FP, U])).toBe("uncertain");
  });

  it("reads the same rule from counts", () => {
    expect(autoVerdictFromCounts({ tp: 1, fp: 3, uncertain: 2 })).toBe(
      "contaminated",
    );
    expect(autoVerdictFromCounts({ fp: 3, uncertain: 1 })).toBe("uncertain");
    expect(autoVerdictFromCounts({ fp: 1, pending: 4 })).toBe("correct");
    expect(autoVerdictFromCounts({ pending: 2 })).toBe(null);
    expect(autoVerdictFromCounts(null)).toBe(null);
  });
});

describe("syncSampleCuration — automatic values", () => {
  it("stores the rule's verdict, paired with Suppress when contaminated", () => {
    for (const evals of sequences(3)) {
      const sc = syncSampleCuration({}, eventsOn("T", evals), ["T"]);
      const v = expected(evals);
      if (!v) {
        expect(sc.T, evals.join(",")).toBeUndefined();
        continue;
      }
      const want = { verdict: v, verdictAuto: true };
      if (v === "contaminated") Object.assign(want, { action: "suppress", actionAuto: true });
      expect(sc.T, evals.join(",")).toEqual(want);
    }
  });

  it("recomputes from scratch, whatever automatic state was stored", () => {
    const stale = [
      { verdict: "correct", verdictAuto: true },
      { verdict: "uncertain", verdictAuto: true },
      { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true },
      { action: "suppress", actionAuto: true },
    ];
    for (const prev of stale) {
      for (const evals of sequences(2)) {
        const fresh = syncSampleCuration({}, eventsOn("T", evals), ["T"]);
        const resynced = syncSampleCuration({ T: prev }, eventsOn("T", evals), ["T"]);
        expect(resynced.T, `${JSON.stringify(prev)} / ${evals}`).toEqual(fresh.T);
      }
    }
  });

  it("unwinds: back to all pending removes the automatic verdict and action", () => {
    const tp = syncSampleCuration({}, eventsOn("T", [TP, P]), ["T"]);
    expect(tp.T).toEqual({
      verdict: "contaminated",
      verdictAuto: true,
      action: "suppress",
      actionAuto: true,
    });
    const back = syncSampleCuration(tp, eventsOn("T", [P, P]), ["T"]);
    expect(back.T).toBeUndefined();
  });

  it("keeps the notes when the automatic values go away", () => {
    const sc = syncSampleCuration(
      { T: { verdict: "correct", verdictAuto: true, notes: "plate edge" } },
      eventsOn("T", [P]),
      ["T"],
    );
    expect(sc.T).toEqual({ notes: "plate edge" });
  });

  it("leaves untouched samples alone and returns the same object when nothing changes", () => {
    const sc = { A: { verdict: "uncertain", notes: "x" } };
    const events = eventsOn("T", [P]);
    expect(syncSampleCuration(sc, events, ["T"])).toBe(sc);
    const synced = syncSampleCuration({}, eventsOn("T", [TP]), ["T"]);
    expect(syncSampleCuration(synced, eventsOn("T", [TP]), ["T"])).toBe(synced);
  });

  it("only looks at the events that target the sample", () => {
    const events = [
      { id: 0, source: "T", target: "X", verdict: TP }, // T is the source
      { id: 1, source: "Y", target: "T", verdict: FP },
    ];
    expect(syncSampleCuration({}, events, ["T"]).T).toEqual({
      verdict: "correct",
      verdictAuto: true,
    });
  });

  it("syncs every entry and every target when no ids are given", () => {
    const events = [
      { id: 0, source: "A", target: "B", verdict: TP },
      { id: 1, source: "A", target: "C", verdict: P },
    ];
    const sc = syncSampleCuration(
      { C: { verdict: "correct", verdictAuto: true }, D: { verdict: "uncertain", verdictAuto: true } },
      events,
    );
    expect(Object.keys(sc).sort()).toEqual(["B"]);
  });
});

describe("manual values are never changed by the rule", () => {
  const manualEntries = [
    { verdict: "contaminated" },
    { verdict: "correct" },
    { verdict: "uncertain" },
    { verdict: "correct", action: "suppress" },
    { verdict: "contaminated", action: "keep" },
    { action: "keep" },
    { action: "suppress", notes: "n" },
  ];
  it("keeps a manual verdict and a manual action for every mix of evaluations", () => {
    for (const entry of manualEntries) {
      for (const evals of sequences(3)) {
        const sc = syncSampleCuration({ T: entry }, eventsOn("T", evals), ["T"]);
        const label = `${JSON.stringify(entry)} / ${evals}`;
        if (entry.verdict) expect(sc.T.verdict, label).toBe(entry.verdict);
        if (entry.verdict) expect(sc.T.verdictAuto, label).toBeUndefined();
        if (entry.action) expect(sc.T.action, label).toBe(entry.action);
        if (entry.action) expect(sc.T.actionAuto, label).toBeUndefined();
      }
    }
  });

  it("still fills in what the curator left empty", () => {
    // Manual action, no verdict: the verdict follows the events.
    const sc = syncSampleCuration({ T: { action: "keep" } }, eventsOn("T", [TP]), ["T"]);
    expect(sc.T).toEqual({ action: "keep", verdict: "contaminated", verdictAuto: true });
    // Manual Contaminated, no action: Suppress is paired automatically.
    const sc2 = syncSampleCuration({ T: { verdict: "contaminated" } }, eventsOn("T", [FP]), ["T"]);
    expect(sc2.T).toEqual({ verdict: "contaminated", action: "suppress", actionAuto: true });
  });
});

describe("action pairing", () => {
  it("drops the automatic Suppress once the effective verdict is not contaminated", () => {
    const sc = syncSampleCuration(
      { T: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true } },
      eventsOn("T", [FP, FP]),
      ["T"],
    );
    expect(sc.T).toEqual({ verdict: "correct", verdictAuto: true });
  });

  it("keeps a manual Suppress on a sample that is not contaminated", () => {
    // Unusual, shown as such in the Samples tab, but the curator's call.
    const sc = syncSampleCuration({ T: { action: "suppress" } }, eventsOn("T", [FP]), ["T"]);
    expect(sc.T).toEqual({ action: "suppress", verdict: "correct", verdictAuto: true });
  });

  it("pairs a manual Contaminated with an automatic Suppress", () => {
    expect(syncSampleEntry({ verdict: "contaminated" }, null)).toEqual({
      verdict: "contaminated",
      action: "suppress",
      actionAuto: true,
    });
  });
});

describe("click order does not matter (the reported sequences)", () => {
  // Replay single clicks: each one changes one event, then syncs its target.
  const replay = (events, clicks, sc = {}) => {
    let ev = events;
    let cur = sc;
    for (const [id, verdict] of clicks) {
      ev = ev.map((e) => (e.id === id ? { ...e, verdict } : e));
      const target = ev.find((e) => e.id === id).target;
      cur = syncSampleCuration(cur, ev, [target]);
    }
    return { ev, sc: cur };
  };
  const demo = [
    { id: 0, source: "63D250", target: "63D9", verdict: P },
    { id: 6, source: "58D256", target: "63D9", verdict: P },
    { id: 7, source: "60D38", target: "63D9", verdict: P },
    { id: 17, source: "79M", target: "63D9", verdict: P },
  ];

  it("(d) F then P leaves no verdict behind", () => {
    expect(replay(demo, [[0, FP], [0, P]]).sc["63D9"]).toBeUndefined();
    expect(replay(demo, [[0, U], [0, P]]).sc["63D9"]).toBeUndefined();
  });

  it("(a) rejecting one event of a TP target never creates the suppression by itself", () => {
    // Bulk TP synced the targets; an FP click on one event keeps it
    // contaminated because three TP events remain.
    const allTp = demo.map((e) => ({ ...e, verdict: TP }));
    const bulk = syncSampleCuration({}, allTp, ["63D9"]);
    expect(bulk["63D9"]).toMatchObject({ verdict: "contaminated", action: "suppress" });
    const after = replay(allTp, [[7, FP]], bulk).sc["63D9"];
    expect(after).toEqual(bulk["63D9"]);
    // …and with no TP left, the rejection makes the sample Not contaminated.
    const none = replay(demo, [[7, FP]]).sc["63D9"];
    expect(none).toEqual({ verdict: "correct", verdictAuto: true });
  });

  it("gives the same end state for every order of the same clicks", () => {
    const clicks = [[0, TP], [6, FP], [7, U], [17, FP], [0, P]];
    const perms = (a) =>
      a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
    // Last click per event wins whatever the order, so compare against the
    // state the final evaluations call for.
    for (const order of perms(clicks)) {
      const { ev, sc } = replay(demo, order);
      const direct = syncSampleCuration({}, ev, ["63D9"]);
      expect(sc["63D9"]).toEqual(direct["63D9"]);
    }
  });

  it("(e) a bulk FP over TP events removes the automatic Suppress", () => {
    const allTp = demo.map((e) => ({ ...e, verdict: TP }));
    const sc = syncSampleCuration({}, allTp, ["63D9"]);
    const allFp = demo.map((e) => ({ ...e, verdict: FP }));
    expect(applyTargetSideEffects(sc, allFp, ["63D9"])["63D9"]).toEqual({
      verdict: "correct",
      verdictAuto: true,
    });
  });
});

describe("withManualVerdict / withManualAction", () => {
  const ev = eventsOn("T", [TP]);
  it("records the curator's verdict and pairs the action", () => {
    expect(withManualVerdict({}, "T", "contaminated", [])).toEqual({
      T: { verdict: "contaminated", action: "suppress", actionAuto: true },
    });
    expect(withManualVerdict({}, "T", "uncertain", ev).T).toEqual({ verdict: "uncertain" });
  });

  it("clearing the curator's verdict brings the automatic one back", () => {
    const sc = withManualVerdict({}, "T", "correct", ev);
    expect(sc.T).toEqual({ verdict: "correct" });
    expect(withManualVerdict(sc, "T", "pending", ev).T).toEqual({
      verdict: "contaminated",
      verdictAuto: true,
      action: "suppress",
      actionAuto: true,
    });
    expect(withManualVerdict(sc, "T", null, eventsOn("T", [P]))).toEqual({});
  });

  it("a Contaminated set by hand on a sample with a stored Keep keeps the Keep", () => {
    expect(withManualVerdict({ T: { action: "keep" } }, "T", "contaminated", []).T).toEqual({
      action: "keep",
      verdict: "contaminated",
    });
  });

  it("records the curator's action; clearing it gives the automatic one back", () => {
    let sc = syncSampleCuration({}, ev, ["T"]);
    sc = withManualAction(sc, "T", "keep", ev);
    expect(sc.T).toEqual({ verdict: "contaminated", verdictAuto: true, action: "keep" });
    sc = withManualAction(sc, "T", null, ev);
    expect(sc.T).toEqual({
      verdict: "contaminated",
      verdictAuto: true,
      action: "suppress",
      actionAuto: true,
    });
    expect(withManualAction({}, "T", null, [])).toEqual({});
  });

  it("returns the same object when the write changes nothing", () => {
    const sc = { T: { verdict: "uncertain" } };
    expect(withManualVerdict(sc, "T", "uncertain", [])).toBe(sc);
    expect(withManualVerdict(sc, null, "uncertain", [])).toBe(sc);
  });
});

describe("applyTargetSideEffects — the bulk dialog's sample side", () => {
  const events = [
    { id: 0, source: "A", target: "T1", verdict: TP },
    { id: 1, source: "A", target: "T2", verdict: TP },
    { id: 2, source: "B", target: "T2", verdict: TP },
  ];
  const auto = syncSampleCuration({}, events, ["T1", "T2"]);

  it("with no explicit choice, applies the automatic rule (same as clicking)", () => {
    expect(applyTargetSideEffects({}, events, ["T1", "T2", "T2"])).toEqual(auto);
  });

  it("writes explicit choices as manual values", () => {
    const sc = applyTargetSideEffects({}, events, ["T1"], {
      targetVerdict: "contaminated",
      targetAction: "keep",
    });
    expect(sc.T1).toEqual({ verdict: "contaminated", action: "keep" });
  });

  it("'don't overwrite' protects manual values only (A3.2)", () => {
    const start = {
      ...auto,
      T2: { verdict: "uncertain", action: "suppress" }, // manual
    };
    const sc = applyTargetSideEffects(start, events, ["T1", "T2"], {
      targetVerdict: "correct",
      targetAction: "keep",
      skipExistingTargetVerdict: true,
      skipExistingTargetAction: true,
    });
    // T1 only had automatic values: they do not count as already set.
    expect(sc.T1).toEqual({ verdict: "correct", action: "keep" });
    // T2's manual values are left alone.
    expect(sc.T2).toEqual({ verdict: "uncertain", action: "suppress" });
  });

  it("overwrites manual values when the safety toggles are off", () => {
    const sc = applyTargetSideEffects(
      { T1: { verdict: "uncertain", action: "suppress" } },
      events,
      ["T1"],
      { targetVerdict: "pending", targetAction: null },
    );
    // Both manual values removed: the rule fills them in again.
    expect(sc.T1).toEqual(auto.T1);
  });

  it("prepends the note to each target once", () => {
    const sc = applyTargetSideEffects({ T2: { notes: "old" } }, events, ["T2", "T2"], {
      note: "[bulk] new",
    });
    expect(sc.T2.notes).toBe("[bulk] new\n\nold");
  });

  it("hasManualVerdict / hasManualAction ignore automatic and pending values", () => {
    expect(hasManualVerdict({ verdict: "correct", verdictAuto: true })).toBe(false);
    expect(hasManualVerdict({ verdict: "pending" })).toBe(false);
    expect(hasManualVerdict({ verdict: "correct" })).toBe(true);
    expect(hasManualAction({ action: "suppress", actionAuto: true })).toBe(false);
    expect(hasManualAction({ action: "keep" })).toBe(true);
    expect(hasManualAction(undefined)).toBe(false);
  });
});

/* One click semantics for the Keep / Suppress chips of a sample, in the
   Samples tab, the Events table and the gallery cards. A click used to
   "clear" whatever was active: on an automatic Suppress the rule put it
   straight back (nothing happened), and "Clear keep" on a Contaminated
   sample quietly suppressed it. */
describe("actionChipState — what a click on a Keep / Suppress chip does", () => {
  const events = [{ id: 0, source: "S", target: "T", verdict: TP }];
  const auto = syncSampleCuration({}, events); // T: Contaminated + Suppress, automatic
  const click = (sc, chip) =>
    withManualAction(sc, "T", actionChipState(sc.T, chip).next, events).T;

  it("sets an action that is not active, by hand", () => {
    expect(actionChipState(auto.T, "keep")).toMatchObject({ active: false, next: "keep" });
    expect(click(auto, "keep")).toMatchObject({ action: "keep" });
    expect(click(auto, "keep").actionAuto).toBeUndefined();
  });

  it("makes an automatic action the curator's own instead of 'clearing' it", () => {
    expect(actionChipState(auto.T, "suppress")).toMatchObject({ active: true, auto: true, next: "suppress" });
    const t = click(auto, "suppress");
    expect(t.action).toBe("suppress");
    expect(t.actionAuto).toBeUndefined();
  });

  it("removes the curator's own action and says what the rule puts back", () => {
    const kept = withManualAction(auto, "T", "keep", events);
    expect(actionChipState(kept.T, "keep")).toMatchObject({ active: true, auto: false, next: null, returnsTo: "suppress" });
    expect(click(kept, "keep")).toMatchObject({ action: "suppress", actionAuto: true });

    const own = withManualAction(auto, "T", "suppress", events);
    expect(actionChipState(own.T, "suppress")).toMatchObject({ next: null, returnsTo: "suppress" });
    expect(click(own, "suppress")).toMatchObject({ action: "suppress", actionAuto: true });
  });

  it("clears for good on a sample that is not Contaminated", () => {
    let sc = withManualVerdict(auto, "T", "correct", events);
    sc = withManualAction(sc, "T", "suppress", events); // the unusual combination
    expect(actionChipState(sc.T, "suppress")).toMatchObject({ next: null, returnsTo: null });
    expect(click(sc, "suppress")).toEqual({ verdict: "correct" });
  });
});

/* The label of the curator's own Keep / Suppress announces what a click
   leaves in its place (returnsTo). On a sample no event targets, that is
   the default Keep while it is Not contaminated: "Clear keep" on 63D250
   (a source only) gave the default Keep back, and its label said
   nothing about it. */
describe("actionChipState — what a cleared action gives way to", () => {
  it("names the default Keep of a Not contaminated sample no event targets", () => {
    const entry = { verdict: "correct", verdictAuto: true, action: "keep" };
    expect(actionChipState(entry, "keep", { neverTargeted: true })).toMatchObject({
      active: true,
      auto: false,
      next: null,
      returnsTo: "keep",
    });
    expect(
      actionChipState({ ...entry, action: "suppress" }, "suppress", { neverTargeted: true }).returnsTo,
    ).toBe("keep");
    // A targeted sample has no default action.
    expect(actionChipState(entry, "keep").returnsTo).toBe(null);
    // Nor a never-targeted one marked Uncertain by hand.
    expect(
      actionChipState({ verdict: "uncertain", action: "keep" }, "keep", { neverTargeted: true }).returnsTo,
    ).toBe(null);
  });

  it("is automaticAction: Suppress with Contaminated, the never-targeted Keep, else none", () => {
    expect(automaticAction("contaminated")).toBe("suppress");
    expect(automaticAction("contaminated", true)).toBe("suppress");
    expect(automaticAction("correct", true)).toBe("keep");
    expect(automaticAction("correct")).toBe(null);
    expect(automaticAction("uncertain", true)).toBe(null);
    expect(automaticAction(undefined, true)).toBe(null);
  });

  it("announces exactly what the click leaves, on every kind of sample", () => {
    // T is targeted by one event from A; A is targeted by none.
    let checked = 0;
    for (const evaluation of VERDICTS) {
      const events = [{ id: 0, source: "A", target: "T", verdict: evaluation }];
      const never = new Set(["A"]);
      for (const id of ["T", "A"]) {
        for (const verdict of [null, "contaminated", "correct", "uncertain"]) {
          for (const action of ["keep", "suppress"]) {
            let raw = syncSampleCuration({}, events);
            if (verdict) raw = withManualVerdict(raw, id, verdict, events);
            raw = withManualAction(raw, id, action, events);
            const before = buildEffectiveSampleCuration(raw, never)[id];
            const state = actionChipState(before, action, { neverTargeted: never.has(id) });
            const what = `${id} ${evaluation} ${verdict} ${action}`;
            expect(state, what).toMatchObject({ active: true, auto: false, next: null });
            const after = buildEffectiveSampleCuration(
              withManualAction(raw, id, state.next, events),
              never,
            )[id];
            expect(after?.action ?? null, what).toBe(state.returnsTo);
            if (state.returnsTo) expect(after.actionAuto, what).toBe(true);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(64);
  });
});

/* The verdict chips follow one click semantics too, in the Samples tab,
   the Events table, the gallery cards and Guided validation. Outside the
   Samples tab an automatic verdict used to look like one set by hand, and
   its Pending chip read "Set 63D9's sample-level verdict to Pending"
   although a click could not change anything: the events still call for
   that verdict. */
describe("verdictChipState — what a click on a verdict chip does", () => {
  const events = [{ id: 0, source: "S", target: "T", verdict: TP }];
  const auto = syncSampleCuration({}, events); // T: automatic Contaminated
  const click = (sc, chip) =>
    withManualVerdict(sc, "T", verdictChipState(sc.T, chip).next, events);

  it("marks an automatic verdict, and leaves it alone on Pending", () => {
    expect(verdictChipState(auto.T, "contaminated")).toMatchObject({ active: true, auto: true });
    expect(verdictChipState(auto.T, "pending")).toMatchObject({
      active: false,
      auto: false,
      next: "pending",
      changes: false,
    });
    expect(click(auto, "pending")).toBe(auto);
  });

  it("makes the automatic verdict the curator's own on a click", () => {
    expect(verdictChipState(auto.T, "contaminated").changes).toBe(true);
    const t = click(auto, "contaminated").T;
    expect(t.verdict).toBe("contaminated");
    expect(t.verdictAuto).toBeUndefined();
  });

  it("removes the curator's own verdict on Pending: the rule's comes back", () => {
    const own = withManualVerdict(auto, "T", "correct", events);
    expect(verdictChipState(own.T, "correct")).toMatchObject({ active: true, auto: false, changes: false });
    expect(verdictChipState(own.T, "pending")).toMatchObject({ active: false, changes: true });
    expect(click(own, "pending").T).toEqual(auto.T);
  });

  it("shows Pending active when there is no verdict", () => {
    expect(verdictChipState(undefined, "pending")).toMatchObject({ active: true, auto: false, changes: false });
    expect(verdictChipState({ verdict: "pending" }, "pending").active).toBe(true); // older sessions
    expect(verdictChipState({ action: "keep" }, "contaminated")).toMatchObject({ active: false, changes: true });
  });

  it("says whether the click changes anything, on every kind of sample", () => {
    // T is targeted by one event from A; A is targeted by none (its
    // effective verdict is the default Not contaminated).
    let checked = 0;
    for (const evaluation of VERDICTS) {
      const events = [{ id: 0, source: "A", target: "T", verdict: evaluation }];
      const never = new Set(["A"]);
      for (const id of ["T", "A"]) {
        for (const verdict of [null, "contaminated", "correct", "uncertain"]) {
          let raw = syncSampleCuration({}, events);
          if (verdict) raw = withManualVerdict(raw, id, verdict, events);
          const entry = buildEffectiveSampleCuration(raw, never)[id];
          for (const chip of ["pending", "contaminated", "correct", "uncertain"]) {
            const state = verdictChipState(entry, chip);
            const what = `${id} ${evaluation} ${verdict} ${chip}`;
            const after = withManualVerdict(raw, id, state.next, events);
            expect(after !== raw, what).toBe(state.changes);
            expect(state.active, what).toBe((entry?.verdict || "pending") === chip);
            expect(state.auto, what).toBe(state.active && chip !== "pending" && !verdict);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(128);
  });
});
