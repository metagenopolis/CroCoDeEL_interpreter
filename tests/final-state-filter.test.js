import { describe, it, expect } from "vitest";
import { restoreFilter, sessionFromPayload, sessionToJSON } from "../src/persistence.js";
import { parseEvents } from "../src/parsing.js";
import { SAMPLE_CURATION_VERSION } from "../src/curation.js";

/* The filter a session keeps (the UI record at a reload, ui_state.filter
   in a session JSON) is read back by restoreFilter, merged over the
   defaults of AppMain's defaultFilter(). */

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

const parsed = parseEvents(
  [
    "source\ttarget\trate\tprobability\tcontamination_specific_species",
    "S1\tT1\t0.1\t0.9\tsp_a",
    "S2\tT2\t0.2\t0.8\tsp_b",
  ].join("\n"),
);
const session = (filter) => ({
  rawEvents: parsed.events,
  sampleCuration: {},
  sampleCurationVersion: SAMPLE_CURATION_VERSION,
  runMetadata: null,
  eventsWarnings: [],
  metadata: null,
  plateMap: null,
  ab: null,
  analysisTitle: "",
  tab: "export",
  selId: null,
  filter,
  sort: { by: "score", dir: "desc" },
});
const imported = (filter) =>
  sessionFromPayload(JSON.parse(JSON.stringify(sessionToJSON(session(filter)))), {
    defaults: defaults(),
    tabs: TABS,
  });

describe("restoreFilter — the Action filter", () => {
  it("keeps 'keep only' and 'suppress only', at a reload and through a session file", () => {
    for (const action of ["keep", "suppress"]) {
      expect(restoreFilter({ ...defaults(), action }, defaults()).action).toBe(action);
      const r = imported({ ...defaults(), action });
      expect(r.ok).toBe(true);
      expect(r.session.filter.action).toBe(action);
    }
  });

  it("reads anything else as any action", () => {
    for (const action of [null, undefined, "", "drop", 3, { a: 1 }]) {
      expect(restoreFilter({ ...defaults(), action }, defaults()).action ?? null).toBeNull();
    }
    expect(imported(defaults()).session.filter).toEqual(defaults());
  });
});
