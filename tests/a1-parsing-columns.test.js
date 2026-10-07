import { describe, it, expect } from "vitest";
import {
  parseMetadata,
  parsePlateMap,
  parseEvents,
  metadataColumnsLine,
  plateColumnsLine,
} from "../src/parsing.js";
import { areRelated, flagSample } from "../src/App.jsx";

/* A1.2 — metadata and plate-map headers are matched exactly, up to case and
   separators. Substring matching invented relatedness: age_group became the
   group_id, host_age the subject, birthday the timepoint, and two different
   subjects of the same age band then counted as related. */

const tsv = (rows) => rows.map((r) => r.join("\t")).join("\n");

describe("parseMetadata — exact header matching", () => {
  const md = parseMetadata(
    tsv([
      ["Sample ID", "Subject-ID", "host_age", "birthday", "family_history", "age_group", "treatment_group"],
      ["S1", "p1", "34", "1990-01-01", "yes", "adult", "A"],
      ["S2", "p2", "35", "1989-05-02", "yes", "adult", "A"],
      ["S3", "p1", "34", "1990-01-01", "yes", "adult", "A"],
    ]),
  );

  it("reads no group, timepoint or subject out of a header that merely contains an alias", () => {
    expect(md.cols).toMatchObject({
      sample: "Sample ID",
      subject: "Subject-ID",
      timepoint: null,
      groupId: null,
    });
    expect(md.hasGroupIdCol).toBe(false);
  });

  it("does not make two different subjects of the same age band related", () => {
    expect(areRelated(md, "S1", "S2")).toEqual({ related: false });
    // The same subject still is.
    expect(areRelated(md, "S1", "S3")).toMatchObject({ related: true, kind: "subject" });
  });

  it("keeps the unrecognised columns as context", () => {
    expect(flagSample("S1", md).other).toMatchObject({
      age_group: "adult",
      host_age: "34",
      birthday: "1990-01-01",
    });
  });

  it("matches a header whatever its case and separators", () => {
    for (const h of ["subject_id", "Subject ID", "subject-id", "SubjectID", "subject.id", "SUBJECT_ID"]) {
      const m = parseMetadata(tsv([["sample_id", h], ["S1", "p1"]]));
      expect(m.cols.subject, h).toBe(h);
    }
    const m = parseMetadata(
      tsv([["sample-id", "subject_id", "Time Point", "Body Site", "Low Biomass", "Group ID"], ["S1", "p1", "D0", "gut", "yes", "g1"]]),
    );
    expect(m.cols).toMatchObject({
      sample: "sample-id",
      timepoint: "Time Point",
      biome: "Body Site",
      lowBiomass: "Low Biomass",
      groupId: "Group ID",
    });
    expect(m.bySample.S1).toMatchObject({ timepoint: "D0", biome: "gut", lowBiomassExplicit: true, groupId: "g1" });
  });

  it("takes the MIxS host_subject_id as the subject, never the host organism", () => {
    const both = parseMetadata(
      tsv([["sample_id", "host", "host_subject_id"], ["S1", "Homo sapiens", "p1"], ["S2", "Homo sapiens", "p2"]]),
    );
    expect(both.cols.subject).toBe("host_subject_id");
    expect(areRelated(both, "S1", "S2")).toEqual({ related: false });
    // `host` alone is the organism, not a subject id.
    expect(() =>
      parseMetadata(tsv([["sample_id", "host"], ["S1", "Homo sapiens"]])),
    ).toThrow(/subject_id column not found/);
  });

  it("does not take an experimental `group` column for a relatedness group", () => {
    const m = parseMetadata(
      tsv([["sample_id", "subject_id", "group"], ["S1", "p1", "CRC"], ["S2", "p2", "CRC"]]),
    );
    expect(m.cols.groupId).toBeNull();
    expect(areRelated(m, "S1", "S2")).toEqual({ related: false });
  });

  it("still reads every documented alias", () => {
    const m = parseMetadata(
      tsv([["sample", "patient", "visit", "tissue", "is_low_biomass", "low_depth", "household", "display_name"], ["S1", "p1", "V1", "gut", "1", "0", "h1", "Sample one"]]),
    );
    expect(m.cols).toEqual({
      sample: "sample",
      sampleName: "display_name",
      subject: "patient",
      timepoint: "visit",
      biome: "tissue",
      lowBiomass: "is_low_biomass",
      lowSequencingDepth: "low_depth",
      groupId: "household",
    });
  });
});

