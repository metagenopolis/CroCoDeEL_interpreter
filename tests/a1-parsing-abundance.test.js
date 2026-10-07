import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbundance } from "../src/parsing.js";

/* A1.8 — a header-only abundance table was accepted: no species, every
   sample empty, and a warning blaming the decimal separator. */

describe("parseAbundance — a table without species rows", () => {
  it("is refused with a clear error", () => {
    for (const text of [
      "species\tS1\tS2",
      "species\tS1\tS2\n",
      "# comment\nspecies\tS1\tS2\n\n \t \n",
    ]) {
      expect(() => parseAbundance(text), JSON.stringify(text)).toThrow(
        "The abundance table has no species rows: only its header line (2 sample columns) was found.",
      );
    }
  });

  it("is refused when no row names a species", () => {
    expect(() => parseAbundance("species\tS1\n\t5\n\t3")).toThrow(/no species rows/);
  });

  it("still returns null for a file without sample columns", () => {
    expect(parseAbundance("species")).toBeNull();
    expect(parseAbundance("")).toBeNull();
  });
});

/* A1.7 — what an export needs to give the user's table back. The parser
   turns every column into fractions, so the curated-abundance export could
   not return the input: counts 1500 / 500 came out as 0.75 / 0.25, and the
   first header became "species". The fractions themselves do not change. */

describe("parseAbundance — fields to rebuild the original table", () => {
  const text = [
    "# made by hand",
    "id_mgs\tS1\tS2\tS3\tS4",
    "msp_2\t1500\t0.25\t0\t7",
    "msp_1\t500\t0.5\tNA\t-3",
    "10\t0\t0.25\t\t3",
  ].join("\n");
  const ab = parseAbundance(text);

  it("keeps the first header cell as written", () => {
    expect(ab.firstHeader).toBe("id_mgs");
  });

  it("keeps the species in file order, integer-like names included", () => {
    expect(ab.species).toEqual(["msp_2", "msp_1", "10"]);
  });

  it("keeps each column's sum before normalisation, and whether it held only integers", () => {
    // S4: the negative cell reads as 0, as in the matrix.
    expect(ab.colSums).toEqual({ S1: 2000, S2: 1, S3: 0, S4: 10 });
    expect(ab.integerCols).toEqual({ S1: true, S2: false, S3: true, S4: true });
  });

  it("leaves the fractions as they were", () => {
    expect(ab.matrix.msp_2.S1).toBe(0.75);
    expect(ab.matrix.msp_1.S1).toBe(0.25);
    expect(ab.matrix.msp_1.S2).toBe(0.5);
    expect(ab.matrix["10"].S3).toBe(0);
  });

  it("gives the values back: fraction × colSum, integers exactly once rounded", () => {
    const back = (sp, s) => {
      const v = ab.matrix[sp][s] * ab.colSums[s];
      return ab.integerCols[s] ? Math.round(v) : v;
    };
    expect([back("msp_2", "S1"), back("msp_1", "S1"), back("10", "S1")]).toEqual([1500, 500, 0]);
    expect(back("msp_2", "S2")).toBeCloseTo(0.25, 15);
    expect(back("msp_1", "S2")).toBeCloseTo(0.5, 15);
    expect([back("msp_2", "S3"), back("msp_1", "S3")]).toEqual([0, 0]);
    expect([back("msp_2", "S4"), back("msp_1", "S4"), back("10", "S4")]).toEqual([7, 0, 3]);
  });

  it("gives large counts back exactly", () => {
    const rows = ["species\tA\tB"];
    const counts = [];
    for (let i = 0; i < 300; i++) {
      const a = (i * 7919 + 13) * 104729;
      const b = i % 3 === 0 ? 0 : i * 31;
      counts.push([a, b]);
      rows.push(`sp_${i}\t${a}\t${b}`);
    }
    const big = parseAbundance(rows.join("\n"));
    expect(big.integerCols).toEqual({ A: true, B: true });
    counts.forEach(([a, b], i) => {
      expect(Math.round(big.matrix[`sp_${i}`].A * big.colSums.A)).toBe(a);
      expect(Math.round(big.matrix[`sp_${i}`].B * big.colSums.B)).toBe(b);
    });
  });
});

describe("parseAbundance — rebuilding a bundled table", () => {
  it("gives every value of the demo table back to 12 significant digits", () => {
    const text = readFileSync(
      join(import.meta.dirname, "..", "public", "demo", "species_abundance.tsv"),
      "utf8",
    );
    const ab = parseAbundance(text);
    const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(ab.firstHeader).toBe(lines[0].split("\t")[0]);
    let worst = 0;
    for (const line of lines.slice(1)) {
      const cells = line.split("\t");
      const sp = cells[0];
      ab.samples.forEach((s, j) => {
        const orig = Number(cells[j + 1]);
        const v = ab.matrix[sp][s] * ab.colSums[s];
        if (orig !== 0) worst = Math.max(worst, Math.abs(v - orig) / Math.abs(orig));
        else expect(v).toBe(0);
      });
    }
    expect(worst).toBeLessThan(1e-12);
  });
});
