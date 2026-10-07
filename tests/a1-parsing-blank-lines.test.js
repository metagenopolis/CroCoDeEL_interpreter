import { describe, it, expect } from "vitest";
import {
  parseTSV,
  parseEvents,
  parseAbundance,
  parseMetadata,
} from "../src/parsing.js";

/* A1.3 — blank lines and trailing tabs.

   A line holding only spaces or tabs (a cleared spreadsheet row) became a
   phantom event with an empty source, and trailing tabs on the header line
   (cleared trailing columns) became phantom "" sample columns. */

const EVENTS_HEADER =
  "source\ttarget\trate\tprobability\tcontamination_specific_species";

describe("parseTSV", () => {
  it("skips lines holding only spaces or tabs, and keeps the file line of each row", () => {
    const { rows, lineNumbers } = parseTSV(
      ["a\tb", "1\t2", "   ", "\t\t", " \t ", "3\t4", ""].join("\n"),
    );
    expect(rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
    expect(lineNumbers).toEqual([2, 6]);
  });

  it("skips blank lines between the comment lines and the header", () => {
    const { header, headerComments, rows } = parseTSV(
      ["# run: 1", "  ", "a\tb", "1\t2"].join("\n"),
    );
    expect(headerComments).toEqual(["run: 1"]);
    expect(header).toEqual(["a", "b"]);
    expect(rows).toHaveLength(1);
  });

  // The empty trailing header cells with nothing under them are dropped.
  // The one with a value under it ("stray") is a column without a name,
  // read as pandas reads it ("Unnamed: 2"), no longer dropped with its
  // value (tests/final-science-io-layout.test.js).
  it("drops empty trailing header cells with nothing under them", () => {
    const { header, rows } = parseTSV(
      ["a\tb\t\t \t", "1\t2\t\t\t", "3\t4\tstray\t\t"].join("\n"),
    );
    expect(header).toEqual(["a", "b", "Unnamed: 2"]);
    expect(rows).toEqual([
      { a: "1", b: "2", "Unnamed: 2": "" },
      { a: "3", b: "4", "Unnamed: 2": "stray" },
    ]);
  });
});

describe("parseEvents — phantom rows", () => {
  it("creates no event for whitespace-only lines", () => {
    const tsv = [
      EVENTS_HEADER,
      "S1\tS2\t0.1\t0.9\tsp_a",
      "\t\t\t\t",
      "    ",
      "S3\tS4\t0.2\t0.8\tsp_b",
    ].join("\n");
    const { events, warnings } = parseEvents(tsv);
    expect(events.map((e) => [e.source, e.target])).toEqual([
      ["S1", "S2"],
      ["S3", "S4"],
    ]);
    expect(events.map((e) => e.id)).toEqual([0, 1]);
    expect(warnings).toEqual([]);
  });

  it("skips rows with an empty source or target, with a warning count", () => {
    const tsv = [
      EVENTS_HEADER,
      "S1\tS2\t0.1\t0.9\tsp_a",
      "\tS9\t0.3\t0.7\tsp_c", // no source
      "S5\t \t0.3\t0.7\tsp_c", // blank target
      "S3\tS4\t0.2\t0.8\tsp_b",
    ].join("\n");
    const { events, warnings } = parseEvents(tsv);
    expect(events.map((e) => [e.id, e.source, e.target])).toEqual([
      [0, "S1", "S2"],
      [1, "S3", "S4"],
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^2 rows with an empty source or target were skipped/);
    expect(warnings[0]).toContain("line 3");
  });

  it("does not let a skipped row's bad numbers fail the file", () => {
    const tsv = [
      EVENTS_HEADER,
      "S1\tS2\t0.1\t0.9\tsp_a",
      "\t\tnot a rate\t\t",
    ].join("\n");
    expect(parseEvents(tsv).events).toHaveLength(1);
  });

  it("refuses a file in which no row has both a source and a target", () => {
    const tsv = [EVENTS_HEADER, "\tS2\t0.1\t0.9\tsp_a"].join("\n");
    expect(() => parseEvents(tsv)).toThrow(/source.*target/i);
  });
});

describe("trailing header tabs in the other inputs", () => {
  it("gives the abundance table no phantom sample column", () => {
    const ab = parseAbundance(
      ["species\tS1\tS2\t", "sp_a\t1\t3\t", "sp_b\t1\t1\t", "\t\t\t"].join("\n"),
    );
    expect(ab.samples).toEqual(["S1", "S2"]);
    expect(ab.species).toEqual(["sp_a", "sp_b"]);
    expect(ab.matrix.sp_a.S2).toBeCloseTo(0.75, 12);
    expect(ab.warnings).toEqual([]);
  });

  it("drops several trailing tabs as well", () => {
    const ab = parseAbundance(["species\tS1\t\t", "sp_a\t1\t\t"].join("\n"));
    expect(ab.samples).toEqual(["S1"]);
  });

  it("keeps a '' column out of the metadata rows", () => {
    const md = parseMetadata(
      ["sample_id\tsubject_id\t", "A\tp1\t", "  ", "B\tp2\t"].join("\n"),
    );
    expect(md.nSamples).toBe(2);
    expect(Object.keys(md.bySample.A.extra)).toEqual(["sample_id", "subject_id"]);
  });
});
