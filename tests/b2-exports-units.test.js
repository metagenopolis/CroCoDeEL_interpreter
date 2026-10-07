import { describe, it, expect } from "vitest";
import { parseAbundance, parseEvents } from "../src/parsing.js";
import { introducedPercent, speciesCountsBySample } from "../src/diagnostics.js";
import { curatedEventsToTSV, CURATED_EVENT_COLUMNS } from "../src/exports.js";
import { buildContaminationGraph, graphToCSV, graphToGraphML } from "../src/App.jsx";

/* B2.2 — introduced_pct has one unit: percent.

   The curated events TSV wrote it as a fraction (0.6154) while the
   samples TSV (max_target_introduced_pct), the GraphML and the CSV pair
   (introduced_pct, max_introduced_pct) and every screen write a
   percentage (61.54): the same column name, two scales a factor 100
   apart. The events TSV now writes the percentage too. */

// TGT holds 13 species, 8 of which the event lists as introduced.
const ab = parseAbundance(
  [
    "species\tSRC\tTGT",
    ...Array.from({ length: 13 }, (_, i) => `sp_${i}\t${i + 1}\t${i + 2}`),
  ].join("\n"),
);
const { events } = parseEvents(
  [
    "source\ttarget\trate\tprobability\tcontamination_specific_species",
    `SRC\tTGT\t0.2\t0.9\t${Array.from({ length: 8 }, (_, i) => `sp_${i}`).join(",")}`,
  ].join("\n"),
);
const event = {
  ...events[0],
  introducedPct: introducedPercent(ab, speciesCountsBySample(ab), events[0]),
};

describe("introduced_pct — one unit, percent, in every export", () => {
  it("is 8 / 13 of the target's species, in percent", () => {
    expect(event.introducedPct).toBeCloseTo(61.538, 3);
  });

  it("is written as a percentage in the curated events TSV", () => {
    const lines = curatedEventsToTSV([event]).split("\n");
    const col = CURATED_EVENT_COLUMNS.indexOf("introduced_pct");
    expect(lines[0].split("\t")[col]).toBe("introduced_pct");
    expect(lines[1].split("\t")[col]).toBe("61.54");
  });

  it("matches the contamination graph's edge and node attributes", () => {
    const graph = buildContaminationGraph([event], { ab });
    const edge = graph.edges[0];
    const target = graph.nodes.find((n) => n.id === "TGT");
    const tsvValue = Number(curatedEventsToTSV([event]).split("\n")[1].split("\t")[5]);
    expect(Math.abs(edge.introduced_pct - tsvValue)).toBeLessThan(0.005);
    expect(Math.abs(target.max_introduced_pct - tsvValue)).toBeLessThan(0.005);
    // The same number in both graph files.
    const csv = graphToCSV(graph).edges.split("\n");
    const header = csv[0].split(",");
    expect(Number(csv[1].split(",")[header.indexOf("introduced_pct")])).toBe(edge.introduced_pct);
    expect(graphToGraphML(graph)).toContain(`>${edge.introduced_pct}</data>`);
  });

  it("is empty in the events TSV, and -1 in the graph, when the target is not in the table", () => {
    const missing = { ...event, target: "ELSEWHERE", introducedPct: null };
    expect(curatedEventsToTSV([missing]).split("\n")[1].split("\t")[5]).toBe("");
    const graph = buildContaminationGraph([missing], { ab });
    expect(graph.edges[0].introduced_pct).toBe(-1);
    // Not 0, which reads as "no species introduced"; a sample that is only
    // a source has no introduced share either.
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
    expect(byId.ELSEWHERE.max_introduced_pct).toBe(-1);
    expect(byId.SRC.max_introduced_pct).toBe(-1);
  });
});

describe("the contamination graph: a missing number is -1, never 0", () => {
  // The Help says so, and graphToGraphML's doc comment: Gephi draws a
  // missing number as 0, which reads as a measurement. max_incoming_rate
  // was 0 on every node no event targets (12 of the demo's 28), next to
  // its max_introduced_pct of -1.
  it("writes max_incoming_rate -1 on a node no event targets", () => {
    const graph = buildContaminationGraph([event], { ab });
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
    expect(byId.SRC.events_as_target).toBe(0);
    expect(byId.SRC.max_incoming_rate).toBe(-1);
    expect(byId.SRC.max_introduced_pct).toBe(-1);
    expect(byId.TGT.max_incoming_rate).toBe(0.2);
    const csv = graphToCSV(graph).nodes.split("\n");
    const header = csv[0].split(",");
    const src = csv.find((l) => l.startsWith("SRC,")).split(",");
    expect(src[header.indexOf("max_incoming_rate")]).toBe("-1");
  });

  it("writes -1 for an event's rate and probability when they are not numbers", () => {
    // Only a hand-edited session has such an event: parseEvents reads a
    // missing rate or probability as 0, with a warning.
    const graph = buildContaminationGraph([{ ...event, rate: undefined, score: null }], { ab });
    const edge = graph.edges[0];
    expect(edge.rate).toBe(-1);
    expect(edge.weight).toBe(edge.rate);
    expect(edge.probability).toBe(-1);
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
    expect(byId.TGT.max_incoming_rate).toBe(-1);
    // A rate CroCoDeEL wrote as 0 stays 0: that one is a number.
    expect(buildContaminationGraph([{ ...event, rate: 0 }], { ab }).edges[0].rate).toBe(0);
  });
});
