/* ---------- the stored session: records, migration, validation ----------

   The session survives a reload in IndexedDB (src/storage.js does the
   I/O; everything in this module is pure). It is kept as separate
   records, so that a change rewrites only what it touches:

     events    the events file as read: every event WITHOUT its curation
               fields (verdict, notes), the run header (runMetadata) and
               the parser's warnings. Written when a file is loaded or an
               event added, never on an evaluation.
     ab        the abundance table, sparsified, tagged with a token that
               the curation record names: a table whose write failed is
               never paired with a newer session.
     metadata  the parsed metadata.
     plate     the parsed plate map.
     curation  the curator's work: event verdicts and notes by event id,
               the sample curation and the model version it follows, the
               study title. Small, rewritten on every evaluation. It also
               carries the session's revision (rev): every write of the
               records above checks and bumps it (src/storage.js), so a
               browser tab holding an older copy cannot overwrite a newer
               one.
     ui        tab, selected event, filter and sort. Rewritten on every
               switch; last writer wins.

   The first layout kept everything but the abundance table in one record
   ("main"), rewritten whole on every change — tab switches included:
   about 130 ms of structured clone per change on the Sylph benchmark
   (15.4k events with long species lists), 0.6 s with a 4x slower CPU;
   31 ms on Meteor. It is still read, and migrated on boot
   (sessionFromLegacyMain).

   Every reader gets the same session object back:

     { rawEvents, sampleCuration, sampleCurationVersion, runMetadata,
       eventsWarnings, metadata, plateMap, ab, analysisTitle,
       tab, selId, filter, sort }

   The session JSON (Download / Import session) is the same session under
   the field names exportJSON has always written (sessionToJSON), read
   back by sessionFromPayload, which validates the whole file before
   anything replaces the current session. A stored session goes through
   the same readers at every boot (checkStoredSession): both repair what
   the earlier versions left in a session, and say so. */

import { isSet, migrateSampleCuration, SAMPLE_CURATION_VERSION } from "./curation.js";
import { remapMetadata, splitSpeciesList } from "./parsing.js";

export const LAYOUT_VERSION = 2;

export const RECORD_KEYS = {
  events: "events",
  ab: "ab",
  metadata: "metadata",
  plate: "plate",
  curation: "curation",
  ui: "ui",
};
/** The record of the first layout (everything but the abundance table). */
export const LEGACY_MAIN_KEY = "main";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/* ---------------------------------------------------------------- events */

/** The events record's copy of one event: everything but its curation. */
export function stripEventCuration(event) {
  const { verdict: _verdict, notes: _notes, ...rest } = event;
  return rest;
}

/** The evaluations and notes of the events, by event id (as a string):
    only the events that have one. */
export function eventCurationById(events) {
  const verdicts = {};
  const notes = {};
  for (const e of events || []) {
    const id = String(e.id);
    if (isSet(e.verdict)) verdicts[id] = e.verdict;
    if (e.notes) notes[id] = e.notes;
  }
  return { verdicts, notes };
}

/** The events of the events record with their curation put back. */
export function withEventCuration(events, verdicts, notes) {
  return (events || []).map((e) => {
    const id = String(e.id);
    return {
      ...e,
      verdict: (verdicts && verdicts[id]) || "pending",
      notes: (notes && notes[id]) || "",
    };
  });
}

/** True when the events differ in anything but their evaluations and
    notes (another file, an event added): the events record must then be
    written again. Events are never changed in place — an evaluation
    builds a new object and keeps the others — so only the objects that
    changed are compared, field by field (`introduced` by reference). */
