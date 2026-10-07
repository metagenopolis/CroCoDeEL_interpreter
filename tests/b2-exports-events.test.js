import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvents, tsvCell } from "../src/parsing.js";
import {
  pythonFloat,
  eventsToTSV,
  curatedEventsToTSV,
  CROCODEEL_EVENT_COLUMNS,
  CURATED_EVENT_COLUMNS,
} from "../src/exports.js";

/* B2.1 — the curated events TSV goes back into CroCoDeEL.

   exportReport renamed two of CroCoDeEL's columns (rate →
   contamination_rate, contamination_specific_species → introduced_species)
   and put introduced_pct between them, so CroCoDeEL's reader
   (ContaminationEventIO.read_tsv, which looks its columns up by name)
   failed on the file: KeyError 'rate'. The file now starts with
   CroCoDeEL's five columns, under its names and written with its number
   formatting (str() of a Python float), then introduced_pct, verdict,
   action and notes, under the run's "#" line and the "# study:" line. */

const demoText = readFileSync(
  join(import.meta.dirname, "..", "public", "demo", "contamination_events.tsv"),
  "utf8",
);

/** What CroCoDeEL's read_tsv does with a file: skip the leading "#" lines,
    read the header, look each of its columns up by exact name and
    float() the rate and the probability (Python's float() takes every
    spelling pythonFloat writes). Throws like read_tsv on a missing column. */
function readLikeCroCoDeEL(text) {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].startsWith("#")) i++;
  const header = lines[i].split("\t");
  const rows = lines.slice(i + 1).filter((l) => l.length > 0);
  return rows.map((l) => {
    const cells = l.split("\t");
    const row = Object.fromEntries(header.map((h, j) => [h, cells[j]]));
    for (const c of CROCODEEL_EVENT_COLUMNS) {
      if (!(c in row)) throw new Error(`KeyError: '${c}'`);
    }
    const num = (s) => {
      if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$|^-?(nan|inf)$/i.test(s)) {
        throw new Error(`ValueError: could not convert string to float: '${s}'`);
      }
      return Number(s);
    };
    return {
      source: row.source,
      target: row.target,
      rate: num(row.rate),
      probability: num(row.probability),
      species: row.contamination_specific_species.split(","),
    };
  });
}

