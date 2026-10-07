import { describe, it, expect } from "vitest";
import { checkStoredSession, sessionFromPayload } from "../src/persistence.js";
import { parseAbundance } from "../src/parsing.js";

/* The previous version's parser kept a sample column with an empty name
   (trailing tabs on the abundance header), counted it with the other
   columns that sum to 0 and warned "1 of 92 sample columns sum to 0 and
   were left empty.". The readers of a stored session or a session file
   leave such a column out (src/persistence.js, readAbundance), but kept
   that warning as it was: the abundance card said, right below the
   notice that the empty column was left out, that one of 92 columns was
   empty, although the table now had 91 samples and none of them empty.
   The count is now told again for the table as the readers leave it. */

const ZERO = /sample columns sum to 0|Every sample column sums to 0/;

/** What the previous version stored for a table, as its parser read it:
    every column divided by its total, a column summing to 0 left as it
    was, and its warnings. `cols` maps a sample to its raw values. */
function previousTable(species, cols, warnings) {
  const samples = Object.keys(cols);
  const matrix = {};
  species.forEach((sp, i) => {
    matrix[sp] = {};
    for (const s of samples) {
      const total = cols[s].reduce((a, b) => a + b, 0);
      matrix[sp][s] = total > 0 ? cols[s][i] / total : cols[s][i];
    }
  });
  return { samples, species, matrix, logRange: { min: -2, max: 0 }, warnings };
}

const stored = (ab) => ({
  rawEvents: [
    { id: 0, source: "S1", target: "S2", rate: 0.1, score: 0.9, introduced: ["sp_a"], verdict: "pending", notes: "" },
  ],
  sampleCuration: {},
  sampleCurationVersion: 2,
  runMetadata: null,
  eventsWarnings: [],
  metadata: null,
  plateMap: null,
  ab,
  analysisTitle: "",
});

describe("the warning about the columns that sum to 0, after the readers left a column out", () => {
  it("is dropped when the column left out was the only empty one", () => {
    const ab = previousTable(["sp_a", "sp_b"], { S1: [1, 3], S2: [2, 2], S3: [0, 5], "": [0, 0] }, [
      "1 of 4 sample columns sum to 0 and were left empty.",
    ]);
    const { session, notes } = checkStoredSession(stored(ab));
    expect(session.ab.samples).toEqual(["S1", "S2", "S3"]);
    expect(notes.some((n) => /column with an empty name and no value/.test(n))).toBe(true);
    expect(session.ab.warnings.filter((w) => ZERO.test(w))).toEqual([]);
  });

  it("counts the columns that are still empty, among the columns that are left", () => {
    const ab = previousTable(["sp_a", "sp_b"], { S1: [1, 3], S2: [0, 0], S3: [0, 5], "": [0, 0] }, [
      "A first warning.",
      "2 of 4 sample columns sum to 0 and were left empty.",
      "A last warning.",
    ]);
    const { session } = checkStoredSession(stored(ab));
    expect(session.ab.warnings).toEqual([
      "A first warning.",
      "1 of 3 sample columns sum to 0 and were left empty.",
      "A last warning.",
    ]);
  });

  it("says what the current parser says of the same file", () => {
    // The file the previous version read, trailing tabs included: the
    // current parser drops the trailing empty header cell.
    const text = "species\tS1\tS2\tS3\t\nsp_a\t1\t0\t0\t\nsp_b\t3\t0\t5\t\n";
    const parsed = parseAbundance(text);
    const ab = previousTable(["sp_a", "sp_b"], { S1: [1, 3], S2: [0, 0], S3: [0, 5], "": [0, 0] }, [
      "2 of 4 sample columns sum to 0 and were left empty.",
    ]);
    const { session } = checkStoredSession(stored(ab));
    expect(session.ab.warnings.filter((w) => ZERO.test(w))).toEqual(parsed.warnings.filter((w) => ZERO.test(w)));
  });

  it("is told again in a session file read by the import", () => {
    const ab = previousTable(["sp_a", "sp_b"], { S1: [1, 3], S2: [2, 2], "": [0, 0] }, [
      "1 of 3 sample columns sum to 0 and were left empty.",
    ]);
    const res = sessionFromPayload({
      events: [{ id: 0, source: "S1", target: "S2", contamination_rate: 0.1, probability: 0.9, introduced_species: ["sp_a"] }],
      abundance: JSON.parse(JSON.stringify(ab)),
    });
    expect(res.ok).toBe(true);
    expect(res.session.ab.samples).toEqual(["S1", "S2"]);
    expect(res.session.ab.warnings).toEqual([]);
    expect(res.repairs.some((r) => /column with an empty name and no value/.test(r))).toBe(true);
  });

  it("no longer counts a column whose only values were outweighed by negative ones", () => {
    // S2's total was below 0 (5 - 8): the previous parser left the column
    // as it was, and counted it. Its negative value reads as 0 now, and
    // the column is a fraction of its positive values again.
    const ab = previousTable(["sp_a", "sp_b"], { S1: [1, 3], S2: [5, -8], "": [0, 0] }, [
      "2 of 3 sample columns sum to 0 and were left empty.",
    ]);
    const { session } = checkStoredSession(stored(ab));
    expect(session.ab.matrix.sp_a.S2).toBe(1);
    expect(session.ab.warnings).toEqual([]);
  });

  it("is kept as it is when every column that is left is still empty", () => {
    const every =
      "Every sample column sums to 0 — no abundance could be read. Check the decimal separator " +
      "(a comma is not recognised) and that the first column holds species names.";
    const ab = previousTable(["sp_a", "sp_b"], { S1: [0, 0], S2: [0, 0], "": [0, 0] }, [every]);
    const { session } = checkStoredSession(stored(ab));
    expect(session.ab.samples).toEqual(["S1", "S2"]);
    expect(session.ab.warnings).toEqual([every]);
  });

  it("is left alone in a table the readers do not change", () => {
    const ab = previousTable(["sp_a", "sp_b"], { S1: [1, 3], S2: [0, 0], S3: [0, 5] }, [
      "1 of 3 sample columns sum to 0 and were left empty.",
    ]);
    const s = stored(ab);
    const { session, notes } = checkStoredSession(s);
    expect(notes).toEqual([]);
    expect(session.ab).toBe(ab);
  });
});
