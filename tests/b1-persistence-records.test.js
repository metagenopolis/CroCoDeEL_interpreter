import { describe, it, expect } from "vitest";
import {
  ALL_DIRTY,
  RECORD_KEYS,
  abundanceRecord,
  dirtyRecords,
  eventInputsChanged,
  restoreFilter,
  sessionFromLegacyMain,
  sessionFromRecords,
  sessionWrites,
  sparsifyAbundance,
  uiRecord,
  withEventCuration,
  eventCurationById,
} from "../src/persistence.js";
import { parseAbundance, parseEvents, parseMetadata, parsePlateMap } from "../src/parsing.js";
import { SAMPLE_CURATION_VERSION } from "../src/curation.js";

/* The session is stored as separate records (src/persistence.js): the
   inputs, written when they change; the curation, small, on every
   evaluation; the UI state on every switch. These tests pin down that a
   session comes back exactly as it was written, what each kind of change
   rewrites, and that the first layout ("main") is still read. */

const EVENTS_TSV = [
  "# crocodeel version: 1.2.1 | filtering_ab_thr_factor: 20.0 | probability_cutoff: 0.5",
  "source\ttarget\trate\tprobability\tcontamination_specific_species",
  "S1\tT1\t0.10\t0.90\tsp_a,sp_b",
  "S2\tT1\t0.20\t0.80\tsp_c",
  "S3\tT2\t1.50\t0.70\tsp_a",
  "S4\t\t0.10\t0.60\tsp_a",
].join("\n");

// Counts, integer-like species names and a first header that is not
// "species": everything an export needs to give the user's table back.
const AB_TSV = [
  "id_mgs\tS1\tS2\tS3\tT1\tT2",
  "10\t5\t0\t1\t3\t0",
  "2\t0\t7\t1\t0\t4",
  "sp_a\t1\t1\t0\t1\t1",
].join("\n");

const METADATA_TSV = [
  "SampleID\tpatient\tbiome",
  "S1\tP1\tgut",
  "T1\tP1\tgut",
  "T1\tP9\tgut",
].join("\n");

const PLATE_TSV = ["sample_id\tplate\twell", "S1\tP1\tA01", "T1\tP1\tA02", "T2\tP1\tZ99"].join("\n");

const defaults = () => ({
  q: "",
  minScore: 0,
  minRate: 0,
  minIntroduced: 0,
  verdicts: ["pending", "true_positive", "false_positive", "uncertain"],
  sampleVerdicts: ["pending", "contaminated", "correct", "uncertain"],
  sampleVerdictsSide: "either",
  subject: "any",
  group: "any",
  adjacent: "any",
  scopeSamples: null,
  scopeSide: "either",
  lowAbFilter: true,
});

function curatedSession() {
  const parsed = parseEvents(EVENTS_TSV);
  const rawEvents = parsed.events.map((e, i) =>
    i === 0
      ? { ...e, verdict: "true_positive", notes: "seen\twith a tab" }
      : i === 2
        ? { ...e, verdict: "false_positive" }
        : e,
  );
  return {
    rawEvents,
    sampleCuration: {
      T1: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true },
      S3: { verdict: "uncertain", notes: "by hand" },
    },
    sampleCurationVersion: SAMPLE_CURATION_VERSION,
    runMetadata: parsed.runMetadata,
    eventsWarnings: parsed.warnings,
    metadata: parseMetadata(METADATA_TSV),
    plateMap: parsePlateMap(PLATE_TSV),
    ab: parseAbundance(AB_TSV),
    analysisTitle: "Study",
    tab: "validate",
    selId: 2,
    filter: { ...defaults(), q: "T1", lowAbFilter: false },
    sort: { by: "rate", dir: "asc" },
  };
}

/** The records a first save writes, as storage would hold them. */
function store(session, token = "tok-1") {
  const { puts, dels } = sessionWrites(session, ALL_DIRTY, session.ab ? token : null);
  const records = {};
  for (const [k, v] of puts) records[k] = structuredClone(v);
  for (const k of dels) delete records[k];
  records[RECORD_KEYS.curation] = { ...records[RECORD_KEYS.curation], rev: 1 };
  if (session.ab) records[RECORD_KEYS.ab] = structuredClone(abundanceRecord(session.ab, token));
  records[RECORD_KEYS.ui] = structuredClone(uiRecord(session));
  return records;
}

