import { describe, it, expect } from "vitest";
import { parseAbundance } from "../src/parsing.js";
import {
  buildScatter,
  canonicalIntegerName,
  matchSpeciesName,
  introducedSpeciesSet,
  cascadeExplanations,
} from "../src/diagnostics.js";

/* A2.8 — species ids that CroCoDeEL rewrote as integers.

   CroCoDeEL reads the abundance table with pandas (ab_table_utils.read:
   `read_csv(..., index_col=0)` then `index.astype(str)`). When every
   species name parses as an integer, pandas makes the index int64, and
   the names CroCoDeEL writes back are the integers' str(): "001" becomes
   "1". The interpreter reads the table as text and matched the events'
   names exactly, so not a single introduced species landed on the line —
   only the ">50 % unresolved" warning hinted at it.

   Golden values — what upstream CroCoDeEL writes for each name, obtained
   by running ab_table_utils.read (pandas 2.2.2) on small tables:

     table index                      → CroCoDeEL's species names
     001, 002, 010, 7                 → 1, 2, 10, 7
     +5, -007, 00, " 12"              → 5, -7, 0, 12
     001, sp_x, 010   (not all ints)  → 001, sp_x, 010   (left as text)
     001, 1                           → 1, 1             (collide)
     1.0, 2.5                         → refused: "floating" species names */
const PANDAS_GOLDEN = [
  ["001", "1"],
  ["002", "2"],
  ["010", "10"],
  ["7", "7"],
  ["+5", "5"],
  ["-007", "-7"],
  ["00", "0"],
  [" 12", "12"],
];

describe("canonicalIntegerName", () => {
  it("reproduces pandas' rewriting of integer-like names", () => {
    for (const [name, written] of PANDAS_GOLDEN) {
      expect([name, canonicalIntegerName(name)]).toEqual([name, written]);
    }
  });

  it("leaves everything else alone", () => {
    for (const name of ["sp_x", "1.0", "2.5", "1e3", "", "msp_0001", "12a"]) {
      expect(canonicalIntegerName(name)).toBeNull();
    }
  });
});

const table = (names, cols = 2) =>
  parseAbundance(
    [
      ["species", ...Array.from({ length: cols }, (_, j) => `S${j}`)].join("\t"),
      ...names.map((n, i) =>
        [n, ...Array.from({ length: cols }, (_, j) => (j + 1) * 10 ** (-i / 8))].join("\t"),
      ),
    ].join("\n"),
  );

describe("matchSpeciesName", () => {
  it("prefers the exact name", () => {
    const ab = table(["1", "001", "sp_a"]);
    expect(matchSpeciesName(ab, "1")).toBe("1");
    expect(matchSpeciesName(ab, "001")).toBe("001");
    expect(matchSpeciesName(ab, "sp_a")).toBe("sp_a");
  });

  it("falls back to the canonical integer form when it is unique", () => {
    const ab = table(["001", "002", "010", "7"]);
    expect(matchSpeciesName(ab, "1")).toBe("001");
    expect(matchSpeciesName(ab, "10")).toBe("010");
    expect(matchSpeciesName(ab, "7")).toBe("7");
    expect(matchSpeciesName(ab, "3")).toBeNull();
  });

  it("never guesses between two table species with the same integer", () => {
    const ab = table(["01", "001", "002"]);
    expect(matchSpeciesName(ab, "1")).toBeNull();
    expect(matchSpeciesName(ab, "2")).toBe("002");
  });

  it("does not touch non-integer names", () => {
    const ab = table(["sp_1", "001"]);
    expect(matchSpeciesName(ab, "sp_01")).toBeNull();
    expect(matchSpeciesName(ab, "sp_1")).toBe("sp_1");
  });
});

describe("introduced species with integer ids land on the line", () => {
  // Table ids "001".."030"; CroCoDeEL lists the first twenty as "1".."20".
  const ids = Array.from({ length: 30 }, (_, i) => String(i + 1).padStart(3, "0"));
  const ab = table(ids);
  const written = Array.from({ length: 20 }, (_, i) => String(i + 1));

  it("in buildScatter", () => {
    const sc = buildScatter(ab, { source: "S0", target: "S1", rate: 0.1, introduced: written });
    expect(sc.points.filter((p) => p.onLine).map((p) => p.species)).toEqual(ids.slice(0, 20));
  });

  it("in introducedSpeciesSet", () => {
    expect([...introducedSpeciesSet(ab, [...written, "999", "sp_x"])]).toEqual(ids.slice(0, 20));
  });

  it("in the cascade explanation", () => {
    // Points far above a rate-0.1 line, all among the upstream's species.
    const scatter = {
      logC: -1,
      points: ids.slice(0, 5).map((sp) => ({ species: sp, x: 1e-4, y: 0.1, onLine: false })),
    };
    const up = { id: 1, source: "C", rate: 0.3, introduced: ["1", "2", "3"] };
    expect(cascadeExplanations(scatter, [up], ab)).toEqual([
      { upstream_source: "C", upstream_event_id: 1, upstream_rate: 0.3, species_explained: 3 },
    ]);
  });
});
