import { describe, it, expect } from "vitest";
import { parseAbundance, areRelated } from "../src/App.jsx";
import {
  automaticScore,
  buildScatter,
  eventBulkCriteria,
  lineDiagnostics,
  matchesBulkCriteria,
  missingAbundantFromSource,
  pointsAboveLine,
} from "../src/diagnostics.js";

/* A2.3 — the bulk dialog's criteria are the Guided validation panel's.

   The dialog recomputed its six criteria with rules of its own, and
   criterion 06 tested `ρ < 0.7` alone. The panel (and the Help) read ρ
   jointly with the metadata: a high ρ between UNRELATED samples (different
   subjects, not in one group) is consistent with strong contamination and
   passes; a high ρ within one subject or one group fails; a high ρ without
   metadata is inconclusive. So "biological similarity: ✓ pass" in the
   dialog skipped exactly the strong cross-subject contaminations the panel
   showed with a green tick, while the comment above the dialog claimed the
   two mirrored each other.

   Both now read the same automaticScore reasons. These tests run the
   panel's chain (as AppMain's memos compute it for the selected event)
   and the dialog's own per-event code — its eventCriteria memo is
   eventBulkCriteria mapped over the events — and compare. The dialog
   itself is driven in a browser by e2e/a2-diagnostics.e2e.mjs. */

// SRC spans four decades. HIGH_* hold 10 % of SRC on every species, so
// their profiles rank exactly like SRC's (ρ ≈ 1); LOW holds the same
// species in reverse order of abundance (ρ ≈ −1).
const N = 30;
const src = Array.from({ length: N }, (_, i) => 10 ** (-4 * (i / (N - 1))));
const cols = {
  SRC: src,
  HIGH_UNRELATED: src.map((v) => 0.1 * v),
  HIGH_SAME_SUBJECT: src.map((v) => 0.1 * v),
  HIGH_SAME_GROUP: src.map((v) => 0.1 * v),
  HIGH_NO_METADATA: src.map((v) => 0.1 * v),
  LOW: src.map((_, i) => 0.1 * src[N - 1 - i]),
};
const names = Object.keys(cols);
const ab = parseAbundance(
  [
    ["species", ...names].join("\t"),
    ...Array.from({ length: N }, (_, i) =>
      [`sp_${i}`, ...names.map((s) => cols[s][i].toPrecision(8))].join("\t"),
    ),
  ].join("\n"),
);
const metadata = {
  bySample: {
    SRC: { subject: "alice", groupId: "family1" },
    HIGH_UNRELATED: { subject: "bob" },
    HIGH_SAME_SUBJECT: { subject: "alice" },
    // Another subject of SRC's group (e.g. a household): related.
    HIGH_SAME_GROUP: { subject: "dave", groupId: "family1" },
    LOW: { subject: "carol" },
    // HIGH_NO_METADATA: deliberately absent
  },
};
const introduced = ab.species.slice(0, 20);
const events = names
  .filter((s) => s !== "SRC")
  .map((target, id) => ({ id, source: "SRC", target, rate: 0.1, introduced }));

/** Guided validation: the AppMain memos for the selected event. */
function panelScore(e) {
  const sc = buildScatter(ab, e);
  const di = lineDiagnostics(sc);
  return {
    di,
    score: automaticScore(
      di,
      pointsAboveLine(sc),
      missingAbundantFromSource(ab, e.source, e.target, e.rate),
      e.cascade,
      areRelated(metadata, e.source, e.target),
    ),
  };
}

/** Bulk dialog: the body of its eventCriteria memo, per event. */
const dialogCriteria = (e) =>
  eventBulkCriteria(ab, e, areRelated(metadata, e.source, e.target));

const ANY = {
  shape: "any",
  nOnLine: "any",
  decade: "any",
  missing: "any",
  above: "any",
  spearman: "any",
};
const select = (picks) =>
  events.filter((e) => matchesBulkCriteria(dialogCriteria(e), picks)).map((e) => e.target);