describe("records — a session comes back as it was written", () => {
  it("restores events, curation, inputs and UI state", () => {
    const s = curatedSession();
    const back = sessionFromRecords(store(s));
    expect(back.rawEvents).toEqual(s.rawEvents);
    expect(back.sampleCuration).toEqual(s.sampleCuration);
    expect(back.sampleCurationVersion).toBe(SAMPLE_CURATION_VERSION);
    expect(back.runMetadata).toEqual(s.runMetadata);
    expect(back.analysisTitle).toBe("Study");
    expect(back.metadata).toEqual(s.metadata);
    expect(back.plateMap).toEqual(s.plateMap);
    expect([back.tab, back.selId, back.filter, back.sort]).toEqual([s.tab, s.selId, s.filter, s.sort]);
    expect(back.abLost).toBeUndefined();
  });

  it("keeps the events parser's warnings with the events (B1.2)", () => {
    const s = curatedSession();
    expect(s.eventsWarnings.some((w) => /outside \(0, 1\]/.test(w))).toBe(true);
    expect(s.eventsWarnings.some((w) => /empty source or target/.test(w))).toBe(true);
    expect(sessionFromRecords(store(s)).eventsWarnings).toEqual(s.eventsWarnings);
  });

  it("keeps the abundance table's first header, column sums, integer flags and species order (B1.7)", () => {
    const s = curatedSession();
    const back = sessionFromRecords(store(s)).ab;
    expect(back.firstHeader).toBe("id_mgs");
    expect(back.colSums).toEqual(s.ab.colSums);
    expect(back.integerCols).toEqual(s.ab.integerCols);
    // In file order, although Object.keys would list "2" and "10" first.
    expect(back.species).toEqual(["10", "2", "sp_a"]);
    expect(back.samples).toEqual(s.ab.samples);
    expect(back.logRange).toEqual(s.ab.logRange);
    // Sparse, but every value reads the same.
    for (const sp of s.ab.species) {
      for (const smp of s.ab.samples) {
        expect(back.matrix[sp]?.[smp] || 0).toBe(s.ab.matrix[sp][smp]);
      }
    }
    expect(back.storageToken).toBeUndefined();
  });

  it("keeps the metadata and plate-map column mappings and warnings (B1.7)", () => {
    const s = curatedSession();
    expect(s.metadata.warnings.length).toBe(1);
    expect(s.plateMap.warnings.length).toBe(1);
    const back = sessionFromRecords(store(s));
    expect(back.metadata.cols).toEqual(s.metadata.cols);
    expect(back.metadata.warnings).toEqual(s.metadata.warnings);
    expect(back.plateMap.cols).toEqual(s.plateMap.cols);
    expect(back.plateMap.warnings).toEqual(s.plateMap.warnings);
  });

  it("keeps the filter's lowAbFilter, and gives it its default when absent (B1.7)", () => {
    const s = curatedSession();
    const back = sessionFromRecords(store(s));
    expect(restoreFilter(back.filter, defaults()).lowAbFilter).toBe(false);
    const { lowAbFilter: _drop, ...older } = back.filter;
    expect(restoreFilter(older, defaults()).lowAbFilter).toBe(true);
  });

  it("stores the events without their curation, and the curation by event id", () => {
    const s = curatedSession();
    const records = store(s);
    for (const e of records.events.events) {
      expect(e).not.toHaveProperty("verdict");
      expect(e).not.toHaveProperty("notes");
    }
    expect(records.curation.verdicts).toEqual({ 0: "true_positive", 2: "false_positive" });
    expect(records.curation.notes).toEqual({ 0: "seen\twith a tab" });
    // String and numeric ids alike.
    const manual = [{ id: "manual-1", source: "A", target: "B", verdict: "uncertain", notes: "x" }];
    const { verdicts, notes } = eventCurationById(manual);
    expect(withEventCuration([{ id: "manual-1", source: "A", target: "B" }], verdicts, notes)).toEqual(manual);
  });

  it("leaves out an abundance table whose write did not go with this session", () => {
    const s = curatedSession();
    const records = store(s);
    records.ab = { ...records.ab, storageToken: "an older write" };
    const back = sessionFromRecords(records);
    expect(back.ab).toBeNull();
    expect(back.abLost).toBe(true);
    delete records.ab;
    expect(sessionFromRecords(records).abLost).toBe(true);
  });

  it("restores a session without events: clearing the events keeps the other files (B1.5)", () => {
    const s = { ...curatedSession(), rawEvents: [], eventsWarnings: [], runMetadata: null };
    const records = store(s);
    expect(records.events).toBeUndefined();
    const back = sessionFromRecords(records);
    expect(back.rawEvents).toEqual([]);
    expect(back.ab.samples).toEqual(s.ab.samples);
    expect(back.metadata.nSamples).toBe(2);
  });

  it("restores nothing from an empty session", () => {
    const empty = { rawEvents: [], sampleCuration: {}, ab: null, metadata: null, plateMap: null };
    expect(sessionFromRecords(store(empty))).toBeNull();
    expect(sessionFromRecords({})).toBeNull();
  });
});

