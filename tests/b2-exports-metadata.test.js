import { describe, it, expect } from "vitest";
import {
  parseMetadata,
  metadataToTSV,
  metadataColumnsLine,
  remapMetadata,
  parsePlateMap,
} from "../src/parsing.js";

/* B2.6 — shapes of a hand-edited session.

   A session file stores the parsed metadata, and every entry keeps its
   row as `extra`. An `extra` that is not a plain object made the metadata
   download throw (`col in "abc"`: "Cannot use 'in' operator") and the
   metadata card list the string's characters as columns ("other: 0, 1,
   2"); a list was read as a row headed "0", "1", … and lost the entry's
   subject. Such an entry now keeps what was parsed for it, and its broken
   row is ignored. */

const md = parseMetadata("sample_id\tsubject_id\tbatch\nS1\tp1\tb1\nS2\tp2\tb2");
const withExtra = (extra) => {
  const m = structuredClone(md);
  m.bySample.S1.extra = extra;
  return m;
};

describe("metadataToTSV — an entry whose extra is not a row", () => {
  for (const [name, extra] of [
    ["a string", "abc"],
    ["a list", ["a", "b"]],
    ["a number", 7],
  ]) {
    it(`does not throw on ${name}, and writes the parsed values`, () => {
      const m = withExtra(extra);
      let text;
      expect(() => (text = metadataToTSV(m))).not.toThrow();
      const lines = text.split("\n").map((l) => l.split("\t"));
      expect(lines[0]).toEqual(["sample_id", "subject_id", "batch"]);
      // S1 keeps its id and subject; its batch, which only its row held,
      // is empty. S2 is untouched.
      expect(lines[1]).toEqual(["S1", "p1", ""]);
      expect(lines[2]).toEqual(["S2", "p2", "b2"]);
      // Read back, the relatedness is the same.
      const back = parseMetadata(text);
      expect(back.bySample.S1.subject).toBe("p1");
      expect(back.bySample.S2.subject).toBe("p2");
    });
  }

  it("does not throw when every entry is broken, and keeps sample_id and subject_id", () => {
    const m = { cols: md.cols, bySample: { S1: { extra: "xyz", subject: "p1" }, S2: "nonsense" } };
    expect(metadataToTSV(m)).toBe("sample_id\tsubject_id\nS1\tp1\nS2\t");
  });
});

describe("metadataColumnsLine — the card's column line", () => {
  it("never lists a string's characters as columns", () => {
    const only = { cols: md.cols, bySample: { S1: { extra: "abc", subject: "p1" } } };
    expect(metadataColumnsLine(only)).toBe("sample_id · subject_id");
  });

  it("reads the other columns from the first entry that keeps a row", () => {
    const m = withExtra("abc");
    // S1 (first) is broken: the line comes from S2's row.
    expect(metadataColumnsLine(m)).toBe("sample_id · subject_id · other: batch");
    expect(metadataColumnsLine(withExtra(["a", "b"]))).toBe("sample_id · subject_id · other: batch");
  });
});

describe("remapMetadata — a list is not a row", () => {
  it("leaves the entry as parsed instead of reading a header '0', '1'", () => {
    const m = { cols: md.cols, bySample: { S1: { extra: ["a", "b"], subject: "p1" } } };
    expect(remapMetadata(m)).toBe(m);
    expect(remapMetadata(withExtra(["a", "b"])).bySample.S1.subject).toBe("p1");
  });
});

/* The plate map card and the Help agree: a file without a plate column is
   one plate (P1), and the card warns only when the file suggests several
   plates — an unrecognised header containing "plate", or two samples in
   one well. */
describe("parsePlateMap — when the card warns about a missing plate column", () => {
  const warns = (text) =>
    parsePlateMap(text).warnings.some((w) => w.startsWith("No plate column was recognised"));

  it("does not warn for a one-plate file without a plate column", () => {
    const pm = parsePlateMap("sample_id\twell\nS1\tA01\nS2\tA02");
    expect(pm.warnings).toEqual([]);
    expect(pm.cols.plate).toBeNull();
    expect(pm.bySample.S1.plate).toBe("P1");
  });

  it("warns when a header looks like a plate column", () => {
    expect(warns("sample_id\twell\tPlateLabel\nS1\tA01\tX\nS2\tA02\tY")).toBe(true);
  });

  it("warns when two samples share a well", () => {
    expect(warns("sample_id\twell\nS1\tA01\nS2\tA01")).toBe(true);
  });

  it("does not warn when the plate column is recognised", () => {
    expect(warns("sample_id\tplate\twell\nS1\tP1\tA01\nS2\tP2\tA01")).toBe(false);
  });
});
