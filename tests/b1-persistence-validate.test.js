import { describe, it, expect } from "vitest";
import { restoreFilter, restoreSort, sessionFromPayload, sessionToJSON } from "../src/persistence.js";
import { parseAbundance, parseEvents, parseMetadata, parsePlateMap } from "../src/parsing.js";
import { SAMPLE_CURATION_VERSION } from "../src/curation.js";

/* Importing a session JSON used to clear the browser's storage first and
   apply the file as it was: a filter without `q` then crashed every
   render (filter.q.trim), a wrong-shaped abundance table or metadata
   crashed too, and the previous session was gone. sessionFromPayload
   checks the whole file before anything is replaced. */

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

const parsed = parseEvents(
  [
    "# crocodeel version: 1.2.1 | probability_cutoff: 0.5",
    "source\ttarget\trate\tprobability\tcontamination_specific_species",
    "S1\tT1\t0.1\t0.9\t10,sp_a",
    "S2\tT1\t0.2\t0.8\tsp_a",
    "S3\tT2\t1.5\t0.7\t2",
  ].join("\n"),
);
const ab = parseAbundance(
  ["id_mgs\tS1\tS2\tS3\tT1\tT2", "10\t5\t0\t1\t3\t0", "2\t0\t7\t1\t0\t4", "sp_a\t1\t1\t0\t1\t1"].join("\n"),
);
const metadata = parseMetadata(["sample_id\tsubject_id", "S1\tP1", "T1\tP1", "T1\tP2"].join("\n"));
const plateMap = parsePlateMap(["sample_id\tplate\twell", "S1\tP1\tA01", "T1\tP1\tA02"].join("\n"));

function session() {
  return {
    rawEvents: parsed.events.map((e, i) => (i === 0 ? { ...e, verdict: "true_positive", notes: "n" } : e)),
    sampleCuration: {
      T1: { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true },
      S2: { action: "keep" },
    },
    sampleCurationVersion: SAMPLE_CURATION_VERSION,
    runMetadata: parsed.runMetadata,
    eventsWarnings: parsed.warnings,
    metadata,
    plateMap,
    ab,
    analysisTitle: "Study",
    tab: "validate",
    selId: 1,
    filter: { ...defaults(), q: "S1", lowAbFilter: false },
    sort: { by: "rate", dir: "asc" },
  };
}
/** What exportJSON writes, through a JSON text. */
const exported = (s = session()) => JSON.parse(JSON.stringify(sessionToJSON(s)));

describe("sessionFromPayload — a session JSON round trip (B1.7)", () => {
  it("gives the exported session back", () => {
    const s = session();
    const r = read(exported(s));
    expect(r.ok).toBe(true);
    const back = r.session;
    expect(back.rawEvents).toEqual(s.rawEvents);
    expect(back.sampleCuration).toEqual(s.sampleCuration);
    expect(back.sampleCurationVersion).toBe(SAMPLE_CURATION_VERSION);
    expect(back.runMetadata).toEqual(s.runMetadata);
    expect(back.analysisTitle).toBe("Study");
    expect([back.tab, back.selId, back.sort]).toEqual(["validate", 1, { by: "rate", dir: "asc" }]);
    expect(back.filter).toEqual(s.filter);
    expect(r.changes).toBeNull();
  });

  it("keeps the abundance table's first header, column sums, integer flags and species order", () => {
    const back = read(exported()).session.ab;
    expect(back.firstHeader).toBe("id_mgs");
    expect(back.colSums).toEqual(ab.colSums);
    expect(back.integerCols).toEqual(ab.integerCols);
    expect(back.species).toEqual(["10", "2", "sp_a"]);
    expect(back.matrix).toEqual(ab.matrix);
    // Through JSON: -0 comes back as 0, the same bound.
    expect(JSON.stringify(back.logRange)).toBe(JSON.stringify(ab.logRange));
  });

  it("keeps the metadata and plate-map mappings and warnings, the events parser's warnings and the curation version", () => {
    const json = exported();
    expect(json.sample_curation_version).toBe(SAMPLE_CURATION_VERSION);
    expect(json.events_warnings).toEqual(parsed.warnings);
    const back = read(json).session;
    expect(back.metadata.cols).toEqual(metadata.cols);
    expect(back.metadata.warnings).toEqual(metadata.warnings);
    expect(back.plateMap.cols).toEqual(plateMap.cols);
    expect(back.plateMap.warnings).toEqual(plateMap.warnings);
    expect(back.eventsWarnings).toEqual(parsed.warnings);
  });

  it("reads a file of an earlier version: no warnings, no version, legacy per-event actions", () => {
    const json = exported();
    delete json.events_warnings;
    delete json.sample_curation_version;
    delete json.sample_curation;
    json.events[2].action = "keep";
    const r = read(json);
    expect(r.ok).toBe(true);
    expect(r.session.eventsWarnings).toEqual([]);
    // The legacy action moved to its target sample, then off the event.
    expect(r.session.sampleCuration.T2).toEqual({ action: "keep" });
    expect(r.session.rawEvents.every((e) => !("action" in e))).toBe(true);
    // T1's TP: automatic Contaminated + Suppress, recomputed.
    expect(r.session.sampleCuration.T1).toMatchObject({ verdict: "contaminated", action: "suppress" });
  });
});

