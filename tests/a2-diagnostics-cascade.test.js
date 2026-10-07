import { describe, it, expect } from "vitest";
import { parseAbundance } from "../src/parsing.js";
import {
  buildScatter,
  pointsAboveLine,
  cascadeExplanations,
} from "../src/diagnostics.js";

/* A2.7 — a cascade's explanation names the upstream event's rate.

   detectCascades flags A → B as a cascade when the points above its line
   are species that an upstream event C → A introduced into A. The HTML
   report prints each explaining event as "C → A (rate%) explains n
   species", reading `rate` from the explanation entry — which never had
   one, so every cascade printed "(NaN%)". */

// The cascade, as abundance profiles. C carries six marker species (m_*)
// that A received from it (rate 0.2) and passed on to B (rate 0.05, much
// less than what A's own markers would predict, so they sit ABOVE A → B's
// line). The shared species s_* make the line itself.
function cascadeTable() {
  const rows = [["species", "C", "A", "B"].join("\t")];
  for (let i = 0; i < 20; i++) {
    const a = 10 ** (-3 * (i / 19));
    rows.push([`s_${i}`, 0, a, 0.05 * a].join("\t"));
  }
  for (let i = 0; i < 6; i++) {
    const c = 10 ** (-1 - i / 3);
    // A holds 20 % of C's marker; B holds far less than 5 % of that.
    rows.push([`m_${i}`, c, 0.2 * c, 0.0005 * 0.2 * c].join("\t"));
  }
  return parseAbundance(rows.join("\n"));
}

describe("cascadeExplanations", () => {
  const ab = cascadeTable();
  const markers = ab.species.filter((s) => s.startsWith("m_"));
  const up = { id: 7, source: "C", target: "A", rate: 0.2, introduced: markers };
  const ev = {
    id: 8,
    source: "A",
    target: "B",
    rate: 0.05,
    introduced: ab.species.filter((s) => s.startsWith("s_")),
  };

  it("finds the markers above A → B's line", () => {
    const above = pointsAboveLine(buildScatter(ab, ev));
    expect(above.count).toBeGreaterThan(3);
  });

  it("carries the upstream event's id, source and rate", () => {
    const explained = cascadeExplanations(buildScatter(ab, ev), [up], ab);
    expect(explained).toHaveLength(1);
    expect(explained[0]).toMatchObject({
      upstream_source: "C",
      upstream_event_id: 7,
      upstream_rate: 0.2,
    });
    expect(explained[0].species_explained).toBeGreaterThanOrEqual(2);
    // What the HTML report prints next to "C → A".
    expect(`${(explained[0].upstream_rate * 100).toFixed(2)}%`).toBe("20.00%");
  });

  it("ignores an upstream event that introduced none of those species", () => {
    const unrelated = { ...up, id: 9, introduced: ["s_0", "s_1"] };
    expect(cascadeExplanations(buildScatter(ab, ev), [unrelated], ab)).toEqual([]);
  });
});
