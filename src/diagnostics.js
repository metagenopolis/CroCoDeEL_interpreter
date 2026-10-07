/* ============================================================================
   Pure diagnostic helpers shared by the Guided validation panel, the bulk
   dialog, the gallery and the HTML report:
     - an event's scatter (buildScatter) and its line diagnostics: the line
       fit, Spearman ρ, points above the line, the missing-species test;
     - automaticScore and its grade, and the bulk dialog's view of it;
     - cascade explanations;
     - matching the events file's names to the abundance table (samples,
       and species ids CroCoDeEL rewrote as integers);
     - CroCoDeEL's low-abundance filter, applied to a parsed table.

   They live outside App.jsx so they can be exported to the unit tests:
   App.jsx exports React components, and every non-component export there
   costs Fast Refresh its granularity (react-refresh/only-export-components).
   Nothing in this module touches React, the DOM or App.jsx — inputs are
   parsed tables (parseAbundance), events, and the relatedness record of
   App.jsx's areRelated (which reads the metadata index).
   ============================================================================ */

/* ---- The scatter of an event, and its line diagnostics ---- */

export function buildScatter(ab, event) {
  if (!ab) return null;
  const { source, target, introduced, rate } = event;
  const srcKey = resolveSample(ab, source);
  const tgtKey = resolveSample(ab, target);
  if (!srcKey || !tgtKey) {
    return {
      points: [],
      logC: null,
      source,
      target,
      error:
        (!srcKey && !tgtKey)
          ? `Neither "${source}" nor "${target}" found in abundance table`
          : !srcKey
            ? `Source sample "${source}" not found in abundance table`
            : `Target sample "${target}" not found in abundance table`,
    };
  }
  // Through matchSpeciesName, so that ids CroCoDeEL rewrote as integers
  // ("1" for the table's "001") still land on the line.
  const introducedSet = introducedSpeciesSet(ab, introduced);
  const points = [];
  ab.species.forEach((sp) => {
    const xs = ab.matrix[sp][tgtKey] || 0;
    const ys = ab.matrix[sp][srcKey] || 0;
    if (xs === 0 && ys === 0) return;
    points.push({ species: sp, x: xs, y: ys, onLine: introducedSet.has(sp) });
  });
  // Species richness = number of species observed (relative abundance > 0)
  // in each sample, both-zero species included. A property of the sample,
  // so it is counted on the table as loaded even when `ab` is the
  // low-abundance-filtered copy the diagnostics use — the same number as
  // the Samples tab. Cached per table.
  const richness = speciesCountsBySample(ab.unfiltered || ab);
  const logC = rate > 0 ? Math.log10(rate) : null;
  return {
    points,
    logC,
    source,
    target,
    sourceRichness: richness[srcKey] ?? 0,
    targetRichness: richness[tgtKey] ?? 0,
    logRange: ab.logRange || null,
  };
}

/** Complementary error function — Numerical-Recipes rational
    approximation (max abs error ~1.5e-7 over [0, ∞)). Used to convert
    a normal-approximation Z-score to a one-sided p-value. */
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? ans : 2 - ans;
}

/** Average-rank ranking — handles ties by giving each tied entry the
    mean of the rank positions they would have taken. Returns ranks in
    the original input order. */
function rankArray(arr) {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Spearman's rank correlation between source and target abundances
    across every species present in at least one of the two samples.
    A high ρ (≥ 0.7) means the two overall profiles are similar — typical
    of longitudinal / same-subject pairs where the apparent contamination
    line is biological persistence rather than mechanical transfer. */
export function spearmanRho(scatter) {
  if (!scatter || !Array.isArray(scatter.points)) return null;
  const xs = [];
  const ys = [];
  scatter.points.forEach((p) => {
    if (p.x > 0 || p.y > 0) {
      xs.push(p.x);
      ys.push(p.y);
    }
  });
  const n = xs.length;
  if (n < 3) return null;
  const rx = rankArray(xs);
  const ry = rankArray(ys);
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) ** 2;
    syy += (ry[i] - my) ** 2;
  }
  return sxx * syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

