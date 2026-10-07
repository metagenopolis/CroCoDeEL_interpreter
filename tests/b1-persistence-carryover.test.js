import { describe, it, expect } from "vitest";
import { curationSummary, replaceEvents, replaceReportLines, replacedRunMetadata } from "../src/carryOver.js";
import {
  buildEffectiveSampleCuration,
  neverTargetedSamples,
  sampleActionCounts,
  syncSampleCuration,
  withManualAction,
  withManualVerdict,
} from "../src/curation.js";
import { parseAbundance, parseEvents, tsvCell } from "../src/parsing.js";
import { buildCuratedAbundance } from "../src/App.jsx";

/* Replacing the events file used to wipe every evaluation, note and
   sample decision (setSampleCuration({}), events reset to pending).
   replaceEvents (src/carryOver.js) carries them over, or starts fresh,
   and reads the new file's own curation columns, the file winning. */

const ev = (id, source, target, verdict = "pending", notes = "", extra = {}) => ({
  id,
  source,
  target,
  rate: 0.1,
  score: 0.9,
  introduced: [],
  verdict,
  notes,
  ...extra,
});
/** A parsed events file: pending, no notes, unless the file says so. */
const file = (rows) => rows.map(([s, t, verdict, notes, fileAction], i) => ({
  ...ev(i, s, t, verdict || "pending", notes || ""),
  ...(fileAction ? { fileAction } : {}),
}));

describe("curationSummary", () => {
  it("counts evaluated and annotated events, and sample decisions set by hand", () => {
    const events = [ev(0, "A", "B", "true_positive"), ev(1, "A", "C", "pending", "n"), ev(2, "A", "D")];
    const sc = {
      B: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true },
      C: { action: "keep" },
      D: { notes: "looked at it" },
    };
    expect(curationSummary(events, sc)).toEqual({ evaluations: 1, notes: 1, sampleEntries: 2, any: true });
    expect(curationSummary([ev(0, "A", "B")], { B: { verdict: "correct", verdictAuto: true } }).any).toBe(false);
  });
});

describe("replaceEvents — carry over", () => {
  it("matches events by source and target, duplicates in file order", () => {
    const old = [
      ev(0, "A", "B", "true_positive", "first"),
      ev(1, "A", "B", "false_positive", "second"),
      ev(2, "C", "D", "uncertain"),
      ev(3, "E", "F", "true_positive", "gone"),
    ];
    const { events, report } = replaceEvents({
      oldEvents: old,
      oldSampleCuration: {},
      newEvents: file([["C", "D"], ["A", "B"], ["X", "Y"], ["A", "B"], ["A", "B"]]),
      carryOver: true,
    });
    expect(events.map((e) => [e.id, e.verdict, e.notes])).toEqual([
      [0, "uncertain", ""],
      [1, "true_positive", "first"],
      [2, "pending", ""],
      [3, "false_positive", "second"],
      [4, "pending", ""],
    ]);
    expect(report).toMatchObject({ matched: 3, added: 2, dropped: 1, droppedCurated: 1, keptVerdicts: 3, keptNotes: 2 });
  });

  it("the file wins where both have a value; an empty cell erases nothing", () => {
    const old = [ev(0, "A", "B", "true_positive", "mine"), ev(1, "A", "C", "false_positive", "mine too"), ev(2, "A", "D", "uncertain")];
    const { events, report } = replaceEvents({
      oldEvents: old,
      oldSampleCuration: {},
      newEvents: file([["A", "B", "false_positive", "theirs"], ["A", "C", "pending", ""], ["A", "D", "uncertain", "noted"]]),
      carryOver: true,
    });
    expect(events.map((e) => [e.verdict, e.notes])).toEqual([
      ["false_positive", "theirs"],
      ["false_positive", "mine too"],
      ["uncertain", "noted"],
    ]);
    expect(report).toMatchObject({ fileVerdicts: 2, fileNotes: 2, replacedVerdicts: 1, replacedNotes: 1, keptVerdicts: 1, keptNotes: 1 });
  });

  it("keeps the sample decisions set by hand for samples still present, and recomputes the automatic ones", () => {
    const old = [ev(0, "A", "B", "true_positive"), ev(1, "A", "C", "false_positive")];
    let sc = syncSampleCuration({}, old);
    sc = withManualVerdict(sc, "C", "contaminated", old); // by hand
    sc = withManualAction(sc, "A", "keep", old); // a source, by hand
    sc = { ...sc, Z: { verdict: "uncertain", notes: "gone" }, Q: { notes: "only in the abundance table" } };
    const { sampleCuration, report } = replaceEvents({
      oldEvents: old,
      oldSampleCuration: sc,
      // B's TP is not in the new file; C's FP is.
      newEvents: file([["A", "C"], ["A", "B", "uncertain"]]),
      sampleIds: ["A", "B", "C", "Q"],
      carryOver: true,
    });
    // C: the verdict set by hand stays, with its automatic Suppress.
    expect(sampleCuration.C).toEqual({ verdict: "contaminated", action: "suppress", actionAuto: true });
    expect(sampleCuration.A).toEqual({ action: "keep" });
    expect(sampleCuration.Q).toEqual({ notes: "only in the abundance table" });
    // B: its automatic Contaminated came from the TP, which is gone; the
    // new file says Uncertain.
    expect(sampleCuration.B).toEqual({ verdict: "uncertain", verdictAuto: true });
    expect(sampleCuration.Z).toBeUndefined();
    expect(report).toMatchObject({ keptSampleEntries: 3, droppedSampleEntries: 1 });
  });
});

