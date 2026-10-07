import { describe, it, expect } from "vitest";
import {
  tsvCell,
  parseTSV,
  parseAbundance,
  parseEvents,
  parseMetadata,
  parsePlateMap,
  metadataToTSV,
  plateMapToTSV,
} from "../src/parsing.js";
import {
  abundanceToTSV,
  buildCuratedAbundance,
  eventsToTSV,
  curatedEventsToTSV,
} from "../src/exports.js";

/* A "#" in an id. The abundance table is read with comment="#" — by
   CroCoDeEL (pandas.read_csv(…, comment="#")) and by parseAbundance —
   which ends a line at a "#" outside a quoted cell; every file of this
   interface takes a line that starts with "#" for a comment. R's
   write.table quotes its ids, so a table with a sample "Plate#1_A01" and
   a species "sp#1" loaded as written; the writers left the ids bare, so
   the card's Download, the curated export and the in-browser run's input
   read back as samples ['Plate'] and species ['sp', …] with a "#"
   warning, and ab_table_utils.read refused them ("Expected 2 fields in
   line 3, saw 4"). A cell holding a "#" is now quoted, as one holding a
   double quote was: ab_table_utils.read, pandas' default reader, R's
   read.delim and read.table(comment.char = "#"), CroCoDeEL's events
   reader and pandas with comment="#" on the events all read such a file
   back as written (checked on the same texts with crocodeel, pandas 2.2
   and R). */

const R_QUOTED = 'species\t"Plate#1_A01"\tS2\tS3\n"sp#1"\t1\t2\t3\nsp2\t3\t4\t5\nsp3\t5\t6\t7\n';

describe("tsvCell", () => {
  it("quotes a cell that holds a #", () => {
    expect(tsvCell("Plate#1_A01")).toBe('"Plate#1_A01"');
    expect(tsvCell("#S1")).toBe('"#S1"');
    expect(tsvCell('well "3" #2')).toBe('"well ""3"" #2"');
    expect(tsvCell("plain")).toBe("plain");
  });
});

describe("an abundance table with a # in its ids", () => {
  const ab = parseAbundance(R_QUOTED);

  it("is read as R wrote it", () => {
    expect(ab.samples).toEqual(["Plate#1_A01", "S2", "S3"]);
    expect(ab.species).toEqual(["sp#1", "sp2", "sp3"]);
    expect(ab.warnings).toEqual([]);
  });

  it("is written with those ids quoted, by the card's Download and the curated export", () => {
    const expected = 'species\t"Plate#1_A01"\tS2\tS3\n"sp#1"\t1\t2\t3\nsp2\t3\t4\t5\nsp3\t5\t6\t7';
    expect(abundanceToTSV(ab)).toBe(expected);
    const cur = buildCuratedAbundance(ab, {}, { matrix: false });
    expect(abundanceToTSV({ ...cur, matrix: ab.matrix })).toBe(expected);
    // Nothing for comment="#" to cut.
    expect(parseTSV(expected, { inlineComments: true }).inlineComments).toBe(0);
  });

  it("reads back as it was", () => {
    // What the parser read back before: samples ['Plate'], species
    // ['sp', 'sp2', 'sp3'], and a warning that 2 lines hold a "#".
    const curated = buildCuratedAbundance(ab, { S3: { action: "suppress" } });
    for (const [text, samples] of [
      [abundanceToTSV(ab), ["Plate#1_A01", "S2", "S3"]],
      [abundanceToTSV(curated), ["Plate#1_A01", "S2"]],
    ]) {
      const back = parseAbundance(text);
      expect(back.samples).toEqual(samples);
      expect(back.species).toEqual(ab.species);
      for (const s of samples) expect(back.colSums[s]).toBe(ab.colSums[s]);
      expect(back.warnings).toEqual([]);
    }
  });

  it("keeps a header line that would start with # a header", () => {
    // R's layout, the first sample "#S1": the written header starts with it.
    const r = parseAbundance('"#S1"\t"S2"\n"sp1"\t1\t2\n"sp2"\t3\t4\n');
    expect(r.samples).toEqual(["#S1", "S2"]);
    expect(r.implicitIndex).toBe(true);
    expect(abundanceToTSV(r)).toBe('"#S1"\tS2\nsp1\t1\t2\nsp2\t3\t4');
    expect(parseAbundance(abundanceToTSV(r)).samples).toEqual(["#S1", "S2"]);
    // A first header cell "#OTU ID" (biom), quoted in the input.
    const biom = parseAbundance('"#OTU ID"\tS1\tS2\nsp1\t1\t2\n"#sp2"\t3\t4\n');
    expect(biom.firstHeader).toBe("#OTU ID");
    expect(biom.species).toEqual(["sp1", "#sp2"]);
    const back = parseAbundance(abundanceToTSV(biom));
    expect([back.firstHeader, back.samples, back.species]).toEqual(["#OTU ID", ["S1", "S2"], ["sp1", "#sp2"]]);
  });
});

describe("the other files with a # in a cell", () => {
  it("give an events row whose source starts with # back, from both events writers", () => {
    const { events } = parseEvents(
      'source\ttarget\trate\tprobability\tcontamination_specific_species\n"#S1"\tS2\t0.1\t0.9\tsp#1,sp2\nS3\tS2\t0.2\t0.8\tsp2\n',
    );
    expect(events.map((e) => e.source)).toEqual(["#S1", "S3"]);
    const noted = events.map((e, i) => ({ ...e, verdict: "true_positive", notes: i === 0 ? "well #3" : "" }));
    // Read back before: the "#S1" row was a comment line, gone.
    for (const text of [eventsToTSV(events, null), curatedEventsToTSV(noted, { study: "Plate #3" })]) {
      const back = parseEvents(text);
      expect(back.events.map((e) => [e.source, e.target, e.introduced])).toEqual([
        ["#S1", "S2", ["sp#1", "sp2"]],
        ["S3", "S2", ["sp2"]],
      ]);
    }
    const back = parseEvents(curatedEventsToTSV(noted, { study: "Plate #3" }));
    expect(back.events[0].notes).toBe("well #3");
    expect(back.runMetadata.study).toBe("Plate #3");
  });

  it("give a metadata or plate map row whose sample starts with # back", () => {
    const md = parseMetadata('sample_id\tsubject_id\tnote\n"#S1"\tp1\twell #3\nS2\tp2\tx\n');
    expect(Object.keys(md.bySample)).toEqual(["#S1", "S2"]);
    const mdBack = parseMetadata(metadataToTSV(md));
    expect(Object.keys(mdBack.bySample)).toEqual(["#S1", "S2"]);
    expect(mdBack.bySample["#S1"].extra.note).toBe("well #3");

    const pm = parsePlateMap('sample_id\tplate\twell\n"#S1"\tP#1\tA01\nS2\tP#1\tA02\n');
    const written = plateMapToTSV(pm);
    expect(written).toBe('sample_id\tplate\twell\n"#S1"\t"P#1"\tA01\nS2\t"P#1"\tA02');
    expect(parsePlateMap(written).bySample).toEqual(pm.bySample);
  });
});
