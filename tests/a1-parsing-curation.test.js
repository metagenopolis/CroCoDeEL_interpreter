import { describe, it, expect } from "vitest";
import { parseEvents, tsvCell } from "../src/parsing.js";

/* A1.6 — reading the curation columns back.

   normalizeEvent forced every verdict to "pending" and every note to "", so
   reloading the curated events TSV the app itself exports lost every
   evaluation. The parser now reads the verdict and the notes, and reads the
   per-row keep / suppress action into `fileAction` without applying it. */

const tsv = (rows) => rows.map((r) => r.map(tsvCell).join("\t")).join("\n");

// Header of exportReport (App.jsx) today, and the layout a later change
// will give it. Both must parse.
const OLD_EXPORT = [
  "source",
  "target",
  "contamination_rate",
  "probability",
  "introduced_pct",
  "introduced_species",
  "verdict",
  "action",
  "notes",
];
const NEW_EXPORT = [
  "source",
  "target",
  "rate",
  "probability",
  "contamination_specific_species",
  "introduced_pct",
  "verdict",
  "action",
  "notes",
];

describe("parseEvents — the curated export reloads with its curation", () => {
  const rows = [
    ["S1", "S2", "0.41", "0.998", "0.3500", "sp_a,sp_b", "true_positive", "suppress", "clear line\nsecond line"],
    ["S3", "S4", "0.05", "0.71", "", "sp_c", "false_positive", "keep", ""],
    ["S5", "S6", "0.2", "0.9", "0.1000", "sp_d", "uncertain", "", "check plate"],
    ["S7", "S8", "0.3", "0.8", "", "sp_e", "pending", "", ""],
  ];

  for (const [name, header] of [
    ["the current export (contamination_rate, introduced_species)", OLD_EXPORT],
    ["the planned export (rate, contamination_specific_species)", NEW_EXPORT],
  ]) {
    describe(name, () => {
      // Write each row in this layout's column order.
      const order = header.map((h) =>
        ({
          source: 0,
          target: 1,
          contamination_rate: 2,
          rate: 2,
          probability: 3,
          introduced_pct: 4,
          introduced_species: 5,
          contamination_specific_species: 5,
          verdict: 6,
          action: 7,
          notes: 8,
        })[h],
      );
      const text = [
        "# study: test",
        tsv([header, ...rows.map((r) => order.map((k) => r[k]))]),
      ].join("\n");
      const { events, curation, warnings } = parseEvents(text);

      it("maps the numeric and species columns, never introduced_pct", () => {
        expect(events.map((e) => [e.rate, e.score])).toEqual([
          [0.41, 0.998],
          [0.05, 0.71],
          [0.2, 0.9],
          [0.3, 0.8],
        ]);
        expect(events[0].introduced).toEqual(["sp_a", "sp_b"]);
        expect(warnings).toEqual([]);
      });

      it("restores the verdicts and the notes", () => {
        expect(events.map((e) => e.verdict)).toEqual([
          "true_positive",
          "false_positive",
          "uncertain",
          "pending",
        ]);
        expect(events.map((e) => e.notes)).toEqual([
          "clear line second line",
          "",
          "check plate",
          "",
        ]);
      });

      it("reads the action into fileAction without applying it", () => {
        expect(events.map((e) => e.fileAction)).toEqual([
          "suppress",
          "keep",
          undefined,
          undefined,
        ]);
        // Not `action`: a session holding events with `action` gets it
        // moved onto the target sample by AppMain's legacy migration.
        expect(events.some((e) => "action" in e)).toBe(false);
      });

      it("summarises what it found", () => {
        expect(curation).toEqual({ verdicts: 3, notes: 2, actions: 2 });
      });
    });
  }
});

describe("parseEvents — verdict and action spellings", () => {
  const header = ["source", "target", "rate", "probability", "verdict", "action", "notes", "species"];

  it("accepts the short and spelled-out verdicts in any case", () => {
    const cells = ["TP", "fp", "U", "True positive", "FALSE-POSITIVE", "Uncertain", "PENDING", "true_positive", ""];
    const { events, warnings } = parseEvents(
      tsv([header, ...cells.map((v, i) => [`S${i}`, `T${i}`, "0.1", "0.9", v, "", "", "sp"])]),
    );
    expect(events.map((e) => e.verdict)).toEqual([
      "true_positive",
      "false_positive",
      "uncertain",
      "true_positive",
      "false_positive",
      "uncertain",
      "pending",
      "true_positive",
      "pending",
    ]);
    expect(warnings).toEqual([]);
  });

  it("reads anything else as pending, with a warning count", () => {
    const { events, warnings, curation } = parseEvents(
      tsv([
        header,
        ["A", "B", "0.1", "0.9", "maybe", "", "", "sp"],
        ["C", "D", "0.1", "0.9", "TP", "", "", "sp"],
        ["E", "F", "0.1", "0.9", "NA", "", "", "sp"],
      ]),
    );
    expect(events.map((e) => e.verdict)).toEqual(["pending", "true_positive", "pending"]);
    expect(warnings).toEqual([
      '2 rows have an unrecognised verdict and were read as pending (first on line 2: "maybe").',
    ]);
    expect(curation.verdicts).toBe(1);
  });

  it("ignores an unrecognised action, with a warning count", () => {
    const { events, warnings } = parseEvents(
      tsv([
        header,
        ["A", "B", "0.1", "0.9", "TP", "Suppress", "", "sp"],
        ["C", "D", "0.1", "0.9", "TP", "delete", "", "sp"],
      ]),
    );
    expect(events.map((e) => e.fileAction)).toEqual(["suppress", undefined]);
    expect(warnings).toEqual([
      '1 row has an unrecognised action, ignored: expected keep or suppress (first on line 3: "delete").',
    ]);
  });

  it("unquotes quoted notes", () => {
    const { events } = parseEvents(
      ["source\ttarget\tnotes", 'A\tB\t"a ""quoted"" note"'].join("\n"),
    );
    expect(events[0].notes).toBe('a "quoted" note');
  });
});

describe("parseEvents — files without curation columns", () => {
  it("leaves every event pending, with no curation summary", () => {
    const { events, curation } = parseEvents(
      tsv([
        ["source", "target", "rate", "probability", "contamination_specific_species"],
        ["A", "B", "0.1", "0.9", "sp_a"],
      ]),
    );
    expect(events[0]).toMatchObject({ verdict: "pending", notes: "" });
    expect("fileAction" in events[0]).toBe(false);
    expect(curation).toBeNull();
  });

  it("never reads a header that merely contains a curation name", () => {
    const { events, curation } = parseEvents(
      tsv([
        ["source", "target", "rate", "probability", "extraction_batch", "contamination_fraction", "footnotes"],
        ["A", "B", "0.1", "0.9", "keep", "suppress", "a note"],
      ]),
    );
    expect(curation).toBeNull();
    expect(events[0].notes).toBe("");
    expect("fileAction" in events[0]).toBe(false);
  });
});
