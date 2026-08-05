import { describe, it, expect } from "vitest";
import {
  buildContaminationGraph,
  graphToGraphML,
  graphToCSV,
  parseAbundance,
} from "../src/App.jsx";

const EVENTS = [
  {
    id: 0,
    source: "S1",
    target: "S2",
    rate: 0.05,
    score: 0.91,
    introduced: ["sp_a", "sp_b"],
    introducedPct: 12.5,
    verdict: "true_positive",
    notes: "clear line",
    cascade: null,
  },
  {
    id: 1,
    source: "S2",
    target: "S3",
    rate: 0.01,
    score: 0.55,
    introduced: ["sp_a"],
    introducedPct: 3,
    verdict: "pending",
    notes: "",
    cascade: { points_above: 4 },
  },
];

const METADATA = {
  cols: { sample: "sample_id", subject: "subject_id" },
  bySample: {
    S1: { subject: "P1", timepoint: "T0", groupId: "", biome: "gut", isControl: false, extra: {} },
    S2: { subject: "P1", timepoint: "T1", groupId: "", biome: "gut", isControl: false, extra: {} },
    S3: { subject: "P2", timepoint: "T0", groupId: "", biome: "gut", isControl: false, extra: {} },
  },
};

describe("buildContaminationGraph", () => {
  it("keeps only samples touched by an event", () => {
    const g = buildContaminationGraph(EVENTS, {});
    expect(g.nodes.map((n) => n.id)).toEqual(["S1", "S2", "S3"]);
    expect(g.edges).toHaveLength(2);
  });

  it("preserves the direction of every event", () => {
    const g = buildContaminationGraph(EVENTS, {});
    expect(g.edges.map((e) => [e.source, e.target])).toEqual([
      ["S1", "S2"],
      ["S2", "S3"],
    ]);
  });

  it("aggregates per-sample counts on the right side of each edge", () => {
    const g = buildContaminationGraph(EVENTS, {});
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(byId.S1.events_as_source).toBe(1);
    expect(byId.S1.events_as_target).toBe(0);
    // S2 is both a target (of S1) and a source (of S3).
    expect(byId.S2.events_as_source).toBe(1);
    expect(byId.S2.events_as_target).toBe(1);
    expect(byId.S2.tp_as_target).toBe(1);
    expect(byId.S3.pending_as_target).toBe(1);
    expect(byId.S2.max_incoming_rate).toBeCloseTo(0.05, 10);
  });

  it("writes the rate as `weight` too, which is what layout tools read", () => {
    const g = buildContaminationGraph(EVENTS, {});
    expect(g.edges[0].weight).toBeCloseTo(0.05, 10);
    expect(g.edges[0].weight).toBe(g.edges[0].rate);
  });

  it("carries the curation through", () => {
    const g = buildContaminationGraph(EVENTS, {
      sampleCuration: {
        S2: { verdict: "contaminated", action: "suppress", notes: "drop it" },
      },
    });
    const s2 = g.nodes.find((n) => n.id === "S2");
    expect(s2.sample_verdict).toBe("contaminated");
    expect(s2.sample_action).toBe("suppress");
    expect(s2.notes).toBe("drop it");
    expect(g.edges[0].event_verdict).toBe("true_positive");
    expect(g.edges[0].notes).toBe("clear line");
    expect(g.edges[1].is_cascade).toBe(true);
  });

  it("resolves relatedness from the metadata", () => {
    const g = buildContaminationGraph(EVENTS, { metadata: METADATA });
    // S1 and S2 share subject P1; S2 and S3 do not.
    expect(g.edges[0].same_subject).toBe(true);
    expect(g.edges[0].relatedness).toBe("subject");
    expect(g.edges[1].same_subject).toBe(false);
    expect(g.edges[1].relatedness).toBe("unrelated");
  });

  it("marks absence with -1 rather than 0, which would read as a measurement", () => {
    const g = buildContaminationGraph(
      [{ id: 0, source: "A", target: "B", rate: 0.1, score: 0.8, introduced: [] }],
      {},
    );
    expect(g.edges[0].introduced_pct).toBe(-1);
    expect(g.edges[0].plate_distance).toBe(-1);
    expect(g.nodes[0].species_richness).toBe(-1);
  });

  it("counts species richness when the abundance table is loaded", () => {
    const ab = parseAbundance(
      ["species\tS1\tS2\tS3", "sp_a\t1\t1\t0", "sp_b\t1\t0\t0"].join("\n"),
    );
    const g = buildContaminationGraph(EVENTS, { ab });
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(byId.S1.species_richness).toBe(2);
    expect(byId.S2.species_richness).toBe(1);
    expect(byId.S1.in_abundance_table).toBe(true);
    // S3 has no positive value, so it is in the table but empty.
    expect(byId.S3.species_richness).toBe(0);
  });

  it("handles an empty event list", () => {
    const g = buildContaminationGraph([], {});
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });
});