describe("pythonFloat — CroCoDeEL's number formatting", () => {
  // Python 3.11, str(float(x)) for each x.
  const PYTHON = [
    [0.704, "0.704"],
    [1, "1.0"],
    [0.97, "0.97"],
    [100, "100.0"],
    [0, "0.0"],
    [-0, "-0.0"],
    [-0.0083, "-0.0083"],
    [0.0001, "0.0001"],
    [0.00001, "1e-05"],
    [0.00009999, "9.999e-05"],
    [1.5e-7, "1.5e-07"],
    [2.5e-10, "2.5e-10"],
    [123456789.123, "123456789.123"],
    [1e15, "1000000000000000.0"],
    [1e16, "1e+16"],
    [1.5e16, "1.5e+16"],
    [1e22, "1e+22"],
    [0.1 + 0.2, "0.30000000000000004"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [NaN, "nan"],
    [Infinity, "inf"],
  ];
  for (const [x, py] of PYTHON) {
    it(`writes ${String(x)} as ${py}`, () => {
      expect(pythonFloat(x)).toBe(py);
      if (Number.isFinite(x)) expect(Number(pythonFloat(x))).toBe(x);
    });
  }
});

describe("curatedEventsToTSV — CroCoDeEL's columns first", () => {
  const parsed = parseEvents(demoText);
  const events = parsed.events.map((e, i) => ({
    ...e,
    introducedPct: i === 1 ? null : 61.53846153846154,
    verdict: ["true_positive", "false_positive", "uncertain", "pending"][i % 4],
    notes: i === 0 ? 'clear line\tsplit\nsecond "line"' : i === 2 ? '"quoted" note' : "",
  }));
  const curation = { [events[0].target]: { action: "suppress" }, [events[1].target]: { action: "keep" } };
  const text = curatedEventsToTSV(events, {
    runMetadata: parsed.runMetadata,
    study: "Demo study",
    sampleCuration: curation,
  });
  const lines = text.split("\n");

  it("keeps the run's '#' line as read, then the '# study:' line", () => {
    expect(lines[0]).toBe(demoText.split("\n")[0]);
    expect(lines[1]).toBe("# study: Demo study");
  });

  it("writes CroCoDeEL's five columns first, under CroCoDeEL's names", () => {
    expect(lines[2].split("\t")).toEqual([
      "source",
      "target",
      "rate",
      "probability",
      "contamination_specific_species",
      "introduced_pct",
      "verdict",
      "action",
      "notes",
    ]);
    expect(CURATED_EVENT_COLUMNS.slice(0, 5)).toEqual(CROCODEEL_EVENT_COLUMNS);
  });

  it("writes the rate and the probability as CroCoDeEL does", () => {
    const row = lines[3].split("\t");
    // The demo writes 7.04e-01 and 0.97; CroCoDeEL's str() gives 0.704.
    expect(row.slice(0, 4)).toEqual(["63D250", "63D9", "0.704", "0.97"]);
    // A probability of 1 is "1.0", as in CroCoDeEL's own files.
    expect(lines.find((l) => l.startsWith("58M\t58D7\t")).split("\t")[3]).toBe("1.0");
  });

  it("is read by CroCoDeEL's reader, every number exactly", () => {
    const read = readLikeCroCoDeEL(text);
    expect(read).toHaveLength(events.length);
    read.forEach((r, i) => {
      expect(r.source).toBe(events[i].source);
      expect(r.target).toBe(events[i].target);
      expect(r.rate).toBe(events[i].rate);
      expect(r.probability).toBe(events[i].score);
      expect(r.species).toEqual(events[i].introduced);
    });
  });

  it("reloads here with its verdicts, notes and actions", () => {
    const back = parseEvents(text);
    expect(back.warnings).toEqual([]);
    expect(back.events.map((e) => e.verdict)).toEqual(events.map((e) => e.verdict));
    expect(back.events[0].notes).toBe('clear line split second "line"');
    expect(back.events[2].notes).toBe('"quoted" note');
    expect(back.events[0].fileAction).toBe("suppress");
    expect(back.events[1].fileAction).toBe("keep");
    expect(back.events.map((e) => [e.rate, e.score, e.introduced])).toEqual(
      events.map((e) => [e.rate, e.score, e.introduced]),
    );
    // The run parameters come back as read, the study with them.
    expect(back.runMetadata).toEqual({ ...parsed.runMetadata, study: "Demo study" });
  });

  it("gives the same file again once reloaded and exported again", () => {
    const back = parseEvents(text);
    const again = curatedEventsToTSV(
      back.events.map((e, i) => ({ ...e, introducedPct: events[i].introducedPct })),
      { runMetadata: back.runMetadata, study: "Demo study", sampleCuration: curation },
    );
    expect(again).toBe(text);
    // The study stays on its own line even when only the run metadata
    // carries it (a reloaded file, no session title).
    const untitled = curatedEventsToTSV(back.events.slice(0, 1), { runMetadata: back.runMetadata });
    expect(untitled.split("\n").slice(0, 2)).toEqual(lines.slice(0, 2));
  });

  it("writes an empty introduced_pct when the target is not in the table", () => {
    const row = lines[4].split("\t");
    expect(row[0]).toBe(events[1].source);
    expect(row[5]).toBe("");
  });

  it("writes no '#' line without run metadata or study", () => {
    const bare = curatedEventsToTSV(events.slice(0, 1));
    expect(bare.split("\n")[0]).toBe(CURATED_EVENT_COLUMNS.join("\t"));
  });

  it("keeps a study title with '|' and ':' off the run line, reload after reload", () => {
    // The reader splits every "#" line on "|" and merges what it finds
    // into the run parameters: "# study: Lou 2023 | plate: 3" came back
    // as a study "Lou 2023" and a run parameter "plate: 3", which the
    // next export appended to the run line CroCoDeEL wrote.
    const first = curatedEventsToTSV(events, {
      runMetadata: parsed.runMetadata,
      study: "Lou 2023 | plate: 3",
      sampleCuration: curation,
    });
    expect(first.split("\n")[1]).toBe("# study: Lou 2023 / plate: 3");
    const back = parseEvents(first);
    expect(back.runMetadata).toEqual({ ...parsed.runMetadata, study: "Lou 2023 / plate: 3" });
    // A colleague's fresh session without a title: the study comes from
    // the file, and the run line is still CroCoDeEL's.
    const second = curatedEventsToTSV(back.events, {
      runMetadata: back.runMetadata,
      sampleCuration: curation,
    });
    expect(second.split("\n").slice(0, 2)).toEqual([
      demoText.split("\n")[0],
      "# study: Lou 2023 / plate: 3",
    ]);
    expect(parseEvents(second).runMetadata).toEqual(back.runMetadata);
  });
});

describe("parseEvents — the curated export of the earlier layout still loads", () => {
  // As exportReport wrote it before: renamed columns, introduced_pct as a
  // fraction before the species, the study line only.
  const OLD = [
    "# study: Demo study",
    "source\ttarget\tcontamination_rate\tprobability\tintroduced_pct\tintroduced_species\tverdict\taction\tnotes",
    ["S1", "S2", "0.41", "0.998", "0.3500", "sp_a,sp_b", "true_positive", "suppress", "first note"].map(tsvCell).join("\t"),
    ["S3", "S4", "0.05", "0.71", "", "sp_c", "false_positive", "keep", '"quoted"'].map(tsvCell).join("\t"),
  ].join("\n");

  it("restores the verdicts, notes and actions", () => {
    const { events, warnings, curation } = parseEvents(OLD);
    expect(warnings).toEqual([]);
    expect(events.map((e) => [e.source, e.target, e.rate, e.score, e.introduced])).toEqual([
      ["S1", "S2", 0.41, 0.998, ["sp_a", "sp_b"]],
      ["S3", "S4", 0.05, 0.71, ["sp_c"]],
    ]);
    expect(events.map((e) => e.verdict)).toEqual(["true_positive", "false_positive"]);
    expect(events.map((e) => e.notes)).toEqual(["first note", '"quoted"']);
    expect(events.map((e) => e.fileAction)).toEqual(["suppress", "keep"]);
    expect(curation).toEqual({ verdicts: 2, notes: 2, actions: 2 });
  });

  it("is not readable by CroCoDeEL, which is what the new layout fixes", () => {
    expect(() => readLikeCroCoDeEL(OLD)).toThrow("KeyError: 'rate'");
  });
});

describe("eventsToTSV — the events card's Download", () => {
  const parsed = parseEvents(demoText);
  const text = eventsToTSV(parsed.events, parsed.runMetadata);

  it("writes the run's '#' line and CroCoDeEL's five columns", () => {
    const lines = text.split("\n");
    expect(lines[0]).toBe(demoText.split("\n")[0]);
    expect(lines[1]).toBe(CROCODEEL_EVENT_COLUMNS.join("\t"));
    expect(lines).toHaveLength(parsed.events.length + 2);
  });

  it("reads back to the same events, here and in CroCoDeEL", () => {
    const back = parseEvents(text);
    expect(back.events.map((e) => [e.source, e.target, e.rate, e.score, e.introduced])).toEqual(
      parsed.events.map((e) => [e.source, e.target, e.rate, e.score, e.introduced]),
    );
    expect(back.runMetadata).toEqual(parsed.runMetadata);
    expect(readLikeCroCoDeEL(text)).toHaveLength(parsed.events.length);
  });
});
