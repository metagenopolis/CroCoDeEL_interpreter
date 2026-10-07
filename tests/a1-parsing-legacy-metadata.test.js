import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMetadata, metadataToTSV, remapMetadata, metadataColumnsLine } from "../src/parsing.js";
import { areRelated, flagSample } from "../src/App.jsx";

/* Metadata stored by a session saved before headers were matched exactly.
   A session keeps the PARSED metadata, so the substring mapping of that
   time (age_group read as the group_id, host as the subject) came back on
   every reload, and the metadata download wrote it out under the canonical
   names: the age bands became a group_id column, and the false relatedness
   survived even a re-upload of the downloaded file. */

const tsv = (rows) => rows.map((r) => r.join("\t")).join("\n");

/** The object the previous parser stored for `rows`, given the columns its
    substring pass picked (checked against that parser's output). */
function storedByEarlierVersion(rows, picked) {
  const cols = {
    sample: null,
    sampleName: null,
    subject: null,
    timepoint: null,
    biome: null,
    lowBiomass: null,
    lowSequencingDepth: null,
    groupId: null,
    ...picked,
  };
  const [head, ...body] = rows;
  const bySample = {};
  for (const cells of body) {
    const r = Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]));
    const read = (k) => (cols[k] ? r[cols[k]] || "" : "");
    bySample[r[cols.sample]] = {
      sampleName: read("sampleName"),
      subject: read("subject"),
      timepoint: read("timepoint"),
      biome: read("biome"),
      isControl: /control|blank|negative/i.test(read("biome")),
      lowBiomassExplicit: null,
      lowSequencingDepthExplicit: null,
      groupId: read("groupId"),
      extra: r,
    };
  }
  return {
    cols,
    bySample,
    nSamples: Object.keys(bySample).length,
    hasSampleNameCol: !!cols.sampleName,
    hasBiomeCol: !!cols.biome,
    hasLowBiomassCol: false,
    hasLowSequencingDepthCol: false,
    hasGroupIdCol: !!cols.groupId,
  };
}

// Two different patients in the same age band, and one patient twice.
const AGED = [
  ["SampleID", "patient", "visit", "age_group"],
  ["S1", "P1", "V1", "20-30"],
  ["S2", "P2", "V1", "20-30"],
  ["S3", "P1", "V2", "40-50"],
];
// "group" is a substring of age_group.
const agedLegacy = () =>
  storedByEarlierVersion(AGED, { sample: "SampleID", subject: "patient", timepoint: "visit", groupId: "age_group" });

describe("metadataToTSV on metadata saved by an earlier version", () => {
  it("writes the age bands under their own name, not as group_id", () => {
    const header = metadataToTSV(agedLegacy()).split("\n")[0].split("\t");
    expect(header).toEqual(["sample_id", "subject_id", "timepoint", "age_group"]);
  });

  it("reloads to what the original file gives today: two patients of one age band are not related", () => {
    const back = parseMetadata(metadataToTSV(agedLegacy()));
    const fresh = parseMetadata(tsv(AGED));
    expect(areRelated(back, "S1", "S2")).toEqual({ related: false });
    expect(back.cols.groupId).toBeNull();
    for (const [a, b] of [["S1", "S2"], ["S1", "S3"], ["S2", "S3"]]) {
      expect(areRelated(back, a, b)).toEqual(areRelated(fresh, a, b));
    }
  });

  it("does not write a group_id either when the session kept no mapping at all", () => {
    const { cols: _drop, ...noCols } = agedLegacy();
    const text = metadataToTSV(noCols);
    expect(text.split("\n")[0]).toBe("sample_id\tsubject_id\ttimepoint\tage_group");
    expect(areRelated(parseMetadata(text), "S1", "S2")).toEqual({ related: false });
  });
});

