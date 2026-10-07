import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbundance, parseEvents, parseMetadata } from "../src/parsing.js";
import {
  automaticScore,
  bulkCriteria,
  buildScatter,
  eventBulkCriteria,
  eventScore,
  lineDiagnostics,
  missingAbundantFromSource,
  pointsAboveLine,
} from "../src/diagnostics.js";
import { areRelated } from "../src/App.jsx";

/* Guided validation (AppMain's memos), the bulk dialog (eventBulkCriteria)
   and the events HTML report each wrote the five-step evaluation out by
   hand — scatter, line diagnostics, points above the line, missing
   species, automaticScore — and the unit tests comparing the panel with
   the dialog ran copies of AppMain's chain. All of them run eventScore
   now, and the tests call it. */

const root = join(import.meta.dirname, "..", "public");
const read = (p) => readFileSync(join(root, p), "utf8");
const { events } = parseEvents(read("demo/contamination_events.tsv"));
const ab = parseAbundance(read("demo/species_abundance.tsv"));
const metadata = parseMetadata(read("demo/metadata.tsv"));

describe("eventScore", () => {
  it("is the five steps, for every demo event", () => {
    for (const e of events) {
      const rel = areRelated(metadata, e.source, e.target);
      const r = eventScore(ab, e, rel);
      const sc = buildScatter(ab, e);
      const di = lineDiagnostics(sc);
      const above = pointsAboveLine(sc);
      const mi = missingAbundantFromSource(ab, e.source, e.target, e.rate);
      expect(r.scatter).toEqual(sc);
      expect(r.diag).toEqual(di);
      expect(r.above).toEqual(above);
      expect(r.missing).toEqual(mi);
      expect(r.score).toEqual(automaticScore(di, above, mi, e.cascade, rel));
      // The bulk dialog's criteria are read off the same score.
      expect(eventBulkCriteria(ab, e, rel)).toEqual(bulkCriteria(r.score));
    }
  });

  it("reuses the scatter it is given", () => {
    const e = events[0];
    const sc = buildScatter(ab, e);
    expect(eventScore(ab, e, null, sc).scatter).toBe(sc);
  });

  it("scores nothing without an event or a table", () => {
    for (const [table, e] of [
      [ab, null],
      [null, events[0]],
    ]) {
      const r = eventScore(table, e, null);
      expect([r.scatter, r.diag, r.above, r.missing]).toEqual([null, null, null, null]);
      expect(r.score).toMatchObject({ good: 0, total: 0, reasons: [], grade: "not_evaluable" });
    }
  });

  it("does not grade a pair missing from the table", () => {
    const r = eventScore(ab, { source: "nope", target: events[0].target, rate: 0.1, introduced: [] }, null);
    expect(r.scatter.error).toMatch(/not found in abundance table/);
    expect([r.diag, r.above, r.missing]).toEqual([null, null, null]);
    expect(r.score.grade).toBe("not_evaluable");
  });
});