describe("replaceEvents — events added by hand", () => {
  // Scatter › Explore new pairs: a false negative CroCoDeEL missed, which
  // no CroCoDeEL file holds.
  const old = [
    ev(0, "A", "B", "true_positive"),
    ev("manual-1", "C", "D", "true_positive", "missed by CroCoDeEL"),
    ev("manual-2", "E", "F", "uncertain", "a later run found it"),
    ev("manual-3", "G", "H", "false_positive", "checked"),
  ];

  it("carried over: kept after the file's events, renumbered, and still yours when the file has their pair", () => {
    const { events, sampleCuration, report } = replaceEvents({
      oldEvents: old,
      oldSampleCuration: syncSampleCuration({}, old),
      newEvents: file([["A", "B"], ["E", "F"]]),
      carryOver: true,
    });
    // E → F, which the new file has, stays an event added by hand: a
    // later file without it keeps it (it used to become the file's event
    // 1, and the next rerun's carry-over dropped it).
    expect(events.map((e) => [e.id, e.source, e.target, e.verdict, e.notes])).toEqual([
      [0, "A", "B", "true_positive", ""],
      ["manual-1", "E", "F", "uncertain", "a later run found it"],
      ["manual-2", "C", "D", "true_positive", "missed by CroCoDeEL"],
      ["manual-3", "G", "H", "false_positive", "checked"],
    ]);
    // Their targets follow them, with the shared rule.
    expect(sampleCuration.D).toEqual({ verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true });
    expect(sampleCuration.H).toEqual({ verdict: "correct", verdictAuto: true });
    expect(report).toMatchObject({ matched: 2, added: 0, dropped: 0, keptManual: 2, manual: 3 });
    expect(replaceReportLines(report).join(" ")).toMatch(
      /2 events you added by hand \(Explore new pairs\) are not in the new file: kept, with their evaluations and notes\./,
    );
  });

  it("started fresh: dropped with the rest, and the banner counts them", () => {
    const { events, report } = replaceEvents({
      oldEvents: old,
      oldSampleCuration: {},
      newEvents: file([["A", "B"]]),
      carryOver: false,
    });
    expect(events.map((e) => e.id)).toEqual([0]);
    expect(report).toMatchObject({ keptManual: 0, manual: 3 });
    expect(replaceReportLines(report)[0]).toMatch(
      /Started fresh: your previous curation \(4 evaluations, 3 notes, 3 events added by hand\) was dropped\./,
    );
  });
});