export function eventInputsChanged(prev, next) {
  if (prev === next) return false;
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) {
    return true;
  }
  for (let i = 0; i < next.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (a === b) continue;
    if (!a || !b) return true;
    for (const k of Object.keys(a)) {
      if (k !== "verdict" && k !== "notes" && a[k] !== b[k]) return true;
    }
    for (const k of Object.keys(b)) {
      if (k !== "verdict" && k !== "notes" && !(k in a)) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------- abundance */

/** Drop zero / falsy entries from the abundance matrix before saving.
    Most metagenomic profiles are very sparse (a typical sample has a
    few hundred non-zero species out of thousands), so omitting the
    zeros usually shrinks the structured-clone payload 5–10×. The
    dense form is never needed downstream: every consumer reads
    `matrix[sp]?.[s] || 0` so a missing key is treated as zero exactly
    like an explicit zero. Every other field — samples, species in file
    order, logRange, warnings, firstHeader, colSums, integerCols — is
    kept as it is. */
export function sparsifyAbundance(ab) {
  if (!ab || !ab.matrix) return ab;
  const sparse = {};
  for (const sp of Object.keys(ab.matrix)) {
    const row = ab.matrix[sp];
    const sparseRow = {};
    for (const s of Object.keys(row)) {
      const v = row[s];
      if (v) sparseRow[s] = v;
    }
    sparse[sp] = sparseRow;
  }
  return { ...ab, matrix: sparse };
}

/** The ab record: the sparsified table and the token of this write. */
export function abundanceRecord(ab, token) {
  return { ...sparsifyAbundance(ab), storageToken: token ?? null };
}

/** The table of an ab record. */
export function abundanceFromRecord(record) {
  if (!isObj(record)) return null;
  const { storageToken: _token, ...ab } = record;
  return ab;
}

/* --------------------------------------------------------------- records */

/** The events record of a session (null when it has no events). */
export function eventsRecord(s) {
  if (!Array.isArray(s.rawEvents) || s.rawEvents.length === 0) return null;
  return {
    events: s.rawEvents.map(stripEventCuration),
    runMetadata: s.runMetadata ?? null,
    warnings: Array.isArray(s.eventsWarnings) ? s.eventsWarnings : [],
  };
}

/** The curation record of a session, without the revision fields (rev,
    writer, savedAt), which src/storage.js adds when it writes it.
    `abToken` names the ab record this session goes with (null: none). */
export function curationRecord(s, abToken) {
  const { verdicts, notes } = eventCurationById(s.rawEvents);
  return {
    layout: LAYOUT_VERSION,
    verdicts,
    notes,
    sampleCuration: s.sampleCuration || {},
    sampleCurationVersion: s.sampleCurationVersion ?? null,
    analysisTitle: s.analysisTitle || "",
    abToken: abToken ?? null,
  };
}

/** The UI record of a session. */
export function uiRecord(s) {
  return { tab: s.tab, selId: s.selId, filter: s.filter, sort: s.sort };
}

/** Every record dirty: nothing has been written yet. */
export const ALL_DIRTY = Object.freeze({
  events: true,
  ab: true,
  metadata: true,
  plate: true,
  curation: true,
  ui: true,
});

/** Which records must be written for the state `s`, given the state the
    stored records were last written from (`saved`; null: none). Inputs
    and curation are compared by reference — every change makes a new
    object — except the events, compared by eventInputsChanged so that an
    evaluation does not rewrite the events record.

    The curation record is written whenever any session record is: it
    holds the revision every such write bumps, and the token of the
    abundance table the session goes with. */
export function dirtyRecords(saved, s) {
  if (!saved) return { ...ALL_DIRTY };
  const events =
    saved.runMetadata !== s.runMetadata ||
    saved.eventsWarnings !== s.eventsWarnings ||
    eventInputsChanged(saved.rawEvents, s.rawEvents);
  const ab = saved.ab !== s.ab;
  const metadata = saved.metadata !== s.metadata;
  const plate = saved.plateMap !== s.plateMap;
  const curation =
    events ||
    ab ||
    metadata ||
    plate ||
    saved.rawEvents !== s.rawEvents ||
    saved.sampleCuration !== s.sampleCuration ||
    saved.sampleCurationVersion !== s.sampleCurationVersion ||
    saved.analysisTitle !== s.analysisTitle;
  const ui =
    saved.tab !== s.tab ||
    saved.selId !== s.selId ||
    saved.filter !== s.filter ||
    saved.sort !== s.sort;
  return { events, ab, metadata, plate, curation, ui };
}

/** The writes of one save of the session records — everything but the
    abundance table, which is written on its own (a quota error on the
    largest record must not cost the curation) — as
    { puts: [[key, value]], dels: [key] }. A cleared input deletes its
    record; a cleared abundance table is deleted here too. The events
    record replaces the first layout's "main" record, deleted with it:
    after a migration that failed, the first save writes every record,
    and "main" must not outlive them. */
export function sessionWrites(s, dirty, abToken) {
  const puts = [];
  const dels = [];
  if (dirty.events) {
    const rec = eventsRecord(s);
    if (rec) puts.push([RECORD_KEYS.events, rec]);
    else dels.push(RECORD_KEYS.events);
    dels.push(LEGACY_MAIN_KEY);
  }
  if (dirty.metadata) {
    if (s.metadata) puts.push([RECORD_KEYS.metadata, s.metadata]);
    else dels.push(RECORD_KEYS.metadata);
  }
  if (dirty.plate) {
    if (s.plateMap) puts.push([RECORD_KEYS.plate, s.plateMap]);
    else dels.push(RECORD_KEYS.plate);
  }
  if (dirty.ab && !s.ab) dels.push(RECORD_KEYS.ab);
  if (dirty.curation) puts.push([RECORD_KEYS.curation, curationRecord(s, abToken)]);
  return { puts, dels };
}

/** True when the session holds nothing worth restoring. */
export function isEmptySession(s) {
  return (
    !s ||
    ((!Array.isArray(s.rawEvents) || s.rawEvents.length === 0) &&
      !s.ab &&
      !s.metadata &&
      !s.plateMap)
  );
}

/** The session the records hold, or null when they hold none. An ab
    record whose token is not the one the curation record names was not
    written with this session (its write failed after the session's):
    it is left out, and `abLost` says the session had a table. */
export function sessionFromRecords({ events, ab, metadata, plate, curation, ui }) {
  if (!isObj(curation)) return null;
  const rawEvents = Array.isArray(events?.events)
    ? withEventCuration(events.events, curation.verdicts, curation.notes)
    : [];
  const wantToken = curation.abToken ?? null;
  const abMatches = isObj(ab) && (ab.storageToken ?? null) === wantToken;
  const session = {
    rawEvents,
    sampleCuration: isObj(curation.sampleCuration) ? curation.sampleCuration : {},
    sampleCurationVersion: curation.sampleCurationVersion ?? undefined,
    runMetadata: events?.runMetadata ?? null,
    eventsWarnings: Array.isArray(events?.warnings) ? events.warnings : [],
    metadata: isObj(metadata) ? metadata : null,
    plateMap: isObj(plate) ? plate : null,
    ab: abMatches ? abundanceFromRecord(ab) : null,
    analysisTitle: typeof curation.analysisTitle === "string" ? curation.analysisTitle : "",
    tab: ui?.tab,
    selId: ui?.selId,
    filter: ui?.filter,
    sort: ui?.sort,
  };
  if (wantToken != null && !abMatches) session.abLost = true;
  return isEmptySession(session) ? null : session;
}

/** A session restored without its table (abLost) says so once: then the
    curation record stops naming that table — in place, the revision
    unchanged, since nothing of the session changes — and a table left
    behind by an older write is deleted. Kept as it was, the record named
    the lost table at every later boot, and the notice came back on every
    reload until another table was loaded.

    `rev` and `token` are the revision and the token read on boot. The
    records are read again in the transaction that repairs them: null
    (nothing to do) when they changed since — another tab wrote — or when
    the table has been written since. Otherwise { curation, deleteAb }. */
export function forgetLostTable(curation, ab, rev, token) {
  if (!isObj(curation) || (curation.rev ?? 0) !== rev) return null;
  const want = curation.abToken ?? null;
  if (want === null || want !== token) return null;
  if (isObj(ab) && (ab.storageToken ?? null) === want) return null;
  return { curation: { ...curation, abToken: null }, deleteAb: isObj(ab) };
}

/** The session of the first layout: one record ("main") holding
    everything but the abundance table, stored on its own. Null when it
    holds no events: that layout cleared itself whenever the events were
    cleared. */
export function sessionFromLegacyMain(main, ab) {
  if (!isObj(main) || !Array.isArray(main.rawEvents) || main.rawEvents.length === 0) {
    return null;
  }
  const table = isObj(ab) ? ab : isObj(main.ab) ? main.ab : null;
  return {
    rawEvents: main.rawEvents,
    sampleCuration: isObj(main.sampleCuration) ? main.sampleCuration : {},
    sampleCurationVersion: main.sampleCurationVersion,
    runMetadata: main.runMetadata ?? null,
    eventsWarnings: [],
    metadata: isObj(main.metadata) ? main.metadata : null,
    plateMap: isObj(main.plateMap) ? main.plateMap : null,
    ab: table ? abundanceFromRecord(table) : null,
    analysisTitle: typeof main.analysisTitle === "string" ? main.analysisTitle : "",
    tab: main.tab,
    selId: main.selId,
    filter: main.filter,
    sort: main.sort,
  };
}

/** True when a "main" record found next to the current records was
    written after them. Once a tab of this version has migrated the
    session, a tab still running the earlier version (open since before
    the upgrade) keeps saving in "main", which nothing read any more: its
    work was lost without a word. Such a record is newer than the
    curation record, which every write of this version stamps; one that
    is older was superseded, as two tabs of either version have always
    superseded each other's saves: the last one wins. */
export function newerLegacyMain(main, curation) {
  return (
    isObj(main) &&
    Array.isArray(main.rawEvents) &&
    main.rawEvents.length > 0 &&
    typeof main.savedAt === "string" &&
    isObj(curation) &&
    !(typeof curation.savedAt === "string" && curation.savedAt >= main.savedAt)
  );
}

/* ----------------------------------------------------------- UI state */

/** The values the filter bar offers (VERDICT_OPTIONS,
    SAMPLE_VERDICT_OPTIONS and the subject / group / plate selects of
    App.jsx). */
const FILTER_VERDICTS = ["pending", "true_positive", "false_positive", "uncertain"];
const FILTER_SAMPLE_VERDICTS = ["pending", "contaminated", "correct", "uncertain"];
const FILTER_RELATIONS = ["any", "same", "different"];
const FILTER_ADJACENCY = ["any", "adjacent", "non-adjacent"];

/** A filter read back from a stored session or a session file, merged
    over the current defaults (`defaults`, AppMain's defaultFilter()):
    a field the file lacks — or holds with the wrong type — gets its
    default (a filter without `q` used to crash every render on
    filter.q.trim()), so fields added since, such as lowAbFilter, come
    with their default. Earlier shapes are promoted: a single `verdict`
    string to the `verdicts` list, the hideRelated / adjacentOnly
    booleans to the tri-state strings.

    The verdict lists and the subject / group / plate choices keep only
    the values the filter bar offers: any other text used to come back
    as it was, and the events HTML report prints them in its "Filter
    applied" banner, so a crafted session file put its own markup and
    script into the report. */
export function restoreFilter(saved, defaults) {
  const f = isObj(saved) ? saved : {};
  const d = defaults;
  const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const listOf = (v, allowed) => Array.isArray(v) && v.every((x) => allowed.includes(x));
  const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
  const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const str = (v, fallback) => (typeof v === "string" ? v : fallback);
  let verdicts;
  if (listOf(f.verdicts, FILTER_VERDICTS)) verdicts = f.verdicts;
  else if (FILTER_VERDICTS.includes(f.verdict)) verdicts = [f.verdict];
  else verdicts = [...d.verdicts];
  const side = (v) => (v === "source" || v === "target" ? v : "either");
  return {
    ...d,
    q: str(f.q, d.q),
    minScore: num(f.minScore, d.minScore),
    minRate: num(f.minRate, d.minRate),
    minIntroduced: num(f.minIntroduced, d.minIntroduced),
    verdicts,
    sampleVerdicts: listOf(f.sampleVerdicts, FILTER_SAMPLE_VERDICTS)
      ? f.sampleVerdicts
      : [...d.sampleVerdicts],
    sampleVerdictsSide: side(f.sampleVerdictsSide),
    subject: oneOf(f.subject, FILTER_RELATIONS, f.hideRelated ? "different" : d.subject),
    group: oneOf(f.group, FILTER_RELATIONS, d.group),
    adjacent: oneOf(f.adjacent, FILTER_ADJACENCY, f.adjacentOnly ? "adjacent" : d.adjacent),
    // Optional sample-list scope (Network drill-ins).
    scopeSamples: strings(f.scopeSamples) ? f.scopeSamples : null,
    scopeSide: side(f.scopeSide),
    // Sessions saved before the toggle existed get it on.
    lowAbFilter: f.lowAbFilter !== false,
    // The Action filter (keep / suppress only; absent: any action). It
    // used to be left out, so a reload or an imported session lost it,
    // and every export covered all the events again.
    ...(f.action === "keep" || f.action === "suppress" ? { action: f.action } : {}),
  };
}

export const DEFAULT_SORT = Object.freeze({ by: "score", dir: "desc" });

/** A sort read back from a session: { by, dir } or the default. */
export function restoreSort(saved) {
  return isObj(saved) &&
    typeof saved.by === "string" &&
    (saved.dir === "asc" || saved.dir === "desc")
    ? { by: saved.by, dir: saved.dir }
    : { ...DEFAULT_SORT };
}

/* ------------------------------------------------------- session JSON */

/** Verdict counts of a list of events, as the session JSON writes them. */
export function verdictCounts(events) {
  const c = { total: 0, true_positive: 0, false_positive: 0, uncertain: 0, pending: 0 };
  for (const e of events || []) {
    c.total++;
    if (e.verdict === "true_positive") c.true_positive++;
    else if (e.verdict === "false_positive") c.false_positive++;
    else if (e.verdict === "uncertain") c.uncertain++;
    else c.pending++;
  }
  return c;
}

/** The session JSON of a session (Download session; also offered by the
    error screen from what the browser stored). `events` defaults to the
    session's own; `eventFields(e)` adds per-event fields (relatedness,
    plate distance, cascade) that the importer ignores. The model version
    of the sample curation is the session's: one that has none was saved
    by an earlier version, and the importer then migrates it. */
export function sessionToJSON(s, { events = s.rawEvents || [], counts, eventFields } = {}) {
  const sc = s.sampleCuration || {};
  return {
    generated: new Date().toISOString(),
    schema_version: 2,
    counts: counts || verdictCounts(events),
    analysis_title: s.analysisTitle || null,
    has_metadata: !!s.metadata,
    has_plate_map: !!s.plateMap,
    has_abundance: !!s.ab,
    run_metadata: s.runMetadata || null,
    metadata: s.metadata || null,
    plate_map: s.plateMap || null,
    abundance: s.ab || null,
    // UI state — let the importer drop the user back exactly where
    // they were (active tab, selected event, filters, sort).
    ui_state: {
      tab: s.tab,
      sel_id: s.selId,
      filter: s.filter,
      sort: s.sort,
    },
    // Sample-level curation: verdict / action / notes per sample. Its
    // version tells the importer which model the map follows.
    sample_curation: sc,
    sample_curation_version: s.sampleCurationVersion ?? null,
    // What the events parser reported about the file, shown again with
    // the other data warnings.
    events_warnings: Array.isArray(s.eventsWarnings) ? s.eventsWarnings : [],
    events: events.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      contamination_rate: e.rate,
      probability: e.score,
      introduced_species: e.introduced,
      verdict: e.verdict,
      action: sc[e.target]?.action || null,
      notes: e.notes,
      ...(eventFields ? eventFields(e) : {}),
    })),
  };
}