describe("parseMetadata — subject headers and the refusal message", () => {
  it("reads the usual subject id headers, which the substring pass used to catch", () => {
    for (const h of ["individual_id", "IndividualID", "participant_id", "Participant ID", "participant", "host_id"]) {
      const m = parseMetadata(tsv([["sample_id", h], ["S1", "i1"], ["S2", "i1"], ["S3", "i2"]]));
      expect(m.cols.subject, h).toBe(h);
      expect(areRelated(m, "S1", "S2"), h).toMatchObject({ related: true, kind: "subject" });
      expect(areRelated(m, "S1", "S3"), h).toEqual({ related: false });
    }
  });

  it("names the accepted headers and the file's own when the subject is missing", () => {
    const err = () => parseMetadata(tsv([["sample_id", "patient_number", "host"], ["S1", "1", "Homo sapiens"]]));
    expect(err).toThrow(
      "subject_id column not found: expected subject_id, subject, host_subject_id, patient_id, " +
        "patient, individual_id, individual, participant_id, participant or host_id. Headers are " +
        "matched exactly, ignoring case, spaces, _ - and . — this file has: sample_id, " +
        "patient_number, host.",
    );
  });

  it("does the same for the sample id, and keeps a long header list short", () => {
    const header = ["SampleName", "subject_id", ...Array.from({ length: 14 }, (_, i) => `extra_column_${i}`)];
    let message = "";
    try {
      parseMetadata(tsv([header, header.map(() => "x")]));
    } catch (e) {
      message = e.message;
    }
    expect(message).toMatch(/^sample_id column not found: expected sample_id, sample or id\. /);
    expect(message).toMatch(/this file has: SampleName, subject_id, extra_column_0, .*, extra_column_9, … \(16 in all\)\.$/);
  });
});

describe("parsePlateMap — exact header matching and the resolved mapping", () => {
  it("returns the columns it read, matched up to case and separators", () => {
    const pm = parsePlateMap(
      tsv([["Sample ID", "Plate Name", "Well Position"], ["S1", "P1", "A01"]]),
    );
    expect(pm.cols).toMatchObject({
      sample: "Sample ID",
      plate: "Plate Name",
      well: "Well Position",
    });
    expect(pm.bySample.S1).toEqual({ plate: "P1", row: 0, col: 0 });
  });

  it("names the accepted headers and the file's own when the well is missing", () => {
    expect(() => parsePlateMap(tsv([["sample_id", "plate", "position_on_plate"], ["S1", "P1", "A01"]]))).toThrow(
      "Missing columns: sample_id and either well or row + column are required (plate optional). " +
        "Accepted names: sample_id, sample, id; well, well_position, position, well_id, pos; row, " +
        "well_row; column, col, well_column, well_col; plate, plate_id, plate_name, plate_number, " +
        "plate_no, plate_barcode. Headers are " +
        "matched exactly, ignoring case, spaces, _ - and . — this file has: sample_id, plate, " +
        "position_on_plate.",
    );
  });

  it("does not read a header that merely contains `well` or `plate`", () => {
    const pm = parsePlateMap(
      tsv([["sample_id", "plate_notes", "well_volume_ul", "well"], ["S1", "x", "50", "B02"]]),
    );
    expect(pm.cols).toMatchObject({ sample: "sample_id", plate: null, well: "well" });
    expect(pm.bySample.S1).toEqual({ plate: "P1", row: 1, col: 1 });
  });
});

describe("parseEvents keeps its substring fallback", () => {
  it("still finds hand-written events headers", () => {
    const { events } = parseEvents(
      tsv([["Source sample", "Contaminated sample", "Estimated rate", "Probability"], ["A", "B", "0.1", "0.9"]]),
    );
    expect(events[0]).toMatchObject({ source: "A", target: "B", rate: 0.1, score: 0.9 });
  });
});

describe("the one-line column mapping shown on the upload cards", () => {
  it("names each recognised field with the header it was read from, then the context columns", () => {
    // "SampleID" is sample_id up to case and separators: no arrow for it.
    const md = parseMetadata(
      tsv([["SampleID", "patient", "timepoint", "age_group", "host_age"], ["S1", "p1", "D0", "adult", "34"]]),
    );
    expect(metadataColumnsLine(md)).toBe(
      "sample_id · subject_id ← patient · timepoint · other: age_group, host_age",
    );
  });

  it("describes a plate map, and nothing for an old session without the mapping", () => {
    const pm = parsePlateMap(tsv([["sample_id", "Plate", "Well"], ["S1", "P1", "A01"]]));
    expect(plateColumnsLine(pm)).toBe("sample_id · plate · well");
    expect(plateColumnsLine({ bySample: {}, format: { rows: 8, cols: 12 } })).toBeNull();
    expect(metadataColumnsLine(null)).toBeNull();
  });
});
