import { describe, it, expect } from "vitest";
import {
  checkStoredSession,
  sessionFromLegacyMain,
  sessionFromPayload,
  sessionFromRecords,
  sessionToJSON,
  sessionWrites,
  abundanceRecord,
  uiRecord,
  ALL_DIRTY,
  RECORD_KEYS,
} from "../src/persistence.js";
import { migrateSampleCuration, SAMPLE_CURATION_VERSION } from "../src/curation.js";
import { parseAbundance, parseEvents, parseMetadata, parsePlateMap } from "../src/parsing.js";

/* A session is read back from a session JSON (Import session) and from
   this browser's storage (every boot), by the same readers.

   The previous version (9ef891c) kept, from files its parser read,
   things the current parser never writes: a sample column with an empty
   name (trailing tabs on the abundance header), an event with an empty
   source and target (a line of tabs at the end of the events file), a
   negative cell kept as a negative fraction. Its import checked nothing,
   so its own session files and its storage held them. This version's
   import refused such a file whole ("abundance: "samples" must be a list
   of sample names", "event 25 has no source or no target") — also the
   session it had itself downloaded after opening the stored session,
   which opened fine from storage. Storage was read with no check at
   all: a species list kept as one text blanked the whole app. */

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
const TABS = ["overview", "samples", "table", "scatter", "validate", "network", "plate", "export", "datasets", "learn", "help"];
const read = (json) => sessionFromPayload(json, { defaults: defaults(), tabs: TABS });

/* What the previous version's parser made of these two files. Its
   parseTSV split every non-empty line on tabs, its parseAbundance read
   each cell with parseFloat (an empty one as 0) and divided each column
   by its total, negatives included, leaving a column summing to 0 as it
   was; its parseEvents kept every row. */
const AB_TEXT = [
  "species\tS1\tS2\tT1\t",
  "sp_a\t5\t0\t1\t",
  "sp_b\t5\t10\t1\t",
  "sp_c\t0\t-2\t2\t",
].join("\n");
const PREVIOUS_AB = {
  samples: ["S1", "S2", "T1", ""],
  species: ["sp_a", "sp_b", "sp_c"],
  matrix: {
    sp_a: { S1: 0.5, S2: 0, T1: 0.25, "": 0 },
    sp_b: { S1: 0.5, S2: 1.25, T1: 0.25, "": 0 },
    sp_c: { S1: 0, S2: -0.25, T1: 0.5, "": 0 },
  },
  logRange: { min: -1, max: 0 },
  warnings: ["1 of 4 sample columns sum to 0 and were left empty."],
};
const PREVIOUS_EVENTS = [
  { id: 0, source: "S1", target: "T1", rate: 0.1, score: 0.9, introduced: ["sp_a"], verdict: "true_positive", notes: "" },
  { id: 1, source: "S2", target: "T1", rate: 0.2, score: 0.8, introduced: ["sp_b"], verdict: "pending", notes: "" },
  // The events file's last line: "\t\t\t\t".
  { id: 2, source: "", target: "", rate: 0, score: 0, introduced: [], verdict: "pending", notes: "" },
];
const PREVIOUS_CURATION = {
  T1: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true },
  // Its Samples tab stamped every sample no event targets, "" included.
  S1: { verdict: "correct", action: "keep" },
  S2: { verdict: "correct", action: "keep" },
  "": { verdict: "correct", action: "keep" },
};

/** The previous version's Download session (its exportJSON). */
function previousSessionJSON({ events = PREVIOUS_EVENTS, ab = PREVIOUS_AB, sc = PREVIOUS_CURATION } = {}) {
  return JSON.parse(
    JSON.stringify({
      generated: "2026-10-07T10:00:00.000Z",
      schema_version: 2,
      counts: { total: events.length, true_positive: 1, false_positive: 0, uncertain: 0, pending: events.length - 1 },
      analysis_title: "Plate 3",
      has_metadata: false,
      has_plate_map: false,
      has_abundance: !!ab,
      run_metadata: { "crocodeel version": "1.2.1" },
      metadata: null,
      plate_map: null,
      abundance: ab,
      ui_state: { tab: "table", sel_id: 1, filter: defaults(), sort: { by: "score", dir: "desc" } },
      sample_curation: sc,
      events: events.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        contamination_rate: e.rate,
        probability: e.score,
        introduced_species: e.introduced,
        verdict: e.verdict,
        action: sc[e.target]?.action || null,
        notes: e.notes,
        relatedness: null,
        plate_distance: null,
      })),
    }),
  );
}

