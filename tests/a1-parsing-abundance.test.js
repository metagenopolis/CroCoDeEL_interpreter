import { describe, it, expect } from "vitest";
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
