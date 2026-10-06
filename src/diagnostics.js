/* ============================================================================
   Pure diagnostic helpers shared by the Guided validation panel, the bulk
   dialog and the HTML report.

   They live outside App.jsx so they can be exported to the unit tests:
   App.jsx exports React components, and every non-component export there
   costs Fast Refresh its granularity (react-refresh/only-export-components).
   Nothing in this module touches React, the DOM or App.jsx — inputs are the
   plain objects the domain functions in App.jsx produce (scatter,
   lineDiagnostics, pointsAboveLine, missingAbundantFromSource, areRelated).
   ============================================================================ */

export function automaticScore(diag, aboveInfo, nMissing, cascade, relatedness) {
  // Each reason carries a stable `key` so the Validate panel can pair
  // the colloquial summary line with its matching Criterion card
  // even when some entries are missing (no abundance loaded etc.).
  // `ok` is true (pass), false (fail) or null (evaluated but inconclusive
  // — counts for neither the numerator nor the denominator).
  const reasons = [];
  if (diag && diag.r2 != null) {
    if (diag.r2 > 0.8) {
      reasons.push({ key: "r2", ok: true, label: `Straight line (R² = ${diag.r2.toFixed(2)})` });
    } else {
      reasons.push({ key: "r2", ok: false, label: `Dispersed line (R² = ${diag.r2.toFixed(2)})` });
    }
  }
  if (diag && diag.n != null) {
    if (diag.n > 10) {
      reasons.push({ key: "n", ok: true, label: `${diag.n} species on line (> 10)` });
    } else {
      reasons.push({ key: "n", ok: false, label: `Only ${diag.n} species on line` });
    }
  }
  // Decade range of the contamination line — a real (mechanical)
  // contamination transfers ALL species proportionally, so the line
  // spans many decades of abundance (TP cases C and D in the paper:
  // 4-5 decades). Biological similarity shares only the most abundant
  // species, concentrating the apparent line in 1-1.5 decades. Threshold
  // ≥ 1.5 decades is permissive enough not to penalise genuine low-rate
  // TPs but flags the typical FP-by-shared-microbiota pattern.
  if (diag && diag.decadeRange != null) {
    const dr = diag.decadeRange;
    if (dr >= 1.5) {
      reasons.push({
        key: "decade",
        ok: true,
        label: `Line spans ${dr.toFixed(1)} decades of abundance (≥ 1.5)`,
      });
    } else {
      reasons.push({
        key: "decade",
        ok: false,
        label: `Line concentrated in ${dr.toFixed(1)} decades — possibly only abundant species shared`,
      });
    }
  }
  if (nMissing != null) {
    const { count: missingCount, evaluated, pValue } = nMissing;
    if (evaluated === 0) {
      // No core species had any predictable contribution (rate ≈ 0 or
      // empty source). Cannot inform the verdict — mark it inconclusive
      // rather than passing it, which used to hand a free point to every
      // event whose rate column failed to parse.
      reasons.push({
        key: "missing",
        ok: null,
        label: `Missing-species check not informative (no species expected in target given rate)`,
      });
    } else if (missingCount === 0) {
      reasons.push({
        key: "missing",
        ok: true,
        label: `All ${evaluated} expected source species present in target`,
      });
    } else if (pValue >= 0.05) {
      // Observed misses are consistent with Poisson-binomial sampling
      // noise under H_real — fold them into the "tolerable" bucket and
      // keep the criterion as a pass. Headline stays short so the
      // card row doesn't spill over; the p-value / expected count
      // are surfaced in the dropdown's technical readout.
      reasons.push({
        key: "missing",
        ok: true,
        label: `${missingCount}/${evaluated} missing — within Poisson noise`,
      });
    } else {
      reasons.push({
        key: "missing",
        ok: false,
        label: `${missingCount}/${evaluated} expected species missing — beyond Poisson noise`,
      });
    }
  }
  // Above-line points. buildScatter puts TARGET on x and SOURCE on y, so
  // pointsAboveLine's `dist > 0` is log10(rate × source / target) > 0,
  // i.e. target < rate × source — the half-plane additive contamination
  // cannot reach, since the target keeps its own natives on top of what
  // it received. ANY such point is a signal, but the magnitude matters
  // more than the count: a single point 3 decades off is much stronger
  // evidence than 5 points slightly off. Threshold:
  // PASS if no point is more than 0.5 decade above the line (tight
  // tolerance — beyond that the target holds ≤ 1/3 of the delivered
  // contamination, so either the rate is over-estimated or the line is
  // shared biology rather than transfer); FAIL
  // otherwise. The exception is cascade contamination — we soften the
  // wording when a cascade has been detected upstream.
  if (aboveInfo != null) {
    const { count: nAbove, maxDist, farAbove } = aboveInfo;
    if (nAbove === 0) {
      reasons.push({ key: "above", ok: true, label: `No points above the line` });
    } else if (maxDist < 0.5) {
      reasons.push({
        key: "above",
        ok: true,
        label: `${nAbove} points above the line, all within 0.5 decade (tolerable)`,
      });
    } else if (cascade) {
      reasons.push({
        key: "above",
        ok: false,
        label: `${nAbove} points above the line (${farAbove} ≥ 0.5 decade, max ${maxDist.toFixed(1)}) — explained by detected cascade`,
      });
    } else {
      reasons.push({
        key: "above",
        ok: false,
        label: `${nAbove} points above the line (${farAbove} ≥ 0.5 decade, max ${maxDist.toFixed(1)}) — strong biological signal, no cascade detected`,
      });
    }
  }
  // Joint "biological similarity" criterion — combines the Spearman
  // correlation (ρ) with the metadata-driven relatedness check. ρ
  // alone is ambiguous: high ρ can mean either longitudinal /
  // same-subject persistence (FP) OR very strong contamination (TP).
  // Reading the two signals together resolves the ambiguity:
  //   • high ρ + samples NOT related   → strong contamination plausible → PASS (TP-leaning)
  //   • high ρ + samples ARE related   → biological persistence  → FAIL (FP-leaning)
  //   • low ρ                          → profiles distinct  → PASS
  //   • high ρ + no metadata           → ambiguous, mark inconclusive (ok: null)
  // Replaces the older separate Spearman + relatedness criteria.
  if (diag && diag.spearman != null) {
    const rho = diag.spearman;
    const rhoText = `ρ = ${rho.toFixed(2)}`;
    const high = rho >= 0.7;
    const related =
      relatedness && relatedness.related != null
        ? relatedness.related
        : null;
    if (related === null) {
      if (!high) {
        reasons.push({
          key: "biosim",
          ok: true,
          label: `Source / target profiles distinct (${rhoText})`,
        });
      } else {
        // High ρ without metadata: can't tell longitudinal vs strong
        // contamination. Surface as inconclusive (ok = null) so the
        // curator sees it but it doesn't tilt the score.
        reasons.push({
          key: "biosim",
          ok: null,
          label: `Source / target profiles highly correlated (${rhoText}) — load metadata to know if same subject (FP) or strong contamination (TP)`,
        });
      }
    } else if (related === false) {
      if (high) {
        reasons.push({
          key: "biosim",
          ok: true,
          label: `Profiles highly correlated (${rhoText}) despite different subjects — consistent with strong contamination`,
        });
      } else {
        reasons.push({
          key: "biosim",
          ok: true,
          label: `Profiles distinct (${rhoText}) and from different subjects`,
        });
      }
    } else {
      // related === true
      const kindText =
        relatedness.kind === "group"
          ? `same group (${relatedness.value})`
          : `same subject (${relatedness.value})`;
      if (high) {
        reasons.push({
          key: "biosim",
          ok: false,
          label: `Profiles highly correlated (${rhoText}) AND ${kindText} — biological persistence, likely FP`,
        });
      } else {
        reasons.push({
          key: "biosim",
          ok: true,
          label: `Profiles distinct (${rhoText}) despite ${kindText}`,
        });
      }
    }
  }
  // Derive both counts from `reasons` rather than maintaining a `good++`
  // alongside a hard-coded `total = 6`. Criteria are only pushed when
  // their input exists, so `total` is now the number of criteria actually
  // evaluated — 0 when no abundance table is loaded (the callers guard on
  // `total > 0` and suppress the banner) instead of a red "0 / 6 —
  // PROBABLY NOT CONTAMINATED" printed above "Open the abundance table to
  // compute." And an `ok: null` abstention no longer silently consumes a
  // point, which used to cap otherwise-perfect events at 5/6.
  const total = reasons.filter((r) => r.ok !== null).length;
  const good = reasons.filter((r) => r.ok === true).length;
  return { good, total, reasons, grade: scoreGrade(good, total) };
}