/* ------------------------------------------------------ reading a session

   A session is read back from two places: a session JSON (Import
   session) and this browser's storage, at every boot. Both go through
   the same readers, which check every part and say what they found:

     errors   what cannot be shown as it is. An import refuses the file —
              nothing replaces the current session. A stored session
              must open whatever it holds: it gets a safe value instead
              (the value reset, the event or the file left out), and the
              notice of the boot lists them. Stored sessions used to skip
              every check: one whose species list was a single text, or
              whose metadata rows were not objects, blanked the whole app
              at every reload;
     repairs  what the earlier versions' parsers left in a session, which
              this one never writes and which is repaired, saying so: an
              event of a blank line (no source, no target), a sample
              column with an empty name, a negative abundance, a species
              list kept as one text. The import refused such files whole —
              a session saved by the previous version and downloaded from
              it, or from this one after it opened that session — while
              the same session opened from storage. */

const EVENT_VERDICTS = new Set(["pending", "true_positive", "false_positive", "uncertain"]);
const SAMPLE_VERDICTS = new Set(["contaminated", "correct", "uncertain", "pending"]);
const SAMPLE_ACTIONS = new Set(["keep", "suppress"]);
const MAX_LISTED = 6;

const problems = () => ({ errors: [], repairs: [] });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A sample / event id read from a session file: a string, or a finite
    number written without quotes; null otherwise. */
