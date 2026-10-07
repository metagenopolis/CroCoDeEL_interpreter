import { describe, it, expect } from "vitest";
import { parseAbundance } from "../src/parsing.js";
import { detectCascades } from "../src/diagnostics.js";

/* B3.3 — the upstream events of a cascade are found by the table's name of
   the sample, as the scatter finds it.

   detectCascades flags A → B when the points above its line are species
   that an upstream event C → A introduced into A. It listed the upstream
   events by target name exactly as the events file spells it, while the
   scatter of each event resolves names through resolveSample (case and
   surrounding blanks aside). An events file that wrote the shared sample
   "a " in one row and "A" in the other drew both scatters, but no cascade. */

// C carries six marker species that A received from it (rate 0.2) and
// passed on to B (rate 0.05, far less than A's own markers predict, so they
// sit ABOVE A → B's line). The shared species s_* make the line itself.
function cascadeTable() {
  const rows = [["species", "C", "A", "B"].join("\t")];
  for (let i = 0; i < 20; i++) {
    const a = 10 ** (-3 * (i / 19));
    rows.push([`s_${i}`, 0, a, 0.05 * a].join("\t"));
  }
  for (let i = 0; i < 6; i++) {
    const c = 10 ** (-1 - i / 3);
    rows.push([`m_${i}`, c, 0.2 * c, 0.0005 * 0.2 * c].join("\t"));
  }
  return parseAbundance(rows.join("\n"));
}

const ab = cascadeTable();
const markers = ab.species.filter((s) => s.startsWith("m_"));
const line = ab.species.filter((s) => s.startsWith("s_"));

/** C → upstreamTarget (the markers), then downstreamSource → B. */
function events(upstreamTarget, downstreamSource = "A") {
  return [
    { id: 7, source: "C", target: upstreamTarget, rate: 0.2, introduced: markers },
    { id: 8, source: downstreamSource, target: "B", rate: 0.05, introduced: line },
  ];
}

describe("detectCascades", () => {
  it("flags A → B when the upstream event names A as the table does", () => {
    const [up, down] = detectCascades(events("A"), ab, null);
    expect(up.cascade).toBeNull();
    expect(down.cascade).not.toBeNull();
    expect(down.cascade.points_above).toBeGreaterThan(3);
    expect(down.cascade.explained).toHaveLength(1);
    expect(down.cascade.explained[0]).toMatchObject({
      upstream_source: "C",
      upstream_event_id: 7,
      upstream_rate: 0.2,
    });
  });

  for (const spelling of ["a", " A", "A ", " a ", "A  "]) {
    it(`finds the upstream event whose target is spelled ${JSON.stringify(spelling)}`, () => {
      const down = detectCascades(events(spelling), ab, null)[1];
      expect(down.cascade).not.toBeNull();
      expect(down.cascade.explained[0].upstream_event_id).toBe(7);
    });
  }

  it("finds it when the downstream event spells its source differently", () => {
    expect(detectCascades(events("A", "a "), ab, null)[1].cascade).not.toBeNull();
    expect(detectCascades(events(" a", "A "), ab, null)[1].cascade).not.toBeNull();
  });

  it("still flags nothing when the upstream event is about another sample", () => {
    // B is not A: C → B introduced nothing into A.
    expect(detectCascades(events("B"), ab, null)[1].cascade).toBeNull();
  });

  it("skips a pair the relatedness function calls related", () => {
    const calls = [];
    const related = (source, target) => {
      calls.push([source, target]);
      return source === "A" && target === "B"
        ? { related: true, kind: "subject", value: "p1" }
        : { related: false };
    };
    const out = detectCascades(events("a "), ab, related);
    expect(out[1].cascade).toBeNull();
    expect(calls).toContainEqual(["A", "B"]);
    // Unrelated or unknown: detected as before.
    expect(detectCascades(events("a "), ab, () => ({ related: false }))[1].cascade).not.toBeNull();
    expect(detectCascades(events("a "), ab, () => null)[1].cascade).not.toBeNull();
  });

  it("gives every event a null cascade without an abundance table", () => {
    const out = detectCascades(events("A"), null, null);
    expect(out.map((e) => e.cascade)).toEqual([null, null]);
    expect(out.map((e) => e.id)).toEqual([7, 8]);
  });

  it("ignores upstream events whose target is not in the table", () => {
    const evs = [
      { id: 1, source: "C", target: "nowhere", rate: 0.2, introduced: markers },
      ...events("A"),
    ];
    const out = detectCascades(evs, ab, null);
    expect(out[0].cascade).toBeNull();
    expect(out[2].cascade.explained.map((x) => x.upstream_event_id)).toEqual([7]);
  });

  it("does not throw on samples named after Object's own properties", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const evs = [
        { id: 1, source: "C", target: name, rate: 0.2, introduced: markers },
        { id: 2, source: name, target: "B", rate: 0.05, introduced: line },
      ];
      expect(() => detectCascades(evs, ab, null)).not.toThrow();
    }
  });
});
