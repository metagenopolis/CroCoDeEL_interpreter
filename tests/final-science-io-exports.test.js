import { describe, it, expect } from "vitest";
import { parseAbundance } from "../src/parsing.js";
import { buildCuratedAbundance, curatedAbundanceProvenance } from "../src/exports.js";

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
