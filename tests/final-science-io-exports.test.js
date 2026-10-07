import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbundance, parseEvents, parseMetadata } from "../src/parsing.js";
import { sessionFromPayload, sparsifyAbundance } from "../src/persistence.js";
import {
  abundanceToTSV,
  buildCuratedAbundance,
  curatedAbundanceProvenance,
  sampleFlagCells,
  rateCell,
} from "../src/exports.js";
import {
  syncSampleCuration,
  withManualAction,
  neverTargetedSamples,
  buildEffectiveSampleCuration,
} from "../src/curation.js";
import { buildContaminationGraph, graphToCSV, graphToGraphML } from "../src/App.jsx";

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

/* The graph files wrote the never-targeted default, Not contaminated +
   Keep, as sample_verdict / sample_action without saying it is one: a
   sample nobody reviewed read as a curated "correct / keep", while the
   samples TSV marks the same values "default". Each node now carries
   sample_verdict_origin and sample_action_origin (curationOrigin). */
describe("buildContaminationGraph — where a sample's verdict and action come from", () => {
  const events = [
    { id: 0, source: "S", target: "T", rate: 0.1, score: 0.9, verdict: "true_positive" },
    { id: 1, source: "S", target: "U", rate: 0.1, score: 0.9, verdict: "pending" },
  ];
  let stored = syncSampleCuration({}, events);
  stored = withManualAction(stored, "T", "keep", events);
  const never = new Set(neverTargetedSamples(events, ["S", "T", "U"]));
  const effective = buildEffectiveSampleCuration(stored, never);

  it("says manual, automatic or default, as the samples TSV does", () => {
    const g = buildContaminationGraph(events, { sampleCuration: effective, neverTargeted: never });
    const node = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect([node.S.sample_verdict, node.S.sample_verdict_origin]).toEqual(["correct", "default"]);
    expect([node.S.sample_action, node.S.sample_action_origin]).toEqual(["keep", "default"]);
    expect([node.T.sample_verdict, node.T.sample_verdict_origin]).toEqual(["contaminated", "automatic"]);
    expect([node.T.sample_action, node.T.sample_action_origin]).toEqual(["keep", "manual"]);
    expect([node.U.sample_verdict, node.U.sample_verdict_origin]).toEqual(["pending", ""]);
    const csv = graphToCSV(g).nodes.split("\n");
    expect(csv[0].split(",").slice(0, 6)).toEqual([
      "id", "label", "sample_verdict", "sample_verdict_origin", "sample_action", "sample_action_origin",
    ]);
    expect(graphToGraphML(g)).toContain('attr.name="sample_action_origin"');
  });

  it("tells the rule's value from a default when the exported events are a subset", () => {
    // Only the S → U event exported: T is no node; U is targeted.
    const g = buildContaminationGraph([events[1]], { sampleCuration: effective, neverTargeted: never });
    const s = g.nodes.find((n) => n.id === "S");
    expect(s.sample_verdict_origin).toBe("default");
    // A sample targeted only by an event left out is still no default.
    const ev = [{ id: 2, source: "T", target: "U", rate: 0.1, score: 0.9, verdict: "pending" }];
    const t = buildContaminationGraph(ev, { sampleCuration: effective, neverTargeted: never }).nodes.find((n) => n.id === "T");
    expect([t.sample_verdict, t.sample_verdict_origin]).toEqual(["contaminated", "automatic"]);
  });
});

/* The curated abundance export rebuilt a dense copy of the whole matrix
   and formatted every cell through the general path: 0.46 s on the
   Meteor benchmark against 0.24 s for main. It now writes the kept
   samples and species straight from the input's rows, zeros and counts
   by their short paths: the same bytes. */
describe("abundanceToTSV from the input's own rows", () => {
  const ab = parseAbundance(readFileSync(join(import.meta.dirname, "..", "public", "demo", "species_abundance.tsv"), "utf8"));
  const sup = Object.fromEntries(ab.samples.filter((_, i) => i % 4 === 0).map((s) => [s, { action: "suppress" }]));

  it("writes the curated table the dense copy wrote, from a dense or a sparse matrix", () => {
    const dense = abundanceToTSV(buildCuratedAbundance(ab, sup));
    const cur = buildCuratedAbundance(ab, sup, { matrix: false });
    expect(cur.matrix).toBeNull();
    expect(abundanceToTSV({ ...cur, matrix: ab.matrix })).toBe(dense);
    const sparse = sparsifyAbundance(ab);
    expect(abundanceToTSV({ ...buildCuratedAbundance(sparse, sup, { matrix: false }), matrix: sparse.matrix })).toBe(dense);
  });

  it("writes counts, zeros and long values as before", () => {
    const t = parseAbundance(
      ["id\tC\tF\tB", "a\t1500\t0.0000010630384344999\t123456789012345678", "b\t0\t0.3\t0", "c\t7\t\t1"].join("\n"),
    );
    expect(abundanceToTSV(t)).toBe(
      ["id\tC\tF\tB", "a\t1500\t1.0630384344999e-6\t1.2345678901234568e+17", "b\t0\t0.3\t0", "c\t7\t0\t1"].join("\n"),
    );
    // A session saved before the column sums: fractions, by the same paths.
    const { colSums: _drop, ...old } = t;
    expect(abundanceToTSV(old).split("\n")[2]).toBe(`b\t0\t${String(t.matrix.b.F)}\t0`);
    expect(abundanceToTSV(old).split("\n")[1]).toBe(`a\t${String(t.matrix.a.C)}\t${t.matrix.a.F.toExponential()}\t${String(t.matrix.a.B)}`);
  });
});

/* Could a rate or a probability that is not a number reach the events
   TSVs, which write it as an empty cell that CroCoDeEL's float() refuses?
   Not through any path: parseEvents refuses a cell that is not a number,
   the session import refuses an event whose rate or probability is not a
   finite number (1e999 in a JSON file reads as Infinity), main's stored
   sessions read such a cell as 0 (parseFloat(...) || 0), and a manual
   event takes its rate from a slider. */
describe("a rate that is not a number", () => {
  const event = (extra) => ({
    events: [{ id: 0, source: "S1", target: "S2", contamination_rate: 0.1, probability: 0.9, ...extra }],
  });

  it("is refused by the session import", () => {
    for (const extra of [{ contamination_rate: "x" }, { probability: "0,5" }, { contamination_rate: {} }]) {
      const r = sessionFromPayload(event(extra));
      expect(r.ok, JSON.stringify(extra)).toBe(false);
      expect(r.errors[0]).toMatch(/is not a number/);
    }
    const inf = sessionFromPayload(JSON.parse('{"events":[{"id":0,"source":"S1","target":"S2","contamination_rate":1e999,"probability":0.9}]}'));
    expect(inf.ok).toBe(false);
    expect(inf.errors[0]).toMatch(/contamination_rate is not a number/);
  });

  it("is refused by the events parser", () => {
    expect(() => parseEvents("source\ttarget\trate\tprobability\nS1\tS2\tx\t0.9")).toThrow(/"x" is not a number/);
    expect(() => parseEvents("source\ttarget\trate\tprobability\nS1\tS2\t1e999\t0.9")).toThrow(/is not a number/);
  });
});