function idOf(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Warnings as a list of strings (a hand-edited file may hold a single
    string, or anything): the list itself when it already is one. */
function warningList(v) {
  if (Array.isArray(v) && v.every((w) => typeof w === "string" && w)) return v;
  if (typeof v === "string") return v ? [v] : [];
  return Array.isArray(v) ? v.filter((w) => typeof w === "string" && w) : [];
}

/** True when the stored event `e` holds exactly the fields read from it. */
function readAsItIs(e, ev) {
  for (const k of ["id", "source", "target", "rate", "score", "verdict", "notes"]) {
    if (e[k] !== ev[k]) return false;
  }
  const list = e.introduced;
  return (
    Array.isArray(list) &&
    list.length === ev.introduced.length &&
    list.every((sp, i) => sp === ev.introduced[i])
  );
}

/** The events of a session, as the app keeps them, and whether their ids
    had to be renumbered. A session file names the fields as exportJSON
    writes them (contamination_rate, probability, introduced_species),
    a stored session as the app keeps them (rate, score, introduced);
    `stored` keeps a stored event's other fields, and returns the list
    itself when every event was read as it is. */
function readEvents(list, p, { stored = false } = {}) {
  if (!Array.isArray(list)) {
    p.errors.push('"events" must be a list of events.');
    return { events: [], renumbered: false };
  }
  const out = [];
  let changed = false;
  let blank = 0;
  let joined = 0;
  list.forEach((e, i) => {
    const where = `event ${i + 1}`;
    if (!isObj(e)) {
      p.errors.push(`${where} is not an object.`);
      changed = true;
      return;
    }
    const source = idOf(e.source);
    const target = idOf(e.target);
    if ((source == null && e.source != null) || (target == null && e.target != null)) {
      p.errors.push(`${where}: its source or its target is neither text nor a number.`);
      changed = true;
      return;
    }
    // What the previous parser made of a line of tabs (a cleared
    // spreadsheet row): an event with an empty source and target. The
    // events parser skips such a row now; so does this.
    if (!source?.trim() || !target?.trim()) {
      blank++;
      changed = true;
      return;
    }
    const number = (v, name) => {
      if (v == null) return 0;
      if (typeof v === "number" && Number.isFinite(v)) return v;
      p.errors.push(`${where} (${source} → ${target}): ${name} is not a number.`);
      return 0;
    };
    const rate = number(e.contamination_rate ?? e.rate, "contamination_rate");
    const score = number(e.probability ?? e.score, "probability");
    let species = e.introduced_species ?? e.introduced ?? [];
    if (typeof species === "string") {
      // The species cell as one text, split as the events parser splits
      // it.
      species = splitSpeciesList(species);
      joined++;
    }
    let introduced = [];
    if (Array.isArray(species) && species.every((sp) => idOf(sp) != null)) {
      introduced = species.map(idOf);
    } else {
      p.errors.push(`${where} (${source} → ${target}): introduced_species is not a list of names.`);
    }
    let verdict = e.verdict == null || e.verdict === "" ? "pending" : e.verdict;
    if (!EVENT_VERDICTS.has(verdict)) {
      p.errors.push(`${where} (${source} → ${target}): unknown verdict "${String(verdict).slice(0, 40)}".`);
      verdict = "pending";
    }
    let notes = "";
    if (typeof e.notes === "string") notes = e.notes;
    else if (e.notes != null) {
      p.errors.push(`${where} (${source} → ${target}): notes are not text.`);
    }
    let id = e.id == null ? i : e.id;
    if (idOf(id) == null) {
      p.errors.push(`${where}: its id is neither text nor a number.`);
      id = i;
    }
    const ev = { id, source, target, rate, score, introduced, verdict, notes };
    // A session saved before the sample-level model kept the action on
    // its events: migrateSampleCuration moves it to the target sample.
    if (SAMPLE_ACTIONS.has(e.action)) ev.action = e.action;
    if (!stored) out.push(ev);
    else if (readAsItIs(e, ev)) out.push(e);
    else {
      out.push({ ...e, ...ev });
      changed = true;
    }
  });
  if (blank > 0) {
    p.repairs.push(
      `${plural(blank, "event")} without a source or a target (what an earlier version made of an ` +
        `empty line of the events file) ${blank === 1 ? "was" : "were"} left out.`,
    );
    if (out.length === 0 && blank === list.length) {
      p.errors.push("No event has both a source and a target.");
    }
  }
  if (joined > 0) {
    p.repairs.push(
      `The introduced species of ${plural(joined, "event")}, kept as one text, ` +
        `${joined === 1 ? "was" : "were"} split at the commas.`,
    );
  }
  // Ids key the curation record, the selection and the per-event caches:
  // a hand-edited file with repeated ids gets them renumbered.
  const ids = new Set(out.map((e) => String(e.id)));
  const renumbered = ids.size !== out.length;
  if (renumbered) return { events: out.map((e, i) => ({ ...e, id: i })), renumbered };
  return { events: stored && !changed ? list : out, renumbered };
}

/** The sample curation of a session: an entry that is not an object is
    left out, a value that is not one the model knows is removed. The
    map itself when nothing had to be. */
function readSampleCuration(sc, p) {
  if (sc == null) return {};
  if (!isObj(sc)) {
    p.errors.push('"sample_curation" must map sample ids to their verdict / action / notes.');
    return {};
  }
  let out = null;
  for (const [id, entry] of Object.entries(sc)) {
    if (!isObj(entry)) {
      p.errors.push(`sample_curation of ${id} is not an object.`);
      if (!out) out = { ...sc };
      delete out[id];
      continue;
    }
    let next = entry;
    const drop = (...keys) => {
      if (next === entry) next = { ...entry };
      for (const k of keys) delete next[k];
    };
    if (entry.verdict != null && !SAMPLE_VERDICTS.has(entry.verdict)) {
      p.errors.push(`sample_curation of ${id}: unknown verdict "${String(entry.verdict).slice(0, 40)}".`);
      drop("verdict", "verdictAuto");
    }
    if (entry.action != null && entry.action !== "" && !SAMPLE_ACTIONS.has(entry.action)) {
      p.errors.push(`sample_curation of ${id}: unknown action "${String(entry.action).slice(0, 40)}".`);
      drop("action", "actionAuto");
    }
    if (entry.notes != null && typeof entry.notes !== "string") {
      p.errors.push(`sample_curation of ${id}: notes are not text.`);
      drop("notes");
    }
    if (next === entry) continue;
    if (!out) out = { ...sc };
    out[id] = next;
  }
  return out || sc;
}

/** The abundance table of a session, and the samples it renamed or left
    out (`renamed`: old name → new name, null when left out; null when
    none). The table itself when it is read as it is.

    The previous parser kept two things the current one never writes: a
    sample with an empty name — an empty header cell, from trailing tabs
    on the header line above an empty column — and negative values, kept
    as negative fractions. An empty-named column holding no value is left
    out, as the parser now drops trailing empty header cells; one holding
    values is named "Unnamed: N" (its column in the file, counted from
    0), as the parser and CroCoDeEL (pandas) name it. A negative value
    reads as 0, as the parser reads it; in a table of fractions only (no
    column sums: a session of that version), the column it was in is
    made a fraction of its positive values again, which is what the
    parser gives for the same file. */
function readAbundance(ab, p) {
  if (ab == null) return { ab: null, renamed: null };
  const bad = (msg) => {
    p.errors.push(`abundance: ${msg}`);
    return { ab: null, renamed: null };
  };
  if (!isObj(ab)) return bad("not a species × sample table.");
  const { matrix } = ab;
  if (!Array.isArray(ab.samples) || ab.samples.length === 0 || ab.samples.some((s) => idOf(s) == null)) {
    return bad('"samples" must be a list of sample names.');
  }
  const names = ab.samples.map(idOf);
  if (new Set(names).size !== names.length) return bad("a sample appears twice.");
  if (!isObj(matrix)) {
    return bad('"matrix" (species → sample → abundance) is missing or is not an object.');
  }
  const species = ab.species == null ? Object.keys(matrix) : ab.species;
  if (!Array.isArray(species) || species.some((sp) => typeof sp !== "string" || !sp)) {
    return bad('"species" must be a list of species names.');
  }
  if (new Set(species).size !== species.length) return bad("a species appears twice.");
  let min = Infinity;
  let max = -Infinity;
  let negative = 0;
  // Per sample: the sum of its positive values, for the columns that hold
  // a negative one.
  const positiveSums = new Map();
  for (const sp of species) {
    const row = matrix[sp];
    if (!isObj(row)) return bad(`species "${sp.slice(0, 60)}" has no row in the matrix.`);
    for (const s in row) {
      const v = row[s];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return bad(`the value of "${sp.slice(0, 60)}" in "${s.slice(0, 60)}" is not an abundance.`);
      }
      if (v < 0) {
        negative++;
        if (!positiveSums.has(s)) positiveSums.set(s, 0);
      } else if (v > 0) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  // Some views read the species list, others the matrix's rows: a row the
  // list does not name passed unchecked, and then broke the Samples tab.
  if (ab.species != null) {
    const listed = new Set(species);
    const stray = Object.keys(matrix).find((sp) => !listed.has(sp));
    if (stray !== undefined) {
      return bad(`"matrix" has a row for "${stray.slice(0, 60)}", which "species" does not list.`);
    }
  }
  // What an export needs to give the user's own values back (see
  // parseAbundance): optional — a session saved before they existed has
  // none — but read as written when present.
  if (ab.firstHeader != null && typeof ab.firstHeader !== "string") {
    return bad('"firstHeader" is not text.');
  }
  if (ab.colSums != null) {
    if (!isObj(ab.colSums) || Object.values(ab.colSums).some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      return bad('"colSums" must map samples to their column sums.');
    }
  }
  if (ab.integerCols != null) {
    if (!isObj(ab.integerCols) || Object.values(ab.integerCols).some((v) => typeof v !== "boolean")) {
      return bad('"integerCols" must map samples to true / false.');
    }
  }

  // Samples with an empty name: left out when empty, named otherwise.
  const renamed = new Map();
  names.forEach((s, i) => {
    if (s.trim()) return;
    if (!species.some((sp) => matrix[sp][s] > 0)) {
      renamed.set(s, null);
      return;
    }
    const taken = new Set([...names, ...renamed.values()]);
    let name = `Unnamed: ${i + 1}`;
    for (let k = 1; taken.has(name); k++) name = `Unnamed: ${i + 1}.${k}`;
    renamed.set(s, name);
  });
  const fractionsOnly = ab.colSums == null;
  if (fractionsOnly) {
    for (const s of positiveSums.keys()) {
      let sum = 0;
      for (const sp of species) {
        const v = matrix[sp][s];
        if (v > 0) sum += v;
      }
      positiveSums.set(s, sum);
    }
  }

  let out = ab;
  const patch = (fields) => {
    if (out === ab) out = { ...ab };
    Object.assign(out, fields);
  };
  if (ab.species == null) patch({ species });
  if (names.some((s, i) => s !== ab.samples[i])) patch({ samples: names });
  if (renamed.size > 0 || negative > 0) {
    const to = (s) => (renamed.has(s) ? renamed.get(s) : s);
    const fixed = {};
    for (const sp of species) {
      const row = matrix[sp];
      let next = row;
      for (const s in row) {
        const v = row[s];
        const name = to(s);
        const scale = positiveSums.get(s);
        if (name === s && !(v < 0) && !(fractionsOnly && scale > 0)) continue;
        if (next === row) next = { ...row };
        delete next[s];
        if (name === null) continue;
        next[name] = v < 0 ? 0 : fractionsOnly && scale > 0 ? v / scale : v;
      }
      fixed[sp] = next;
    }
    const renameKeys = (map) => {
      if (!isObj(map)) return map;
      const next = {};
      for (const [s, v] of Object.entries(map)) {
        const name = to(s);
        if (name !== null) next[name] = v;
      }
      return next;
    };
    patch({
      samples: names.map(to).filter((s) => s !== null),
      matrix: fixed,
      ...(ab.colSums != null ? { colSums: renameKeys(ab.colSums) } : {}),
      ...(ab.integerCols != null ? { integerCols: renameKeys(ab.integerCols) } : {}),
    });
    const dropped = [...renamed.values()].filter((s) => s === null).length;
    const named = [...renamed.values()].filter((s) => s !== null);
    if (dropped > 0) {
      p.repairs.push(
        `The abundance table's ${plural(dropped, "column")} with an empty name and no value ` +
          `(trailing tabs on its header line) ${dropped === 1 ? "was" : "were"} left out.`,
      );
    }
    if (named.length > 0) {
      p.repairs.push(
        `The abundance table's ${plural(named.length, "column")} with an empty name ` +
          `${named.length === 1 ? "was" : "were"} named ${named.map((s) => `"${s}"`).join(", ")}, ` +
          "as CroCoDeEL names an empty header cell (its column, counted from 0).",
      );
    }
    if (negative > 0) {
      p.repairs.push(
        `${plural(negative, "negative abundance")} ${negative === 1 ? "was" : "were"} read as 0, ` +
          "as the abundance parser reads them" +
          (fractionsOnly ? ", the relative abundances of their samples recomputed without them." : "."),
      );
    }
  }
  const warnings = warningList(ab.warnings);
  if (warnings !== ab.warnings) patch({ warnings });
  const lr = ab.logRange;
  if (!(isObj(lr) && Number.isFinite(lr.min) && Number.isFinite(lr.max))) {
    patch({
      logRange: Number.isFinite(min)
        ? { min: Math.floor(Math.log10(min)), max: Math.min(0, Math.ceil(Math.log10(max))) }
        : { min: -8, max: 0 },
    });
  }
  return { ab: out, renamed: renamed.size > 0 ? renamed : null };
}

/** The sample curation with the samples the abundance table renamed or
    left out (readAbundance's `renamed`) renamed or left out too. */
function renameCuratedSamples(sc, renamed) {
  if (!renamed || ![...renamed.keys()].some((s) => s in sc)) return sc;
  const out = { ...sc };
  for (const [from, to] of renamed) {
    if (!(from in out)) continue;
    if (to !== null && !(to in out)) out[to] = out[from];
    delete out[from];
  }
  return out;
}

/** A value a table cell can hold: text, a number, or nothing. */
const isCell = (v) => v == null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** The text fields of a metadata entry (parseMetadata's metadataEntry),
    and its true / false flags (null: not given). */
const METADATA_TEXT = ["sampleName", "subject", "timepoint", "biome", "groupId"];
const METADATA_FLAGS = ["lowBiomassExplicit", "lowSequencingDepthExplicit"];

/** The metadata of a session. Every entry is read the way parseMetadata
    writes it: its text fields as text — a number becomes text, a missing
    field "" — its flags as true / false, the cells of its row (`extra`)
    as text or numbers. Anything else is an error: a subject or a sample
    name written as an object, or a cell holding one, passed unchecked and
    then broke the Samples, Events, Scatter and Validate tabs at every
    visit. Such an entry is left out — a stored session keeps the others
    — and null comes back when no entry is left. The metadata itself
    when it is read as it is. */
function readMetadata(md, p) {
  if (md == null) return null;
  if (!isObj(md) || !isObj(md.bySample)) {
    p.errors.push('metadata: "bySample" (the per-sample annotations) is missing.');
    return null;
  }
  let bySample = null;
  const ids = Object.keys(md.bySample);
  let left = ids.length;
  const put = (id, entry) => {
    if (!bySample) bySample = { ...md.bySample };
    if (entry) bySample[id] = entry;
    else {
      delete bySample[id];
      left--;
    }
  };
  for (const id of ids) {
    const m = md.bySample[id];
    const name = id.slice(0, 60);
    const wrong = (msg) => {
      p.errors.push(`metadata: ${msg}`);
      put(id, null);
    };
    if (!isObj(m) || (m.extra != null && !isObj(m.extra))) {
      wrong(`the annotations of ${name} are not an object.`);
      continue;
    }
    const text = METADATA_TEXT.find((f) => !isCell(m[f]));
    if (text) {
      wrong(`the ${text} of ${name} is not text.`);
      continue;
    }
    const flag = ["isControl", ...METADATA_FLAGS].find((f) => m[f] != null && typeof m[f] !== "boolean");
    if (flag) {
      wrong(`${flag} of ${name} is neither true nor false.`);
      continue;
    }
    const cell = m.extra != null ? Object.entries(m.extra).find(([, v]) => !isCell(v)) : null;
    if (cell) {
      wrong(`the "${cell[0].slice(0, 60)}" cell of ${name} is not text.`);
      continue;
    }
    let entry = m;
    const set = (k, v) => {
      if (entry[k] === v) return;
      if (entry === m) entry = { ...m };
      entry[k] = v;
    };
    for (const f of METADATA_TEXT) set(f, m[f] == null ? "" : String(m[f]));
    set("isControl", m.isControl === true);
    for (const f of METADATA_FLAGS) set(f, m[f] ?? null);
    if (entry !== m) put(id, entry);
  }
  if (ids.length > 0 && left === 0) return null;
  let out = md;
  const patch = (fields) => {
    if (out === md) out = { ...md };
    Object.assign(out, fields);
  };
  if (bySample) patch({ bySample });
  const warnings = warningList(md.warnings);
  if (warnings !== md.warnings) patch({ warnings });
  if (md.cols != null && !isObj(md.cols)) {
    patch({});
    delete out.cols;
  }
  if (typeof md.nSamples !== "number" || left !== ids.length) {
    patch({ nSamples: Object.keys(out.bySample).length });
  }
  return out;
}

/** The plate map of a session; the plate map itself when it is read as
    it is. A missing or wrong format is given from the wells. A sample
    without a valid well is an error, and is left out — a stored session
    keeps the other wells — and null comes back when no well is left. */
function readPlateMap(pm, p) {
  if (pm == null) return null;
  if (!isObj(pm) || !isObj(pm.bySample)) {
    p.errors.push('plate_map: "bySample" (the sample → well placement) is missing.');
    return null;
  }
  let maxRow = 7;
  let maxCol = 11;
  let bySample = null;
  const ids = Object.keys(pm.bySample);
  let left = ids.length;
  for (const id of ids) {
    const w = pm.bySample[id];
    const okWell =
      isObj(w) &&
      Number.isInteger(w.row) &&
      Number.isInteger(w.col) &&
      w.row >= 0 &&
      w.row <= 15 &&
      w.col >= 0 &&
      w.col <= 23 &&
      (w.plate == null || typeof w.plate === "string" || typeof w.plate === "number");
    if (!okWell) {
      p.errors.push(`plate_map: ${id} has no valid well.`);
      if (!bySample) bySample = { ...pm.bySample };
      delete bySample[id];
      left--;
      continue;
    }
    maxRow = Math.max(maxRow, w.row);
    maxCol = Math.max(maxCol, w.col);
    // The plate as parsePlateMap names it: text, "P1" when none is given.
    const plate = w.plate == null || w.plate === "" ? "P1" : String(w.plate);
    if (plate === w.plate) continue;
    if (!bySample) bySample = { ...pm.bySample };
    bySample[id] = { ...w, plate };
  }
  if (ids.length > 0 && left === 0) return null;
  const big = maxRow > 7 || maxCol > 11;
  const f = pm.format;
  const formatOk =
    isObj(f) &&
    ((f.rows === 8 && f.cols === 12 && !big) || (f.rows === 16 && f.cols === 24));
  let out = pm;
  const patch = (fields) => {
    if (out === pm) out = { ...pm };
    Object.assign(out, fields);
  };
  if (bySample) patch({ bySample });
  const warnings = warningList(pm.warnings);
  if (warnings !== pm.warnings) patch({ warnings });
  if (!formatOk) patch({ format: big ? { rows: 16, cols: 24 } : { rows: 8, cols: 12 } });
  if (pm.cols != null && !isObj(pm.cols)) {
    patch({});
    delete out.cols;
  }
  return out;
}

/** The run metadata of a session: the run header's parameters, shown as
    they are in the Overview — a value that is an object stopped that
    tab, and is left out. */
function readRunMetadata(rm, p) {
  if (rm == null) return null;
  if (!isObj(rm)) {
    p.errors.push('"run_metadata" must be an object.');
    return null;
  }
  const wrong = Object.keys(rm).filter((k) => !isCell(rm[k]));
  if (wrong.length === 0) return rm;
  for (const k of wrong) p.errors.push(`run_metadata: "${k.slice(0, 60)}" is not text.`);
  const out = { ...rm };
  for (const k of wrong) delete out[k];
  return out;
}

/** Every part of a session, read (see above). */
function readParts(parts, p, { stored }) {
  const { events, renumbered } = readEvents(parts.events, p, { stored });
  const ab = readAbundance(parts.ab, p);
  return {
    events,
    renumbered,
    sampleCuration: renameCuratedSamples(readSampleCuration(parts.sampleCuration, p), ab.renamed),
    ab: ab.ab,
    metadata: readMetadata(parts.metadata, p),
    plateMap: readPlateMap(parts.plateMap, p),
    runMetadata: readRunMetadata(parts.runMetadata, p),
    eventsWarnings: warningList(parts.eventsWarnings),
  };
}

/** The first few problems, each naming where it is. */
const listed = (errors) => {
  const more = errors.length - MAX_LISTED;
  return more > 0
    ? [...errors.slice(0, MAX_LISTED), `… and ${more} more problem${more > 1 ? "s" : ""}.`]
    : errors;
};

/** A session read from this browser's storage, checked by the readers
    of the session import (see above), so that whatever an earlier
    version, a damaged profile or a file that version imported unchecked
    left in it opens. Returns { session, notes }: `session` is `s` with
    the parts the readers had to change replaced — every part read as it
    is stays the very object read, so the autosave writes only what
    changed, once — and `notes` the lines of the notice that says what
    was repaired, reset or left out (empty when nothing was). */
export function checkStoredSession(s) {
  if (!s) return { session: s, notes: [] };
  const p = problems();
  const parts = readParts(
    {
      events: s.rawEvents ?? [],
      sampleCuration: s.sampleCuration,
      ab: s.ab,
      metadata: s.metadata,
      plateMap: s.plateMap,
      runMetadata: s.runMetadata,
      eventsWarnings: s.eventsWarnings,
    },
    p,
    { stored: true },
  );
  const session = {
    ...s,
    rawEvents: parts.events,
    sampleCuration: parts.sampleCuration,
    ab: parts.ab,
    metadata: parts.metadata,
    plateMap: parts.plateMap,
    runMetadata: parts.runMetadata,
    eventsWarnings: parts.eventsWarnings,
    analysisTitle: typeof s.analysisTitle === "string" ? s.analysisTitle : "",
  };
  // The selection named an event by an id that is gone.
  if (parts.renumbered) session.selId = null;
  const notes = [...p.repairs];
  if (p.errors.length > 0) {
    notes.push(
      "Some of it could not be read, and was reset (an event's value) or left out (an event, " +
        "a file — load it again): " +
        listed(p.errors).join(" "),
    );
  }
  const same = Object.keys(session).every((k) => session[k] === s[k]);
  return { session: same ? s : session, notes };
}

/** A session of an earlier layout, as the boot writes it into the
    current records: read by the readers (checkStoredSession), its
    metadata read again with the current header rules (remapMetadata),
    its sample curation brought up to date with the current model
    (migrateSampleCuration), its events without their legacy actions.
    Returns { session, notes, changes }: what the readers repaired and
    what the migration changed in the curated output, for the notice of
    the tab that writes it.

    Done once, before the records are written, so that every tab reads a
    session already up to date. AppMain did it on mount, as a change of
    the session: two tabs opening such a session at once each wrote it,
    and the second one was told "This session was changed in another
    tab" and stopped saving, although nothing had changed. */
export function upgradedSession(stored) {
  const checked = checkStoredSession(stored);
  const s = checked.session;
  const migrated = migrateSampleCuration(s.rawEvents, s.sampleCuration, s.sampleCurationVersion);
  return {
    session: {
      ...s,
      rawEvents: s.rawEvents.map((e) => {
        if (!e.action) return e;
        const { action: _drop, ...rest } = e;
        return rest;
      }),
      sampleCuration: migrated.sampleCuration,
      sampleCurationVersion: SAMPLE_CURATION_VERSION,
      metadata: s.metadata ? remapMetadata(s.metadata) : s.metadata,
    },
    notes: checked.notes,
    changes: migrated.changes,
  };
}

/** Read a session JSON (exportJSON's format, any version) into a session,
    checking the WHOLE file first: nothing replaces the current session
    unless every part of the file can be shown.

    `defaults` is AppMain's defaultFilter() (the imported filter is merged
    over it), `tabs` the tab ids the app knows.

    Returns { ok: false, errors } (the first few problems, each naming
    where it is), or { ok: true, session, changes, repairs }: `session`
    has the shape every reader of this module uses, its sample curation
    brought up to date with the current model (migrateSampleCuration),
    `changes` what that migration changed in the curated output (null:
    nothing to tell), and `repairs` what was repaired in the file (see
    above), for the notice of the import. */
export function sessionFromPayload(json, { defaults, tabs } = {}) {
  if (!isObj(json)) {
    return {
      ok: false,
      errors: ['This is not a session file: expected a JSON object with an "events" list.'],
    };
  }
  const p = problems();
  if (!("events" in json)) p.errors.push('Missing "events" list.');
  const parts = readParts(
    {
      events: "events" in json ? json.events : [],
      sampleCuration: json.sample_curation,
      ab: json.abundance,
      metadata: json.metadata,
      plateMap: json.plate_map,
      runMetadata: json.run_metadata,
      eventsWarnings: json.events_warnings,
    },
    p,
    { stored: false },
  );
  const { events, renumbered, sampleCuration, ab, metadata, plateMap, runMetadata } = parts;
  const ui = json.ui_state == null ? {} : json.ui_state;
  if (!isObj(ui)) p.errors.push('"ui_state" must be an object.');
  if (p.errors.length > 0) return { ok: false, errors: listed(p.errors) };
  if (events.length === 0 && !ab && !metadata && !plateMap) {
    return {
      ok: false,
      errors: ["The session holds no events and no file: there is nothing to import."],
    };
  }
  const version = typeof json.sample_curation_version === "number" ? json.sample_curation_version : undefined;
  const migrated = migrateSampleCuration(events, sampleCuration, version);
  const rawEvents = events.map((e) => {
    if (!e.action) return e;
    const { action: _drop, ...rest } = e;
    return rest;
  });
  const tab = typeof ui.tab === "string" && (!tabs || tabs.includes(ui.tab)) ? ui.tab : undefined;
  const selId = renumbered
    ? null
    : typeof ui.sel_id === "string" || typeof ui.sel_id === "number"
      ? ui.sel_id
      : null;
  return {
    ok: true,
    changes: migrated.changes,
    repairs: p.repairs,
    session: {
      rawEvents,
      // Brought up to date by the migration above.
      sampleCuration: migrated.sampleCuration,
      sampleCurationVersion: SAMPLE_CURATION_VERSION,
      runMetadata,
      eventsWarnings: parts.eventsWarnings,
      metadata,
      plateMap,
      ab,
      analysisTitle: typeof json.analysis_title === "string" ? json.analysis_title : "",
      tab,
      selId,
      filter: defaults ? restoreFilter(ui.filter, defaults) : undefined,
      sort: restoreSort(ui.sort),
    },
  };
}