describe("replaceEvents — start fresh", () => {
  it("keeps nothing of the session, and reads the file's own curation", () => {
    const old = [ev(0, "A", "B", "true_positive", "mine")];
    const { events, sampleCuration, report } = replaceEvents({
      oldEvents: old,
      oldSampleCuration: { B: { verdict: "contaminated" }, A: { action: "keep" } },
      newEvents: file([["A", "B"], ["A", "C", "false_positive", "theirs", "keep"]]),
      carryOver: false,
    });
    expect(events.map((e) => [e.verdict, e.notes])).toEqual([["pending", ""], ["false_positive", "theirs"]]);
    expect(sampleCuration).toEqual({ C: { verdict: "correct", verdictAuto: true, action: "keep" } });
    expect(report.previous).toMatchObject({ evaluations: 1, notes: 1, sampleEntries: 2 });
    expect(replaceReportLines(report)[0]).toMatch(/Started fresh: your previous curation \(1 evaluation, 1 note, 2 sample decisions\) was dropped/);
  });
});

describe("replaceEvents — the file's actions", () => {
  const run = (rows, oldSampleCuration = {}, oldEvents = []) =>
    replaceEvents({ oldEvents, oldSampleCuration, newEvents: file(rows), carryOver: true });

  it("applies an action all of a target's rows agree on, as the curator's own", () => {
    const { sampleCuration, report } = run([
      ["A", "T1", "true_positive", "", "keep"],
      ["B", "T1", "pending", "", "keep"],
      ["A", "T2", "false_positive", "", "suppress"],
      ["A", "T3", "pending", "", "keep"],
    ]);
    expect(sampleCuration.T1).toEqual({ verdict: "contaminated", verdictAuto: true, action: "keep" });
    expect(sampleCuration.T2).toEqual({ verdict: "correct", verdictAuto: true, action: "suppress" });
    expect(sampleCuration.T3).toEqual({ action: "keep" });
    expect(report.fileActions).toBe(3);
  });

  it("leaves the rule's own value alone, and a target whose rows disagree", () => {
    const { sampleCuration, report } = run([
      ["A", "T1", "true_positive", "", "suppress"],
      ["A", "T2", "true_positive", "", "keep"],
      ["B", "T2", "true_positive", "", "suppress"],
      ["A", "T3", "false_positive", "", "keep"],
      ["B", "T3", "false_positive", "", ""],
    ]);
    expect(sampleCuration.T1).toEqual({ verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true });
    expect(sampleCuration.T2.actionAuto).toBe(true);
    expect(sampleCuration.T3).toEqual({ verdict: "correct", verdictAuto: true });
    expect(report).toMatchObject({ fileActions: 0, conflictingActions: 2 });
  });

  it("wins over an action the curator set, and says so", () => {
    const old = [ev(0, "A", "T1", "true_positive")];
    const sc = withManualAction(syncSampleCuration({}, old), "T1", "keep", old);
    const { sampleCuration, report } = run([["A", "T1", "pending", "", "suppress"]], sc, old);
    expect(sampleCuration.T1).toEqual({ verdict: "contaminated", verdictAuto: true, action: "suppress" });
    expect(report.replacedActions).toBe(1);
  });

  it("drops fileAction from the events", () => {
    const { events } = run([["A", "T1", "pending", "", "keep"]]);
    expect(events[0]).not.toHaveProperty("fileAction");
  });
});

/* The curated events TSV of the Export tab (exportReport), written from a
   curated session, then loaded into an empty one: every evaluation, note
   and sample action, so every count and the curated abundance table,
   come back. */