export function lineDiagnostics(scatter) {
  // An error scatter (source or target missing from the abundance table —
  // routine after a CroCoDeEL `-s2` run with one table loaded) has no
  // diagnostics at all. Its empty point list used to read as "0 species on
  // the line", a FAIL that graded the event PROBABLY NOT CONTAMINATED.
  if (!scatter || scatter.error) return null;
  const spearman = spearmanRho(scatter);
  const pts = scatter.points.filter((p) => p.onLine && p.x > 0 && p.y > 0);
  const n = pts.length;
  if (n < 2) return { n, r2: null, slope: null, decadeRange: null, spearman };
  const logs = pts.map((p) => ({ x: Math.log10(p.x), y: Math.log10(p.y) }));
  const mx = logs.reduce((s, p) => s + p.x, 0) / n;
  const my = logs.reduce((s, p) => s + p.y, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  logs.forEach((p) => {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
  });
  const slope = sxx > 0 ? sxy / sxx : 0;
  const r2 = sxx * syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  // Spread of the line in log space — how many decades of source
  // abundance the contamination line spans. A real (mechanical)
  // contamination transfers ALL species proportionally, so the line is
  // visible across many decades of abundance (typically 3+). Biological
  // similarity tends to share only the abundant species, so the
  // "apparent line" is concentrated within 1-2 decades. This is a
  // strong discriminator between TP and FP that complements R² (which
  // only measures linearity).
  const xMin = Math.min(...logs.map((p) => p.x));
  const xMax = Math.max(...logs.map((p) => p.x));
  const decadeRange = xMax - xMin;
  return { n, r2, slope, decadeRange, spearman };
}

export function pointsAboveLine(scatter) {
  if (!scatter || scatter.error || scatter.logC == null) return null;
  let above = 0;
  let maxDist = 0;
  let farAbove = 0; // points ≥ 0.5 decade above the line
  scatter.points.forEach((p) => {
    if (p.x <= 0 || p.y <= 0 || p.onLine) return;
    const threshold = Math.log10(p.x) - scatter.logC;
    const dist = Math.log10(p.y) - threshold;
    // Threshold 0.1 decade (~1.26× the predicted target abundance) —
    // matches what's visibly above the line by eye while still
    // excluding the tight noise cluster sitting almost exactly on it.
    if (dist > 0.1) {
      above++;
      if (dist > maxDist) maxDist = dist;
      if (dist >= 0.5) farAbove++;
    }
  });
  return { count: above, maxDist, farAbove };
}

/** Exact upper-tail probability P(X ≥ k) for a Poisson-binomial sum
    X = Σ Bernoulli(p_i), by dynamic programming over the p_i.

    The tail is always built as a sum of non-negative terms, never as a
    difference. It used to be `1 − P(X ≤ k−1)` whenever k was the short
    side, which cancels catastrophically once the tail drops under ~1e-16:
    a true 2.5e-20 came back as 8.9e-16, and the Validate panel printed it.

    Only one tail is ever materialised, on whichever side is shorter:
    - k small: track P(X = j) for j < k (k states) and pour, at every step,
      the mass that a success moves from k−1 to k into the tail — once
      there it never leaves, so the tail is accumulated directly;
    - k large: the complement Y = n − X (a Poisson-binomial on the 1 − p_i)
      gives P(X ≥ k) = P(Y ≤ n − k), the sum of n − k + 1 states. Y fails
      with probability p_i itself, used as is: rebuilding it as
      1 − (1 − p_i) loses every digit of a p_i below ~1e-16.
    So the cost is O(n × min(k, n−k+1)) — at most n²/2, a few milliseconds
    for the few thousand species these tables carry, and far less in the
    usual case where the miss count is small.

    Falls back to a continuity-corrected normal tail only if the DP would
    be genuinely large, which real inputs do not reach. */
export function poissonBinomialUpperTail(ps, k) {
  const n = ps.length;
  if (k <= 0) return 1;
  if (n === 0) return 0;
  if (k > n) return 0;

  const useComplement = n - k + 1 < k;
  const limit = useComplement ? n - k : k - 1;

  if ((limit + 1) * n > 5e6) {
    // Unreachable with realistic species counts; keeps the function total.
    let mean = 0;
    let variance = 0;
    for (const p of ps) {
      mean += p;
      variance += p * (1 - p);
    }
    const sd = Math.sqrt(variance);
    if (sd <= 0) return k <= mean ? 1 : 0;
    return 0.5 * erfc((k - 0.5 - mean) / (sd * Math.SQRT2));
  }

  // dist[j] = P(exactly j successes so far), truncated above `limit`.
  const dist = new Float64Array(limit + 1);
  dist[0] = 1;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    // Success / failure probabilities of the variable the DP counts.
    const p = useComplement ? 1 - ps[i] : ps[i];
    const q = useComplement ? ps[i] : 1 - ps[i];
    // X side: a success from state k−1 is mass entering "≥ k" for good.
    if (!useComplement) tail += dist[limit] * p;
    const top = Math.min(limit, i + 1);
    for (let j = top; j >= 1; j--) {
      dist[j] = dist[j] * q + dist[j - 1] * p;
    }
    dist[0] *= q;
  }
  // Y side: P(Y ≤ n − k), the plain sum of the states kept.
  if (useComplement) for (let j = 0; j <= limit; j++) tail += dist[j];
  return Math.min(1, Math.max(0, tail));
}

