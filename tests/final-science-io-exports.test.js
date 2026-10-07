import { describe, it, expect } from "vitest";
import { parseAbundance, parseMetadata } from "../src/parsing.js";
import {
  buildCuratedAbundance,
  curatedAbundanceProvenance,
  sampleFlagCells,
  rateCell,
} from "../src/exports.js";

/* The provenance file next to the curated abundance table is plain text:
   its study and its sample and species lists used to go through tsvCell,
   so a study '"Lou" 2023' was written 'Study: """Lou"" 2023"' and a
   suppressed sample '"Q3' as '"""Q3"'. Only tabs and line breaks are
   flattened now. */
describe("curatedAbundanceProvenance", () => {
  const ab = parseAbundance('species\t"""Q3"\tS2\tS3\n"sp ""x"""\t5\t0\t0\nsp2\t1\t2\t3');

  it("writes the study and the names as they are", () => {
    expect(ab.samples).toEqual(['"Q3', "S2", "S3"]);
    const cur = buildCuratedAbundance(ab, { '"Q3': { action: "suppress" } });
    expect(cur.droppedSpecies).toEqual(['sp "x"']);
    const text = curatedAbundanceProvenance(ab, cur, { study: '"Lou" 2023\twith\na tab' });
    const lines = text.split("\n");
    expect(lines).toContain('Study: "Lou" 2023 with a tab');
    expect(lines).toContain('"Q3');
    expect(lines).toContain('sp "x"');
    expect(text).not.toContain('"""');
  });
});

/* The samples TSV wrote is_control, is_low_biomass and
   is_low_sequencing_depth "false" whenever the metadata did not say —
   with no metadata loaded, every sample was "not a control, not low
   biomass" — and max_target_rate with toFixed(6), so a rate below 5e-7
   read 0.000000 and the others lost their digits. */
describe("samples TSV cells", () => {
  const md = parseMetadata(
    [
      "sample_id\tsubject_id\tbiome\tlow_biomass",
      "NC\tx\tnegative control\tyes",
      "A\tp1\tgut\tno",
      "B\tp2\t\t",
    ].join("\n"),
  );

  it("are empty where the metadata does not say", () => {
    expect(sampleFlagCells(null, null)).toEqual(["", "", ""]);
    expect(sampleFlagCells(undefined, md)).toEqual(["", "", ""]);
    // No low_sequencing_depth column; B's biome and low_biomass are empty.
    expect(sampleFlagCells(md.bySample.NC, md)).toEqual(["true", "true", ""]);
    expect(sampleFlagCells(md.bySample.A, md)).toEqual(["false", "false", ""]);
    expect(sampleFlagCells(md.bySample.B, md)).toEqual(["", "", ""]);
    // No biome column at all: nobody is known not to be a control.
    const noBiome = parseMetadata("sample_id\tsubject_id\nA\tp1");
    expect(sampleFlagCells(noBiome.bySample.A, noBiome)).toEqual(["", "", ""]);
  });

  it("write the rate with every digit, as the events TSV does", () => {
    expect(rateCell(0.0167)).toBe("0.0167");
    expect(rateCell(3.2e-7)).toBe("3.2e-07");
    expect(rateCell(0.123456789)).toBe("0.123456789");
    expect(rateCell(1)).toBe("1.0");
    expect(rateCell(null)).toBe("");
    expect(rateCell(undefined)).toBe("");
  });
});
