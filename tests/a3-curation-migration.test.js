import { describe, it, expect } from "vitest";
import { migrateSampleCuration, SAMPLE_CURATION_VERSION } from "../src/curation.js";

/* Sessions saved before the sample-level model kept the keep / suppress
   action on each event. The migration moves it to the target sample;
   when the events of one target disagree, the legacy app's own reading
   decides: the most severe action wins (its Network curation colouring
   painted "the most-severe action targeting it", and its events TSV
   listed every event's action, so a filter on "suppress" dropped the
   sample as soon as one of its events said so). */

// Pending unless a test says otherwise, so the automatic verdicts the
// migration also recomputes stay out of the way of the legacy actions.
const ev = (id, target, action, verdict = "pending") => ({
  id,
  source: `S${id}`,
  target,
  verdict,
  ...(action ? { action } : {}),
});

describe("migrateSampleCuration — legacy per-event actions", () => {
  it("resolves keep + suppress on one target to suppress, in either order", () => {
    for (const actions of [
      ["keep", "suppress"],
      ["suppress", "keep"],
      ["keep", "keep", "suppress"],
      ["suppress", "keep", "keep"],
    ]) {
      const events = actions.map((a, i) => ev(i, "T", a));
      const { sampleCuration } = migrateSampleCuration(events, {});
      expect(sampleCuration.T, actions.join(",")).toEqual({ action: "suppress" });
    }
  });

  it("keeps a single action as it is", () => {
    expect(migrateSampleCuration([ev(0, "T", "keep")], {}).sampleCuration).toEqual({
      T: { action: "keep" },
    });
    expect(
      migrateSampleCuration([ev(0, "T", "suppress"), ev(1, "T", null)], {}).sampleCuration,
    ).toEqual({ T: { action: "suppress" } });
  });

  it("migrates each target on its own", () => {
    const { sampleCuration } = migrateSampleCuration(
      [ev(0, "A", "keep"), ev(1, "B", "suppress"), ev(2, "A", "keep"), ev(3, "B", "keep")],
      {},
    );
    expect(sampleCuration).toEqual({ A: { action: "keep" }, B: { action: "suppress" } });
  });

  it("never overrides an action already recorded on the sample", () => {
    const { sampleCuration } = migrateSampleCuration(
      [ev(0, "T", "suppress")],
      { T: { verdict: "correct", action: "keep", notes: "n" } },
    );
    expect(sampleCuration.T).toEqual({ verdict: "correct", action: "keep", notes: "n" });
  });

  it("keeps the rest of the sample entry", () => {
    const { sampleCuration } = migrateSampleCuration(
      [ev(0, "T", "keep"), ev(1, "T", "suppress")],
      { T: { verdict: "contaminated", notes: "plate edge" } },
    );
    expect(sampleCuration.T).toEqual({
      verdict: "contaminated",
      notes: "plate edge",
      action: "suppress",
    });
  });

  it("ignores values no legacy picker offered, but still reports them for stripping", () => {
    const { sampleCuration, touched } = migrateSampleCuration(
      [ev(0, "T", "decontaminate"), ev(1, "U", "keep")],
      {},
    );
    expect(sampleCuration).toEqual({ U: { action: "keep" } });
    expect(touched).toBe(true);
  });

  it("is a no-op on a current session", () => {
    const sc = { T: { verdict: "uncertain" } };
    const { sampleCuration, touched } = migrateSampleCuration([ev(0, "T", null)], sc);
    expect(sampleCuration).toEqual(sc);
    expect(touched).toBe(false);
  });

  it("survives a missing session", () => {
    expect(migrateSampleCuration(undefined, undefined)).toEqual({
      sampleCuration: {},
      touched: false,
      changes: null,
    });
  });
});

describe("migrateSampleCuration — automatic values recomputed on load", () => {
  it("brings automatic values saved by an older version in line with the rule", () => {
    const events = [
      { id: 0, source: "A", target: "T1", verdict: "pending" },
      { id: 1, source: "A", target: "T2", verdict: "true_positive" },
      { id: 2, source: "B", target: "T3", verdict: "false_positive" },
      { id: 3, source: "C", target: "T3", verdict: "false_positive" },
    ];
    const { sampleCuration, touched } = migrateSampleCuration(events, {
      // F then P left an automatic verdict on an all-pending target.
      T1: { verdict: "correct", verdictAuto: true },
      // A bulk TP never reached T2. (No entry at all.)
      // A bulk FP over TP events left the automatic Suppress behind.
      T3: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true },
    });
    expect(sampleCuration.T1).toBeUndefined();
    expect(sampleCuration.T2).toEqual({
      verdict: "contaminated",
      verdictAuto: true,
      action: "suppress",
      actionAuto: true,
    });
    expect(sampleCuration.T3).toEqual({ verdict: "correct", verdictAuto: true });
    expect(touched).toBe(true);
  });

  it("leaves manual values and consistent sessions alone", () => {
    const events = [{ id: 0, source: "A", target: "T", verdict: "true_positive" }];
    const sc = {
      T: { verdict: "uncertain", action: "keep", notes: "n" },
    };
    const { sampleCuration, touched } = migrateSampleCuration(events, sc);
    expect(sampleCuration).toEqual(sc);
    expect(touched).toBe(false);
  });
});