/** The previous version's "main" record of the same session. */
const previousMainRecord = () => ({
  version: 1,
  savedAt: "2026-10-07T10:00:00.000Z",
  rawEvents: structuredClone(PREVIOUS_EVENTS),
  sampleCuration: structuredClone(PREVIOUS_CURATION),
  runMetadata: { "crocodeel version": "1.2.1" },
  metadata: null,
  plateMap: null,
  analysisTitle: "Plate 3",
  tab: "table",
  selId: 1,
  filter: defaults(),
  sort: { by: "score", dir: "desc" },
});

describe("Import session — a file of the previous version is repaired, not refused", () => {
  const r = read(previousSessionJSON());

  it("imports, and says what it repaired", () => {
    expect(r.ok).toBe(true);
    const said = r.repairs.join(" ");
    expect(said).toMatch(/1 event without a source or a target .* was left out/);
    expect(said).toMatch(/column with an empty name and no value .* was left out/);
    expect(said).toMatch(/1 negative abundance was read as 0/);
  });

  it("leaves out the empty column and the blank event, keeps everything else", () => {
    const s = r.session;
    expect(s.ab.samples).toEqual(["S1", "S2", "T1"]);
    for (const row of Object.values(s.ab.matrix)) expect("" in row).toBe(false);
    expect(s.rawEvents.map((e) => [e.id, e.source, e.target, e.verdict])).toEqual([
      [0, "S1", "T1", "true_positive"],
      [1, "S2", "T1", "pending"],
    ]);
    expect(s.sampleCuration.T1).toMatchObject({ verdict: "contaminated", action: "suppress" });
    expect("" in s.sampleCuration).toBe(false);
    expect([s.analysisTitle, s.tab, s.selId]).toEqual(["Plate 3", "table", 1]);
  });

  it("reads a negative cell as the parser reads it now: 0, the column a fraction of its positive values", () => {
    const now = parseAbundance(AB_TEXT);
    for (const sp of ["sp_a", "sp_b", "sp_c"]) {
      for (const sample of ["S1", "S2", "T1"]) {
        expect(r.session.ab.matrix[sp][sample] ?? 0).toBeCloseTo(now.matrix[sp][sample] ?? 0, 15);
      }
    }
  });

  it("names an empty-named column that holds values, as CroCoDeEL names it, with its curation", () => {
    const ab = structuredClone(PREVIOUS_AB);
    // The empty header cell is in the middle of the header, above values.
    ab.samples = ["S1", "", "S2", "T1"];
    for (const [sp, v] of [["sp_a", 0.5], ["sp_b", 0.5]]) ab.matrix[sp][""] = v;
    const sc = { ...PREVIOUS_CURATION, "": { verdict: "uncertain", notes: "odd column" } };
    const back = read(previousSessionJSON({ ab, sc }));
    expect(back.ok).toBe(true);
    expect(back.session.ab.samples).toEqual(["S1", "Unnamed: 2", "S2", "T1"]);
    expect(back.session.ab.matrix.sp_a["Unnamed: 2"]).toBe(0.5);
    expect(back.session.sampleCuration["Unnamed: 2"]).toEqual({ verdict: "uncertain", notes: "odd column" });
    expect(back.repairs.join(" ")).toMatch(/named "Unnamed: 2"/);
  });

  it("splits a species list kept as one text", () => {
    const json = previousSessionJSON();
    json.events[0].introduced_species = "sp_a, sp_b";
    const back = read(json);
    expect(back.ok).toBe(true);
    expect(back.session.rawEvents[0].introduced).toEqual(["sp_a", "sp_b"]);
    expect(back.repairs.join(" ")).toMatch(/kept as one text, was split/);
  });

  it("still refuses what cannot be shown, and says where", () => {
    const json = previousSessionJSON();
    json.abundance.matrix.sp_a.S1 = "0.5";
    expect(read(json).errors.join(" ")).toMatch(/abundance: the value of "sp_a" in "S1" is not an abundance/);
  });
});

