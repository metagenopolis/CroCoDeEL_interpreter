import { describe, it, expect } from "vitest";
import {
  parseEvents,
  parseAbundance,
  parseMetadata,
  parsePlateMap,
  isReservedId,
} from "../src/parsing.js";
import { sessionFromPayload } from "../src/persistence.js";

/* An id that names a property of every JavaScript object ("__proto__",
   "constructor", "toString", …) cannot key the plain objects the app keeps
   its tables in. "__proto__" vanished from them: its cells read as
   "[object Object]", its column sum and curation entry were lost, so a
   true positive's target was never suppressed and the curated table fell
   back to fractions; "constructor" read as present where it was not and
   the Network tab failed ("node not found: constructor"). Such ids are
   refused, named, by every parser and by the session import. */

const EVENTS_HEADER = "source\ttarget\trate\tprobability\tcontamination_specific_species";
const tsv = (rows) => rows.map((r) => r.join("\t")).join("\n");

describe("ids that every object already has", () => {
  it("are the properties of Object.prototype", () => {
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
      expect(isReservedId(id), id).toBe(true);
    }
    for (const id of ["S1", "proto", "Constructor", " constructor", "__proto", "length", "prototype"]) {
      expect(isReservedId(id), id).toBe(false);
    }
  });

  it("are refused in the events file, naming the line and the column", () => {
    expect(() => parseEvents([EVENTS_HEADER, "S1\tS2\t0.1\t0.9\tsp1", "S1\t__proto__\t0.1\t0.9\tsp1"].join("\n"))).toThrow(
      'The sample "__proto__" (line 3, column "target") cannot be read: every JavaScript object already has a property of that name, and the interface keeps its tables in such objects, keyed by id. Rename it in every input file (and run CroCoDeEL again on the renamed table).',
    );
    expect(() => parseEvents([EVENTS_HEADER, "constructor\tS2\t0.1\t0.9\tsp1"].join("\n"))).toThrow(
      /^The sample "constructor" \(line 2, column "source"\)/,
    );
    expect(() => parseEvents([EVENTS_HEADER, "S1\tS2\t0.1\t0.9\tsp1,toString"].join("\n"))).toThrow(
      /^The species "toString" \(line 2, column "contamination_specific_species"\)/,
    );
  });

  it("are refused in the abundance table, samples and species", () => {
    expect(() => parseAbundance("species\tS1\t__proto__\nsp1\t1\t2")).toThrow(
      /^The sample "__proto__" \(column 3 of the abundance table\) cannot be read/,
    );
    expect(() => parseAbundance("species\tS1\tS2\nsp1\t1\t2\nvalueOf\t3\t4")).toThrow(
      /^The species "valueOf" \(line 3 of the abundance table\) cannot be read/,
    );
    // A header without a species cell (R's write.table) counts its columns
    // from the first sample.
    expect(() => parseAbundance("S1\tconstructor\nsp1\t1\t2")).toThrow(/^The sample "constructor" \(column 3/);
  });

  it("are refused in the metadata and the plate map", () => {
    expect(() => parseMetadata(tsv([["sample_id", "subject_id"], ["S1", "p"], ["__proto__", "q"]]))).toThrow(
      /^The sample "__proto__" \(line 3 of the metadata\) cannot be read/,
    );
    expect(() => parsePlateMap(tsv([["sample_id", "well"], ["hasOwnProperty", "A01"]]))).toThrow(
      /^The sample "hasOwnProperty" \(line 2 of the plate map\) cannot be read/,
    );
  });

  it("are refused by the session import, wherever they are", () => {
    const base = () => ({
      events: [{ id: 0, source: "S1", target: "S2", contamination_rate: 0.1, probability: 0.9, introduced_species: ["sp1"] }],
    });
    // JSON.parse keeps "__proto__" as an own key, as a session file holds it.
    const json = (extra) => JSON.parse(JSON.stringify(base()).replace(/}$/, `,${extra}}`));
    const cases = [
      ['"sample_curation":{"__proto__":{"verdict":"contaminated","action":"suppress"}}', /^sample_curation: the id "__proto__" cannot be read/],
      ['"metadata":{"bySample":{"constructor":{"subject":"p"}}}', /^metadata: the id "constructor" cannot be read/],
      ['"plate_map":{"bySample":{"toString":{"plate":"P1","row":0,"col":0}}}', /^plate_map: the id "toString" cannot be read/],
      ['"abundance":{"samples":["S1","__proto__"],"matrix":{"sp1":{"S1":1}}}', /^abundance: the id "__proto__" cannot be read/],
    ];
    for (const [extra, message] of cases) {
      const r = sessionFromPayload(json(extra));
      expect(r.ok, extra).toBe(false);
      expect(r.errors.some((e) => message.test(e)), r.errors.join(" | ")).toBe(true);
    }
    const ev = base();
    ev.events[0].target = "constructor";
    const r = sessionFromPayload(ev);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/^events: the id "constructor" cannot be read/);
    // Nothing leaked into every object.
    expect({}.verdict).toBeUndefined();
    expect(Object.prototype.action).toBeUndefined();
  });

  it("leave ordinary ids alone", () => {
    const { events } = parseEvents([EVENTS_HEADER, "proto\tS2\t0.1\t0.9\tsp1,Constructor"].join("\n"));
    expect(events[0].source).toBe("proto");
    expect(parseAbundance("species\tS1\tprototype\nlength\t1\t2").samples).toEqual(["S1", "prototype"]);
  });
});
