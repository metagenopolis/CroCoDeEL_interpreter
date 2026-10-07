import { describe, it, expect } from "vitest";
import {
  buildEffectiveSampleCuration,
  neverTargetedSamples,
  sampleActionCounts,
  syncSampleCuration,
} from "../src/curation.js";
import { resolveSample } from "../src/diagnostics.js";
import {
  buildCuratedAbundance,
  curationOrigin,
  samplesReportCuration,
  samplesReportIndex,
} from "../src/exports.js";
import { parseAbundance, parseEvents } from "../src/parsing.js";

/* An event targets "s2"; the abundance table's column is "S2" (the app
   says the names differ only by case and matches them). The TP made "s2"
   Contaminated + Suppress and the curated table dropped "S2" - but "S2"
   counted as a sample no event targets: it got the default Not
   contaminated + Keep, and the samples TSV and HTML report listed both
   names, "S2" reading "correct default / keep default" (Total 9 for an
   8-sample table). */

const events = parseEvents(
  [
    "source\ttarget\trate\tprobability\tcontamination_specific_species",
    "S1\ts2\t0.25\t0.97\tsp_A",
    "S3\tS4\t0.1\t0.8\tsp_B",
  ].join("\n"),
).events.map((e, i) => (i === 0 ? { ...e, verdict: "true_positive" } : e));
const ab = parseAbundance(
  ["OTU_ID\tS1\tS2\tS3\tS4\tS5\tS6\tS7\tS8", "sp_A\t5\t1\t0\t3\t9\t3\t0\t1", "sp_B\t6\t1\t6\t9\t0\t5\t4\t4"].join("\n"),
);
const tableSample = (id) => resolveSample(ab, id);

describe("a table sample targeted under another spelling", () => {
  const never = neverTargetedSamples(events, ab.samples, tableSample);
  const eff = buildEffectiveSampleCuration(syncSampleCuration({}, events), never);

  it("is not a sample no event targets", () => {
    expect(never).toEqual(["S1", "S3", "S5", "S6", "S7", "S8"]);
    // Without a table, names are compared as they are.
    expect(neverTargetedSamples(events, ["S2"])).toContain("S2");
  });

  it("is one row of the samples TSV and report, with the event's curation", () => {
    const index = samplesReportIndex(events, ab);
    expect(index.ids).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]);
    expect(index.rowOf("s2")).toBe("S2");
    expect(index.names("S2")).toEqual(["S2", "s2"]);
    const c = samplesReportCuration(eff, index.names("S2"));
    expect(c).toMatchObject({ verdict: "contaminated", action: "suppress" });
    expect([curationOrigin(c, "verdict", true), curationOrigin(c, "action", true)]).toEqual(["automatic", "automatic"]);
    // What the curated table and the counts say.
    expect(buildCuratedAbundance(ab, eff, { matrix: false }).droppedSamples).toEqual(["S2"]);
    expect(sampleActionCounts(eff, index.ids.flatMap((id) => index.names(id)), tableSample)).toEqual({ keep: 0, suppress: 1 });
  });

  it("merges the notes of its names, and a Suppress wins", () => {
    const merged = samplesReportCuration(
      {
        S2: { verdict: "correct", action: "keep", notes: "table name" },
        s2: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true, notes: "events name" },
      },
      ["S2", "s2"],
    );
    expect(merged).toMatchObject({ verdict: "contaminated", action: "suppress", notes: "table name\n\nevents name" });
    expect(samplesReportCuration({ S2: { verdict: "uncertain" } }, ["S2", "s2"])).toEqual({ verdict: "uncertain" });
    expect(samplesReportCuration({}, ["S9"])).toEqual({});
  });
});
