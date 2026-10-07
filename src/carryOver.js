/* ---------- replacing the events file without losing the curation ----------

   A curator who loads another events file into a session that holds
   curation — a rerun of CroCoDeEL, the run page's result, or the curated
   events TSV of the Export tab reloaded — used to lose every evaluation,
   note and sample decision, without being asked. replaceEvents builds the
   new session instead, in one of two ways the curator picks:

     carry over   an event of the new file that has the same source and
                  target as a current one takes its evaluation and notes
                  (duplicate pairs are matched in file order); an event
                  the curator added by hand (Explore new pairs: a false
                  negative CroCoDeEL missed, which no rerun can hold) is
                  kept when the new file does not have its pair; the
                  sample verdicts, actions and notes the curator set by
                  hand stay for every sample still present — in the new
                  events or in the abundance table;
     start fresh  nothing of the current session is kept.

   Either way the new file's own curation columns (the curated events TSV:
   parseEvents reads verdict, notes and the target's action) are used, and
   where the file and the session both have a value, THE FILE WINS: a
   curator who loads a curated export into a session is restoring that
   export, and it is the most recent statement they chose to load. An
   empty cell — a pending verdict, no note, no action — carries no
   decision, so it never erases one of the session's.

   Then the automatic sample values are recomputed from every event with
   the shared rule (syncSampleCuration, src/curation.js), and the file's
   actions applied: a target whose rows all give the same keep / suppress,
   different from the action the rule (or the curator) leaves it, gets it
   as the curator's own value. An export reloaded into an empty session
   thus comes back exactly as it was exported: evaluations, notes, sample
   actions and so every count and the curated abundance table. What the
   events TSV does not hold — sample verdicts and notes set by hand, the
   action of a sample no event targets — only the session JSON keeps. */

import {
  hasManualAction,
  hasManualVerdict,
  syncSampleCuration,
  withManualAction,
} from "./curation.js";

const isSet = (v) => v != null && v !== "" && v !== "pending";
const pairKey = (e) => `${e.source}\u0000${e.target}`;
/** An event the curator added by hand (addManualEvent: ids "manual-N"). */
export const isManualEvent = (e) => typeof e?.id === "string" && e.id.startsWith("manual-");
/** A note as a TSV cell holds it: one line (tsvCell, src/parsing.js),
    trimmed like every cell parseEvents reads. */
const asCell = (notes) => String(notes || "").replace(/[\t\r\n]+/g, " ").trim();

/** What the session holds that replacing its events would affect:
    evaluated events, events with notes, and samples with a verdict, an
    action or notes set by hand. `any` is false for a session with
    nothing to lose. */
export function curationSummary(events, sampleCuration) {
  let evaluations = 0;
  let notes = 0;
  for (const e of events || []) {
    if (isSet(e.verdict)) evaluations++;
    if (e.notes) notes++;
  }
  let sampleEntries = 0;
  for (const entry of Object.values(sampleCuration || {})) {
    if (hasManualVerdict(entry) || hasManualAction(entry) || entry?.notes) sampleEntries++;
  }
  return {
    evaluations,
    notes,
    sampleEntries,
    any: evaluations + notes + sampleEntries > 0,
  };
}

/** The curator's own part of a sample entry — a verdict or an action set
    by hand, notes — or null when it has none. */
function manualPart(entry) {
  const out = {};
  if (hasManualVerdict(entry)) out.verdict = entry.verdict;
  if (hasManualAction(entry)) out.action = entry.action;
  if (entry?.notes) out.notes = entry.notes;
  return Object.keys(out).length > 0 ? out : null;
}

/** The session that replacing the events with `newEvents` (parseEvents'
    events, with their own verdict / notes / fileAction when the file has
    curation columns) leaves.

      oldEvents, oldSampleCuration   the current session
      sampleIds                      the abundance table's samples (a
                                     sample there is still present)
      carryOver                      true: carry the session's curation
                                     over; false: start fresh
      fileHasCuration                the file has curation columns
                                     (parseEvents' `curation`), even if
                                     every cell of them is empty

    Returns { events, sampleCuration, report }. `events` are the new
    file's, in its order and with its ids, `fileAction` removed (it now
    lives in the sample curation), then — carried over — the events added
    by hand whose pair the file does not have, renumbered manual-1, …
    `report` counts what happened, for replaceReportLines (and, computed
    before the choice, for the question that offers it). */