describe("bulk dialog vs Guided validation — biological similarity", () => {
  it("covers every outcome of the joint ρ × relatedness criterion", () => {
    const biosim = Object.fromEntries(
      events.map((e) => [
        e.target,
        panelScore(e).score.reasons.find((r) => r.key === "biosim")?.ok,
      ]),
    );
    expect(biosim).toEqual({
      HIGH_UNRELATED: true, // strong contamination across subjects
      HIGH_SAME_SUBJECT: false, // biological persistence
      HIGH_SAME_GROUP: false, // different subjects, but one group
      HIGH_NO_METADATA: null, // inconclusive
      LOW: true, // profiles distinct
    });
    // The old dialog rule, ρ < 0.7, failed every high-ρ pair, the
    // cross-subject one included.
    const oldRule = Object.fromEntries(
      events.map((e) => [e.target, panelScore(e).di.spearman < 0.7]),
    );
    expect(oldRule).toEqual({
      HIGH_UNRELATED: false,
      HIGH_SAME_SUBJECT: false,
      HIGH_SAME_GROUP: false,
      HIGH_NO_METADATA: false,
      LOW: true,
    });
  });

  it("is what the dialog's per-event code returns for criterion 06", () => {
    const spearman = Object.fromEntries(
      events.map((e) => [e.target, dialogCriteria(e).spearman]),
    );
    expect(spearman).toEqual({
      HIGH_UNRELATED: true,
      HIGH_SAME_SUBJECT: false,
      HIGH_SAME_GROUP: false,
      HIGH_NO_METADATA: null,
      LOW: true,
    });
  });

  it("selects exactly the panel's ✓ with “pass” and its ✗ with “fail”", () => {
    const panelWith = (ok) =>
      events
        .filter(
          (e) => panelScore(e).score.reasons.find((r) => r.key === "biosim")?.ok === ok,
        )
        .map((e) => e.target);
    expect(select({ ...ANY, spearman: "pass" })).toEqual(panelWith(true));
    expect(select({ ...ANY, spearman: "pass" })).toEqual(["HIGH_UNRELATED", "LOW"]);
    expect(select({ ...ANY, spearman: "fail" })).toEqual(panelWith(false));
    expect(select({ ...ANY, spearman: "fail" })).toEqual([
      "HIGH_SAME_SUBJECT",
      "HIGH_SAME_GROUP",
    ]);
    // Inconclusive is matched by neither filter, and "any" keeps everyone.
    expect(select({ ...ANY })).toHaveLength(events.length);
  });
});

describe("bulk dialog vs Guided validation — every criterion", () => {
  const KEYS = {
    shape: "r2",
    nOnLine: "n",
    decade: "decade",
    missing: "missing",
    above: "above",
    spearman: "biosim",
  };
  it("reads each of the six criteria off the panel's own evaluation", () => {
    for (const e of events) {
      const { score } = panelScore(e);
      const c = dialogCriteria(e);
      for (const [dialogKey, reasonKey] of Object.entries(KEYS)) {
        const panelOk = score.reasons.find((r) => r.key === reasonKey)?.ok ?? null;
        expect([e.target, dialogKey, c[dialogKey]]).toEqual([e.target, dialogKey, panelOk]);
      }
    }
  });

  it("leaves a pair missing from the table out of both pass and fail", () => {
    const e = { id: 99, source: "SRC", target: "NOT_THERE", rate: 0.1, introduced };
    const c = dialogCriteria(e);
    expect(c).toBeNull();
    for (const k of Object.keys(ANY)) {
      expect(matchesBulkCriteria(c, { ...ANY, [k]: "pass" })).toBe(false);
      expect(matchesBulkCriteria(c, { ...ANY, [k]: "fail" })).toBe(false);
    }
    expect(matchesBulkCriteria(c, ANY)).toBe(true);
  });
});
