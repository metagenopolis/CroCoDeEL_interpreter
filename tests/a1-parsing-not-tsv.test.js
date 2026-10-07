import { describe, it, expect } from "vitest";
import { parseEvents, parseAbundance, parseMetadata, parsePlateMap } from "../src/parsing.js";

/* A comma-separated file, picked by mistake (the upload buttons accept
   .csv), reads as one column per line. The events parser then failed on a
   "number" that was a whole row, naming the whole header as the column:
   several hundred characters that said nothing about the separator. */

const CSV = [
  'source,target,rate,probability,"contamination_specific_species"',
  '63D250,63D9,7.04e-01,0.97,"msp_0003,msp_0007,msp_0010,msp_0012,msp_0017,msp_0023,msp_0046"',
  '63D29,63D40,1.2e-01,0.88,"msp_0001"',
].join("\n");

const parsers = { parseEvents, parseAbundance, parseMetadata, parsePlateMap };

describe("a file that is not tab-separated", () => {
  for (const [name, parse] of Object.entries(parsers)) {
    it(`${name} says so, in a short message`, () => {
      let message = "";
      try {
        parse(CSV);
      } catch (e) {
        message = e.message;
      }
      expect(message).toMatch(
        /^The file is not tab-separated: its header line is a single column holding commas \("source,target,rate,probability,.*…"\)\. Save it as tab-separated values \(TSV\) and load it again\.$/,
      );
      expect(message.length).toBeLessThan(220);
    });
  }

  it("names semicolons for a European CSV", () => {
    expect(() => parseEvents("source;target;rate\nA;B;0,1")).toThrow(/single column holding semicolons/);
  });

  it("keeps the usual errors for a one-column file without separators", () => {
    expect(() => parseEvents("source\nA")).toThrow(/Could not find source\/target columns/);
    expect(parseAbundance("species\nsp1")).toBeNull();
    expect(() => parseMetadata("sample_id\nS1")).toThrow(/^At least 2 columns required: sample_id and the annotations/);
    expect(() => parsePlateMap("sample_id\nS1")).toThrow(/^Missing columns/);
  });
});

describe("values quoted in messages are cut short", () => {
  it("in the events file's invalid-number error", () => {
    const long = "x".repeat(300);
    let message = "";
    try {
      parseEvents(`source\ttarget\trate\nA\tB\t${long}`);
    } catch (e) {
      message = e.message;
    }
    expect(message).toBe(`Row 1 (line 2), column "rate": "${"x".repeat(59)}…" is not a number.`);
  });

  it("in the abundance warnings", () => {
    const { warnings } = parseAbundance(`species\tS1\tS2\nsp1\t${"y".repeat(200)}\t1\nsp2\t1\t1`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].length).toBeLessThan(160);
    expect(warnings[0]).toContain(`"${"y".repeat(59)}…" for sp1 in S1`);
  });
});