export function replaceEvents({
  oldEvents,
  oldSampleCuration,
  newEvents,
  sampleIds,
  carryOver,
  fileHasCuration = false,
}) {
  const report = {
    carryOver: !!carryOver,
    total: (newEvents || []).length,
    matched: 0,
    added: 0,
    dropped: 0,
    droppedCurated: 0,
    keptManual: 0,
    manual: (oldEvents || []).filter(isManualEvent).length,
    keptVerdicts: 0,
    keptNotes: 0,
    fileVerdicts: 0,
    fileNotes: 0,
    notesFromFile: 0,
    replacedVerdicts: 0,
    replacedNotes: 0,
    keptSampleEntries: 0,
    droppedSampleEntries: 0,
    fileActions: 0,
    replacedActions: 0,
    conflictingActions: 0,
    fileHasCuration: !!fileHasCuration,
    previous: curationSummary(oldEvents, oldSampleCuration),
  };

  // The current events by (source, target), in file order.
  const queues = new Map();
  if (carryOver) {
    for (const e of oldEvents || []) {
      const k = pairKey(e);
      if (!queues.has(k)) queues.set(k, []);
      queues.get(k).push(e);
    }
  }

  const events = (newEvents || []).map((ne) => {
    const { fileAction: _fileAction, ...base } = ne;
    const fileVerdict = isSet(ne.verdict) ? ne.verdict : null;
    const fileNotes = ne.notes || "";
    if (fileVerdict) report.fileVerdicts++;
    if (fileNotes) report.fileNotes++;
    if (fileVerdict || fileNotes || ne.fileAction) report.fileHasCuration = true;
    let verdict = fileVerdict || "pending";
    let notes = fileNotes;
    let notesFromFile = !!fileNotes;
    const old = carryOver ? queues.get(pairKey(ne))?.shift() : undefined;
    if (old) {
      report.matched++;
      if (isSet(old.verdict)) {
        if (!fileVerdict) {
          verdict = old.verdict;
          report.keptVerdicts++;
        } else if (fileVerdict !== old.verdict) {
          report.replacedVerdicts++;
        }
      }
      if (old.notes) {
        // The file's copy of a note written over several lines is the
        // same note on one line: the session's own is kept.
        if (!fileNotes || asCell(old.notes) === asCell(fileNotes)) {
          notes = old.notes;
          notesFromFile = false;
          if (!fileNotes) report.keptNotes++;
        } else {
          report.replacedNotes++;
        }
      }
    } else if (carryOver) {
      report.added++;
    }
    if (notesFromFile) report.notesFromFile++;
    return { ...base, verdict, notes };
  });
  // The current events the new file has no pair for: dropped, except the
  // ones added by hand, kept after the file's events in their order.
  const unmatched = new Set();
  for (const left of queues.values()) left.forEach((e) => unmatched.add(e));
  for (const e of oldEvents || []) {
    if (!unmatched.has(e)) continue;
    if (isManualEvent(e)) {
      report.keptManual++;
      events.push({ ...e, id: `manual-${report.keptManual}` });
      continue;
    }
    report.dropped++;
    if (isSet(e.verdict) || e.notes) report.droppedCurated++;
  }

  // The curator's own sample values, for the samples still present.
  let sampleCuration = {};
  if (carryOver) {
    const present = new Set(sampleIds || []);
    for (const e of events) {
      if (e.source) present.add(e.source);
      if (e.target) present.add(e.target);
    }
    for (const [id, entry] of Object.entries(oldSampleCuration || {})) {
      const part = manualPart(entry);
      if (!part) continue;
      if (present.has(id)) {
        sampleCuration[id] = part;
        report.keptSampleEntries++;
      } else {
        report.droppedSampleEntries++;
      }
    }
  }

  // Every automatic value from the events, with the shared rule.
  sampleCuration = syncSampleCuration(sampleCuration, events);

  // The file's actions: one per target, when all its rows agree.
  const fileActions = new Map();
  for (const ne of newEvents || []) {
    if (!ne.target) continue;
    const a = ne.fileAction || "";
    if (!fileActions.has(ne.target)) fileActions.set(ne.target, a);
    else if (fileActions.get(ne.target) !== a) fileActions.set(ne.target, null);
  }
  for (const [target, action] of fileActions) {
    if (action === null) {
      report.conflictingActions++;
      continue;
    }
    if (!action) continue;
    // A target is never "never targeted": its stored entry is the one
    // every view shows (buildEffectiveSampleCuration adds nothing to it).
    const current = sampleCuration[target];
    if ((current?.action || null) === action) continue;
    if (hasManualAction(current)) report.replacedActions++;
    sampleCuration = withManualAction(sampleCuration, target, action, events);
    report.fileActions++;
  }
  if (report.fileActions > 0 || report.conflictingActions > 0) report.fileHasCuration = true;

  return { events, sampleCuration, report };
}

