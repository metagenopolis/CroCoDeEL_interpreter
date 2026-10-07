import { describe, it, expect } from "vitest";
import {
  parseStrictNumber,
  parseEvents,
  parseAbundance,
} from "../src/parsing.js";

/* A1.1 — numbers are read strictly.

   parseFloat reads the longest numeric PREFIX of a cell, so a table re-saved
   by a French-locale spreadsheet loaded without a word of warning:
   "7,41E-01" read as 7, "0,87" as 0, "1,23E-05" as 1. */

const EVENTS_HEADER =
  "source\ttarget\trate\tprobability\tcontamination_specific_species";

describe("parseStrictNumber", () => {
  it("reads decimal numbers: sign, digits, fraction, exponent, surrounding blanks", () => {
    const cases = [
      ["0", 0],
      ["42", 42],
      ["-3", -3],
      ["+3", 3],
      ["0.87", 0.87],
      [".5", 0.5],
      ["5.", 5],
      ["7.41E-01", 0.741],
      ["1e-05", 1e-5],
      ["1.23E+05", 123000],
      ["  0.25\t", 0.25],
      ["0e0", 0],
    ];
    for (const [cell, value] of cases) {
      expect(parseStrictNumber(cell), cell).toBe(value);
    }
    expect(Object.is(parseStrictNumber("-0"), -0)).toBe(true);
  });

  it("returns null (missing) for empty and NA-like cells, in any case", () => {
    const cells = [
      "",
      "   ",
      "\t",
      "NA",
      "na",
      " NA ",
      "N/A",
      "n/a",
      "NaN",
      "nan",
      "null",
      "NULL",
      "None",
      "none",
      "-",
      "#N/A",
      undefined,
      null,
    ];
    for (const cell of cells) {
      expect(parseStrictNumber(cell), JSON.stringify(cell)).toBeNull();
    }
  });

  it("returns NaN (invalid) for anything else, including what Number() accepts", () => {
    const cells = [
      // decimal comma, the motivating case
      "0,87",
      "7,41E-01",
      "1,23E-05",
      // Number() reads these, a decimal number is none of them
      "0x1F",
      "0X1f",
      " 0x1F",
      "0b101",
      "0o17",
      "Infinity",
      "-Infinity",
      "1e999",
      // plain garbage
      "12 %",
      "1 000",
      "abc",
      "1.2.3",
      "--1",
      "1e",
      "e5",
      ".",
      "+",
      "1_000",
    ];
    for (const cell of cells) {
      expect(parseStrictNumber(cell), cell).toBeNaN();
    }
  });
});

describe("parseEvents — strict rate and probability", () => {
  it("refuses a decimal-comma rate, naming the row, the column and the value", () => {
    const tsv = [
      EVENTS_HEADER,
      "S1\tS2\t7,41E-01\t0,98\tsp_a",
      "S3\tS4\t0,5\t1\tsp_b",
    ].join("\n");
    let err = null;
    try {
      parseEvents(tsv);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/row 1 \(line 2\)/i);
    expect(err.message).toContain('column "rate"');
    expect(err.message).toContain('"7,41E-01"');
    expect(err.message).toContain(
      "looks like a decimal comma — re-export the file with '.' as decimal separator",
    );
    // The other two bad cells are counted, so the user knows it is not a typo.
    expect(err.message).toMatch(/2 more/);
  });

  it("refuses a decimal-comma probability, naming the column it was read from", () => {
    const tsv = [
      "# crocodeel version: 1.2.1",
      "source\ttarget\tcontamination_rate\tscore\tspecies",
      "S1\tS2\t0.5\t0.9\tsp_a",
      "S3\tS4\t0.25\t0,87\tsp_b",
    ].join("\n");
    expect(() => parseEvents(tsv)).toThrow(
      /row 2 \(line 4\), column "score": "0,87" is not a number — looks like a decimal comma/i,
    );
  });

  it("refuses other non-numbers without the decimal-comma hint", () => {
    const tsv = [EVENTS_HEADER, "S1\tS2\thigh\t0.9\tsp_a"].join("\n");
    let msg = "";
    try {
      parseEvents(tsv);
    } catch (e) {
      msg = e.message;
    }
    expect(msg).toContain('column "rate": "high" is not a number');
    expect(msg).not.toMatch(/decimal comma/);
  });

  it("still reads a missing rate or probability (empty, NA) as 0", () => {
    const tsv = [
      EVENTS_HEADER,
      "S1\tS2\t\tNA\tsp_a",
      "S3\tS4\tNA\t\tsp_b",
      "S5\tS6\t0.1\t0.9\tsp_c",
    ].join("\n");
    const { events, warnings } = parseEvents(tsv);
    expect(events.map((e) => [e.rate, e.score])).toEqual([
      [0, 0],
      [0, 0],
      [0.1, 0.9],
    ]);
    expect(warnings).toEqual([]);
  });

  it("falls through to the next probability column when the first holds NA", () => {
    const tsv = [
      "source\ttarget\trate\tprobability\tscore",
      "S1\tS2\t0.1\tNA\t0.8",
    ].join("\n");
    expect(parseEvents(tsv).events[0].score).toBeCloseTo(0.8, 12);
  });

  it("warns about out-of-range rates and probabilities, with a count and a first example", () => {
    const tsv = [
      EVENTS_HEADER,
      "S1\tS2\t0.4\t0.9\tsp_a",
      "S3\tS4\t1.5\t0.9\tsp_b", // rate > 1
      "S5\tS6\t0\t1.2\tsp_c", // rate 0, probability > 1
      "S7\tS8\t-0.1\t-0.5\tsp_d", // both negative
    ].join("\n");
    const { events, warnings } = parseEvents(tsv);
    expect(events).toHaveLength(4);
    // Values are kept as read: the warning is the signal, not a silent clamp.
    expect(events[1].rate).toBe(1.5);
    expect(events[2].score).toBe(1.2);
    const rateW = warnings.find((w) => /\brates?\b/.test(w) && /\(0, 1\]/.test(w));
    const probW = warnings.find((w) => /probabilit/.test(w) && /\[0, 1\]/.test(w));
    expect(rateW).toMatch(/^3 events/);
    expect(rateW).toContain("line 3");
    expect(rateW).toContain("S3 → S4");
    expect(rateW).toContain("1.5");
    expect(probW).toMatch(/^2 events/);
    expect(probW).toContain("line 4");
    expect(probW).toContain("1.2");
  });
});