describe("sessionFromPayload — the UI state is merged over the defaults", () => {
  it("a filter without q gets the defaults, lowAbFilter on included", () => {
    const json = exported();
    json.ui_state.filter = { minScore: 0.5 };
    const f = read(json).session.filter;
    expect(f.q).toBe("");
    expect(f.minScore).toBe(0.5);
    expect(f.lowAbFilter).toBe(true);
    expect(f.verdicts).toEqual(defaults().verdicts);
  });

  it("wrong types and unknown tabs fall back; no ui_state at all is fine", () => {
    const json = exported();
    json.ui_state = { tab: "nowhere", sel_id: { x: 1 }, filter: { q: 3, verdicts: "tp", scopeSamples: [1, 2] }, sort: { by: 3 } };
    const s = read(json).session;
    expect(s.tab).toBeUndefined();
    expect(s.selId).toBeNull();
    expect(s.filter.q).toBe("");
    expect(s.filter.verdicts).toEqual(defaults().verdicts);
    expect(s.filter.scopeSamples).toBeNull();
    expect(s.sort).toEqual({ by: "score", dir: "desc" });
    delete json.ui_state;
    expect(read(json).ok).toBe(true);
  });

  it("restoreFilter promotes the earlier shapes, restoreSort keeps a valid sort", () => {
    const f = restoreFilter({ verdict: "pending", hideRelated: true, adjacentOnly: true }, defaults());
    expect([f.verdicts, f.subject, f.adjacent]).toEqual([["pending"], "different", "adjacent"]);
    expect(restoreSort({ by: "rate", dir: "asc" })).toEqual({ by: "rate", dir: "asc" });
    expect(restoreSort(null)).toEqual({ by: "score", dir: "desc" });
  });
});

