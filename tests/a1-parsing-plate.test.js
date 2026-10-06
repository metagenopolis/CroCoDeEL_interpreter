import { describe, it, expect } from "vitest";
import {
  parsePlateMap,
  plateMapToTSV,
  plateColumnsLine,
} from "../src/parsing.js";

/* A1.5 — plate maps given as row + column. README and Help promised them
   ("well (alphanumeric or row + column)"), parsePlateMap refused them. */

const tsv = (rows) => rows.map((r) => r.join("\t")).join("\n");

describe("parsePlateMap — well column", () => {
  it("reads letter-then-number wells, 96-well by default", () => {
    const pm = parsePlateMap(
      tsv([["sample_id", "plate", "well"], ["S1", "P1", "A01"], ["S2", "P1", "h12"], ["S3", "P2", "C7"]]),
    );
    expect(pm.bySample).toEqual({
      S1: { plate: "P1", row: 0, col: 0 },
      S2: { plate: "P1", row: 7, col: 11 },
      S3: { plate: "P2", row: 2, col: 6 },
    });
    expect(pm.format).toEqual({ rows: 8, cols: 12 });
    expect(pm.warnings).toEqual([]);
  });
});

describe("parsePlateMap — row + column instead of a well", () => {
  it("reads a row letter and a 1-based column number", () => {
    const pm = parsePlateMap(
      tsv([["sample_id", "plate", "row", "column"], ["S1", "P1", "A", "1"], ["S2", "P1", "h", "12"], ["S3", "P1", " C ", "07"]]),
    );
    expect(pm.bySample).toEqual({
      S1: { plate: "P1", row: 0, col: 0 },
      S2: { plate: "P1", row: 7, col: 11 },
      S3: { plate: "P1", row: 2, col: 6 },
    });
    expect(pm.format).toEqual({ rows: 8, cols: 12 });
    expect(pm.cols).toMatchObject({ well: null, row: "row", col: "column" });
    expect(plateColumnsLine(pm)).toBe("sample_id · plate · row · column");
  });

  it("reads a 1-based row number, detects a 384-well plate and accepts the usual headers", () => {
    const pm = parsePlateMap(
      tsv([["Sample ID", "Plate", "Well Row", "Col"], ["S1", "P1", "1", "1"], ["S2", "P1", "16", "24"], ["S3", "P1", "2", "3.0"]]),
    );
    expect(pm.bySample.S1).toEqual({ plate: "P1", row: 0, col: 0 });
    expect(pm.bySample.S2).toEqual({ plate: "P1", row: 15, col: 23 });
    expect(pm.bySample.S3).toEqual({ plate: "P1", row: 1, col: 2 });
    expect(pm.format).toEqual({ rows: 16, cols: 24 });
  });

  it("prefers a well column when the file has both", () => {
    const pm = parsePlateMap(
      tsv([["sample_id", "well", "row", "column"], ["S1", "B02", "A", "1"]]),
    );
    expect(pm.bySample.S1).toEqual({ plate: "P1", row: 1, col: 1 });
    expect(pm.cols).toMatchObject({ well: "well", row: null, col: null });
  });

  it("skips coordinates off the plate, and says how many and where", () => {
    const pm = parsePlateMap(
      tsv([
        ["sample_id", "row", "column"],
        ["S1", "A", "1"],
        ["S2", "Q", "1"], // no row Q
        ["S3", "A", "25"], // no column 25
        ["S4", "0", "3"], // rows count from 1
        ["S5", "B", "2.5"], // not a column
        ["S6", "", ""], // not placed: skipped without a word
      ]),
    );
    expect(Object.keys(pm.bySample)).toEqual(["S1"]);
    expect(pm.warnings).toEqual([
      '4 rows with no readable well were skipped (first on line 3: "Q / 1").',
    ]);
  });

  it("refuses a file with neither a well nor a row + column pair", () => {
    expect(() =>
      parsePlateMap(tsv([["sample_id", "plate", "row"], ["S1", "P1", "A"]])),
    ).toThrow(/sample_id and either well or row \+ column are required/);
  });
});

describe("plateMapToTSV", () => {
  it("still writes the well format, which parses back to the same placement", () => {
    const pm = parsePlateMap(
      tsv([["sample_id", "plate", "row", "column"], ["S1", "P1", "A", "1"], ["S2", "P2", "P", "24"]]),
    );
    const out = plateMapToTSV(pm);
    expect(out).toBe("sample_id\tplate\twell\nS1\tP1\tA01\nS2\tP2\tP24");
    expect(parsePlateMap(out).bySample).toEqual(pm.bySample);
  });
});
