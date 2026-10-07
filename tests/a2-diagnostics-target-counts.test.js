import { describe, it, expect } from "vitest";
import { parseAbundance } from "../src/parsing.js";
import {
  buildScatter,
  resolveSample,
  speciesCountsBySample,
  introducedPercent,
} from "../src/diagnostics.js";

/* A2.4 — the introduced % finds the target the way the scatter does.

   The scatter resolves an events-file sample name against the table's
   columns exactly, then case- and whitespace-insensitively. The species
   count behind "introduced %" was looked up by the raw name, so a target
   written "TGT " plotted fine yet exported a blank introduced_pct, and the
   introduced-% filter hid the event. */

const ab = parseAbundance(
  [
    "species\tSRC\tTGT\tOther",
    "sp_a\t1\t1\t0",
    "sp_b\t1\t1\t1",
    "sp_c\t1\t0\t1",
    "sp_d\t0\t1\t1",
    "sp_e\t1\t0\t0",
  ].join("\n"),
);
const introduced = ["sp_a", "sp_b"];

describe("resolveSample", () => {
  it("matches exactly, then ignoring case and surrounding whitespace", () => {
    expect(resolveSample(ab, "TGT")).toBe("TGT");
    expect(resolveSample(ab, "TGT ")).toBe("TGT");
    expect(resolveSample(ab, " tgt")).toBe("TGT");
    expect(resolveSample(ab, "OTHER")).toBe("Other");
    expect(resolveSample(ab, "nope")).toBeNull();
    expect(resolveSample(ab, "")).toBeNull();
    expect(resolveSample(null, "TGT")).toBeNull();
  });

  it("prefers the first column when two differ only by case", () => {
    const twin = parseAbundance("species\tA\ta\nsp\t1\t1");
    expect(resolveSample(twin, "a")).toBe("a"); // exact first
    expect(resolveSample(twin, " A ")).toBe("A"); // then the first in order
  });
});

describe("introducedPercent", () => {
  const counts = speciesCountsBySample(ab);

  it("counts the species observed in each sample", () => {
    expect(counts).toEqual({ SRC: 4, TGT: 3, Other: 3 });
  });

  for (const target of ["TGT", "TGT ", "tgt", " Tgt\t"]) {
    it(`finds target ${JSON.stringify(target)} like the scatter does`, () => {
      const e = { source: "SRC", target, rate: 0.1, introduced };
      // The scatter resolves it…
      expect(buildScatter(ab, e).error).toBeUndefined();
      // …so the introduced % must too: 2 introduced of TGT's 3 species.
      expect(introducedPercent(ab, counts, e)).toBeCloseTo((2 / 3) * 100, 12);
    });
  }

  it("is null when the target is not in the table, or nothing is loaded", () => {
    expect(introducedPercent(ab, counts, { target: "nope", introduced })).toBeNull();
    expect(introducedPercent(ab, null, { target: "TGT", introduced })).toBeNull();
    expect(introducedPercent(ab, counts, { target: "TGT" })).toBeNull();
  });
});