describe("records — what each change rewrites (B1.3a)", () => {
  const saved = curatedSession();
  const sessionKeys = (d) => Object.keys(d).filter((k) => d[k]).sort();

  it("a tab, selection, filter or sort change rewrites the UI record only", () => {
    for (const change of [
      { tab: "network" },
      { selId: 7 },
      { filter: { ...saved.filter, q: "x" } },
      { sort: { by: "score", dir: "desc" } },
    ]) {
      expect(sessionKeys(dirtyRecords(saved, { ...saved, ...change }))).toEqual(["ui"]);
    }
  });

  it("an evaluation or a note rewrites the curation record, not the events", () => {
    const rawEvents = saved.rawEvents.map((e) => (e.id === 1 ? { ...e, verdict: "uncertain" } : e));
    expect(sessionKeys(dirtyRecords(saved, { ...saved, rawEvents }))).toEqual(["curation"]);
    const noted = saved.rawEvents.map((e) => (e.id === 1 ? { ...e, notes: "n" } : e));
    expect(sessionKeys(dirtyRecords(saved, { ...saved, rawEvents: noted }))).toEqual(["curation"]);
    expect(
      sessionKeys(dirtyRecords(saved, { ...saved, sampleCuration: {} })),
    ).toEqual(["curation"]);
    expect(sessionKeys(dirtyRecords(saved, { ...saved, analysisTitle: "B" }))).toEqual(["curation"]);
  });

  it("an input rewrites its own record (and the curation record, which holds the revision)", () => {
    const added = [...saved.rawEvents, { id: 9, source: "A", target: "B", rate: 0, score: 0, introduced: [], verdict: "pending", notes: "" }];
    expect(sessionKeys(dirtyRecords(saved, { ...saved, rawEvents: added }))).toEqual(["curation", "events"]);
    expect(sessionKeys(dirtyRecords(saved, { ...saved, ab: { ...saved.ab } }))).toEqual(["ab", "curation"]);
    expect(sessionKeys(dirtyRecords(saved, { ...saved, metadata: null }))).toEqual(["curation", "metadata"]);
    expect(sessionKeys(dirtyRecords(saved, { ...saved, plateMap: null }))).toEqual(["curation", "plate"]);
    expect(sessionKeys(dirtyRecords(saved, { ...saved, eventsWarnings: [] }))).toEqual(["curation", "events"]);
  });

  it("eventInputsChanged compares only what changed, and ignores the curation fields", () => {
    const a = saved.rawEvents;
    expect(eventInputsChanged(a, a)).toBe(false);
    expect(eventInputsChanged(a, a.map((e) => ({ ...e, verdict: "uncertain", notes: "z" })))).toBe(false);
    expect(eventInputsChanged(a, a.map((e, i) => (i === 1 ? { ...e, rate: 0.3 } : e)))).toBe(true);
    expect(eventInputsChanged(a, a.map((e, i) => (i === 1 ? { ...e, introduced: [...e.introduced] } : e)))).toBe(true);
    expect(eventInputsChanged(a, a.map((e, i) => (i === 1 ? { ...e, cascade: {} } : e)))).toBe(true);
    expect(eventInputsChanged(a, a.slice(1))).toBe(true);
  });

  it("writes the curation with a cleared input deleted", () => {
    const { puts, dels } = sessionWrites(
      { ...saved, rawEvents: [], ab: null, metadata: null },
      { events: true, ab: true, metadata: true, plate: false, curation: true },
      null,
    );
    expect(dels.sort()).toEqual(["ab", "events", "main", "metadata"]);
    expect(puts.map(([k]) => k)).toEqual(["curation"]);
  });

  it('drops the first layout\'s "main" record with every write of the events record', () => {
    // After a migration that failed, the first save writes every record:
    // "main" must go with it, or it would outlive the records that
    // replace it. A write that leaves the events alone does not touch it.
    const all = sessionWrites(saved, ALL_DIRTY, "t");
    expect(all.dels).toContain("main");
    expect(all.puts.map(([k]) => k).sort()).toEqual(["curation", "events", "metadata", "plate"]);
    const verdict = sessionWrites(saved, { ...dirtyRecords(saved, { ...saved, sampleCuration: {} }) }, "t");
    expect(verdict.dels).toEqual([]);
  });
});