/** The run header after another events file replaced the current one:
    { runMetadata, study, kept }.

    The curated events TSV of the Export tab starts with "# study: …",
    which parseEvents reads with the run parameters: it is the study's
    title (`study`), not a parameter of the run. Such a file has no
    CroCoDeEL run header at all. Carried over — the same study — the
    session keeps its own (`kept`), and with it the low-abundance filter
    factor the diagnostics apply and the cutoffs: it used to be replaced
    by { study }, which changed the diagnostics of a curated export
    reloaded into the session it came from. A file with a run header (a
    rerun) brings its own. */
export function replacedRunMetadata(fileRunMetadata, sessionRunMetadata, carryOver) {
  const { study, ...runKeys } = fileRunMetadata || {};
  const fileRun = Object.keys(runKeys).length > 0 ? runKeys : null;
  const kept = !!(carryOver && !fileRun && sessionRunMetadata);
  return {
    runMetadata: kept ? sessionRunMetadata : fileRun,
    study: typeof study === "string" && study.trim() ? study.trim() : null,
    kept,
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a replacement did, in a few sentences for the banner that
    follows it. Empty when there is nothing to say (a CroCoDeEL output
    loaded into a session without curation). */
export function replaceReportLines(report) {
  const r = report;
  const lines = [];
  const prev = r.previous || { evaluations: 0, notes: 0, sampleEntries: 0, any: false };
  if (r.carryOver) {
    lines.push(
      `${plural(r.total, "event")} in the new file: ${r.matched} matched an event of your session ` +
        `(same source and target), ${plural(r.added, "new one", "new ones")}.`,
    );
    if (r.dropped > 0) {
      lines.push(
        `${plural(r.dropped, "event")} of your session ${r.dropped === 1 ? "is" : "are"} not in the new file` +
          (r.droppedCurated > 0
            ? `: the evaluations and notes of ${r.droppedCurated} of them were dropped.`
            : "."),
      );
    }
    if (r.keptManual > 0) {
      lines.push(
        `${plural(r.keptManual, "event")} you added by hand (Explore new pairs) ` +
          `${r.keptManual === 1 ? "is" : "are"} not in the new file: kept, with ` +
          `${r.keptManual === 1 ? "its evaluation and notes" : "their evaluations and notes"}.`,
      );
    }
    const kept = [];
    if (r.keptVerdicts) kept.push(plural(r.keptVerdicts, "evaluation"));
    if (r.keptNotes) kept.push(plural(r.keptNotes, "note"));
    if (r.keptSampleEntries) kept.push(plural(r.keptSampleEntries, "sample decision"));
    if (kept.length) lines.push(`Kept from your session: ${kept.join(", ")}.`);
    if (r.droppedSampleEntries > 0) {
      lines.push(
        `${plural(r.droppedSampleEntries, "sample decision")} of samples no longer present ` +
          `(in the new events or the abundance table) ${r.droppedSampleEntries === 1 ? "was" : "were"} dropped.`,
      );
    }
  } else if (prev.any) {
    const lost = [];
    if (prev.evaluations) lost.push(plural(prev.evaluations, "evaluation"));
    if (prev.notes) lost.push(plural(prev.notes, "note"));
    if (prev.sampleEntries) lost.push(plural(prev.sampleEntries, "sample decision"));
    if (r.manual) lost.push(`${plural(r.manual, "event")} added by hand`);
    lines.push(`Started fresh: your previous curation (${lost.join(", ")}) was dropped.`);
  }
  if (r.fileHasCuration) {
    const restored = [];
    if (r.fileVerdicts) restored.push(plural(r.fileVerdicts, "evaluation"));
    if (r.fileNotes) restored.push(plural(r.fileNotes, "note"));
    if (r.fileActions) restored.push(plural(r.fileActions, "sample action"));
    if (restored.length) {
      const replaced = [];
      if (r.replacedVerdicts) replaced.push(plural(r.replacedVerdicts, "evaluation"));
      if (r.replacedNotes) replaced.push(plural(r.replacedNotes, "note"));
      if (r.replacedActions) replaced.push(plural(r.replacedActions, "sample action"));
      lines.push(
        `Restored from the file: ${restored.join(", ")}` +
          (replaced.length ? ` (the file's value replaced yours on ${replaced.join(", ")})` : "") +
          ".",
      );
    }
    if (r.conflictingActions > 0) {
      lines.push(
        `${plural(r.conflictingActions, "target")} whose rows give different actions ` +
          `${r.conflictingActions === 1 ? "was" : "were"} left to the automatic rule.`,
      );
    }
    if (r.notesFromFile > 0) {
      lines.push(
        "Notes read from the file are on one line, as the events TSV holds them (line breaks and tabs became spaces).",
      );
    }
    lines.push(
      "Sample verdicts and sample notes set by hand, and the action of a sample no event targets, " +
        "are not stored in the events TSV: only the session JSON (Download session) keeps them.",
    );
  }
  return lines;
}