describe("remapMetadata", () => {
  it("reads a stored session again with the current rules", () => {
    const legacy = agedLegacy();
    expect(areRelated(legacy, "S1", "S2")).toMatchObject({ related: true, kind: "group" });
    const md = remapMetadata(legacy);
    expect(md.cols).toEqual(parseMetadata(tsv(AGED)).cols);
    expect(md.hasGroupIdCol).toBe(false);
    expect(md.bySample.S1).toMatchObject({ subject: "P1", timepoint: "V1", groupId: "" });
    expect(areRelated(md, "S1", "S2")).toEqual({ related: false });
    expect(areRelated(md, "S1", "S3")).toMatchObject({ related: true, kind: "subject" });
    // age_group is context again, and the card says what changed.
    expect(flagSample("S1", md).other).toEqual({ age_group: "20-30" });
    expect(metadataColumnsLine(md)).toBe(
      "sample_id · subject_id ← patient · timepoint ← visit · other: age_group",
    );
    expect(md.warnings).toEqual([
      "Saved by an earlier version, which matched headers more loosely; read again with the " +
        "current rules: group_id is no longer read from age_group.",
    ]);
    // The stored object is left alone.
    expect(legacy.bySample.S1.groupId).toBe("20-30");
  });

  it("stops reading the host organism as the subject, and says how to fix the file", () => {
    // `host` was an exact alias of the subject: "Homo sapiens" made every
    // pair of samples the same subject.
    const legacy = storedByEarlierVersion(
      [["sample_id", "host", "biome"], ["S1", "Homo sapiens", "gut"], ["S2", "Homo sapiens", "gut"]],
      { sample: "sample_id", subject: "host", biome: "biome" },
    );
    expect(areRelated(legacy, "S1", "S2")).toMatchObject({ related: true, kind: "subject" });
    const md = remapMetadata(legacy);
    expect(md.cols.subject).toBeNull();
    expect(md.bySample.S1.subject).toBe("");
    expect(areRelated(md, "S1", "S2")).toBeNull();
    expect(md.warnings[0]).toMatch(/subject_id is no longer read from host\./);
    expect(md.warnings[0]).toMatch(/name the subject column subject_id and upload the file again/);
    // The download still has the subject_id column parseMetadata requires.
    const back = parseMetadata(metadataToTSV(legacy));
    expect(areRelated(back, "S1", "S2")).toBeNull();
  });

  it("re-derives the entries of a session saved without the mapping", () => {
    const { cols: _drop, ...noCols } = agedLegacy();
    const md = remapMetadata(noCols);
    expect(md.cols.groupId).toBeNull();
    expect(md.bySample.S2.groupId).toBe("");
    expect(md.warnings).toHaveLength(1);
  });

  it("returns the very object this version parsed, with no warning added", () => {
    const root = join(import.meta.dirname, "..", "public");
    const files = ["demo/metadata.tsv", "datasets/PRJEB33500/metadata.tsv", "datasets/PRJEB6337/metadata.tsv"];
    for (const p of files) {
      const md = parseMetadata(readFileSync(join(root, p), "utf8"));
      expect(remapMetadata(md), p).toBe(md);
    }
    const aged = parseMetadata(tsv(AGED));
    expect(remapMetadata(aged)).toBe(aged);
    // A stored session, cloned as IndexedDB does, is unchanged too.
    const cloned = structuredClone(aged);
    expect(remapMetadata(cloned)).toBe(cloned);
  });

  it("is idempotent", () => {
    const once = remapMetadata(agedLegacy());
    expect(remapMetadata(once)).toBe(once);
  });

  it("leaves what it cannot read again as it is, without throwing", () => {
    expect(remapMetadata(null)).toBeNull();
    expect(remapMetadata(undefined)).toBeUndefined();
    const odd = [{ bySample: "x" }, { bySample: { S1: null } }, { bySample: { S1: { subject: "p" } } }, {}];
    for (const m of odd) expect(remapMetadata(m)).toBe(m);
    // A hand-edited session mixing a broken entry with a readable one.
    const mixed = {
      cols: "nonsense",
      warnings: "not a list",
      bySample: { S1: null, S2: { extra: { sample_id: "S2", subject_id: "p2", group: "CRC" } } },
    };
    const md = remapMetadata(mixed);
    expect(md.bySample.S1).toBeNull();
    expect(md.bySample.S2).toMatchObject({ subject: "p2", groupId: "" });
    expect(Array.isArray(md.warnings)).toBe(true);
    expect(() => metadataToTSV(mixed)).not.toThrow();
  });
});
