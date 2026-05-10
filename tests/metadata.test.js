import { describe, it, expect } from "vitest";
import {
  flagSample,
  sampleName,
  areRelated,
  plateDistance,
  parseAbundance,
  abundanceToTSV,
} from "../src/App.jsx";

const METADATA = {
  cols: {
    sample: "sample_id",
    sampleName: "sample_name",
    subject: "subject_id",
    timepoint: "timepoint",
    biome: "biome",
    lowBiomass: "low_biomass",
    lowSequencingDepth: "low_sequencing_depth",
    groupId: "group_id",
  },
  bySample: {
    S1: {
      sampleName: "Donor A · stool",
      subject: "subj1",
      timepoint: "T0",
      biome: "stool",
      isControl: false,
      lowBiomassExplicit: false,
      lowSequencingDepthExplicit: false,
      groupId: "house1",
      extra: { sample_id: "S1", note: "first run" },
    },
    S2: {
      sampleName: "S2",          // identical to id → sampleName() returns null
      subject: "subj1",          // same subject as S1 → related (subject)
      timepoint: "T1",
      biome: "stool",
      isControl: false,
      lowBiomassExplicit: false,
      lowSequencingDepthExplicit: false,
      groupId: "house1",
      extra: { sample_id: "S2" },
    },
    S3: {
      sampleName: "",
      subject: "subj2",
      timepoint: "T0",
      biome: "control blank",    // string contains 'control' or 'blank' → isControl true at parse time
      isControl: true,
      lowBiomassExplicit: true,
      lowSequencingDepthExplicit: null,
      groupId: "house2",         // different group than S1/S2
      extra: { sample_id: "S3" },
    },
  },
};

describe("flagSample", () => {
  it("returns a neutral flag bag for unknown samples", () => {
    expect(flagSample("missing", METADATA)).toMatchObject({
      isControl: false,
      isLowBiomass: false,
      isLowSequencingDepth: false,
      biome: null,
      subject: null,
      timepoint: null,
      groupId: null,
    });
  });

  it("propagates explicit flags + facets from metadata", () => {
    const f = flagSample("S3", METADATA);
    expect(f.isControl).toBe(true);
    expect(f.isLowBiomass).toBe(true);
    expect(f.isLowSequencingDepth).toBe(false); // null in metadata stays false
    expect(f.biome).toBe("control blank");
    expect(f.subject).toBe("subj2");
    expect(f.groupId).toBe("house2");
  });

  it("collects extra columns the user provided into `other`, without leaking standard columns", () => {
    const f = flagSample("S1", METADATA);
    expect(f.other).toEqual({ note: "first run" });
  });
});

describe("sampleName", () => {
  it("returns the human-readable name when distinct from the id", () => {
    expect(sampleName(METADATA, "S1")).toBe("Donor A · stool");
  });

  it("returns null when the sample_name field equals the id", () => {
    expect(sampleName(METADATA, "S2")).toBeNull();
  });

  it("returns null when the metadata is missing", () => {
    expect(sampleName(null, "S1")).toBeNull();
    expect(sampleName(METADATA, "missing")).toBeNull();
  });
});

describe("areRelated", () => {
  it("returns related/subject for samples of the same subject", () => {
    expect(areRelated(METADATA, "S1", "S2")).toEqual({
      related: true,
      kind: "subject",
      value: "subj1",
    });
  });

  it("returns related: false for two samples with different subjects (regardless of group)", () => {
    expect(areRelated(METADATA, "S1", "S3")).toEqual({ related: false });
  });

  it("returns null when either sample is unknown", () => {
    expect(areRelated(METADATA, "S1", "Z")).toBeNull();
    expect(areRelated(null, "S1", "S2")).toBeNull();
  });

  it("falls back to group when subjects are absent", () => {
    const md = {
      bySample: {
        A: { subject: "", groupId: "g1" },
        B: { subject: "", groupId: "g1" },
      },
    };
    expect(areRelated(md, "A", "B")).toEqual({
      related: true,
      kind: "group",
      value: "g1",
    });
  });
});

describe("plateDistance", () => {
  const plateMap = {
    bySample: {
      A: { plate: "P1", row: 0, col: 0 }, // A01
      B: { plate: "P1", row: 0, col: 1 }, // A02 → 1 column over
      C: { plate: "P1", row: 2, col: 5 }, // C06 → far away
      D: { plate: "P2", row: 0, col: 0 }, // different plate
    },
  };

  it("returns null when either sample is missing", () => {
    expect(plateDistance(plateMap, "A", "Z")).toBeNull();
    expect(plateDistance(null, "A", "B")).toBeNull();
  });

  it("flags samePlate=false (distance null) for cross-plate pairs", () => {
    expect(plateDistance(plateMap, "A", "D")).toEqual({
      distance: null,
      samePlate: false,
    });
  });

  it("returns the Chebyshev distance + per-axis deltas on the same plate", () => {
    expect(plateDistance(plateMap, "A", "B")).toMatchObject({
      distance: 1,
      dr: 0,
      dc: 1,
      samePlate: true,
    });
    expect(plateDistance(plateMap, "A", "C")).toMatchObject({
      distance: 5,
      dr: 2,
      dc: 5,
      samePlate: true,
    });
  });
});

describe("abundanceToTSV (parse → emit roundtrip)", () => {
  it("re-emits a TSV that re-parses to the same normalized matrix", () => {
    const tsv = [
      "species\tA\tB",
      "sp_a\t40\t10",
      "sp_b\t60\t40",
      "sp_c\t0\t50",
    ].join("\n");
    const first = parseAbundance(tsv);
    const round = parseAbundance(abundanceToTSV(first));
    expect(round.samples).toEqual(first.samples);
    expect(round.species).toEqual(first.species);
    for (const sp of first.species) {
      for (const s of first.samples) {
        expect(round.matrix[sp][s]).toBeCloseTo(first.matrix[sp][s], 10);
      }
    }
  });

  it("returns an empty string when given a falsy abundance", () => {
    expect(abundanceToTSV(null)).toBe("");
    expect(abundanceToTSV(undefined)).toBe("");
  });
});