describe("replaceEvents — an export reloaded into an empty session reproduces it", () => {
  const AB = parseAbundance(
    [
      "species\tS1\tS2\tS3\tT1\tT2\tT3\tT4",
      "sp_a\t1\t2\t3\t4\t5\t6\t7",
      "sp_b\t0\t1\t0\t1\t0\t1\t0",
    ].join("\n"),
  );
  const original = () => {
    let events = [
      ev(0, "S1", "T1", "true_positive", '"quoted" note'),
      ev(1, "S2", "T1", "false_positive"),
      ev(2, "S1", "T2", "false_positive", "fp"),
      ev(3, "S3", "T3", "true_positive"),
      ev(4, "S2", "T4", "uncertain"),
      ev(5, "S3", "T2", "false_positive"),
    ].map((e) => ({ ...e, introduced: ["sp_a"] }));
    let sc = syncSampleCuration({}, events);
    sc = withManualAction(sc, "T3", "keep", events); // contaminated, kept by hand
    sc = withManualAction(sc, "T2", "suppress", events); // not contaminated, suppressed by hand
    sc = withManualAction(sc, "T4", "keep", events); // uncertain, kept by hand
    return { events, sc };
  };
  /** The rows exportReport writes. */
  const exportTSV = ({ events, sc }) =>
    [
      "# study: test",
      ["source", "target", "contamination_rate", "probability", "introduced_pct", "introduced_species", "verdict", "action", "notes"].join("\t"),
      ...events.map((e) =>
        [e.source, e.target, e.rate, e.score, "", e.introduced.join(","), e.verdict, sc[e.target]?.action || "", e.notes]
          .map(tsvCell)
          .join("\t"),
      ),
    ].join("\n");
  const view = (events, sc) => {
    const never = new Set(neverTargetedSamples(events, AB.samples));
    const effective = buildEffectiveSampleCuration(sc, never);
    const cur = buildCuratedAbundance(AB, effective, { dropEmptySpecies: true });
    return {
      evaluations: events.map((e) => [e.source, e.target, e.verdict, e.notes]),
      actions: Object.fromEntries(AB.samples.map((s) => [s, effective[s]?.action || null])),
      counts: sampleActionCounts(effective, undefined, (id) => (AB.samples.includes(id) ? id : null)),
      kept: cur.samples,
    };
  };

  it("gives the same evaluations, notes, sample actions, counts and curated table", () => {
    const o = original();
    const parsed = parseEvents(exportTSV(o));
    expect(parsed.curation).toEqual({ verdicts: 6, notes: 2, actions: 6 });
    const { events, sampleCuration, report } = replaceEvents({
      oldEvents: [],
      oldSampleCuration: {},
      newEvents: parsed.events,
      sampleIds: AB.samples,
      carryOver: false,
    });
    expect(view(events, sampleCuration)).toEqual(view(o.events, o.sc));
    expect(view(o.events, o.sc).counts).toEqual({ keep: 2, suppress: 2 });
    expect(report).toMatchObject({ fileVerdicts: 6, fileNotes: 2, fileActions: 3 });
    const lines = replaceReportLines(report);
    expect(lines.join(" ")).toMatch(/Restored from the file: 6 evaluations, 2 notes, 3 sample actions\./);
    expect(lines.join(" ")).toMatch(/only the session JSON \(Download session\) keeps them/);
    // The notes come back as the TSV holds them: on one line.
    expect(report.notesFromFile).toBe(2);
    expect(lines.join(" ")).toMatch(/Notes read from the file are on one line, as the events TSV holds them/);
  });

  it("and again when carried over into the session it came from", () => {
    const o = original();
    const parsed = parseEvents(exportTSV(o));
    const { events, sampleCuration, report } = replaceEvents({
      oldEvents: o.events,
      oldSampleCuration: o.sc,
      newEvents: parsed.events,
      sampleIds: AB.samples,
      carryOver: true,
    });
    expect(view(events, sampleCuration)).toEqual(view(o.events, o.sc));
    expect(report).toMatchObject({ matched: 6, added: 0, dropped: 0, replacedVerdicts: 0, replacedNotes: 0, replacedActions: 0, fileActions: 0 });
  });
});