describe("parseAbundance — strict cells", () => {
  it("counts decimal-comma cells as non-numeric, reads them as 0 and says why", () => {
    const tsv = [
      "species\tS1\tS2",
      "sp_a\t0,87\t1",
      "sp_b\t0,13\t3",
      "sp_c\tabc\t0",
    ].join("\n");
    const ab = parseAbundance(tsv);
    expect(ab.matrix.sp_a.S1).toBe(0);
    expect(ab.matrix.sp_a.S2).toBeCloseTo(0.25, 12);
    const w = ab.warnings.find((x) => /not numeric/.test(x));
    expect(w).toMatch(/^3 non-empty cells/);
    expect(w).toMatch(/2 of them look like a decimal comma/);
    expect(w).toContain('"0,87"');
    expect(w).toContain("re-export the table with '.' as decimal separator");
  });

  it("reads negative values as 0 with a warning", () => {
    const tsv = ["species\tS1", "sp_a\t-5", "sp_b\t10", "sp_c\t30"].join("\n");
    const ab = parseAbundance(tsv);
    expect(ab.matrix.sp_a.S1).toBe(0);
    expect(ab.matrix.sp_b.S1).toBeCloseTo(0.25, 12);
    const w = ab.warnings.find((x) => /negative/.test(x));
    expect(w).toMatch(/^1 cell holds a negative value/);
    expect(w).toContain('"-5"');
    expect(w).toContain("sp_a");
  });

  it("keeps empty and NA cells a silent 0", () => {
    const tsv = [
      "species\tS1\tS2",
      "sp_a\tNA\t\t",
      "sp_b\t10\tnan",
      "sp_c\t-\t5",
    ].join("\n");
    const ab = parseAbundance(tsv);
    expect(ab.matrix.sp_a.S1).toBe(0);
    expect(ab.matrix.sp_b.S1).toBe(1);
    expect(ab.matrix.sp_c.S2).toBe(1);
    // Nothing about the cells. The first row ends with one tab more than
    // the header, which pandas, hence CroCoDeEL, reads as a header without
    // a cell above the species, every sample one column off: said so
    // (tests/final-science-io-layout.test.js).
    expect(ab.warnings).toHaveLength(1);
    expect(ab.warnings[0]).toMatch(/^The first row \(line 2\) has one cell more than the header/);
  });

  it("rejects hexadecimal and infinite cells instead of reading them", () => {
    const tsv = ["species\tS1", "sp_a\t0x10", "sp_b\tInfinity", "sp_c\t4"].join(
      "\n",
    );
    const ab = parseAbundance(tsv);
    expect(ab.matrix.sp_c.S1).toBe(1);
    expect(ab.warnings.some((w) => /^2 non-empty cells were not numeric/.test(w))).toBe(true);
  });
});