/** The headline outcome of automaticScore, from its pass / evaluated
    counts. Every consumer switches on this rather than re-deriving the
    thresholds, so the Validate panel and the HTML report cannot disagree.

    "not_evaluable" — nothing could be scored: no abundance table, or the
    source or target is missing from it (the normal case after a CroCoDeEL
    `-s2` run with only one of the two tables loaded). It is neither a pass
    nor a fail and must never be shown as PROBABLY NOT CONTAMINATED. */
export function scoreGrade(good, total) {
  if (!(total > 0)) return "not_evaluable";
  if (good === total) return "contaminated";
  if (good >= Math.ceil(total * 0.6)) return "possibly_not";
  return "probably_not";
}

/** The bulk dialog's six criteria for one event, read off automaticScore —
    the very evaluation behind Guided validation's ✓ / ✗ — so "✓ pass" in
    the dialog selects exactly the events the panel ticks. Each value is
    true (pass), false (fail) or null (not evaluated, or inconclusive —
    matched by neither the pass nor the fail filter). Keys are BULK_CRIT's
    ids; `spearman` carries the joint biological-similarity criterion
    (automaticScore's "biosim": ρ read together with relatedness). */
export function bulkCriteria(score) {
  const ok = (key) => score?.reasons?.find((r) => r.key === key)?.ok ?? null;
  return {
    shape: ok("r2"),
    nOnLine: ok("n"),
    decade: ok("decade"),
    missing: ok("missing"),
    above: ok("above"),
    spearman: ok("biosim"),
  };
}