describe("replaceEvents — notes the TSV holds on one line", () => {
  it("keeps the session's own note when the file has its one-line copy", () => {
    const note = "first line\n\n[bulk 2026-10-07] second\twith a tab";
    const old = [ev(0, "A", "B", "true_positive", note)];
    // What tsvCell writes and parseEvents reads back.
    const { events, report } = replaceEvents({
      oldEvents: old,
      oldSampleCuration: {},
      newEvents: file([["A", "B", "true_positive", "first line [bulk 2026-10-07] second with a tab"]]),
      carryOver: true,
    });
    expect(events[0].notes).toBe(note);
    expect(report).toMatchObject({ replacedNotes: 0, keptNotes: 0, fileNotes: 1, notesFromFile: 0 });
    expect(replaceReportLines(report).join(" ")).not.toMatch(/on one line/);
  });
});

describe("replacedRunMetadata — the run header after a replacement", () => {
  const run = { "crocodeel version": "1.2.1", filtering_ab_thr_factor: "20.0", probability_cutoff: "0.5" };

  it("a curated export carries the study title, no run header: carried over, the session keeps its own", () => {
    const curated = parseEvents(["# study: My study", "source\ttarget\trate\tprobability\tverdict", "A\tB\t0.1\t0.9\ttrue_positive"].join("\n"));
    expect(curated.runMetadata).toEqual({ study: "My study" });
    expect(replacedRunMetadata(curated.runMetadata, run, true)).toEqual({ runMetadata: run, study: "My study", kept: true });
    // Started fresh, nothing of the session is kept, and the title is
    // no run parameter.
    expect(replacedRunMetadata(curated.runMetadata, run, false)).toEqual({ runMetadata: null, study: "My study", kept: false });
  });

  it("a file with CroCoDeEL's run header brings its own, even carried over", () => {
    const rerun = { ...run, filtering_ab_thr_factor: "None", study: "Rerun" };
    expect(replacedRunMetadata(rerun, run, true)).toEqual({
      runMetadata: { "crocodeel version": "1.2.1", filtering_ab_thr_factor: "None", probability_cutoff: "0.5" },
      study: "Rerun",
      kept: false,
    });
    expect(replacedRunMetadata(null, null, true)).toEqual({ runMetadata: null, study: null, kept: false });
  });
});

describe("replaceReportLines", () => {
  it("says nothing for a CroCoDeEL output loaded into a session without curation", () => {
    const { report } = replaceEvents({ oldEvents: [], oldSampleCuration: {}, newEvents: file([["A", "B"]]), carryOver: false });
    expect(replaceReportLines(report)).toEqual([]);
  });

  it("names the new events, the ones dropped and what was kept", () => {
    const { report } = replaceEvents({
      oldEvents: [ev(0, "A", "B", "true_positive", "n"), ev(1, "C", "D", "false_positive")],
      oldSampleCuration: { B: { action: "keep" } },
      newEvents: file([["A", "B"], ["E", "F"]]),
      carryOver: true,
    });
    const text = replaceReportLines(report).join("\n");
    expect(text).toMatch(/2 events in the new file: 1 matched an event of your session \(same source and target\), 1 new one\./);
    expect(text).toMatch(/1 event of your session is not in the new file: the evaluations and notes of 1 of them were dropped\./);
    expect(text).toMatch(/Kept from your session: 1 evaluation, 1 note, 1 sample decision\./);
    expect(text).not.toMatch(/session JSON/);
  });

  it("says what the events TSV does not hold whenever the file has curation columns", () => {
    const { report } = replaceEvents({
      oldEvents: [],
      oldSampleCuration: {},
      newEvents: file([["A", "B"]]),
      carryOver: false,
      fileHasCuration: true,
    });
    expect(replaceReportLines(report).join(" ")).toMatch(
      /The notes of the samples, and the verdict and action of a sample no event targets, are not stored in the events TSV/,
    );
  });
});
