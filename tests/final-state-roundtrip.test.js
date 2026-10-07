import { describe, it, expect } from "vitest";
import { curatedEventsToTSV, buildCuratedAbundance } from "../src/exports.js";
import { parseAbundance, parseEvents, tsvCell } from "../src/parsing.js";
import { replaceEvents, replaceReportLines } from "../src/carryOver.js";
import {
  buildEffectiveSampleCuration,
  neverTargetedSamples,
  sampleActionCounts,
  syncSampleCuration,
  withManualVerdict,
} from "../src/curation.js";

/* The curated events TSV of the Export tab, reloaded into an empty session,
   is said to give back the same counts and the same curated abundance
   table. It did not:
     - a target whose verdict the curator set by hand against its events
       (Not contaminated or Uncertain, with a true positive among them)
       was written with an empty action and no verdict, and came back
       Contaminated + Suppress: the curated table lost the sample;
     - an event added by hand (Explore new pairs) came back as one of
       CroCoDeEL's, so the next rerun's carry-over dropped it, with its
       true positive. */

const ROWS = [
  ["S1", "T1", "true_positive"],
  ["S2", "T1", "pending"],
  ["S3", "T2", "true_positive"],
  ["S4", "T3", "false_positive"],
];
const RUN = parseEvents(
  [
    "# crocodeel version: 1.2.1 | filtering_ab_thr_factor: None",
    "source\ttarget\trate\tprobability\tcontamination_specific_species",
    ...ROWS.map(([s, t], i) => `${s}\t${t}\t0.${i + 1}\t0.9\tsp_a`),
  ].join("\n"),
);
const AB = parseAbundance(
  ["species\tS1\tS2\tS3\tS4\tT1\tT2\tT3", "sp_a\t5\t1\t2\t3\t1\t1\t1", "sp_b\t1\t1\t1\t1\t4\t2\t2"].join("\n"),
);
const samples = AB.samples;

/** A curated session of these events: evaluations, then `edit`. */
function session(edit = (sc) => sc, extraEvents = []) {
  const events = [
    ...RUN.events.map((e, i) => ({ ...e, verdict: ROWS[i][2] })),
    ...extraEvents,
  ];
  return { events, sampleCuration: edit(syncSampleCuration({}, events), events) };
}

/** What every reader shows, and what the Export tab and the curated
    table count from it. */
function outcome({ events, sampleCuration }) {
  const eff = buildEffectiveSampleCuration(sampleCuration, neverTargetedSamples(events, samples));
  return {
    verdicts: Object.fromEntries(["T1", "T2", "T3"].map((t) => [t, eff[t]?.verdict ?? null])),
    counts: sampleActionCounts(eff, undefined, (id) => (samples.includes(id) ? id : null)),
    dropped: buildCuratedAbundance(AB, eff, { matrix: false }).droppedSamples,
    eff,
  };
}

/** Export the session's curated events TSV, then load it into a fresh
    session (or, with `into`, carried over into that one). */
function reload(s, into = null) {
  const before = outcome(s);
  const text = curatedEventsToTSV(s.events, { runMetadata: RUN.runMetadata, sampleCuration: before.eff });
  const parsed = parseEvents(text);
  const next = replaceEvents({
    oldEvents: into?.events || [],
    oldSampleCuration: into?.sampleCuration || {},
    newEvents: parsed.events,
    sampleIds: samples,
    carryOver: !!into,
    fileHasCuration: !!parsed.curation,
    fileColumns: parsed.curationColumns,
  });
  return { text, parsed, ...next };
}

