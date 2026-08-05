import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseEvents, parseAbundance, buildScatter } from "../src/App.jsx";

/* Every dataset this repository ships must actually work end to end.

   The motivating regression: the events parser split the species column on
   both `,` and `;`, which shredded the GTDB lineages used by the `sylph`
   dataset into rank fragments matching nothing in the abundance table. All
   15,382 of its events silently ended up with zero on-line points and a
   "PROBABLY NOT CONTAMINATED" grade — with the contamination line still
   drawn. Nothing in the suite noticed, because no test ever touched the
   bundled files. */

const ROOT = join(import.meta.dirname, "..", "public", "datasets");
const datasets = existsSync(ROOT)
  ? readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  : [];

describe("bundled datasets", () => {
  it("finds the shipped datasets", () => {
    expect(datasets.length).toBeGreaterThan(0);
  });

  for (const name of datasets) {
    const dir = join(ROOT, name);
    const evPath = join(dir, "contamination_events.tsv");
    const abPath = join(dir, "species_abundance.tsv");
    if (!existsSync(evPath) || !existsSync(abPath)) continue;

    describe(name, () => {
      const { events, warnings } = parseEvents(readFileSync(evPath, "utf8"));
      const ab = parseAbundance(readFileSync(abPath, "utf8"));

      it("parses both files without warnings", () => {
        expect(events.length).toBeGreaterThan(0);
        expect(ab).not.toBeNull();
        expect(ab.samples.length).toBeGreaterThan(0);
        expect(warnings).toEqual([]);
        expect(ab.warnings).toEqual([]);
      });

      it("resolves the introduced species against the abundance table", () => {
        const known = new Set(ab.species);
        const withSpecies = events.filter((e) => e.introduced.length > 0);
        expect(withSpecies.length).toBeGreaterThan(0);
        const unresolved = withSpecies.filter(
          (e) => !e.introduced.some((sp) => known.has(sp)),
        );
        // A handful of events may legitimately name a species filtered out
        // of the abundance table, but a whole dataset failing to resolve is
        // a parsing bug, not a data property.
        expect(unresolved.length / withSpecies.length).toBeLessThan(0.05);
      });

      it("builds a usable scatter for the first resolvable event", () => {
        const known = new Set(ab.species);
        const e = events.find(
          (ev) =>
            ev.introduced.some((sp) => known.has(sp)) &&
            ab.samples.includes(ev.source) &&
            ab.samples.includes(ev.target),
        );
        // Some datasets carry events whose samples are absent from the
        // shipped abundance subset; skip those rather than fail.
        if (!e) return;
        const sc = buildScatter(ab, e);
        expect(sc.error).toBeUndefined();
        expect(sc.points.length).toBeGreaterThan(0);
        expect(sc.points.some((p) => p.onLine)).toBe(true);
      });
    });
  }
});