describe("records — sessions of the first layout (\"main\") are still read", () => {
  it("reads a main record and its abundance table, migrated to the current records", () => {
    const s = curatedSession();
    const main = {
      version: 1,
      savedAt: "2026-01-01T00:00:00.000Z",
      rawEvents: s.rawEvents,
      sampleCuration: s.sampleCuration,
      runMetadata: s.runMetadata,
      metadata: s.metadata,
      plateMap: s.plateMap,
      analysisTitle: s.analysisTitle,
      tab: s.tab,
      selId: s.selId,
      filter: s.filter,
      sort: s.sort,
    };
    const legacy = sessionFromLegacyMain(main, sparsifyAbundance(s.ab));
    // No model version: AppMain migrates it as a session of an earlier
    // version (migrateSampleCuration).
    expect(legacy.sampleCurationVersion).toBeUndefined();
    expect(legacy.rawEvents).toBe(s.rawEvents);
    expect(legacy.eventsWarnings).toEqual([]);
    // Migrated: the current records, the old abundance record kept (no
    // token on either side).
    const { puts } = sessionWrites(legacy, { ...ALL_DIRTY, ab: false }, null);
    const records = Object.fromEntries(puts.map(([k, v]) => [k, structuredClone(v)]));
    records.ab = structuredClone(sparsifyAbundance(s.ab));
    records.ui = uiRecord(legacy);
    const back = sessionFromRecords(records);
    expect(back.rawEvents).toEqual(s.rawEvents);
    expect(back.sampleCuration).toEqual(s.sampleCuration);
    expect(back.sampleCurationVersion).toBeUndefined();
    expect(back.ab.firstHeader).toBe("id_mgs");
    expect(back.metadata).toEqual(s.metadata);
    expect(back.filter).toEqual(s.filter);
  });

  it("keeps legacy per-event actions for the migration, and reads nothing from an emptied session", () => {
    const main = { rawEvents: [{ id: 0, source: "A", target: "B", verdict: "pending", notes: "", action: "keep" }] };
    expect(sessionFromLegacyMain(main, null).rawEvents[0].action).toBe("keep");
    expect(sessionFromLegacyMain({ rawEvents: [] }, null)).toBeNull();
    expect(sessionFromLegacyMain(null, null)).toBeNull();
  });
});

describe("sparsifyAbundance", () => {
  it("drops zeros and keeps every other field (B1.7)", () => {
    const ab = parseAbundance(AB_TSV);
    const sparse = sparsifyAbundance(ab);
    expect(sparse.matrix["10"]).toEqual({ S1: ab.matrix["10"].S1, S3: ab.matrix["10"].S3, T1: ab.matrix["10"].T1 });
    const { matrix: _a, ...rest } = ab;
    const { matrix: _b, ...sparseRest } = sparse;
    expect(sparseRest).toEqual(rest);
  });
});
