import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbundance, parseStrictNumber, parseTSV } from "../src/parsing.js";
import {
  abundanceToTSV,
  buildCuratedAbundance,
  curatedAbundanceProvenance,
  hasInputValues,
  inputValue,
} from "../src/exports.js";

/* B2.3 — the curated abundance table is the input table.

   The export wrote the parser's fractions (counts 1500 / 500 came out as
   0.75 / 0.25) under a "species" first header, behind "#" provenance
   lines that pandas' and R's default readers take for data. It now
   writes each remaining column with the input's own values, rebuilt from
   the parser's fraction and column sum (rounded for a column of
   integers), under the input's first header and in its species order,
   and the provenance goes to a separate text file. */

const root = join(import.meta.dirname, "..", "public");

/** The cells of a TSV text: { header, rows: [[name, ...cells]] }. */
function cells(text) {
  const lines = text.split("\n").filter((l) => l.length > 0);
  return { header: lines[0].split("\t"), rows: lines.slice(1).map((l) => l.split("\t")) };
}

/** Every value of `written` equals the input's value as a number, for the
    columns and rows they share (what pandas or R would read). */
function sameValues(input, written) {
  const a = parseTSV(input);
  const b = cells(written);
  const byName = new Map(a.rows.map((r) => [r[a.header[0]], r]));
  for (const row of b.rows) {
    const orig = byName.get(row[0]);
    if (!orig) return `species ${row[0]} is not in the input`;
    for (let j = 1; j < b.header.length; j++) {
      let v = parseStrictNumber(orig[b.header[j]]);
      if (v === null || Number.isNaN(v) || v < 0) v = 0;
      if (Number(row[j]) !== v) return `${row[0]} / ${b.header[j]}: ${row[j]} for ${orig[b.header[j]]}`;
    }
  }
  return null;
}

const COUNTS = [
  "id_mgs\tS1\tS2\tS3",
  "msp_2\t1500\t7\t0",
  "10\t500\t0\t12",
  "msp_1\t0\t3\t988",
  "2\t1\t0\t0",
].join("\n");

