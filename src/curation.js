/* ---------- sample-level curation rules ----------

   Every event evaluation (true positive / false positive / uncertain /
   pending) is evidence about the sample the event TARGETS. Next to the
   event evaluations the interface keeps, per sample, a verdict and a
   downstream action:

     sampleCuration[sampleId] = {
       verdict?: "contaminated" | "correct" | "uncertain",
       action?: "keep" | "suppress",
       notes?: string,
       verdictAuto?: true,   // verdict derived from the events (rule below)
       actionAuto?: true,    // action paired with the verdict (rule below)
     }

   A value WITHOUT its *Auto flag is the curator's own decision: no rule
   ever changes it. Automatic values are recomputed from scratch, from
   every event that targets the sample, so the outcome never depends on
   the order of the clicks that led to it.

     verdict  any event TP            → contaminated
              else any Uncertain      → uncertain
              else any FP             → correct (not contaminated)
              else (all pending)      → none (an automatic one is removed)
     action   contaminated, no action → suppress (automatic)
              not contaminated        → an automatic action is removed

   Everything here is pure, so the rule table is unit-tested once and the
   app applies the very same rule on every path that changes an event
   evaluation: a click, a keyboard shortcut, the gallery, the bulk dialog,
   both presets, the Network node popover, a reset.

   The module also holds what the readers share: the default of a sample
   no event targets (buildEffectiveSampleCuration), what a click on a
   sample's verdict or action chip does in every view (verdictChipState,
   actionChipState), the keep / suppress counts (sampleActionCounts) and
   the migration of stored sessions (migrateSampleCuration).

   Each of the three automatic rules is a switch (Configuration →
   Automatic sample decisions), saved with the session:

     verdictFromEvents     the verdict rule above: a sample's verdict
                           follows the evaluations of its events;
     suppressContaminated  the action rule above: Suppress goes with a
                           Contaminated verdict, automatic or not;
     neverTargetedDefault  a sample no event targets is Not contaminated
                           + Keep by default (buildEffectiveSampleCuration).

   Every function here takes the session's rules (`rules`, all on by
   default: the model of every session saved before the switches) and
   applies only the rules that are on. A rule that is off writes nothing
   and clears nothing: the value it would derive is the curator's to set.
   Switched off, a rule leaves none of its values behind — they are
   cleared or made the curator's own (clearRuleValues, keepRuleValues);
   switched on, it is applied to every sample again (applyRule). */

/** The three rules, in the order Configuration lists them. */
export const CURATION_RULES = Object.freeze([
  "verdictFromEvents",
  "suppressContaminated",
  "neverTargetedDefault",
]);

/** Every rule on: today's model, and that of every session saved before
    the rules could be switched off. */
export const DEFAULT_CURATION_RULES = Object.freeze({
  verdictFromEvents: true,
  suppressContaminated: true,
  neverTargetedDefault: true,
});

/** True when `rule` is on in `rules` (a rule `rules` does not name is
    on). */
export const ruleOn = (rules, rule) => rules?.[rule] !== false;

/** The rules as a session keeps them: true / false for each of
    CURATION_RULES, a rule `raw` does not set (or sets to anything but
    false) on — a session saved before the switches has every rule on.
    `raw` itself when it already holds a true / false for each rule, so a
    session read back keeps the very object it was saved with. */
export function normalizeCurationRules(raw) {
  const obj = raw !== null && typeof raw === "object" && !Array.isArray(raw);
  if (obj && CURATION_RULES.every((r) => typeof raw[r] === "boolean")) return raw;
  const out = {};
  for (const r of CURATION_RULES) out[r] = !(obj && raw[r] === false);
  return CURATION_RULES.every((r) => out[r]) ? DEFAULT_CURATION_RULES : out;
}

/** A stored verdict / action that counts as set. "pending" is how the
    pickers spell "no verdict" and is never stored on purpose, but older
    session files may carry it. The one rule of every module. */
export const isSet = (v) => v != null && v !== "" && v !== "pending";

/** True when the curator set the sample's verdict by hand. */
export const hasManualVerdict = (entry) =>
  isSet(entry?.verdict) && !entry.verdictAuto;

/** True when the curator set the sample's action by hand. */
export const hasManualAction = (entry) =>
  isSet(entry?.action) && !entry.actionAuto;

/** The automatic sample verdict from the tally of the evaluations of the
    events that target it ({ tp, fp, uncertain } — pending ones do not
    count). null when nothing has been evaluated yet. */
