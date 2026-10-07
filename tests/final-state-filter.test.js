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

describe("restoreFilter — only the values the filter bar offers", () => {
  // The events HTML report prints these in its "Filter applied" banner:
  // a crafted session file put its own markup (and script) there.
  const markup = '<img src=x onerror="alert(1)">';

  it("falls back to the default for any other subject, group or plate choice", () => {
    const f = restoreFilter({ ...defaults(), subject: markup, group: "<b>g</b>", adjacent: "<i>a</i>" }, defaults());
    expect([f.subject, f.group, f.adjacent]).toEqual(["any", "any", "any"]);
    // An earlier shape still promotes to its value.
    const old = restoreFilter({ subject: markup, hideRelated: true, adjacent: 3, adjacentOnly: true }, defaults());
    expect([old.subject, old.adjacent]).toEqual(["different", "adjacent"]);
  });

  it("keeps every value the selects offer", () => {
    for (const v of ["any", "same", "different"]) {
      const f = restoreFilter({ ...defaults(), subject: v, group: v }, defaults());
      expect([f.subject, f.group]).toEqual([v, v]);
    }
    for (const v of ["any", "adjacent", "non-adjacent"]) {
      expect(restoreFilter({ ...defaults(), adjacent: v }, defaults()).adjacent).toBe(v);
    }
  });

  it("keeps a verdict list only when every entry is a verdict", () => {
    const d = defaults();
    expect(restoreFilter({ verdicts: ["true_positive", "uncertain"] }, d).verdicts).toEqual(["true_positive", "uncertain"]);
    expect(restoreFilter({ verdicts: [] }, d).verdicts).toEqual([]);
    expect(restoreFilter({ verdicts: ["true_positive", markup] }, d).verdicts).toEqual(d.verdicts);
    expect(restoreFilter({ verdict: markup }, d).verdicts).toEqual(d.verdicts);
    expect(restoreFilter({ verdict: "uncertain" }, d).verdicts).toEqual(["uncertain"]);
    expect(restoreFilter({ sampleVerdicts: ["correct"] }, d).sampleVerdicts).toEqual(["correct"]);
    expect(restoreFilter({ sampleVerdicts: ["correct", markup] }, d).sampleVerdicts).toEqual(d.sampleVerdicts);
  });

  it("an imported session file brings none of the markup back", () => {
    const r = imported({ ...defaults(), subject: markup, group: markup, adjacent: markup, verdicts: [markup], sampleVerdicts: [markup] });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.session.filter)).not.toContain("<");
    expect(r.session.filter).toEqual(defaults());
  });
});
