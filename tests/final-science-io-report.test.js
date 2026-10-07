import { describe, it, expect } from "vitest";
import { restoreFilter, sessionFromPayload } from "../src/persistence.js";
import { reportFilterSummary } from "../src/exports.js";

/* The filter a session file carries is written into the events HTML
   report ("Filter applied: … · subject: …"). restoreFilter accepted any
   text for the subject, the group, the plate adjacency and the verdicts,
   and the report printed them as they were: a session JSON whose filter
   said subject '<img src=x onerror=alert(1)>' imported without a word,
   and its report ran the script when opened. The report escapes them now
   (e2e/final-science-io.e2e.mjs), and restoreFilter keeps only the values
   these fields can take. */

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

describe("restoreFilter — fields with a fixed set of values", () => {
  it("keeps the values the filter bar offers", () => {
    const f = restoreFilter(
      {
        subject: "same",
        group: "different",
        adjacent: "non-adjacent",
        verdicts: ["true_positive"],
        sampleVerdicts: ["contaminated", "correct"],
      },
      defaults(),
    );
    expect([f.subject, f.group, f.adjacent]).toEqual(["same", "different", "non-adjacent"]);
    expect(f.verdicts).toEqual(["true_positive"]);
    expect(f.sampleVerdicts).toEqual(["contaminated", "correct"]);
  });

  it("gives any other text the default", () => {
    const f = restoreFilter(
      {
        subject: "<img src=x onerror=alert(document.title)>",
        group: "<script>alert(2)</script>",
        adjacent: "next door",
        verdicts: ["<b>tp</b>"],
        sampleVerdicts: ["<i>x</i>"],
      },
      defaults(),
    );
    expect([f.subject, f.group, f.adjacent]).toEqual(["any", "any", "any"]);
    expect(f.verdicts).toEqual(defaults().verdicts);
    expect(f.sampleVerdicts).toEqual(defaults().sampleVerdicts);
  });

  it("drops the unknown entries of a list and keeps the known ones, or none", () => {
    const f = restoreFilter({ verdicts: ["pending", "<x>"], sampleVerdicts: [] }, defaults());
    expect(f.verdicts).toEqual(["pending"]);
    // An empty list is the curator's (every chip unticked).
    expect(f.sampleVerdicts).toEqual([]);
  });

  it("still promotes the earlier shapes", () => {
    const f = restoreFilter({ verdict: "uncertain", hideRelated: true, adjacentOnly: true }, defaults());
    expect([f.verdicts, f.subject, f.adjacent]).toEqual([["uncertain"], "different", "adjacent"]);
    expect(restoreFilter({ verdict: "<x>" }, defaults()).verdicts).toEqual(defaults().verdicts);
  });

  it("applies to a session file's filter", () => {
    const r = sessionFromPayload(
      {
        events: [{ id: 0, source: "S1", target: "S2", contamination_rate: 0.1, probability: 0.9 }],
        ui_state: { filter: { minScore: 0.5, subject: "<img src=x onerror=alert(1)>", group: "same" } },
      },
      { defaults: defaults() },
    );
    expect(r.ok).toBe(true);
    expect(r.session.filter).toMatchObject({ minScore: 0.5, subject: "any", group: "same" });
  });
});

/* The report's "Filter applied" line left out the sample-verdict filter,
   the sample scope (a Network drill-in) and the target-action filter: a
   report of the 8 events whose target is Contaminated said only "Events
   in report 8" next to "Total events loaded 24". */
describe("reportFilterSummary", () => {
  it("is null for the default filter", () => {
    expect(reportFilterSummary(defaults())).toBeNull();
    expect(reportFilterSummary(null)).toBeNull();
  });

  it("names the fields it named before, as before", () => {
    expect(
      reportFilterSummary({ ...defaults(), q: " 63D ", minScore: 0.5, minRate: 0.01, verdicts: ["true_positive", "uncertain"], subject: "same", adjacent: "adjacent" }),
    ).toBe('search: "63D" · probability ≥ 0.50 · rate ≥ 1.00% · verdict: true positive, uncertain · subject: same · plate: adjacent');
  });

  it("names the sample verdicts and their side", () => {
    expect(reportFilterSummary({ ...defaults(), sampleVerdicts: ["contaminated"], sampleVerdictsSide: "target" })).toBe(
      "target sample verdict: contaminated",
    );
    expect(reportFilterSummary({ ...defaults(), sampleVerdicts: ["correct", "uncertain"] })).toBe(
      "source or target sample verdict: not contaminated, uncertain",
    );
    expect(reportFilterSummary({ ...defaults(), sampleVerdicts: [] })).toBe("source or target sample verdict: none");
  });

  it("names the sample scope and its side, escaped", () => {
    expect(reportFilterSummary({ ...defaults(), scopeSamples: ["63D9"], scopeSide: "source" })).toBe("source sample 63D9");
    expect(
      reportFilterSummary({ ...defaults(), scopeSamples: ["a", "b", "c", "d", "<i>e</i>", "f", "g"], scopeSide: "either" }),
    ).toBe("source or target samples a, b, c, d, &lt;i&gt;e&lt;/i&gt; and 2 more");
  });

  it("names the target-action filter", () => {
    expect(reportFilterSummary({ ...defaults(), action: "suppress" })).toBe("target action: suppress");
    expect(reportFilterSummary({ ...defaults(), action: "<b>" })).toBeNull();
  });

  it("escapes what it prints", () => {
    expect(reportFilterSummary({ ...defaults(), q: "<script>", subject: "<img src=x>" })).toBe(
      'search: "&lt;script&gt;" · subject: &lt;img src=x&gt;',
    );
  });
});
