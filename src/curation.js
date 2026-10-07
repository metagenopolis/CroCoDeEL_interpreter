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
   no event targets (buildEffectiveSampleCuration), the keep / suppress
   counts (sampleActionCounts) and the migration of stored sessions
   (migrateSampleCuration). */

/** A stored verdict / action that counts as set. "pending" is how the
    pickers spell "no verdict" and is never stored on purpose, but older
    session files may carry it. */
const isSet = (v) => v != null && v !== "" && v !== "pending";

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
    automatic ones are recomputed. Returns `entry` itself when nothing
    changes, and null when nothing is left worth storing (no verdict, no
    action, no notes). */
export function syncSampleEntry(entry, autoVerdict) {
  const cur = entry || {};
  const next = { ...cur };
  if (!hasManualVerdict(cur)) {
    delete next.verdict;
    delete next.verdictAuto;
    if (autoVerdict) {
      next.verdict = autoVerdict;
      next.verdictAuto = true;
    }
  }
  if (!hasManualAction(cur)) {
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
    (or will be, once a pending update lands). Returns `curation` itself
    when nothing changes. */
export function syncSampleCuration(curation, events, sampleIds) {
  const base = curation || {};
  const byTarget = evaluationsByTarget(events);
  const ids =
    sampleIds ?? new Set([...Object.keys(base), ...byTarget.keys()]);
  let next = null;
  for (const id of ids) {
    if (!id) continue;
    const cur = base[id];
    const synced = syncSampleEntry(cur, autoSampleVerdict(byTarget.get(id)));
    if (synced === (cur ?? null)) continue;
    if (!next) next = { ...base };
    if (synced) next[id] = synced;
    else delete next[id];
  }
  return next || base;
}

/** Record the curator's verdict for one sample, then re-apply the rule.
    null / "pending" removes the curator's verdict: the automatic one
    (from the events) applies again. */
export function withManualVerdict(curation, sampleId, verdict, events) {
  const base = curation || {};
  if (!sampleId) return base;
  const entry = { ...(base[sampleId] || {}) };
  delete entry.verdictAuto;
  if (isSet(verdict)) entry.verdict = verdict;
  else delete entry.verdict;
  return putEntry(
    base,
    sampleId,
    syncSampleEntry(entry, autoVerdictOf(events, sampleId)),
  );
}

/** Record the curator's action for one sample, then re-apply the rule.
    null removes the curator's action: a Contaminated sample then gets
    its automatic Suppress back. */
export function withManualAction(curation, sampleId, action, events) {
  const base = curation || {};
  if (!sampleId) return base;
  const entry = { ...(base[sampleId] || {}) };
  delete entry.actionAuto;
  if (isSet(action)) entry.action = action;
  else delete entry.action;
  return putEntry(
    base,
    sampleId,
    syncSampleEntry(entry, autoVerdictOf(events, sampleId)),
  );
}

/** What a click on the Keep or the Suppress chip (`chip`) of a sample
    does, given its effective entry — the same in every view:

      not active          → that action, set by hand;
      active, automatic   → the same action, made the curator's own
                            (there is nothing to clear: the rule would
                            put it straight back);
      active, set by hand → removed: the sample goes back to the rule,
                            which pairs a Contaminated sample with
                            Suppress again.

    Returns { active, auto, next, returnsTo }: `next` is the action to
    write with withManualAction (null removes the curator's), and
    `returnsTo`, for a removal, the action the rule leaves in its place
    ("suppress" on a Contaminated sample, else null) — what the chip's
    label must announce, since "clear" then does not mean "no action". */
export function actionChipState(entry, chip) {
  const active = entry?.action === chip;
  const auto = active && !!entry.actionAuto;
  if (!active || auto) return { active, auto, next: chip, returnsTo: undefined };
  return {
    active,
    auto,
    next: null,
    returnsTo: entry.verdict === "contaminated" ? "suppress" : null,
  };
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

    `events` is the event list once the bulk evaluation has landed. */
export function applyTargetSideEffects(curation, events, targets, opts = {}) {
  const base = curation || {};
  const {
    targetVerdict = null,
    targetAction,
    skipExistingTargetVerdict = false,
    skipExistingTargetAction = false,
    note = "",
  } = opts;
  const byTarget = evaluationsByTarget(events);
  let next = base;
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
    next = putEntry(
      next,
      t,
      syncSampleEntry(entry, autoSampleVerdict(byTarget.get(t))),
    );
  }
  return next;
}

/** Samples no event targets: event sources that are never a target, plus
    every id of `extraSampleIds` (the abundance table's columns) that no
    event targets. Sorted. Computed over the FULL event list — a filter
    must not turn a targeted sample into a "never targeted" one. */
export function neverTargetedSamples(events, extraSampleIds) {
  const targeted = new Set();
  const universe = new Set();
  for (const e of events || []) {
    if (e?.source) universe.add(e.source);
    if (e?.target) {
      universe.add(e.target);
      targeted.add(e.target);
    }
  }
  for (const s of extraSampleIds || []) if (s) universe.add(s);
  const out = [];
  for (const id of universe) if (!targeted.has(id)) out.push(id);
  return out.sort();
}

/** The curation every reader shows (tables, counts, colours, reports):
    the stored entries, plus the default of a sample no event targets —
    nothing calls it contaminated, so it is Not contaminated and kept.
    Both defaults are automatic values, so they never count as a decision
    and never block one: a verdict the curator sets replaces the default
    verdict (and the default Keep only goes with Not contaminated), an
    action the curator sets replaces the default action. Nothing of this
    is stored. */
export function buildEffectiveSampleCuration(curation, neverTargeted) {
  const base = curation || {};
  let out = null;
  for (const id of neverTargeted || []) {
    const cur = base[id];
    let entry = cur || {};
    if (!isSet(entry.verdict)) {
      entry = { ...entry, verdict: "correct", verdictAuto: true };
    }
    if (!isSet(entry.action) && entry.verdict === "correct") {
      entry = { ...entry, action: "keep", actionAuto: true };
    }
    if (entry === cur) continue;
    if (!out) out = { ...base };
    out[id] = entry;
  }
  return out || base;
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

/** The Not contaminated + Keep the Samples tab used to write, as if by
    hand, on every never-targeted sample it displayed: exactly those two
    values, no notes, no automatic flag. */
function isNeverTargetedStamp(entry) {
  if (!entry || entry.verdict !== "correct" || entry.action !== "keep")
    return false;
  return Object.keys(entry).every(
    (k) => k === "verdict" || k === "action" || (k === "notes" && !entry.notes),
  );
}

/** Bring a stored session's sample curation in line with the current
    model, once, when it is loaded. `version` is the
    SAMPLE_CURATION_VERSION the session was saved with (missing: an
    earlier version).

      1. legacy per-event actions move to their target sample (most
         severe wins; a sample that already has an action keeps it);
      2. (earlier versions only) the Not contaminated + Keep stamps of
         never-targeted samples are dropped: that default is derived now
         (buildEffectiveSampleCuration), and a stamp, stored as a manual
         value, counted as a Keep decision and blocked the
         Contaminated → Suppress pairing. In a current session the same
         entry is the curator's decision and stays;
      3. the automatic values are recomputed with the current rule, so a
         session saved by an older version — whose automatic values could
         depend on the order of the clicks, or lag behind a bulk change —
         reads like one curated today. Manual values are not touched;
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
export function migrateSampleCuration(rawEvents, sampleCuration, version) {
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
      if (!targeted.has(id) && isNeverTargetedStamp(sc[id])) {
        delete sc[id];
        touched = true;
      }
    }
  }
  const synced = { ...syncSampleCuration(sc, events) };
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