export function autoVerdictFromCounts(counts) {
  const c = counts || {};
  if (c.tp > 0) return "contaminated";
  if (c.uncertain > 0) return "uncertain";
  if (c.fp > 0) return "correct";
  return null;
}

/** The automatic sample verdict from the evaluations (event `verdict`
    strings) of the events that target it. */
export function autoSampleVerdict(evaluations) {
  const c = { tp: 0, fp: 0, uncertain: 0 };
  for (const v of evaluations || []) {
    if (v === "true_positive") c.tp++;
    else if (v === "false_positive") c.fp++;
    else if (v === "uncertain") c.uncertain++;
  }
  return autoVerdictFromCounts(c);
}

// Event arrays are never mutated in place (every change builds a new
// array), so the per-target index can be cached on the array itself.
// A bulk sample edit then indexes the events once instead of scanning
// them once per sample.
const evaluationIndex = new WeakMap();

/** Evaluations of the events grouped by target sample:
    Map<targetId, verdict[]>. */
export function evaluationsByTarget(events) {
  if (!events) return new Map();
  const cached = evaluationIndex.get(events);
  if (cached) return cached;
  const index = new Map();
  for (const e of events) {
    if (!e?.target) continue;
    let list = index.get(e.target);
    if (!list) {
      list = [];
      index.set(e.target, list);
    }
    list.push(e.verdict || "pending");
  }
  evaluationIndex.set(events, index);
  return index;
}

/** The automatic verdict of one sample, from ALL the events that target
    it. */
export function autoVerdictOf(events, sampleId) {
  return autoSampleVerdict(evaluationsByTarget(events).get(sampleId));
}