describe("curated events TSV — a target's verdict set by hand comes back", () => {
  for (const verdict of ["correct", "uncertain"]) {
    it(`${verdict}: the same verdict, counts and curated table after a reload`, () => {
      const s = session((sc, events) => withManualVerdict(sc, "T1", verdict, events));
      const before = outcome(s);
      expect(before.dropped).toEqual(["T2"]);
      const back = reload(s);
      const after = outcome(back);
      expect(after.verdicts).toEqual(before.verdicts);
      expect(after.counts).toEqual(before.counts);
      expect(after.dropped).toEqual(before.dropped);
      // The curator's own verdict again, with no action.
      expect(back.sampleCuration.T1).toEqual({ verdict });
      expect(back.report.fileSampleVerdicts).toBe(1);
      expect(replaceReportLines(back.report).join(" ")).toMatch(/1 sample verdict/);
    });
  }

  it("writes each target's verdict next to its action", () => {
    const s = session((sc, events) => withManualVerdict(sc, "T1", "correct", events));
    const { text } = reload(s);
    const lines = text.split("\n");
    const header = lines[1].split("\t");
    const col = (row, name) => row.split("\t")[header.indexOf(name)];
    const t1 = lines.find((l) => l.startsWith("S1\tT1\t"));
    const t2 = lines.find((l) => l.startsWith("S3\tT2\t"));
    expect([col(t1, "sample_verdict"), col(t1, "action")]).toEqual(["correct", ""]);
    expect([col(t2, "sample_verdict"), col(t2, "action")]).toEqual(["contaminated", "suppress"]);
  });

  it("a file of an earlier layout, without sample verdicts: the targets now suppressed are named", () => {
    // The previous version's curated TSV: renamed columns, a TP on T1
    // whose Suppress the curator had cleared (empty action).
    const old = [
      "source\ttarget\tcontamination_rate\tprobability\tintroduced_pct\tintroduced_species\tverdict\taction\tnotes",
      ["S1", "T1", "0.1", "0.9", "", "sp_a", "true_positive", "", ""].map(tsvCell).join("\t"),
      ["S3", "T2", "0.3", "0.9", "", "sp_a", "true_positive", "suppress", ""].map(tsvCell).join("\t"),
      ["S4", "T3", "0.4", "0.9", "", "sp_a", "true_positive", "keep", ""].map(tsvCell).join("\t"),
    ].join("\n");
    const parsed = parseEvents(old);
    const { report } = replaceEvents({
      oldEvents: [],
      oldSampleCuration: {},
      newEvents: parsed.events,
      carryOver: false,
      fileHasCuration: !!parsed.curation,
      fileColumns: parsed.curationColumns,
    });
    expect(report.suppressedWithoutAction).toEqual(["T1"]);
    expect(replaceReportLines(report).join(" ")).toMatch(/Now to suppress, although the file gives no action for it \(1\): T1/);
  });
});

describe("curated events TSV — an event added by hand stays one", () => {
  const manual = { id: "manual-1", source: "S4", target: "T4", rate: 0.2, score: 0.9, introduced: ["sp_a"], verdict: "true_positive", notes: "Manually added by user" };
  /** The next CroCoDeEL run (the same events, pending), carried over. */
  const rerun = ({ events, sampleCuration }) =>
    replaceEvents({
      oldEvents: events,
      oldSampleCuration: sampleCuration,
      newEvents: RUN.events.map((e) => ({ ...e })),
      sampleIds: samples,
      carryOver: true,
    });

  it("is marked in the file, comes back added by hand, and survives the next rerun's carry-over", () => {
    const s = session((sc) => sc, [manual]);
    const back = reload(s);
    const row = back.text.split("\n").find((l) => l.startsWith("S4\tT4\t"));
    expect(row.split("\t").at(-1)).toBe("manual");
    const again = back.events.find((e) => e.target === "T4");
    expect(again.id).toBe("manual-1");
    expect(replaceReportLines(back.report).join(" ")).toMatch(/1 event added by hand/);
    // The next CroCoDeEL run, which does not have it, carried over.
    const next = rerun(back);
    const kept = next.events.find((e) => e.target === "T4");
    expect(kept).toMatchObject({ id: "manual-1", verdict: "true_positive" });
    expect(next.report.keptManual).toBe(1);
    expect(next.sampleCuration.T4).toMatchObject({ verdict: "contaminated", action: "suppress" });
  });

  it("carried over, its own export without origin column keeps it added by hand", () => {
    const s = session((sc) => sc, [manual]);
    // A file of the previous layout: no origin column.
    const text = curatedEventsToTSV(s.events, { sampleCuration: outcome(s).eff })
      .split("\n")
      .map((l) => l.split("\t").slice(0, -1).join("\t"))
      .join("\n");
    const parsed = parseEvents(text);
    const back = replaceEvents({
      oldEvents: s.events,
      oldSampleCuration: s.sampleCuration,
      newEvents: parsed.events,
      sampleIds: samples,
      carryOver: true,
      fileHasCuration: true,
      fileColumns: parsed.curationColumns,
    });
    expect(back.events.find((e) => e.target === "T4").id).toBe("manual-1");
    const next = rerun(back);
    expect(next.events.find((e) => e.target === "T4")).toMatchObject({ id: "manual-1", verdict: "true_positive" });
  });
});