describe("Stored sessions are read by the same readers", () => {
  it("opens the previous version's record repaired, and a session JSON of it imports", () => {
    const stored = sessionFromLegacyMain(previousMainRecord(), structuredClone(PREVIOUS_AB));
    const { session, notes } = checkStoredSession(stored);
    expect(session.ab.samples).toEqual(["S1", "S2", "T1"]);
    expect(session.rawEvents).toHaveLength(2);
    expect(notes.join(" ")).toMatch(/left out/);
    // What AppMain then holds, and its Download session: it imports.
    const migrated = migrateSampleCuration(session.rawEvents, session.sampleCuration, session.sampleCurationVersion);
    const own = JSON.parse(
      JSON.stringify(
        sessionToJSON({ ...session, sampleCuration: migrated.sampleCuration, sampleCurationVersion: SAMPLE_CURATION_VERSION }),
      ),
    );
    const back = read(own);
    expect(back.ok).toBe(true);
    expect(back.repairs).toEqual([]);
    expect(back.session.ab.samples).toEqual(["S1", "S2", "T1"]);
    expect(back.session.rawEvents.map((e) => e.verdict)).toEqual(["true_positive", "pending"]);
  });

  it("gives a session of this version back as the very objects read", () => {
    const parsed = parseEvents(
      ["source\ttarget\trate\tprobability\tcontamination_specific_species", "S1\tT1\t0.1\t0.9\tsp_a", "S2\tT1\t0.2\t0.8\tsp_b"].join("\n"),
    );
    const s = {
      rawEvents: parsed.events.map((e, i) => (i === 0 ? { ...e, verdict: "true_positive", notes: "n" } : e)),
      sampleCuration: { T1: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true } },
      sampleCurationVersion: SAMPLE_CURATION_VERSION,
      runMetadata: parsed.runMetadata,
      eventsWarnings: parsed.warnings,
      metadata: parseMetadata(["sample_id\tsubject_id", "S1\tP1", "T1\tP1"].join("\n")),
      plateMap: parsePlateMap(["sample_id\tplate\twell", "S1\tP1\tA01", "T1\tP1\tA02"].join("\n")),
      ab: parseAbundance(["id_mgs\tS1\tS2\tT1", "sp_a\t5\t0\t1", "sp_b\t0\t7\t1"].join("\n")),
      analysisTitle: "Study",
      tab: "validate",
      selId: 1,
      filter: defaults(),
      sort: { by: "rate", dir: "asc" },
    };
    // As the records hold it, and as a boot reads it.
    const { puts } = sessionWrites(s, ALL_DIRTY, "tok");
    const records = Object.fromEntries(puts.map(([k, v]) => [k, structuredClone(v)]));
    records[RECORD_KEYS.curation].rev = 1;
    records[RECORD_KEYS.ab] = structuredClone(abundanceRecord(s.ab, "tok"));
    records[RECORD_KEYS.ui] = uiRecord(s);
    const stored = sessionFromRecords(records);
    const { session, notes } = checkStoredSession(stored);
    expect(notes).toEqual([]);
    expect(session).toBe(stored);
  });

  it("repairs what a damaged profile holds, or leaves it out, instead of breaking the app", () => {
    const stored = sessionFromLegacyMain(
      {
        ...previousMainRecord(),
        rawEvents: [
          { ...PREVIOUS_EVENTS[0], introduced: "sp_a,sp_b" },
          null,
          { ...PREVIOUS_EVENTS[1], verdict: "maybe", rate: "0,2" },
        ],
        sampleCuration: { T1: "contaminated", S1: { verdict: "correct", action: "drop" } },
        metadata: { bySample: { S1: "P1" } },
        plateMap: { bySample: { S1: { plate: 3, row: 0, col: 0 } }, format: null },
        runMetadata: { cutoff: { x: 1 }, version: "1.2.1" },
      },
      null,
    );
    const { session, notes } = checkStoredSession(stored);
    expect(session.rawEvents.map((e) => [e.source, e.introduced, e.verdict, e.rate])).toEqual([
      ["S1", ["sp_a", "sp_b"], "true_positive", 0.1],
      ["S2", ["sp_b"], "pending", 0],
    ]);
    expect(session.sampleCuration).toEqual({ S1: { verdict: "correct" } });
    expect(session.metadata).toBeNull();
    expect(session.plateMap.format).toEqual({ rows: 8, cols: 12 });
    expect(session.plateMap.bySample.S1.plate).toBe("3");
    expect(session.runMetadata).toEqual({ version: "1.2.1" });
    const said = notes.join(" ");
    expect(said).toMatch(/split at the commas/);
    expect(said).toMatch(/could not be read/);
    expect(said).toMatch(/metadata: the annotations of S1 are not an object/);
    // Its session JSON (the error screen's download) imports.
    expect(read(JSON.parse(JSON.stringify(sessionToJSON(session)))).ok).toBe(true);
  });
});