/** Are the source species detected in the target as the contamination
    model predicts? Poisson-binomial detection test over EVERY species
    present in the source — no abundance pre-filter is needed because
    the test self-regulates: rare species (low λ) contribute almost
    nothing to the variance and roughly equal weight to expected and
    observed missing counts, so they don't bias the Z-score. Including
    the full source profile increases statistical power vs. the older
    "top 80%" heuristic. */
export function missingAbundantFromSource(ab, source, target, rate) {
  if (!ab) return null;
  const srcKey = resolveSample(ab, source);
  const tgtKey = resolveSample(ab, target);
  if (!srcKey || !tgtKey) return null;

  // Adaptive empirical LOD for the target — the smallest non-zero
  // abundance observed in this specific sample. Falls back to a
  // conservative 1e-5 if the target has zero or one species: a lone
  // species normalises to exactly 1, an "LOD" of one read under which
  // every source species is expected to be missed — so 29 misses out of
  // 30 used to pass as Poisson noise (p ≈ 0.996).
  const targetValues = [];
  ab.species.forEach((sp) => {
    const v = ab.matrix[sp][tgtKey] || 0;
    if (v > 0) targetValues.push(v);
  });
  const targetLOD = targetValues.length >= 2 ? Math.min(...targetValues) : 1e-5;

  // Poisson-binomial detection test — we model the target as a count
  // process with depth N ≈ 1 / target_LOD (since the LOD is roughly the
  // smallest detectable relative abundance, ≈ 1 read out of N). For each
  // source species the expected number of reads under H_real (genuine
  // contamination at this rate) is λ = N × rate × source = expected /
  // target_LOD. The probability the species is missed by Poisson sampling
  // alone is e^(-λ); the probability of being detected is 1 - e^(-λ).
  // Across all evaluable species the number of misses is a Poisson-
  // binomial sum — its mean is Σ p_miss and its variance is
  // Σ p_miss × p_detect. We compare the observed miss count to that
  // expectation (one-sided normal approximation) and report a p-value.
  let missing = 0;
  let expectedMissing = 0;
  let variance = 0;
  let evaluated = 0;
  let coreSize = 0;
  const missProbs = [];
  ab.species.forEach((sp) => {
    const ys = ab.matrix[sp][srcKey] || 0;
    if (ys <= 0) return;
    coreSize++;
    const xs = ab.matrix[sp][tgtKey] || 0;
    const expected = (rate || 0) * ys;
    if (expected <= 0) return;
    const lambda = expected / targetLOD;
    const pMiss = Math.exp(-lambda);
    expectedMissing += pMiss;
    variance += pMiss * (1 - pMiss);
    missProbs.push(pMiss);
    evaluated++;
    if (xs < targetLOD) missing++;
  });
  const sigma = Math.sqrt(variance);
  const zScore = sigma > 0 ? (missing - expectedMissing) / sigma : 0;
  // One-sided p-value: P(X ≥ missing) under H_real. The normal
  // approximation `0.5 × erfc(z/√2)` that used to stand here is badly
  // wrong in exactly the regime this test lives in — most λ are ≪ 1, so
  // the Poisson-binomial is heavily skewed and nowhere near normal. It
  // reported p = 3.3e-167 where the exact value is 1.9e-23, and it flipped
  // the 0.05 decision on real events. The exact DP is O(n × tail) with n a
  // few hundred, so there is no reason to approximate.
  const pValue = poissonBinomialUpperTail(missProbs, missing);
  return {
    count: missing,
    evaluated,
    targetLOD,
    coreSize,
    expectedMissing,
    sigma,
    zScore,
    pValue,
  };
}

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
  // evaluated — 0 when nothing could be scored (grade "not_evaluable": the
  // callers suppress the banner or say why) instead of a red "0 / 6 —
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