/* Sessions are saved with the model they follow (SAMPLE_CURATION_VERSION).
   The clean-up of the earlier model must only touch sessions saved before
   it: the same entries, in a current session, are the curator's
   decisions. */
describe("migrateSampleCuration — which model a session was saved under", () => {
  const tp = (id, target) => ({ id, source: `S${id}`, target, verdict: "true_positive" });
  const fp = (id, target) => ({ id, source: `S${id}`, target, verdict: "false_positive" });

  it("keeps a Not contaminated + Keep set by hand on a never-targeted sample", () => {
    // The Samples tab writes exactly this entry when the curator clicks
    // Not contaminated, then Keep, on a sample no event targets.
    const sc = { S0: { verdict: "correct", action: "keep" } };
    const { sampleCuration, touched, changes } = migrateSampleCuration(
      [tp(0, "T")],
      { ...sc, T: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true } },
      SAMPLE_CURATION_VERSION,
    );
    expect(sampleCuration.S0).toEqual(sc.S0);
    expect(touched).toBe(false);
    expect(changes).toBeNull();
  });

  it("drops that entry from a session saved by an earlier version (a stamp)", () => {
    const { sampleCuration } = migrateSampleCuration(
      [tp(0, "T")],
      { S0: { verdict: "correct", action: "keep" } },
      undefined,
    );
    expect(sampleCuration.S0).toBeUndefined();
  });

  it("turns an earlier session's cleared Suppress into a Keep set by hand", () => {
    // The previous version left a Contaminated sample with no action when
    // the curator removed its Suppress, and its curated table kept it.
    const events = [tp(0, "T1"), tp(1, "T2"), fp(2, "T3")];
    const { sampleCuration, changes } = migrateSampleCuration(events, {
      T1: { verdict: "contaminated", verdictAuto: true }, // TP click, then Clear suppress
      T2: { verdict: "contaminated", notes: "n" }, // set by hand, then Clear suppress
      T3: { verdict: "contaminated", verdictAuto: true }, // its events are FP now
    });
    expect(sampleCuration.T1).toEqual({ verdict: "contaminated", verdictAuto: true, action: "keep" });
    expect(sampleCuration.T2).toEqual({ verdict: "contaminated", notes: "n", action: "keep" });
    // Not Contaminated any more: nothing would pair a Suppress, no Keep needed.
    expect(sampleCuration.T3).toEqual({ verdict: "correct", verdictAuto: true });
    expect(changes).toEqual({ nowSuppressed: [], noLongerSuppressed: [], keptAsKeep: ["T1", "T2"] });
  });

  it("lists what the curated table drops differently after the update", () => {
    const events = [tp(0, "A"), fp(1, "B"), tp(2, "C"), tp(3, "D")];
    const { sampleCuration, changes } = migrateSampleCuration(events, {
      // A: a bulk TP never reached it.
      B: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true }, // bulk FP over TP
      C: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true }, // up to date
      D: { verdict: "contaminated", action: "keep" }, // by hand
    });
    expect(sampleCuration.A).toMatchObject({ action: "suppress", actionAuto: true });
    expect(changes).toEqual({ nowSuppressed: ["A"], noLongerSuppressed: ["B"], keptAsKeep: [] });
  });

  it("has nothing to report on an earlier session that already follows the rule", () => {
    const sc = { C: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true } };
    const { sampleCuration, touched, changes } = migrateSampleCuration([tp(0, "C")], sc);
    expect(sampleCuration).toBe(sc);
    expect(touched).toBe(false);
    expect(changes).toBeNull();
  });

  it("reports nothing for a current session, and applies only the rule", () => {
    const sc = { T: { verdict: "contaminated" } };
    const { sampleCuration, changes } = migrateSampleCuration(
      [tp(0, "T")],
      sc,
      SAMPLE_CURATION_VERSION,
    );
    // The current model never stores this state; if a file carries it,
    // the rule applies as for any sample.
    expect(sampleCuration.T).toEqual({ verdict: "contaminated", action: "suppress", actionAuto: true });
    expect(changes).toBeNull();
  });

  it("reads a version saved as a string", () => {
    const sc = { S0: { verdict: "correct", action: "keep" } };
    expect(migrateSampleCuration([], sc, String(SAMPLE_CURATION_VERSION)).sampleCuration).toBe(sc);
  });
});
