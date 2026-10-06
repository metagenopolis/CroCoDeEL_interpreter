import { describe, it, expect } from "vitest";
import { migrateSampleCuration } from "../src/curation.js";

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
