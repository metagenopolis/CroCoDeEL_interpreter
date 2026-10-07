import { describe, it, expect } from "vitest";
import { newerLegacyMain, sessionFromLegacyMain, upgradedSession } from "../src/persistence.js";
import { migrateSampleCuration, SAMPLE_CURATION_VERSION } from "../src/curation.js";

/* A session the previous version stored ("main" record, no sample
   curation version) is written into the current records on boot. AppMain
   then brought its curation up to date with the current model on mount,
   as a change of the session: each tab that opened it wrote that change,
   so two tabs restored at once on such a session ended with one of them
   saying "This session was changed in another tab" and saving nothing.
   The boot now writes it up to date (upgradedSession), once. */

const tp = (id, source, target, extra = {}) => ({
  id,
  source,
  target,
  rate: 0.1,
  score: 0.9,
  introduced: ["sp_a"],
  verdict: "true_positive",
  notes: "",
  ...extra,
});

const previousMain = () => ({
  version: 1,
  savedAt: "2026-10-07T10:00:00.000Z",
  rawEvents: [
    tp(0, "S1", "T1"),
    // A pre-sample-model event, its action still on it.
    tp(1, "S2", "T2", { verdict: "false_positive", action: "keep" }),
  ],
  sampleCuration: {
    // A bulk TP never reached T1. The stamp of a sample no event targets.
    S1: { verdict: "correct", action: "keep" },
  },
  runMetadata: null,
  metadata: null,
  plateMap: null,
  analysisTitle: "Plate 3",
  tab: "samples",
  selId: 0,
  filter: null,
  sort: null,
});

describe("upgradedSession — a session of the previous version, up to date before it is written", () => {
  const stored = sessionFromLegacyMain(previousMain(), null);
  const { session, changes } = upgradedSession(stored);

  it("follows the current model, its legacy actions moved to the samples", () => {
    expect(session.sampleCurationVersion).toBe(SAMPLE_CURATION_VERSION);
    expect(session.sampleCuration.T1).toEqual({ verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true });
    expect(session.sampleCuration.T2).toMatchObject({ verdict: "correct", action: "keep" });
    expect(session.sampleCuration.S1).toBeUndefined();
    expect(session.rawEvents.some((e) => "action" in e)).toBe(false);
    expect(changes).toEqual({ nowSuppressed: ["T1"], noLongerSuppressed: [], keptAsKeep: [] });
  });

  it("leaves AppMain nothing to write when a tab opens it", () => {
    const again = migrateSampleCuration(session.rawEvents, session.sampleCuration, session.sampleCurationVersion);
    expect(again.touched).toBe(false);
    expect(again.sampleCuration).toBe(session.sampleCuration);
    expect(again.changes).toBeNull();
  });

  it("keeps the rest of the session as it was", () => {
    expect([session.analysisTitle, session.tab, session.selId]).toEqual(["Plate 3", "samples", 0]);
    expect(session.rawEvents.map((e) => e.verdict)).toEqual(["true_positive", "false_positive"]);
  });
});

/* A tab still running the previous version (open since before the
   upgrade) keeps saving in its "main" record after a tab of this version
   migrated the session; that record was never read again, and the old
   tab's work was lost at the next reload, without a word. */
describe("newerLegacyMain — a save of the earlier version after the migration", () => {
  const curation = { rev: 3, savedAt: "2026-10-07T10:05:00.000Z" };
  const main = (savedAt, events = [{ id: 0, source: "A", target: "B" }]) => ({ savedAt, rawEvents: events });

  it("is brought in when it was written after the current records", () => {
    expect(newerLegacyMain(main("2026-10-07T10:06:00.000Z"), curation)).toBe(true);
    // A curation record written without a time (never by this version).
    expect(newerLegacyMain(main("2026-10-07T10:06:00.000Z"), { rev: 1 })).toBe(true);
  });

  it("is superseded when this version saved since, and ignored when it holds nothing", () => {
    expect(newerLegacyMain(main("2026-10-07T10:04:00.000Z"), curation)).toBe(false);
    expect(newerLegacyMain(main("2026-10-07T10:05:00.000Z"), curation)).toBe(false);
    expect(newerLegacyMain(main("2026-10-07T10:06:00.000Z", []), curation)).toBe(false);
    expect(newerLegacyMain({ rawEvents: [{ id: 0 }] }, curation)).toBe(false);
    expect(newerLegacyMain(null, curation)).toBe(false);
    expect(newerLegacyMain(main("2026-10-07T10:06:00.000Z"), null)).toBe(false);
  });
});