/** Does one event's bulkCriteria record satisfy the dialog's per-criterion
    picks ("any" / "pass" / "fail")? An event without a record — no
    abundance table, or a pair missing from it — only matches when every
    pick is "any". */
export function matchesBulkCriteria(criteria, picks) {
  for (const k of Object.keys(picks)) {
    const want = picks[k];
    if (want === "any") continue;
    if (!criteria) return false;
    if (want === "pass" && criteria[k] !== true) return false;
    if (want === "fail" && criteria[k] !== false) return false;
  }
  return true;
}

/** The upstream events that explain the points above an event's line.

    For A → B, `upstream` are the events C → A. Points far above A → B's
    line (≥ 0.3 decade, i.e. B holds well under rate × A of them) cannot
    come from A's contamination of B — unless they are species C introduced
    into A, which then reached B through A. An upstream event explaining at
    least two such points is kept.

    Each entry carries what the cascade banner and the HTML report print:
    the upstream source and event id, the number of species explained, and
    the upstream event's own rate (`upstream_rate`). The report used to read
    a `rate` that no entry had and printed "(NaN%)" for every cascade. */
export function cascadeExplanations(scatter, upstream, ab) {
  const explained = [];
  if (!scatter || scatter.logC == null) return explained;
  for (const up of upstream) {
    const upIntroduced = introducedSpeciesSet(ab, up.introduced);
    let count = 0;
    for (const p of scatter.points) {
      if (p.onLine || p.x <= 0 || p.y <= 0) continue;
      const threshold = Math.log10(p.x) - scatter.logC;
      if (Math.log10(p.y) > threshold + 0.3 && upIntroduced.has(p.species)) {
        count++;
      }
    }
    if (count >= 2) {
      explained.push({
        upstream_source: up.source,
        upstream_event_id: up.id,
        upstream_rate: up.rate,
        species_explained: count,
      });
    }
  }
  return explained;
}

