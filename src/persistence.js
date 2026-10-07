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
   about 150 ms of structured clone per change on the 16.5k-event Meteor
   dataset with a 4x slower CPU. It is still read, and migrated on boot
   (sessionFromLegacyMain).

   Every reader gets the same session object back:

     { rawEvents, sampleCuration, sampleCurationVersion, runMetadata,
       eventsWarnings, metadata, plateMap, ab, analysisTitle,
       tab, selId, filter, sort }

   The session JSON (Download / Import session) is the same session under
   the field names exportJSON has always written (sessionToJSON), read
   back by sessionFromPayload, which validates the whole file before
   anything replaces the current session. */

import { migrateSampleCuration, SAMPLE_CURATION_VERSION } from "./curation.js";

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
const isSetVerdict = (v) => v != null && v !== "" && v !== "pending";

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
    if (isSetVerdict(e.verdict)) verdicts[id] = e.verdict;
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
    record; a cleared abundance table is deleted here too. */
export function sessionWrites(s, dirty, abToken) {
  const puts = [];
  const dels = [];
  if (dirty.events) {
    const rec = eventsRecord(s);
    if (rec) puts.push([RECORD_KEYS.events, rec]);
    else dels.push(RECORD_KEYS.events);
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

/* ----------------------------------------------------------- UI state */

/** A filter read back from a stored session or a session file, merged
    over the current defaults (`defaults`, AppMain's defaultFilter()):
    a field the file lacks — or holds with the wrong type — gets its
    default (a filter without `q` used to crash every render on
    filter.q.trim()), so fields added since, such as lowAbFilter, come
    with their default. Earlier shapes are promoted: a single `verdict`
    string to the `verdicts` list, the hideRelated / adjacentOnly
    booleans to the tri-state strings. */
export function restoreFilter(saved, defaults) {
  const f = isObj(saved) ? saved : {};
  const d = defaults;
  const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const str = (v, fallback) => (typeof v === "string" ? v : fallback);
  let verdicts;
  if (strings(f.verdicts)) verdicts = f.verdicts;
  else if (typeof f.verdict === "string" && f.verdict && f.verdict !== "all") verdicts = [f.verdict];
  else verdicts = [...d.verdicts];
  const side = (v) => (v === "source" || v === "target" ? v : "either");
  return {
    ...d,
    q: str(f.q, d.q),
    minScore: num(f.minScore, d.minScore),
    minRate: num(f.minRate, d.minRate),
    minIntroduced: num(f.minIntroduced, d.minIntroduced),
    verdicts,
    sampleVerdicts: strings(f.sampleVerdicts) ? f.sampleVerdicts : [...d.sampleVerdicts],
    sampleVerdictsSide: side(f.sampleVerdictsSide),
    subject: str(f.subject, f.hideRelated ? "different" : d.subject),
    group: str(f.group, d.group),
    adjacent: str(f.adjacent, f.adjacentOnly ? "adjacent" : d.adjacent),
    // Optional sample-list scope (Network drill-ins).
    scopeSamples: strings(f.scopeSamples) ? f.scopeSamples : null,
    scopeSide: side(f.scopeSide),
    // Sessions saved before the toggle existed get it on.
    lowAbFilter: f.lowAbFilter !== false,
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

const EVENT_VERDICTS = new Set(["pending", "true_positive", "false_positive", "uncertain"]);
const SAMPLE_VERDICTS = new Set(["contaminated", "correct", "uncertain", "pending"]);
const SAMPLE_ACTIONS = new Set(["keep", "suppress"]);
const MAX_LISTED = 6;

/** A sample / event id read from a session file: a string, or a finite
    number written without quotes; null otherwise. */
function idOf(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Warnings as a list of strings (a hand-edited file may hold a single
    string, or anything). */
function warningList(v) {
  if (typeof v === "string") return v ? [v] : [];
  return Array.isArray(v) ? v.filter((w) => typeof w === "string" && w) : [];
}

/** The events of a session file, as the app keeps them, and whether their
    ids had to be renumbered. */
function readEvents(list, errors) {
  if (!Array.isArray(list)) {
    errors.push('"events" must be a list of events.');
    return { events: [], renumbered: false };
  }
  const out = [];
  list.forEach((e, i) => {
    if (errors.length > 50) return;
    const where = `event ${i + 1}`;
    if (!isObj(e)) {
      errors.push(`${where} is not an object.`);
      return;
    }
    const source = idOf(e.source);
    const target = idOf(e.target);
    if (!source || !target) {
      errors.push(`${where} has no source or no target.`);
      return;
    }
    const number = (v, name) => {
      if (v == null) return 0;
      if (typeof v === "number" && Number.isFinite(v)) return v;
      errors.push(`${where} (${source} → ${target}): ${name} is not a number.`);
      return 0;
    };
    const rate = number(e.contamination_rate ?? e.rate, "contamination_rate");
    const score = number(e.probability ?? e.score, "probability");
    const species = e.introduced_species ?? e.introduced ?? [];
    let introduced = [];
    if (Array.isArray(species) && species.every((sp) => idOf(sp) != null)) {
      introduced = species.map(idOf);
    } else {
      errors.push(`${where} (${source} → ${target}): introduced_species is not a list of names.`);
    }
    const verdict = e.verdict == null || e.verdict === "" ? "pending" : e.verdict;
    if (!EVENT_VERDICTS.has(verdict)) {
      errors.push(`${where} (${source} → ${target}): unknown verdict "${String(verdict).slice(0, 40)}".`);
    }
    let notes = "";
    if (typeof e.notes === "string") notes = e.notes;
    else if (e.notes != null) {
      errors.push(`${where} (${source} → ${target}): notes are not text.`);
    }
    const id = e.id == null ? i : e.id;
    if (idOf(id) == null) errors.push(`${where}: its id is neither text nor a number.`);
    const ev = { id, source, target, rate, score, introduced, verdict, notes };
    // A session saved before the sample-level model kept the action on
    // its events: migrateSampleCuration moves it to the target sample.
    if (SAMPLE_ACTIONS.has(e.action)) ev.action = e.action;
    out.push(ev);
  });
  // Ids key the curation record, the selection and the per-event caches:
  // a hand-edited file with repeated ids gets them renumbered.
  const ids = new Set(out.map((e) => String(e.id)));
  const renumbered = ids.size !== out.length;
  return { events: renumbered ? out.map((e, i) => ({ ...e, id: i })) : out, renumbered };
}

function readSampleCuration(sc, errors) {
  if (sc == null) return {};
  if (!isObj(sc)) {
    errors.push('"sample_curation" must map sample ids to their verdict / action / notes.');
    return {};
  }
  const out = {};
  for (const [id, entry] of Object.entries(sc)) {
    if (!isObj(entry)) {
      errors.push(`sample_curation of ${id} is not an object.`);
      continue;
    }
    if (entry.verdict != null && !SAMPLE_VERDICTS.has(entry.verdict)) {
      errors.push(`sample_curation of ${id}: unknown verdict "${String(entry.verdict).slice(0, 40)}".`);
    }
    if (entry.action != null && entry.action !== "" && !SAMPLE_ACTIONS.has(entry.action)) {
      errors.push(`sample_curation of ${id}: unknown action "${String(entry.action).slice(0, 40)}".`);
    }
    if (entry.notes != null && typeof entry.notes !== "string") {
      errors.push(`sample_curation of ${id}: notes are not text.`);
    }
    out[id] = entry;
  }
  return out;
}

function readAbundance(ab, errors) {
  if (ab == null) return null;
  const bad = (msg) => {
    errors.push(`abundance: ${msg}`);
    return null;
  };
  if (!isObj(ab)) return bad("not a species × sample table.");
  const { samples, matrix } = ab;
  if (!Array.isArray(samples) || samples.length === 0 || samples.some((s) => typeof s !== "string" || !s)) {
    return bad('"samples" must be a list of sample names.');
  }
  if (new Set(samples).size !== samples.length) return bad("a sample appears twice.");
  if (!isObj(matrix)) return bad('"matrix" (species → sample → abundance) is missing.');
  const species = ab.species == null ? Object.keys(matrix) : ab.species;
  if (!Array.isArray(species) || species.some((sp) => typeof sp !== "string" || !sp)) {
    return bad('"species" must be a list of species names.');
  }
  if (new Set(species).size !== species.length) return bad("a species appears twice.");
  let min = Infinity;
  let max = -Infinity;
  for (const sp of species) {
    const row = matrix[sp];
    if (!isObj(row)) return bad(`species "${sp.slice(0, 60)}" has no row in the matrix.`);
    for (const s in row) {
      const v = row[s];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return bad(`the value of "${sp.slice(0, 60)}" in "${s.slice(0, 60)}" is not an abundance.`);
      }
      if (v > 0) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  const out = { ...ab, samples, species, matrix, warnings: warningList(ab.warnings) };
  const lr = ab.logRange;
  if (!(isObj(lr) && Number.isFinite(lr.min) && Number.isFinite(lr.max))) {
    out.logRange = Number.isFinite(min)
      ? { min: Math.floor(Math.log10(min)), max: Math.min(0, Math.ceil(Math.log10(max))) }
      : { min: -8, max: 0 };
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
  return out;
}

function readMetadata(md, errors) {
  if (md == null) return null;
  if (!isObj(md) || !isObj(md.bySample)) {
    errors.push('metadata: "bySample" (the per-sample annotations) is missing.');
    return null;
  }
  for (const [id, m] of Object.entries(md.bySample)) {
    if (!isObj(m) || (m.extra != null && !isObj(m.extra))) {
      errors.push(`metadata: the annotations of ${id} are not an object.`);
      return null;
    }
  }
  const out = { ...md, warnings: warningList(md.warnings) };
  if (md.cols != null && !isObj(md.cols)) delete out.cols;
  if (typeof md.nSamples !== "number") out.nSamples = Object.keys(md.bySample).length;
  return out;
}

function readPlateMap(pm, errors) {
  if (pm == null) return null;
  if (!isObj(pm) || !isObj(pm.bySample)) {
    errors.push('plate_map: "bySample" (the sample → well placement) is missing.');
    return null;
  }
  let maxRow = 7;
  let maxCol = 11;
  for (const [id, p] of Object.entries(pm.bySample)) {
    const okWell =
      isObj(p) &&
      Number.isInteger(p.row) &&
      Number.isInteger(p.col) &&
      p.row >= 0 &&
      p.row <= 15 &&
      p.col >= 0 &&
      p.col <= 23 &&
      (p.plate == null || typeof p.plate === "string" || typeof p.plate === "number");
    if (!okWell) {
      errors.push(`plate_map: ${id} has no valid well.`);
      return null;
    }
    maxRow = Math.max(maxRow, p.row);
    maxCol = Math.max(maxCol, p.col);
  }
  const big = maxRow > 7 || maxCol > 11;
  const f = pm.format;
  const formatOk =
    isObj(f) &&
    ((f.rows === 8 && f.cols === 12 && !big) || (f.rows === 16 && f.cols === 24));
  const out = { ...pm, warnings: warningList(pm.warnings) };
  if (!formatOk) out.format = big ? { rows: 16, cols: 24 } : { rows: 8, cols: 12 };
  if (pm.cols != null && !isObj(pm.cols)) delete out.cols;
  return out;
}

/** Read a session JSON (exportJSON's format, any version) into a session,
    checking the WHOLE file first: nothing replaces the current session
    unless every part of the file can be shown.

    `defaults` is AppMain's defaultFilter() (the imported filter is merged
    over it), `tabs` the tab ids the app knows.

    Returns { ok: false, errors } (the first few problems, each naming
    where it is), or { ok: true, session, changes }: `session` has the
    shape every reader of this module uses, its sample curation brought
    up to date with the current model (migrateSampleCuration), and
    `changes` what that migration changed in the curated output (null:
    nothing to tell). */
export function sessionFromPayload(json, { defaults, tabs } = {}) {
  if (!isObj(json)) {
    return {
      ok: false,
      errors: ['This is not a session file: expected a JSON object with an "events" list.'],
    };
  }
  const errors = [];
  if (!("events" in json)) errors.push('Missing "events" list.');
  const { events, renumbered } =
    "events" in json ? readEvents(json.events, errors) : { events: [], renumbered: false };
  const sampleCuration = readSampleCuration(json.sample_curation, errors);
  const ab = readAbundance(json.abundance, errors);
  const metadata = readMetadata(json.metadata, errors);
  const plateMap = readPlateMap(json.plate_map, errors);
  const runMetadata = json.run_metadata == null ? null : json.run_metadata;
  if (runMetadata !== null && !isObj(runMetadata)) {
    errors.push('"run_metadata" must be an object.');
  }
  const ui = json.ui_state == null ? {} : json.ui_state;
  if (!isObj(ui)) errors.push('"ui_state" must be an object.');
  if (errors.length > 0) {
    const more = errors.length - MAX_LISTED;
    return {
      ok: false,
      errors:
        more > 0
          ? [...errors.slice(0, MAX_LISTED), `… and ${more} more problem${more > 1 ? "s" : ""}.`]
          : errors,
    };
  }
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
    session: {
      rawEvents,
      // Brought up to date by the migration above.
      sampleCuration: migrated.sampleCuration,
      sampleCurationVersion: SAMPLE_CURATION_VERSION,
      runMetadata,
      eventsWarnings: warningList(json.events_warnings),
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