/** The bulk dialog's criteria for one event — its eventCriteria memo is
    this function mapped over the events, so the unit tests run the
    dialog's own code. The event is evaluated as Guided validation
    evaluates the selected one (AppMain's memos): its scatter on `ab` (the
    table the diagnostics use), the line diagnostics, the points above the
    line, the missing-species test and automaticScore, read through
    bulkCriteria. `relatedness` is areRelated(metadata, source, target),
    null without metadata. Returns null when the pair cannot be evaluated —
    no table, or a sample missing from it — which neither the pass nor the
    fail pick matches. */
export function eventBulkCriteria(ab, event, relatedness) {
  const scatter = buildScatter(ab, event);
  if (!scatter || scatter.error) return null;
  return bulkCriteria(
    automaticScore(
      lineDiagnostics(scatter),
      pointsAboveLine(scatter),
      missingAbundantFromSource(ab, event.source, event.target, event.rate),
      event.cascade,
      relatedness,
    ),
  );
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

// Per matrix: the species count of every sample (see below).
const speciesCounts = new WeakMap();

/** Number of species observed (relative abundance > 0) in each sample,
    keyed by the table's own sample names. Computed once per table — the
    scatter reads it for every event — so treat the result as read-only. */
export function speciesCountsBySample(ab) {
  let counts = speciesCounts.get(ab.matrix);
  if (!counts) {
    counts = {};
    for (const sample of ab.samples) {
      let n = 0;
      for (const sp of ab.species) {
        if ((ab.matrix[sp]?.[sample] || 0) > 0) n++;
      }
      counts[sample] = n;
    }
    speciesCounts.set(ab.matrix, counts);
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

/* ---- CroCoDeEL's low-abundance filter (--filter-low-ab) ---- */

/** The --filter-low-ab factor a CroCoDeEL run declares in its header
    (`filtering_ab_thr_factor: 20.0`), or null when the run did not filter:
    no header, "None", or a factor ≤ 0 (which zeroes nothing). */
export function lowAbundanceFilterFactor(runMetadata) {
  const raw = runMetadata?.filtering_ab_thr_factor;
  if (raw == null || String(raw).trim() === "") return null;
  const factor = Number(raw);
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

// A value within this relative distance of the threshold counts as ON it
// (and is zeroed, as upstream's `<=` does on a raw tie). What this does and
// does not reproduce exactly is spelled out in applyLowAbundanceFilter.
const LOW_AB_TIE_TOLERANCE = 1e-12;

/** CroCoDeEL's low-abundance filter, applied to a parsed abundance table.

    Upstream (ab_table_utils.filter_low_ab, then normalize) sets to 0, in
    each sample, every value ≤ factor × the sample's smallest positive
    value, then rescales each sample to sum to 1 — before anything is
    fitted. The diagnostics must see the table the run saw: otherwise the
    line, the points above it and the missing-species test are judged on
    species CroCoDeEL had discarded.

    The parsed table only holds per-sample fractions v / S, not the raw
    values CroCoDeEL compared. In exact arithmetic that changes nothing:
    the threshold is relative to the sample's own minimum m, so the
    division moves values and threshold together — v / S ≤ f × m / S ⇔
    v ≤ f × m — and the rescaled survivors are the same,
    (v / S) / Σ(kept v / S) = v / Σ kept v. In floating point the two can
    only disagree on an exact tie, a value equal to f × m:
      - raw integers (20 reads against a minimum of 1, at 20×): upstream
        zeroes every tie, while the fractions can land one ulp either side
        of the threshold. So the comparison treats a relative 1e-12 as a
        tie and zeroes it — far above that rounding, far below any real
        gap between two abundances;
      - raw decimals: upstream's own product f × m may round below v —
        20 × 0.00007 is 0.0013999999999999998, under 0.0014 — and then
        CroCoDeEL KEEPS the tie. That happens to 13 % of the exact ties
        between 5-decimal values (MetaPhlAn's format), and the raw values
        it hinges on are gone from the parsed table, so such a species,
        the one sitting at its sample's threshold, is zeroed here. The
        bundled MetaPhlAn4 run (20×) has 13 exact ties, all zeroed
        upstream as here: all 939,600 cells match;
      - a run made with this app's in-browser runner reads the table as
        abundanceToTSV writes it: the input's own values when the parsed
        table kept its column sums (counts as integers, decimals of up to
        15 significant digits exactly, longer ones within one double), so
        it filters what the CLI would, and the two cases above apply —
        on five bundled tables at 20× (demo, MetaPhlAn4, Sylph, Meteor,
        PRJEB32731), every cell is kept or zeroed as the CLI does from
        the input file. A table restored from a session saved before the
        column sums were kept is sent as its fractions, which the run
        then filters: the same in exact arithmetic, a value at its
        sample's threshold aside (3 cells of 1.35 million fall the other
        way on the Sylph table at 20×).

    Returns a new table sharing `samples` and `species` with `ab`; its
    matrix holds only the non-zero cells (every reader already does
    `matrix[sp][s] || 0`, as for a table restored from storage). `logRange`
    covers both tables, so toggling the filter does not rescale the plots.
    `unfiltered` is the table as loaded, for plain sample statistics such
    as richness; `lowAbFilter` is the factor. A sample with no value above
    its threshold comes out empty (upstream divides 0 by 0 there). */
export function applyLowAbundanceFilter(ab, factor) {
  if (!ab || !(factor > 0)) return ab;
  const { samples, species, matrix } = ab;
  // Per sample: smallest positive value → threshold.
  const threshold = {};
  for (const s of samples) threshold[s] = Infinity;
  for (const sp of species) {
    const row = matrix[sp];
    for (const s in row) {
      const v = row[s];
      if (v > 0 && v < threshold[s]) threshold[s] = v;
    }
  }
  for (const s of samples) threshold[s] *= factor * (1 + LOW_AB_TIE_TOLERANCE);
  // Keep what lies above it, and total it per sample… Rows have no
  // prototype: most lookups into this sparse matrix miss, and a miss on a
  // plain object also searches Object.prototype — the scatter of every
  // event at load ran 75 % slower on the filtered table than on the dense
  // one before this.
  const total = {};
  for (const s of samples) total[s] = 0;
  const filtered = {};
  for (const sp of species) {
    const row = matrix[sp];
    const kept = Object.create(null);
    for (const s in row) {
      const v = row[s];
      if (v > threshold[s]) {
        kept[s] = v;
        total[s] += v;
      }
    }
    filtered[sp] = kept;
  }
  // …then rescale each sample to sum to 1.
  let minVal = Infinity;
  let maxVal = -Infinity;
  for (const sp of species) {
    const kept = filtered[sp];
    for (const s in kept) {
      const v = kept[s] / total[s];
      kept[s] = v;
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
  }
  const range = ab.logRange || { min: -8, max: 0 };
  const logRange = Number.isFinite(minVal)
    ? {
        min: Math.min(range.min, Math.floor(Math.log10(minVal))),
        max: Math.max(range.max, Math.min(0, Math.ceil(Math.log10(maxVal)))),
      }
    : range;
  return { ...ab, matrix: filtered, logRange, unfiltered: ab, lowAbFilter: factor };
}