function sameEntry(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/** One sample entry brought in line with the rule, given the automatic
    verdict its events call for. Manual values are kept as they are;
    automatic ones are recomputed. A rule that is off in `rules` leaves
    its field as it is: with verdictFromEvents off, the verdict (and
    `autoVerdict` is not read); with suppressContaminated off, the
    action. Returns `entry` itself when nothing changes, and null when
    nothing is left worth storing (no verdict, no action, no notes). */
export function syncSampleEntry(entry, autoVerdict, rules = DEFAULT_CURATION_RULES) {
  const cur = entry || {};
  const next = { ...cur };
  if (ruleOn(rules, "verdictFromEvents") && !hasManualVerdict(cur)) {
    delete next.verdict;
    delete next.verdictAuto;
    if (autoVerdict) {
      next.verdict = autoVerdict;
      next.verdictAuto = true;
    }
  }
  if (ruleOn(rules, "suppressContaminated") && !hasManualAction(cur)) {
    delete next.action;
    delete next.actionAuto;
    if (next.verdict === "contaminated") {
      next.action = "suppress";
      next.actionAuto = true;
    }
  }
  if (next.verdict == null && next.action == null && !next.notes) return null;
  return entry && sameEntry(entry, next) ? entry : next;
}

/** `curation` with `sampleId` set to `entry` (removed when null). The
    same object when the entry did not change. */
function putEntry(curation, sampleId, entry) {
  const cur = curation[sampleId];
  if (sameEntry(cur ?? null, entry)) return curation;
  const next = { ...curation };
  if (entry) next[sampleId] = entry;
  else delete next[sampleId];
  return next;
}

/** Re-apply the rule to `sampleIds` — by default to every sample that has
    an entry or that an event targets. `events` is the event list as it is
    (or will be, once a pending update lands). Only the rules on in
    `rules` apply; with neither the verdict nor the action rule on,
    nothing is derived from the events. Returns `curation` itself when
    nothing changes. */
export function syncSampleCuration(curation, events, sampleIds, rules = DEFAULT_CURATION_RULES) {
  const base = curation || {};
  const verdicts = ruleOn(rules, "verdictFromEvents");
  if (!verdicts && !ruleOn(rules, "suppressContaminated")) return base;
  const byTarget = evaluationsByTarget(events);
  const ids =
    sampleIds ?? new Set([...Object.keys(base), ...byTarget.keys()]);
  let next = null;
  for (const id of ids) {
    if (!id) continue;
    const cur = base[id];
    const synced = syncSampleEntry(
      cur,
      verdicts ? autoSampleVerdict(byTarget.get(id)) : null,
      rules,
    );
    if (synced === (cur ?? null)) continue;
    if (!next) next = { ...base };
    if (synced) next[id] = synced;
    else delete next[id];
  }
  return next || base;
}

/** Record the curator's verdict for one sample, then re-apply the rule.
    null / "pending" removes the curator's verdict: the automatic one
    (from the events) applies again — with verdictFromEvents off, the
    sample has no verdict. A Contaminated verdict is paired with Suppress
    while suppressContaminated is on. */
export function withManualVerdict(curation, sampleId, verdict, events, rules = DEFAULT_CURATION_RULES) {
  const base = curation || {};
  if (!sampleId) return base;
  const entry = { ...(base[sampleId] || {}) };
  delete entry.verdictAuto;
  if (isSet(verdict)) entry.verdict = verdict;
  else delete entry.verdict;
  return putEntry(
    base,
    sampleId,
    syncSampleEntry(
      entry,
      ruleOn(rules, "verdictFromEvents") ? autoVerdictOf(events, sampleId) : null,
      rules,
    ),
  );
}

/** Record the curator's action for one sample, then re-apply the rule.
    null removes the curator's action: a Contaminated sample then gets
    its automatic Suppress back — with suppressContaminated off, it has
    no action. */
export function withManualAction(curation, sampleId, action, events, rules = DEFAULT_CURATION_RULES) {
  const base = curation || {};
  if (!sampleId) return base;
  const entry = { ...(base[sampleId] || {}) };
  delete entry.actionAuto;
  if (isSet(action)) entry.action = action;
  else delete entry.action;
  return putEntry(
    base,
    sampleId,
    syncSampleEntry(
      entry,
      ruleOn(rules, "verdictFromEvents") ? autoVerdictOf(events, sampleId) : null,
      rules,
    ),
  );
}

/** Where a decision made on one sample written under several `names` —
    the abundance table's spelling first, then the events file's (case,
    spaces: samplesReportIndex, src/exports.js) — is written: every name
    an event targets, where the rule writes its automatic values, and
    every name that holds a value of the curator's (a verdict or an
    action set by hand, notes); the first name when none does. Such a
    sample shows the curation of all its names (samplesReportCuration: a
    Suppress wins, as in the curated table), so a decision written to one
    name only could stay hidden behind another's. `curation` is the
    effective one. */
export function sampleCurationKeys(names, curation, events) {
  const byTarget = evaluationsByTarget(events);
  const keys = names.filter((n) => {
    const c = curation?.[n];
    return byTarget.has(n) || hasManualVerdict(c) || hasManualAction(c) || !!c?.notes;
  });
  return keys.length > 0 ? keys : names.slice(0, 1);
}

/** The action a sample gets when the curator set none, from its
    effective verdict: Suppress goes with Contaminated (syncSampleEntry);
    a sample no event targets (`neverTargeted`) is kept by default while
    it is Not contaminated (buildEffectiveSampleCuration); otherwise
    none — and none where the rule is off in `rules`. */
export function automaticAction(verdict, neverTargeted = false, rules = DEFAULT_CURATION_RULES) {
  if (verdict === "contaminated") {
    return ruleOn(rules, "suppressContaminated") ? "suppress" : null;
  }
  if (neverTargeted && verdict === "correct" && ruleOn(rules, "neverTargetedDefault")) {
    return "keep";
  }
  return null;
}

/** What a click on the Keep or the Suppress chip (`chip`) of a sample
    does, given its effective entry — the same in every view:

      not active          → that action, set by hand;
      active, automatic   → the same action, made the curator's own
                            (there is nothing to clear: the rule would
                            put it straight back);
      active, set by hand → removed: the sample goes back to the rule,
                            which pairs a Contaminated sample with
                            Suppress again, and keeps a Not contaminated
                            sample no event targets by default.

    `neverTargeted` says that no event targets the sample (only the
    Samples tab lists such samples). `rules` are the session's: a rule
    that is off puts nothing back.

    Returns { active, auto, next, returnsTo }: `next` is the action to
    write with withManualAction (null removes the curator's), and
    `returnsTo`, for a removal, the action the rule leaves in its place
    (automaticAction: "suppress", "keep" or null) — what the chip's label
    must announce, since "clear" then does not mean "no action". */
export function actionChipState(
  entry,
  chip,
  { neverTargeted = false, rules = DEFAULT_CURATION_RULES } = {},
) {
  const active = entry?.action === chip;
  const auto = active && !!entry.actionAuto;
  if (!active || auto) return { active, auto, next: chip, returnsTo: undefined };
  return {
    active,
    auto,
    next: null,
    returnsTo: automaticAction(entry.verdict, neverTargeted, rules),
  };
}

/** What a click on one of the verdict chips of a sample (`chip`:
    "pending", "contaminated", "correct" or "uncertain") does, given its
    effective entry — the same in every view:

      a verdict  → that verdict, set by hand (on the automatic one: the
                   same verdict, made the curator's own);
      Pending    → the curator's verdict is removed and the rule's
                   applies again. An automatic verdict has nothing to
                   remove: the events still call for it, so it stays.

    Returns { active, auto, next, changes, returnsTo }: `next` is the
    verdict to write with withManualVerdict ("pending" removes the
    curator's), `changes` is false when the click leaves the sample as it
    is — the chip must then say why instead of promising a change — and
    `returnsTo` says what the sample's verdict is once the curator's is
    removed, under the session's `rules`: "events" (the verdict its
    events call for: verdictFromEvents), "default" (the Not contaminated
    of a sample no event targets, `neverTargeted`: neverTargetedDefault)
    or null (none: Pending). */
export function verdictChipState(
  entry,
  chip,
  { neverTargeted = false, rules = DEFAULT_CURATION_RULES } = {},
) {
  const verdict = isSet(entry?.verdict) ? entry.verdict : "pending";
  const manual = hasManualVerdict(entry);
  const active = verdict === chip;
  const auto = active && verdict !== "pending" && !manual;
  const changes = chip === "pending" ? manual : !(active && manual);
  const returnsTo = neverTargeted
    ? ruleOn(rules, "neverTargetedDefault")
      ? "default"
      : null
    : ruleOn(rules, "verdictFromEvents")
      ? "events"
      : null;
  return { active, auto, next: chip, changes, returnsTo };
}

/** The sample side of a bulk evaluation: for each target of the matched
    events, write the dialog's explicit choices as the curator's own values
    and re-apply the rule.

      targetVerdict   null → automatic (same as clicking each event);
                      "pending" → remove the curator's verdict;
                      otherwise the verdict to set.
      targetAction    undefined → automatic; null → remove the curator's
                      action; otherwise the action to set.
      skipExistingTargetVerdict / skipExistingTargetAction
                      leave alone a target whose verdict / action the
                      curator set by hand. Automatic values do not count
                      as "already set": they are the rule's, not a
                      decision.
      note            prepended to each target's notes.

    `events` is the event list once the bulk evaluation has landed.
    `rules` are the session's: "automatic" leaves a target's verdict as
    it is while verdictFromEvents is off, and its action while
    suppressContaminated is off — the dialogs then say "(no change)".

    The map is copied once, on the first target that changes, the way
    syncSampleCuration does: a copy per changed target (putEntry) made a
    bulk apply quadratic in the number of targets — 150 ms for the 900
    targets of the Sylph benchmark, 3 s for 5,000 and 18 s for 10,000. */
export function applyTargetSideEffects(
  curation,
  events,
  targets,
  opts = {},
  rules = DEFAULT_CURATION_RULES,
) {
  const base = curation || {};
  const {
    targetVerdict = null,
    targetAction,
    skipExistingTargetVerdict = false,
    skipExistingTargetAction = false,
    note = "",
  } = opts;
  const verdicts = ruleOn(rules, "verdictFromEvents");
  const byTarget = evaluationsByTarget(events);
  let next = null;
  for (const t of new Set(targets || [])) {
    if (!t) continue;
    const cur = base[t];
    const entry = { ...(cur || {}) };
    if (
      targetVerdict &&
      !(skipExistingTargetVerdict && hasManualVerdict(cur))
    ) {
      delete entry.verdictAuto;
      if (isSet(targetVerdict)) entry.verdict = targetVerdict;
      else delete entry.verdict;
    }
    if (
      targetAction !== undefined &&
      !(skipExistingTargetAction && hasManualAction(cur))
    ) {
      delete entry.actionAuto;
      if (isSet(targetAction)) entry.action = targetAction;
      else delete entry.action;
    }
    if (note) entry.notes = entry.notes ? `${note}\n\n${entry.notes}` : note;
    const synced = syncSampleEntry(
      entry,
      verdicts ? autoSampleVerdict(byTarget.get(t)) : null,
      rules,
    );
    if (sameEntry(cur ?? null, synced)) continue;
    if (!next) next = { ...base };
    if (synced) next[t] = synced;
    else delete next[t];
  }
  return next || base;
}

/** Samples no event targets: event sources that are never a target, plus
    every id of `extraSampleIds` (the abundance table's columns) that no
    event targets. Sorted. Computed over the FULL event list — a filter
    must not turn a targeted sample into a "never targeted" one.

    `tableSample` (when an abundance table is loaded: a name → its column
    in the table, or null — resolveSample, the matching the curated
    export makes) makes an event target count for the table sample it
    names under another spelling (case, whitespace). The table's "S2",
    targeted by an event written "s2", used to get the default Not
    contaminated + Keep of a sample no event targets, which the samples
    TSV and HTML report showed while the curated table dropped "S2" with
    the event's Suppress. */
export function neverTargetedSamples(events, extraSampleIds, tableSample = null) {
  const key = (id) => (tableSample && tableSample(id)) || id;
  const targeted = new Set();
  const universe = new Set();
  for (const e of events || []) {
    if (e?.source) universe.add(e.source);
    if (e?.target) {
      universe.add(e.target);
      targeted.add(key(e.target));
    }
  }
  for (const s of extraSampleIds || []) if (s) universe.add(s);
  const out = [];
  for (const id of universe) if (!targeted.has(key(id))) out.push(id);
  return out.sort();
}

/** Which defaults a sample no event targets gets, given its stored entry:
    { verdict } the default Not contaminated (it has no verdict), and
    { action } the default Keep (it has no action and is Not contaminated,
    by default or not). */
function neverTargetedDefaults(entry) {
  const verdict = !isSet(entry?.verdict);
  const action = !isSet(entry?.action) && (verdict || entry.verdict === "correct");
  return { verdict, action };
}

/** The curation every reader shows (tables, counts, colours, reports):
    the stored entries, plus the default of a sample no event targets —
    nothing calls it contaminated, so it is Not contaminated and kept.
    Both defaults are automatic values, so they never count as a decision
    and never block one: a verdict the curator sets replaces the default
    verdict (and the default Keep only goes with Not contaminated), an
    action the curator sets replaces the default action. Nothing of this
    is stored. With neverTargetedDefault off in `rules`, there is no
    default: such a sample shows what is stored, Pending and no action
    when nothing is. */
export function buildEffectiveSampleCuration(
  curation,
  neverTargeted,
  rules = DEFAULT_CURATION_RULES,
) {
  const base = curation || {};
  if (!ruleOn(rules, "neverTargetedDefault")) return base;
  let out = null;
  for (const id of neverTargeted || []) {
    const cur = base[id];
    const defaults = neverTargetedDefaults(cur);
    if (!defaults.verdict && !defaults.action) continue;
    const entry = { ...(cur || {}) };
    if (defaults.verdict) {
      entry.verdict = "correct";
      entry.verdictAuto = true;
    }
    if (defaults.action) {
      entry.action = "keep";
      entry.actionAuto = true;
    }
    if (!out) out = { ...base };
    out[id] = entry;
  }
  return out || base;
}

/* ---------- switching a rule off and on ----------

   Switched off (Configuration), a rule must leave none of its values in
   the session: they would still read "auto" or "default", still count,
   and come back or go at the next evaluation. The curator chooses, when
   the session holds any (ruleValues): clear them (clearRuleValues: back
   to Pending / no action) or keep them as their own decisions
   (keepRuleValues: the same values, set by hand). Switched on again, a
   rule is applied to every sample (applyRule). Values the curator set
   by hand are never touched, so off → keep → on and off → clear → on
   neither duplicate nor lose one of them. */

/** The values `rule` (one of CURATION_RULES) has set in the session, as
    the question that switches it off counts them:

      verdictFromEvents     the samples whose verdict comes from their
                            events, by verdict (`contaminated`, `correct`,
                            `uncertain`); `suppress` of them hold the
                            Suppress paired with that automatic
                            Contaminated, which clearing the verdicts takes
                            away with them while suppressContaminated is on;
      suppressContaminated  the samples holding the Suppress paired with
                            Contaminated (`suppress`);
      neverTargetedDefault  the samples no event targets (`neverTargeted`)
                            that show a default: `correct` the default Not
                            contaminated, `keep` the default Keep.

    `curation` is the stored one (the defaults are derived here, as
    buildEffectiveSampleCuration derives them). Returns { samples,
    contaminated, correct, uncertain, suppress, keep }, `samples` sorted. */
export function ruleValues(rule, curation, neverTargeted) {
  const base = curation || {};
  const out = { samples: [], contaminated: 0, correct: 0, uncertain: 0, suppress: 0, keep: 0 };
  if (rule === "neverTargetedDefault") {
    for (const id of neverTargeted || []) {
      const defaults = neverTargetedDefaults(base[id]);
      if (!defaults.verdict && !defaults.action) continue;
      out.samples.push(id);
      if (defaults.verdict) out.correct++;
      if (defaults.action) out.keep++;
    }
  } else if (rule === "verdictFromEvents") {
    for (const [id, c] of Object.entries(base)) {
      if (!(isSet(c?.verdict) && c.verdictAuto)) continue;
      out.samples.push(id);
      if (c.verdict === "contaminated" || c.verdict === "correct" || c.verdict === "uncertain") {
        out[c.verdict]++;
      }
      if (c.verdict === "contaminated" && c.action === "suppress" && c.actionAuto) out.suppress++;
    }
  } else if (rule === "suppressContaminated") {
    for (const [id, c] of Object.entries(base)) {
      if (!(isSet(c?.action) && c.actionAuto)) continue;
      out.samples.push(id);
      if (c.action === "suppress") out.suppress++;
    }
  }
  out.samples.sort();
  return out;
}

/** `curation` once `rule` is switched off and its values cleared: an
    automatic verdict goes (the sample is Pending) — and with it, while
    suppressContaminated is on in `rules`, the Suppress the rule had
    paired with it, since the sample is no longer Contaminated; an
    automatic Suppress goes (no action). The defaults of the samples no
    event targets are never stored: nothing changes for them, the
    effective curation no longer adds them. Values set by hand and notes
    stay; an entry left with nothing is removed. `curation` itself when
    nothing changes. */
export function clearRuleValues(rule, curation, rules = DEFAULT_CURATION_RULES) {
  const base = curation || {};
  if (rule !== "verdictFromEvents" && rule !== "suppressContaminated") return base;
  let next = null;
  for (const [id, cur] of Object.entries(base)) {
    const entry = { ...(cur || {}) };
    if (rule === "verdictFromEvents") {
      if (!cur?.verdictAuto) continue;
      delete entry.verdict;
      delete entry.verdictAuto;
      if (ruleOn(rules, "suppressContaminated") && !hasManualAction(entry)) {
        delete entry.action;
        delete entry.actionAuto;
      }
    } else {
      if (!cur?.actionAuto) continue;
      delete entry.action;
      delete entry.actionAuto;
    }
    if (!next) next = { ...base };
    if (entry.verdict == null && entry.action == null && !entry.notes) delete next[id];
    else next[id] = entry;
  }
  return next || base;
}

/** `curation` once `rule` is switched off and its values kept as the
    curator's own decisions: the same verdicts and actions, without their
    automatic flag (no "auto" tag; a Keep then counts as a Keep decision).
    The defaults of the samples no event targets (`neverTargeted`), which
    are not stored, are written: Not contaminated and / or Keep, set by
    hand. Every other value stays as it is — with verdictFromEvents kept,
    a Suppress paired with an automatic Contaminated stays the rule's
    while suppressContaminated is on, now paired with a Contaminated of
    the curator's. `curation` itself when nothing changes. */
export function keepRuleValues(rule, curation, neverTargeted) {
  const base = curation || {};
  let next = null;
  const put = (id, entry) => {
    if (!next) next = { ...base };
    next[id] = entry;
  };
  if (rule === "neverTargetedDefault") {
    for (const id of neverTargeted || []) {
      const cur = base[id];
      const defaults = neverTargetedDefaults(cur);
      if (!defaults.verdict && !defaults.action) continue;
      const entry = { ...(cur || {}) };
      if (defaults.verdict) {
        entry.verdict = "correct";
        delete entry.verdictAuto;
      }
      if (defaults.action) {
        entry.action = "keep";
        delete entry.actionAuto;
      }
      put(id, entry);
    }
    return next || base;
  }
  const flag =
    rule === "verdictFromEvents" ? "verdictAuto" : rule === "suppressContaminated" ? "actionAuto" : null;
  if (!flag) return base;
  for (const [id, cur] of Object.entries(base)) {
    if (!cur?.[flag]) continue;
    const { [flag]: _auto, ...entry } = cur;
    put(id, entry);
  }
  return next || base;
}

/** `curation` once `rule` is switched on again (`rules`: the session's
    rules, that one on): the rule applied to every sample, as if each
    event had just been evaluated — values the curator set by hand are
    never changed. The defaults of the samples no event targets are not
    stored: the effective curation adds them again. `curation` itself
    when nothing changes. */
export function applyRule(rule, curation, events, rules = DEFAULT_CURATION_RULES) {
  const base = curation || {};
  if (rule !== "verdictFromEvents" && rule !== "suppressContaminated") return base;
  return syncSampleCuration(base, events, undefined, rules);
}

/** Samples to keep and to suppress, from the effective curation.

      suppress  every sample whose action is Suppress, automatic or not —
                exactly the columns the curated abundance export drops
                (buildCuratedAbundance drops `action === "suppress"`).
      keep      Keep decisions: the automatic Keep a never-targeted sample
                gets by default is not one, so this is 0 right after
                loading.

    `ids` restricts the count to some samples (e.g. the rows on screen);
    by default every entry counts.

    `tableSample`, when an abundance table is loaded, maps a sample id to
    its column in that table, or to null when the table lacks it — the
    matching the curated export itself does. Then only the table's
    samples count: one it lacks cannot be dropped from it, and two ids
    naming one column count once (as Suppress if either says so, as the
    export drops the column). */
export function sampleActionCounts(curation, ids, tableSample) {
  const decided = new Map(); // sample (table column) → "keep" | "suppress"
  const visit = (id) => {
    const c = curation?.[id];
    const action =
      c?.action === "suppress"
        ? "suppress"
        : c?.action === "keep" && !c.actionAuto
          ? "keep"
          : null;
    if (!action) return;
    const key = tableSample ? tableSample(id) : id;
    if (key == null) return;
    if (action === "suppress" || !decided.has(key)) decided.set(key, action);
  };
  if (ids) for (const id of ids) visit(id);
  else for (const id of Object.keys(curation || {})) visit(id);
  let keep = 0;
  let suppress = 0;
  for (const action of decided.values()) {
    if (action === "suppress") suppress++;
    else keep++;
  }
  return { keep, suppress };
}

// Legacy sessions (before the sample-level model) stored the action on
// each event. A target whose events disagree resolves to the most severe
// action, as the legacy app did: its Network curation colouring painted a
// node with "the most-severe action targeting it" (suppress > keep), and
// its events TSV listed every event's action, so filtering that column on
// "suppress" dropped the sample as soon as one of its events said so.
// Only keep / suppress were ever offered; anything else is dropped.
const LEGACY_ACTION_SEVERITY = { keep: 1, suppress: 2 };

/** The sample-curation model a saved session was written under. It is
    saved with every session (the browser's autosave, the session JSON);
    a session without it was saved by an earlier version, whose model
    differed in ways a migration must undo — and only for such a session:

      - the Samples tab stamped Not contaminated + Keep, as if set by
        hand, on every sample no event targets (the same entry a curator
        now writes on purpose);
      - "Clear" on the action of a Contaminated sample left it with no
        action, and the curated abundance table kept it; the current
        model pairs such a sample with Suppress;
      - automatic values could depend on the order of the clicks, or lag
        behind a bulk change.

    2 is the model of this module. */
export const SAMPLE_CURATION_VERSION = 2;

/** A never-targeted sample's entry of a session saved by an earlier
    version, without the stamp that version wrote: its Samples tab wrote
    Not contaminated + Keep, as if by hand, on every sample no event
    targets that it displayed, and the curator may have changed the
    entry since — a note, another verdict, a verdict cleared to Pending.
    The stamp's two values are taken out whatever else the entry holds:
      - Not contaminated set by hand is the stamp's (a click on it only
        repeated it): the default gives it back, as an automatic value;
      - Keep set by hand on a sample that is not Contaminated is the
        stamp's too: that version showed the action chips on Contaminated
        samples only, so the curator never saw it, let alone chose it.
    Notes, any other verdict and a Suppress stay. Returns the entry
    itself when it holds no stamp, null when nothing is left of it. */
function withoutNeverTargetedStamp(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const next = { ...entry };
  if (next.verdict === "correct" && !next.verdictAuto) {
    delete next.verdict;
    delete next.verdictAuto;
  }
  if (next.action === "keep" && !next.actionAuto && next.verdict !== "contaminated") {
    delete next.action;
    delete next.actionAuto;
  }
  if (sameEntry(entry, next)) return entry;
  return next.verdict == null && next.action == null && !next.notes ? null : next;
}

/** Bring a stored session's sample curation in line with the current
    model, once, when it is loaded. `version` is the
    SAMPLE_CURATION_VERSION the session was saved with (missing: an
    earlier version).

      1. legacy per-event actions move to their target sample (most
         severe wins; a sample that already has an action keeps it);
      2. (earlier versions only) the Not contaminated + Keep stamps of
         never-targeted samples are taken out, also from an entry the
         curator changed since (withoutNeverTargetedStamp): that default
         is derived now (buildEffectiveSampleCuration), and a stamp,
         stored as a manual value, counted as a Keep decision and
         blocked the Contaminated → Suppress pairing. In a current
         session the same entry is the curator's decision and stays;
      3. the automatic values are recomputed with the current rule, so a
         session saved by an older version — whose automatic values could
         depend on the order of the clicks, or lag behind a bulk change —
         reads like one curated today. Manual values are not touched.
         Only the session's `rules` apply (all on: every session saved
         before the switches); a value still flagged automatic for a rule
         that is off — which only a hand-edited file holds, since
         switching a rule off clears or keeps its values — is the
         curator's (keepRuleValues);
      4. (earlier versions only) a Contaminated sample stored with no
         action — which only an explicit clear of its action could leave,
         and which the curated table kept — gets a Keep set by hand where
         the recomputed rule would pair it with Suppress: the curator's
         "do not suppress" survives, and so does the curated table.

    Returns { sampleCuration, touched, changes }. `touched` is true when
    the events carry legacy actions (which the caller strips) or the
    curation changed. `changes` (earlier versions only, null when nothing
    the curator should hear about changed) lists, sorted:
      nowSuppressed       samples the curated table now drops,
      noLongerSuppressed  samples it no longer drops,
      keptAsKeep          the samples of step 4. */
export function migrateSampleCuration(
  rawEvents,
  sampleCuration,
  version,
  rules = DEFAULT_CURATION_RULES,
) {
  const events = rawEvents || [];
  const original = sampleCuration || {};
  const earlierModel = !(Number(version) >= SAMPLE_CURATION_VERSION);
  const sc = { ...original };
  let touched = false;
  const legacy = new Map();
  for (const e of events) {
    if (!e?.action) continue;
    touched = true;
    if (!e.target || !LEGACY_ACTION_SEVERITY[e.action]) continue;
    const prev = legacy.get(e.target);
    if (
      !prev ||
      LEGACY_ACTION_SEVERITY[e.action] > LEGACY_ACTION_SEVERITY[prev]
    ) {
      legacy.set(e.target, e.action);
    }
  }
  for (const [target, action] of legacy) {
    const cur = sc[target] || {};
    if (cur.action != null) continue;
    sc[target] = { ...cur, action };
  }
  // What the session said before this load: its entries and the legacy
  // actions, which were its decisions too.
  const before = { ...sc };
  if (earlierModel) {
    const targeted = new Set();
    for (const e of events) if (e?.target) targeted.add(e.target);
    for (const id of Object.keys(sc)) {
      if (targeted.has(id)) continue;
      const cleaned = withoutNeverTargetedStamp(sc[id]);
      if (cleaned === sc[id]) continue;
      if (cleaned) sc[id] = cleaned;
      else delete sc[id];
      touched = true;
    }
  }
  let ruled = sc;
  for (const rule of ["verdictFromEvents", "suppressContaminated"]) {
    if (!ruleOn(rules, rule)) ruled = keepRuleValues(rule, ruled);
  }
  const synced = { ...syncSampleCuration(ruled, events, undefined, rules) };
  const keptAsKeep = [];
  if (earlierModel) {
    for (const id of Object.keys(before)) {
      const was = before[id];
      const now = synced[id];
      if (
        was?.verdict === "contaminated" &&
        !isSet(was.action) &&
        now?.action === "suppress" &&
        now.actionAuto
      ) {
        const { actionAuto: _paired, ...rest } = now;
        synced[id] = { ...rest, action: "keep" };
        keptAsKeep.push(id);
      }
    }
  }
  const ids = new Set([...Object.keys(original), ...Object.keys(synced)]);
  if (!touched) {
    for (const id of ids) {
      if (!sameEntry(original[id] ?? null, synced[id] ?? null)) {
        touched = true;
        break;
      }
    }
  }
  let changes = null;
  if (earlierModel) {
    const nowSuppressed = [];
    const noLongerSuppressed = [];
    for (const id of new Set([...Object.keys(before), ...ids])) {
      const was = before[id]?.action === "suppress";
      const is = synced[id]?.action === "suppress";
      if (is && !was) nowSuppressed.push(id);
      else if (was && !is) noLongerSuppressed.push(id);
    }
    if (nowSuppressed.length || noLongerSuppressed.length || keptAsKeep.length) {
      changes = {
        nowSuppressed: nowSuppressed.sort(),
        noLongerSuppressed: noLongerSuppressed.sort(),
        keptAsKeep: keptAsKeep.sort(),
      };
    }
  }
  return { sampleCuration: touched ? synced : original, touched, changes };
}
