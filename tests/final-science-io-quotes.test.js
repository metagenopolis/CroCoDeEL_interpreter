import { describe, it, expect } from "vitest";
import {
  tsvCell,
  parseAbundance,
  parseEvents,
  parseMetadata,
  parsePlateMap,
  metadataToTSV,
  plateMapToTSV,
} from "../src/parsing.js";
import { abundanceToTSV, buildCuratedAbundance, curatedEventsToTSV } from "../src/exports.js";

/* A double quote inside a cell. tsvCell quoted a cell only when it
   started with one, but R's read.delim (quote = "\"") reads a quote
   anywhere in a cell as quoting: the quotes of a sample id S"q"2 were
   dropped (Sq2), and one lone quote — a note `tube labelled 2" short` —
   made R read the rest of the samples TSV into that cell (17 rows of 91,
   "EOF within quoted string"). Quoted the CSV way — wrapped in quotes,
   inner ones doubled — R, pandas, CroCoDeEL's csv reader and this
   interface all read the text back as written (checked with Rscript
   read.delim, pandas.read_csv and csv.DictReader on the same file). */

describe("tsvCell", () => {
  it("quotes any cell that holds a double quote", () => {
    expect(tsvCell('tube labelled 2" short')).toBe('"tube labelled 2"" short"');
    expect(tsvCell('S"q"2')).toBe('"S""q""2"');
    expect(tsvCell('Lou <i>2023</i> | plate: 3 "q"')).toBe('"Lou <i>2023</i> | plate: 3 ""q"""');
    expect(tsvCell("plain")).toBe("plain");
    expect(tsvCell("")).toBe("");
    expect(tsvCell(null)).toBe("");
  });
});

describe("files written with quotes inside their cells", () => {
  it("give the abundance table's names back", () => {
    const ab = parseAbundance('species\tS"q"2\tS3\nsp"b"\t1\t2\nsp2\t3\t4');
    expect(ab.samples).toEqual(['S"q"2', "S3"]);
    expect(ab.species).toEqual(['sp"b"', "sp2"]);
    const out = abundanceToTSV(buildCuratedAbundance(ab, {}));
    expect(out).toBe('species\t"S""q""2"\tS3\n"sp""b"""\t1\t2\nsp2\t3\t4');
    const back = parseAbundance(out);
    expect(back.samples).toEqual(ab.samples);
    expect(back.species).toEqual(ab.species);
    expect(back.colSums).toEqual(ab.colSums);
  });

  it("give the events, their notes and the study back", () => {
    const events = [
      { source: 'S"q"2', target: "T1", rate: 0.1, score: 0.9, introduced: ['sp"b"'], verdict: "true_positive", notes: 'tube labelled 2" short' },
      { source: "S2", target: "T2", rate: 0.2, score: 0.8, introduced: ["sp2"], verdict: "pending", notes: 'a "quoted" word' },
    ];
    const text = curatedEventsToTSV(events, { study: 'Lou <i>2023</i> "q"' });
    const parsed = parseEvents(text);
    expect(parsed.events.map((e) => [e.source, e.introduced, e.notes])).toEqual([
      ['S"q"2', ['sp"b"'], 'tube labelled 2" short'],
      ["S2", ["sp2"], 'a "quoted" word'],
    ]);
    expect(parsed.runMetadata).toEqual({ study: 'Lou <i>2023</i> "q"' });
  });

  it("give the metadata and the plate map back", () => {
    const md = parseMetadata('sample_id\tsubject_id\tnote\nS"q"2\tp"1\twell "3"\nS3\tp2\tx');
    const back = parseMetadata(metadataToTSV(md));
    expect(Object.keys(back.bySample)).toEqual(['S"q"2', "S3"]);
    expect(back.bySample['S"q"2'].subject).toBe('p"1');
    expect(back.bySample['S"q"2'].extra.note).toBe('well "3"');

    const pm = parsePlateMap('sample_id\tplate\twell\nS"q"2\tP"2"\tA01\n"Q3\tP1\tB02');
    const written = plateMapToTSV(pm);
    expect(written).toBe('sample_id\tplate\twell\n"S""q""2"\t"P""2"""\tA01\n"""Q3"\tP1\tB02');
    expect(parsePlateMap(written).bySample).toEqual(pm.bySample);
  });

  it("leave a lone quote in a cell nobody quoted as it is", () => {
    // The reader strips quotes only from a cell that starts and ends with one.
    const md = parseMetadata('sample_id\tsubject_id\tnote\nS1\tp1\ttube labelled 2" short');
    expect(md.bySample.S1.extra.note).toBe('tube labelled 2" short');
  });
});