describe("graphToGraphML", () => {
  const xml = graphToGraphML(buildContaminationGraph(EVENTS, { metadata: METADATA }));

  it("declares the graph as directed", () => {
    expect(xml).toContain('edgedefault="directed"');
  });

  it("is well-formed XML", () => {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.documentElement.tagName).toBe("graphml");
  });

  it("emits one node and one edge element per row", () => {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.getElementsByTagName("node")).toHaveLength(3);
    expect(doc.getElementsByTagName("edge")).toHaveLength(2);
  });

  it("declares a typed key for every attribute", () => {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const keys = [...doc.getElementsByTagName("key")];
    const byName = Object.fromEntries(
      keys.map((k) => [k.getAttribute("attr.name"), k.getAttribute("attr.type")]),
    );
    expect(byName.rate).toBe("double");
    expect(byName.event_verdict).toBe("string");
    expect(byName.is_cascade).toBe("boolean");
    expect(byName.events_as_source).toBe("double");
    // Every <data> key must resolve to a declaration, or Gephi drops it.
    const declared = new Set(keys.map((k) => k.getAttribute("id")));
    for (const d of doc.getElementsByTagName("data")) {
      expect(declared.has(d.getAttribute("key"))).toBe(true);
    }
  });

  it("escapes characters that would break the XML", () => {
    const g = buildContaminationGraph(
      [
        {
          id: 0,
          source: 'A&B<"1">',
          target: "C'D",
          rate: 0.1,
          score: 0.5,
          introduced: [],
          notes: "a < b & c",
        },
      ],
      {},
    );
    const out = graphToGraphML(g);
    const doc = new DOMParser().parseFromString(out, "application/xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    const ids = [...doc.getElementsByTagName("node")].map((n) => n.getAttribute("id"));
    expect(ids).toContain('A&B<"1">');
    expect(ids).toContain("C'D");
  });
});

describe("graphToCSV", () => {
  const csv = graphToCSV(buildContaminationGraph(EVENTS, {}));

  it("puts the join columns first", () => {
    expect(csv.nodes.split("\n")[0].startsWith("id,label")).toBe(true);
    expect(csv.edges.split("\n")[0].startsWith("source,target,weight")).toBe(true);
  });

  it("emits one row per node and per edge", () => {
    expect(csv.nodes.split("\n")).toHaveLength(4); // header + 3
    expect(csv.edges.split("\n")).toHaveLength(3); // header + 2
  });

  it("quotes cells containing a comma, quote or newline", () => {
    const g = buildContaminationGraph(
      [
        {
          id: 0,
          source: "A",
          target: "B",
          rate: 0.1,
          score: 0.5,
          introduced: [],
          notes: 'has, a comma and a "quote"',
        },
      ],
      {},
    );
    const line = graphToCSV(g).edges.split("\n")[1];
    expect(line).toContain('"has, a comma and a ""quote"""');
    // The quoting must keep the row parseable: 1 unquoted comma per field.
    expect(line.split('"').length % 2).toBe(1);
  });
});