/* ---- Species names CroCoDeEL rewrote as integers ----

   CroCoDeEL reads the abundance table with pandas (ab_table_utils.read:
   `read_csv(index_col=0)`, then `index.astype(str)`). When EVERY species
   name parses as an integer the index becomes int64, so the names it
   writes in contamination_events.tsv are the integers' str(): "001" comes
   back as "1", "+5" as "5", "-007" as "-7". The interpreter reads the
   table as text, so an exact match finds none of them and no introduced
   species lands on the line. Every place that matches an event's species
   against the table goes through matchSpeciesName. */

/** pandas' rendering of an integer-like species name ("007" → "7",
    "+5" → "5", "-007" → "-7", " 12" → "12"), or null if the name is not
    an integer. */
export function canonicalIntegerName(name) {
  const m = /^\s*([+-]?)(\d+)\s*$/.exec(String(name ?? ""));
  if (!m) return null;
  const digits = m[2].replace(/^0+(?=\d)/, "");
  return m[1] === "-" && digits !== "0" ? `-${digits}` : digits;
}

// Per species list: the exact names, and canonical integer form → table
// name (null when two table species share the form: never guess).
// Keyed on the `species` array, which a filtered copy of the table shares.
const speciesIndexes = new WeakMap();
function speciesIndex(ab) {
  let index = speciesIndexes.get(ab.species);
  if (!index) {
    const integers = new Map();
    for (const sp of ab.species) {
      const c = canonicalIntegerName(sp);
      if (c != null) integers.set(c, integers.has(c) ? null : sp);
    }
    index = { exact: new Set(ab.species), integers };
    speciesIndexes.set(ab.species, index);
  }
  return index;
}

/** The abundance table's name for a species named in the events file: the
    name itself when the table has it; otherwise, for an integer-like name,
    the one table species with the same canonical integer form; else null. */
export function matchSpeciesName(ab, name) {
  if (!ab?.species || name == null) return null;
  const index = speciesIndex(ab);
  if (index.exact.has(name)) return name;
  const c = canonicalIntegerName(name);
  return c == null ? null : index.integers.get(c) ?? null;
}

/** The table species an introduced-species list names (matchSpeciesName);
    names matching nothing are left out. */
export function introducedSpeciesSet(ab, introduced) {
  const out = new Set();
  for (const name of introduced || []) {
    const sp = matchSpeciesName(ab, name);
    if (sp != null) out.add(sp);
  }
  return out;
}

/* ---- Sample names of the events file ---- */

// Per sample list: the names as given, and their case- and whitespace-
// insensitive forms (first column wins). Built once per table rather than
// scanning ab.samples twice per call: this runs for every event whenever
// the events are derived, i.e. on every verdict click.
const sampleIndexes = new WeakMap();

/** Resolve a sample name against the abundance table's known samples.
    Tries exact, then case-insensitive and trimmed match. Returns the
    canonical key into ab.matrix[sp][...], or null if no reasonable match. */
export function resolveSample(ab, name) {
  if (!ab || !name) return null;
  let index = sampleIndexes.get(ab.samples);
  if (!index) {
    const loose = new Map();
    for (const s of ab.samples) {
      const k = s.toLowerCase().trim();
      if (!loose.has(k)) loose.set(k, s);
    }
    index = { exact: new Set(ab.samples), loose };
    sampleIndexes.set(ab.samples, index);
  }
  if (index.exact.has(name)) return name;
  return index.loose.get(String(name).toLowerCase().trim()) || null;
}

/** Number of species observed (relative abundance > 0) in each sample,
    keyed by the table's own sample names. */
export function speciesCountsBySample(ab) {
  const counts = {};
  for (const sample of ab.samples) {
    let n = 0;
    for (const sp of ab.species) {
      if ((ab.matrix[sp]?.[sample] || 0) > 0) n++;
    }
    counts[sample] = n;
  }
  return counts;
}

/** An event's introduced %: its introduced species as a share of the
    species observed in its target (`counts` from speciesCountsBySample).
    The target is found through resolveSample, as the scatter finds it.
    null when nothing is loaded or the target is not in the table. */
export function introducedPercent(ab, counts, event) {
  if (!counts || !Array.isArray(event.introduced)) return null;
  const key = resolveSample(ab, event.target);
  const total = key == null ? 0 : counts[key];
  return total > 0 ? (event.introduced.length / total) * 100 : null;
}
