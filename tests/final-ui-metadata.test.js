import { describe, it, expect } from "vitest";
import { parseMetadata, metadataToTSV } from "../src/parsing.js";
import { areRelated, flagSample } from "../src/App.jsx";

/* metadata.tsv: only sample_id is required — the Help ("Mandatory column:
   sample_id"), the metadata card ("Mandatory: sample_id. Recognized
   columns: subject_id, …") and the README say so. A file without a
   subject column was refused whole ("subject_id column not found"), its
   biome, control and low-biomass flags with it: an NCBI BioSample export,
   whose `host` holds the host organism, not a subject, no longer loaded at
   all once headers were matched exactly. It now loads, relatedness
   unknown, and a warning names the subject headers it looked for. */

const tsv = (rows) => rows.map((r) => r.join("\t")).join("\n");

describe("metadata without a subject column", () => {
  const biosample = tsv([
    ["sample_id", "host", "biome", "low_biomass"],
    ["S1", "Homo sapiens", "gut", "no"],
    ["S2", "Homo sapiens", "gut", "yes"],
    ["NC1", "", "negative control", "yes"],
  ]);

  it("loads, with its flags, and says no subject was read", () => {
    const m = parseMetadata(biosample);
    expect(m.nSamples).toBe(3);
    expect(m.cols).toMatchObject({ sample: "sample_id", subject: null, biome: "biome", lowBiomass: "low_biomass" });
    expect(flagSample("NC1", m)).toMatchObject({ isControl: true, isLowBiomass: true });
    expect(flagSample("S2", m)).toMatchObject({ isControl: false, isLowBiomass: true });
    expect(m.warnings).toHaveLength(1);
    expect(m.warnings[0]).toMatch(
      /^subject_id column not found: expected subject_id, subject, host_subject_id, .* this file has: sample_id, host, biome, low_biomass\. No two samples count as the same subject\.$/,
    );
  });

  it("never takes the host organism for a subject: relatedness is unknown", () => {
    const m = parseMetadata(biosample);
    expect(areRelated(m, "S1", "S2")).toBeNull();
    expect(flagSample("S1", m).other).toMatchObject({ host: "Homo sapiens" });
  });

  it("is written back and read again the same way", () => {
    const back = parseMetadata(metadataToTSV(parseMetadata(biosample)));
    expect(back.nSamples).toBe(3);
    expect(areRelated(back, "S1", "S2")).toBeNull();
    expect(flagSample("NC1", back)).toMatchObject({ isControl: true, isLowBiomass: true });
  });

  it("still refuses a file without a sample id column, or with nothing but one", () => {
    expect(() => parseMetadata(tsv([["host", "biome"], ["Homo sapiens", "gut"]]))).toThrow(
      /^sample_id column not found/,
    );
    expect(() => parseMetadata("sample_id\nS1")).toThrow(/^At least 2 columns required/);
  });
});