describe("sessionFromPayload — a malformed file is refused whole (B1.4)", () => {
  const refused = (mutate, re) => {
    const json = exported();
    mutate(json);
    const r = read(json);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(re);
  };

  it("events", () => {
    refused((j) => (j.events = "x"), /"events" must be a list/);
    refused((j) => delete j.events, /Missing "events"/);
    refused((j) => (j.events[1] = 3), /event 2 is not an object/);
    refused((j) => delete j.events[0].target, /event 1 has no source or no target/);
    refused((j) => (j.events[0].verdict = "maybe"), /unknown verdict "maybe"/);
    refused((j) => (j.events[0].contamination_rate = "0,1"), /contamination_rate is not a number/);
    refused((j) => (j.events[0].introduced_species = "sp_a"), /introduced_species is not a list/);
    refused((j) => (j.events[0].notes = { a: 1 }), /notes are not text/);
  });

  it("sample curation", () => {
    refused((j) => (j.sample_curation = []), /"sample_curation" must map/);
    refused((j) => (j.sample_curation.T1 = "contaminated"), /sample_curation of T1 is not an object/);
    refused((j) => (j.sample_curation.T1.action = "drop"), /unknown action "drop"/);
  });

  it("abundance table", () => {
    refused((j) => (j.abundance = "table"), /abundance: not a species × sample table/);
    refused((j) => delete j.abundance.matrix, /abundance: "matrix"/);
    refused((j) => (j.abundance.samples = ["S1", "S1"]), /abundance: a sample appears twice/);
    refused((j) => (j.abundance.samples = "S1"), /abundance: "samples" must be a list/);
    refused((j) => (j.abundance.matrix["10"].S1 = "0.5"), /abundance: the value of "10" in "S1" is not an abundance/);
    refused((j) => (j.abundance.species = ["10", "nope"]), /abundance: species "nope" has no row/);
    refused((j) => (j.abundance.colSums = { S1: "5" }), /"colSums"/);
    refused((j) => (j.abundance.integerCols = { S1: 1 }), /"integerCols"/);
    refused((j) => (j.abundance.firstHeader = 3), /"firstHeader"/);
  });

  it("metadata, plate map, run metadata, UI state", () => {
    refused((j) => (j.metadata = { nSamples: 3 }), /metadata: "bySample"/);
    refused((j) => (j.metadata.bySample.S1 = "P1"), /metadata: the annotations of S1/);
    refused((j) => (j.plate_map = { format: { rows: 8, cols: 12 } }), /plate_map: "bySample"/);
    refused((j) => (j.plate_map.bySample.S1.row = 40), /plate_map: S1 has no valid well/);
    refused((j) => (j.run_metadata = "1.2.1"), /"run_metadata" must be an object/);
    refused((j) => (j.ui_state = 4), /"ui_state" must be an object/);
  });

  it("not an object, or nothing to import", () => {
    expect(read(null).ok).toBe(false);
    expect(read([]).ok).toBe(false);
    expect(read("x").errors[0]).toMatch(/not a session file/);
    expect(read({ events: [] }).errors[0]).toMatch(/nothing to import/);
  });

  it("lists a few problems, not thousands", () => {
    const json = exported();
    json.events = Array.from({ length: 500 }, () => ({ source: "A" }));
    const r = read(json);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeLessThanOrEqual(7);
    expect(r.errors[r.errors.length - 1]).toMatch(/more problems/);
  });
});

describe("sessionFromPayload — what is repaired rather than refused", () => {
  it("a plate map without its format gets one from its wells", () => {
    const json = exported();
    delete json.plate_map.format;
    expect(read(json).session.plateMap.format).toEqual({ rows: 8, cols: 12 });
    json.plate_map.bySample.T1 = { plate: "P1", row: 12, col: 20 };
    expect(read(json).session.plateMap.format).toEqual({ rows: 16, cols: 24 });
  });

  it("an abundance table without logRange, or without its species list (older sessions)", () => {
    const json = exported();
    delete json.abundance.logRange;
    delete json.abundance.species;
    const back = read(json).session.ab;
    expect(back.logRange).toEqual(ab.logRange);
    expect(new Set(back.species)).toEqual(new Set(ab.species));
  });

  it("metadata warnings that are not a list, or no nSamples", () => {
    const json = exported();
    json.metadata.warnings = "2 sample ids appear twice";
    delete json.metadata.nSamples;
    const md = read(json).session.metadata;
    expect(md.warnings).toEqual(["2 sample ids appear twice"]);
    expect(md.nSamples).toBe(2);
  });

  it("repeated event ids are renumbered, and the selection dropped", () => {
    const json = exported();
    json.events.forEach((e) => (e.id = 7));
    const s = read(json).session;
    expect(s.rawEvents.map((e) => e.id)).toEqual([0, 1, 2]);
    expect(s.selId).toBeNull();
  });

  it("numeric sample ids and species names are read as text", () => {
    const json = exported();
    json.events[0].source = 101;
    json.events[0].introduced_species = [10, "sp_a"];
    const e = read(json).session.rawEvents[0];
    expect(e.source).toBe("101");
    expect(e.introduced).toEqual(["10", "sp_a"]);
  });
});