describe("abundanceToTSV — the input's own values", () => {
  it("gives a count table back exactly: values, first header, species order", () => {
    // Integer-like names ("10", "2") stay where they were.
    expect(abundanceToTSV(parseAbundance(COUNTS))).toBe(COUNTS);
  });

  it("gives decimal and percentage values back exactly", () => {
    const decimals = [
      "clade_name\tA\tB\tC",
      "s__One\t70.05308\t0.25\t3.14496940114656e-7",
      "s__Two\t29.94692\t0.1\t1.13996595047665e-5",
      "s__Three\t0\t0.65\t0.000123",
    ].join("\n");
    const ab = parseAbundance(decimals);
    expect(ab.integerCols).toEqual({ A: false, B: false, C: false });
    const out = abundanceToTSV(ab);
    expect(out.split("\n")[0]).toBe("clade_name\tA\tB\tC");
    expect(sameValues(decimals, out)).toBeNull();
    // Not the product as is: 0.1 / 1 × 1 would do, but 0.65 / 1.0 × 1.0
    // need not, and 70.05308 / 100 × 100 does not print as 70.05308.
    expect(cells(out).rows[0][1]).toBe("70.05308");
  });

  it("keeps a column of counts integer next to a column of decimals", () => {
    const mixed = ["species\tN\tF", "a\t3\t0.5", "b\t7\t0.25", "c\t0\t0.25"].join("\n");
    expect(abundanceToTSV(parseAbundance(mixed))).toBe(mixed);
  });

  it("rounds large counts back to the very integers", () => {
    const rows = ["species\tA\tB"];
    for (let i = 0; i < 300; i++) rows.push(`sp_${i}\t${(i * 7919 + 13) * 104729}\t${i % 3 ? i * 31 : 0}`);
    const text = rows.join("\n");
    expect(abundanceToTSV(parseAbundance(text))).toBe(text);
  });

  it("writes 0 for a cell the parser read as 0 (empty, NA, not a number, negative)", () => {
    const text = ["species\tA\tB", "a\tNA\t2", "b\t\t-1", "c\t5\tx", "d\t1\t3"].join("\n");
    const out = cells(abundanceToTSV(parseAbundance(text)));
    expect(out.rows).toEqual([
      ["a", "0", "2"],
      ["b", "0", "0"],
      ["c", "5", "0"],
      ["d", "1", "3"],
    ]);
  });

  it("writes an all-zero column as zeros and an empty first header as empty", () => {
    const text = ["\tA\tB", "a\t0\t1", "b\t0\t2"].join("\n");
    expect(abundanceToTSV(parseAbundance(text))).toBe(text);
  });

  it("writes a long small value in exponent notation, which pandas reads to the last digit", () => {
    // String() writes 0.0000010630384344999: 20 digits, and pandas' default
    // float reader keeps 17 of them, the zeros included (1e-10 off).
    const text = ["species\tA", "a\t1.0630384344999e-6", "b\t0.5", "c\t0.000123"].join("\n");
    const out = cells(abundanceToTSV(parseAbundance(text)));
    expect(out.rows.map((r) => r[1])).toEqual(["1.0630384344999e-6", "0.5", "0.000123"]);
  });

  it("writes no '#' line, which pandas and R would read as data", () => {
    const out = abundanceToTSV(parseAbundance(COUNTS));
    expect(out.split("\n").some((l) => l.startsWith("#"))).toBe(false);
  });

  for (const file of [
    "demo/species_abundance.tsv",
    "datasets/PRJEB83730/species_abundance.tsv",
    "datasets/PRJNA698986_P2/species_abundance.tsv",
  ]) {
    it(`gives ${file} back: every value up to 15 digits exactly, the others to the last digit`, () => {
      const text = readFileSync(join(root, file), "utf8");
      const ab = parseAbundance(text);
      const out = cells(abundanceToTSV(ab));
      const input = parseTSV(text);
      expect(out.header).toEqual([input.header[0], ...ab.samples]);
      expect(out.rows.map((r) => r[0])).toEqual(input.rows.map((r) => r[input.header[0]]));
      let exact = 0;
      let long = 0;
      let worst = 0;
      out.rows.forEach((row, i) => {
        for (let j = 1; j < row.length; j++) {
          const raw = String(input.rows[i][out.header[j]]).trim();
          const v = parseStrictNumber(raw) || 0;
          const w = Number(row[j]);
          const digits = v === 0 ? 0 : v.toExponential().split("e")[0].replace(".", "").length;
          if (digits <= 15) {
            if (w === v) exact++;
            else throw new Error(`${row[0]} / ${out.header[j]}: ${row[j]} for ${raw}`);
          } else {
            long++;
            worst = Math.max(worst, Math.abs(w - v) / v);
          }
        }
      });
      expect(exact).toBeGreaterThan(0);
      // Two 16- or 17-digit values can make the same fraction: those come
      // back within a few units of their last digit.
      expect(worst).toBeLessThan(1e-15);
      expect(exact + long).toBe(ab.samples.length * ab.species.length);
    });
  }
});

describe("inputValue — one value from its fraction and its column sum", () => {
  it("is exact for counts and short decimals", () => {
    expect(inputValue(1500 / 2000, 2000, true)).toBe(1500);
    expect(inputValue(0.1 / 0.3, 0.3, false)).toBe(0.1);
    expect(inputValue(0.65, 1, false)).toBe(0.65);
    expect(inputValue(70.05308 / 100.00001, 100.00001, false)).toBe(70.05308);
  });

  it("is 0 for a zero fraction or a zero column", () => {
    expect(inputValue(0, 10, true)).toBe(0);
    expect(inputValue(0, 10, false)).toBe(0);
    expect(inputValue(0.5, 0, false)).toBe(0);
  });
});

describe("buildCuratedAbundance + abundanceToTSV — the curated table", () => {
  const ab = parseAbundance(COUNTS);

  it("is the input without the suppressed columns, each remaining column unchanged", () => {
    const cur = buildCuratedAbundance(ab, { S2: { action: "suppress" }, S1: { action: "keep" } });
    const out = abundanceToTSV(cur);
    expect(out).toBe(
      ["id_mgs\tS1\tS3", "msp_2\t1500\t0", "10\t500\t12", "msp_1\t0\t988", "2\t1\t0"].join("\n"),
    );
    expect(sameValues(COUNTS, out)).toBeNull();
  });

  it("drops the species left at zero everywhere only when asked, keeping the order", () => {
    const sup = { S1: { action: "suppress" } };
    expect(cells(abundanceToTSV(buildCuratedAbundance(ab, sup))).rows.map((r) => r[0])).toEqual([
      "msp_2",
      "10",
      "msp_1",
    ]);
    expect(
      cells(abundanceToTSV(buildCuratedAbundance(ab, sup, { dropEmptySpecies: false }))).rows.map((r) => r[0]),
    ).toEqual(["msp_2", "10", "msp_1", "2"]);
  });
});

