import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvents, tsvCell } from "../src/parsing.js";
import { curatedEventsToTSV } from "../src/exports.js";

/* The curated events TSV, read downstream. The Help and the README tell
   to skip its leading "#" lines (pandas skiprows, R skip) rather than use
   comment="#", which cuts a note at its first "#". R's read.delim also
   reads a double quote anywhere in a cell as the start of a quoted field:
   a note `well 5" from the edge` written as it is swallowed the rows
   after it, up to the next quote (22 of the demo's 24 rows came back). A
   cell holding a quote is now quoted the CSV way, which R, pandas,
   CroCoDeEL's csv reader and parseEvents all read back as written. */

const demoEvents = readFileSync(
  join(import.meta.dirname, "..", "public", "demo", "contamination_events.tsv"),
  "utf8",
);

/** A cell R's read.delim reads as written: no quote at all, or quoted
    whole with its inner quotes doubled. */
const safeForR = (cell) =>
  !cell.includes('"') || /^"(?:[^"]|"")*"$/.test(cell);

describe("curated events TSV — notes with quotes and hashes", () => {
  const parsed = parseEvents(demoEvents);
  const notes = [
    'see plate #3, well 5" from the edge',
    '"Quoted" start # hash',
    'two "quoted" words',
    "plain # note",
  ];
  const events = parsed.events.map((e, i) => ({
    ...e,
    verdict: i < notes.length ? "true_positive" : "pending",
    notes: notes[i] || "",
  }));
  const text = curatedEventsToTSV(events, {
    runMetadata: parsed.runMetadata,
    study: 'Cohort "A" #2',
    sampleCuration: {},
  });

  it("writes every cell holding a quote quoted the CSV way", () => {
    expect(tsvCell('well 5" from the edge')).toBe('"well 5"" from the edge"');
    const cells = text
      .split("\n")
      .filter((l) => !l.startsWith("#"))
      .flatMap((l) => l.split("\t"));
    expect(cells.filter((c) => !safeForR(c))).toEqual([]);
  });

  it("keeps one line per event under the leading # lines", () => {
    const lines = text.split("\n");
    const n = lines.findIndex((l) => !l.startsWith("#"));
    expect(n).toBe(2);
    expect(lines.slice(n + 1)).toHaveLength(events.length);
  });

  it("reads back with every note and the study as written", () => {
    const back = parseEvents(text);
    expect(back.events.slice(0, notes.length).map((e) => e.notes)).toEqual(notes);
    expect(back.runMetadata.study).toBe('Cohort "A" #2');
  });
});
