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
       tab, selId, filter, sort } */

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