describe("buildCuratedAbundance — which species rows go", () => {
  // "empty" is at zero in every sample of the input, as hundreds of rows of
  // a Meteor catalogue table are; "s2_only" is observed in S2 alone.
  const text = [
    "id\tS1\tS2\tS3",
    "both\t4\t1\t0",
    "empty\t0\t0\t0",
    "s2_only\t0\t9\t0",
    "s3\t0\t0\t2",
  ].join("\n");
  const ab = parseAbundance(text);

  it("drops nothing when nothing is suppressed, empty rows included", () => {
    const cur = buildCuratedAbundance(ab, {});
    expect(cur.droppedSpecies).toEqual([]);
    expect(abundanceToTSV(cur)).toBe(text);
  });

  it("drops only the species observed only in the suppressed samples", () => {
    const cur = buildCuratedAbundance(ab, { S2: { action: "suppress" } });
    expect(cur.droppedSpecies).toEqual(["s2_only"]);
    expect(cur.species).toEqual(["both", "empty", "s3"]);
  });

  it("counts the same without building the table (the Export card)", () => {
    const sup = { S2: { action: "suppress" }, S3: { action: "suppress" } };
    const full = buildCuratedAbundance(ab, sup);
    const counts = buildCuratedAbundance(ab, sup, { matrix: false });
    expect(counts.matrix).toBeNull();
    expect([counts.samples, counts.species, counts.droppedSamples, counts.droppedSpecies]).toEqual([
      full.samples,
      full.species,
      full.droppedSamples,
      full.droppedSpecies,
    ]);
    expect(full.droppedSpecies).toEqual(["s2_only", "s3"]);
  });
});

describe("a table saved without the parser's column sums (earlier session)", () => {
  // As an earlier version stored it: fractions only, species possibly
  // reordered by Object.keys.
  const ab = parseAbundance(COUNTS);
  const old = {
    samples: ab.samples,
    species: Object.keys(ab.matrix),
    matrix: ab.matrix,
    logRange: ab.logRange,
  };

  it("is detected", () => {
    expect(hasInputValues(ab)).toBe(true);
    expect(hasInputValues(old)).toBe(false);
    expect(hasInputValues({ ...ab, colSums: { S1: 1 } })).toBe(false);
    expect(hasInputValues(null)).toBe(false);
  });

  it("is written as fractions under a 'species' header, as before", () => {
    const out = cells(abundanceToTSV(old));
    expect(out.header).toEqual(["species", "S1", "S2", "S3"]);
    // 1500 of S1's 2001, 7 of S2's 10.
    expect(out.rows.find((r) => r[0] === "msp_2")).toEqual([
      "msp_2",
      String(1500 / 2001),
      "0.7",
      "0",
    ]);
    const cur = cells(abundanceToTSV(buildCuratedAbundance(old, { S2: { action: "suppress" } })));
    expect(cur.header).toEqual(["species", "S1", "S3"]);
  });
});

describe("curatedAbundanceProvenance — the text file next to the table", () => {
  const ab = parseAbundance(COUNTS);
  const cur = buildCuratedAbundance(ab, { S1: { action: "suppress" }, s3: { action: "suppress" } });
  const text = curatedAbundanceProvenance(ab, cur, {
    study: "Study X",
    curated: "2026-10-07T00:00:00.000Z",
    build: "abc1234 (2026-10-07)",
  });

  it("names the study, the date, the build and the sizes", () => {
    expect(text).toContain("Study: Study X");
    expect(text).toContain("Curated: 2026-10-07T00:00:00.000Z");
    expect(text).toContain("build abc1234 (2026-10-07)");
    expect(text).toContain("Input table: 4 species rows × 3 samples.");
    expect(text).toContain("This table: 2 species rows × 1 sample.");
  });

  it("lists the suppressed samples and the dropped species, one per line", () => {
    const lines = text.split("\n");
    const at = lines.indexOf("Suppressed samples (2), removed because their action is Suppress:");
    expect(lines.slice(at + 1, at + 3)).toEqual(["S1", "S3"]);
    const sp = lines.findIndex((l) => l.startsWith("Species removed because"));
    expect(lines.slice(sp + 1, sp + 3)).toEqual(["10", "2"]);
  });

  it("says what the values are, input values or fractions", () => {
    expect(text).toContain("the input table's own values");
    const old = { ...ab, colSums: undefined };
    const fallback = curatedAbundanceProvenance(old, buildCuratedAbundance(old, {}), {});
    expect(fallback).toContain("Values: relative abundances");
    expect(fallback).toContain("none — every sample is kept");
  });
});
