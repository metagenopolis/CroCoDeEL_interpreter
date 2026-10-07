/* ---------- autosave: what to write, when, and what to tell ----------

   AppMain hands every new state to `update`; the autosave writes, a short
   while after the last change, only the records that changed
   (src/persistence.js):

     - an evaluation rewrites the small curation record, a tab switch the
       small UI record; the events, the abundance table, the metadata and
       the plate map only when they change;
     - the delay is short (SAVE_DELAY_MS) and a page being hidden or
       closed is saved at once (flushNow on visibilitychange,
       flushOnPageHide on pagehide): a T pressed half a second before a
       reload used to be lost with the 1 s debounce;
     - every write of the session records checks the stored revision
       (src/storage.js). When another tab has written since — or says so
       on the session channel — this tab stops saving and reports a
       conflict: it must not overwrite the newer session with its own
       older copy. The UI record is not checked (last writer wins), but a
       tab in conflict writes nothing at all;
     - a failed write (full quota, storage gone) is reported and retried
       on the next change, at most every RETRY_AFTER_FAILURE_MS: the
       session stays "not saved" until a write succeeds. The abundance
       table, written on its own, is retried the same way.

   The status goes to `onStatus({ state, savedAt, abFailed, error })`:
   state "idle" (nothing written yet), "saved", "failed", "conflict" or,
   without storage, "unavailable" (nothing is ever written). `abFailed`:
   the session was saved but its abundance table could not be. */

import {
  abundanceRecord,
  dirtyRecords,
  isEmptySession,
  sessionWrites,
  uiRecord,
} from "./persistence.js";

export const SAVE_DELAY_MS = 300;
export const RETRY_AFTER_FAILURE_MS = 5000;

/** Stands for an abundance table whose write failed: never equal to the
    session's, so a later save tries again. */
const UNSAVED_TABLE = Object.freeze({ unsaved: true });

const newToken = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** What a failed write says, for the banner. */
export function describeStorageError(err) {
  const name = err?.name || "";
  if (name === "QuotaExceededError") return "the browser's storage for this site is full";
  if (name === "AbortError") return "the browser refused the write (storage full or unavailable)";
  return err?.message
    ? `the browser could not write it (${err.message})`
    : "the browser could not write it";
}

/** The state fields the session records are written from, and the UI
    record's. */
const SESSION_FIELDS = [
  "rawEvents",
  "runMetadata",
  "eventsWarnings",
  "ab",
  "metadata",
  "plateMap",
  "sampleCuration",
  "sampleCurationVersion",
  "analysisTitle",
];
const UI_FIELDS = ["tab", "selId", "filter", "sort"];
const pick = (s, fields) => Object.fromEntries(fields.map((f) => [f, s?.[f]]));

/** Start the autosave of a session.

      backend       { writer, writeSession, writeSessionNow, writeAb,
                      deleteAb, writeUi, openChannel } (src/storage.js)
      initialState  the state the stored records hold, as read on boot
                    (null when nothing is stored)
      rev, abToken  the stored revision and abundance-table token
      available     false: no storage — nothing is ever written
      onStatus      called with every new status

    Returns { update, flushNow, flushOnPageHide, dispose, status }. */
export function createAutosave({
  backend,
  initialState,
  rev = 0,
  abToken = null,
  available = true,
  onStatus = () => {},
  delay = SAVE_DELAY_MS,
  retryAfter = RETRY_AFTER_FAILURE_MS,
  now = () => Date.now(),
}) {
  let latest = initialState;
  // The state the stored records were written from; null: nothing stored
  // (then an empty state writes nothing, and the first one with data
  // writes every record).
  let saved = initialState
    ? { ...pick(initialState, SESSION_FIELDS), ...pick(initialState, UI_FIELDS) }
    : null;
  let confirmedRev = rev;
  let token = abToken;
  let timer = null;
  let inFlight = null;
  let again = false;
  let failedAt = null;
  let tableFailedAt = null;
  let stopped = !available;
  let status = {
    state: available ? "idle" : "unavailable",
    savedAt: null,
    abFailed: false,
    error: null,
  };
  let channel = null;

  const setStatus = (patch) => {
    status = { ...status, ...patch };
    onStatus(status);
  };

  /** Another tab wrote a newer session: stop, and say so. */
  const conflict = () => {
    if (status.state === "conflict") return;
    stopped = true;
    clearTimeout(timer);
    timer = null;
    setStatus({ state: "conflict" });
  };

  if (available && backend.openChannel) {
    try {
      channel = backend.openChannel();
    } catch {
      channel = null;
    }
    if (channel) {
      channel.onmessage = (ev) => {
        const m = ev?.data;
        if (m?.type === "saved" && m.writer !== backend.writer && m.rev > confirmedRev) {
          conflict();
        }
      };
    }
  }
  const announce = (savedRev) => {
    try {
      channel?.postMessage({ type: "saved", rev: savedRev, writer: backend.writer });
    } catch {
      // ignore: the revision check still guards the next write
    }
  };

  const schedule = (ms = delay) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, ms));
  };

  /** What the next write holds, or null when nothing changed. A table
      whose write failed is retried at most every `retryAfter`; until
      then, the other records are written as if the table were saved —
      a tab switch writes the UI record only. Counting the waiting table
      as a change rewrote the curation record on every switch, bumping
      the revision, and every other open tab took it for another tab's
      work ("changed in another tab"). */
  const plan = () => {
    const s = latest;
    if (!s || (!saved && isEmptySession(s))) return null;
    let d = dirtyRecords(saved, s);
    if (d.ab && s.ab && tableFailedAt != null && now() - tableFailedAt < retryAfter) {
      d = { ...dirtyRecords({ ...saved, ab: s.ab }, s), ab: false };
      schedule(retryAfter - (now() - tableFailedAt));
    }
    const session = d.events || d.ab || d.metadata || d.plate || d.curation;
    if (!session && !d.ui) return null;
    const nextToken = d.ab ? (s.ab ? newToken() : null) : token;
    return { s, d, session, nextToken };
  };

  /** Another tab's notice can arrive while one of this tab's writes is in
      flight: the status then stays "conflict" and this tab writes no UI
      record. Setting "saved" (or "failed") once the write settled used to
      hide the banner of a tab that had stopped saving for good. (The
      table of a session just written is still written: a tab that wrote
      since read that session, and its curation record names that
      table.) */
  const inConflict = () => status.state === "conflict";

  async function write({ s, d, session, nextToken }) {
    let abFailed = status.abFailed;
    if (session) {
      const res = await backend.writeSession(sessionWrites(s, d, nextToken), confirmedRev);
      if (res.status === "conflict") {
        conflict();
        return;
      }
      confirmedRev = res.rev;
      token = nextToken;
      announce(res.rev);
      let table = d.ab ? s.ab : saved?.ab;
      if (d.ab && s.ab) {
        try {
          await backend.writeAb(abundanceRecord(s.ab, nextToken));
          tableFailedAt = null;
          abFailed = false;
        } catch (e) {
          console.warn("[crocodeel] saving the abundance table failed:", e?.message || e);
          tableFailedAt = now();
          abFailed = true;
          table = UNSAVED_TABLE;
          // The token already keeps an older table from coming back with
          // this session; deleting it frees the space.
          try {
            await backend.deleteAb();
          } catch {
            // ignore
          }
        }
      } else if (d.ab) {
        abFailed = false;
        tableFailedAt = null;
      }
      saved = { ...saved, ...pick(s, SESSION_FIELDS), ab: table };
    }
    if (inConflict()) return;
    if (d.ui) {
      await backend.writeUi(uiRecord(s));
      if (inConflict()) return;
      saved = { ...saved, ...pick(s, UI_FIELDS) };
    }
    failedAt = null;
    setStatus({ state: "saved", savedAt: now(), abFailed, error: null });
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    if (failedAt != null && now() - failedAt < retryAfter) {
      schedule(retryAfter - (now() - failedAt));
      return;
    }
    const next = plan();
    if (!next) return;
    inFlight = write(next)
      .catch((e) => {
        console.warn("[crocodeel] saving the session failed:", e?.message || e);
        if (inConflict()) return;
        failedAt = now();
        setStatus({ state: "failed", error: describeStorageError(e) });
      })
      .finally(() => {
        inFlight = null;
        if (again && !stopped) {
          again = false;
          schedule(0);
        }
      });
  }

  return {
    /** The state to save; written a short while after the last call. */
    update(state) {
      latest = state;
      schedule();
    },
    /** Write now (the page is being hidden), checking the revision. */
    flushNow() {
      if (!stopped) flush();
    },
    /** Write now, synchronously and without the revision check: the page
        is going away and its callbacks may never run (writeSessionNow).
        Counted as written, so a page restored from the back-forward
        cache goes on from the revision it wrote. */
    flushOnPageHide() {
      if (stopped) return;
      clearTimeout(timer);
      timer = null;
      const next = plan();
      if (!next) return;
      const { s, d, session, nextToken } = next;
      const nextRev = confirmedRev + 1;
      const issued = backend.writeSessionNow({
        writes: session ? sessionWrites(s, d, nextToken) : null,
        rev: nextRev,
        ab: session && d.ab && s.ab ? abundanceRecord(s.ab, nextToken) : null,
        ui: d.ui ? uiRecord(s) : null,
      });
      if (!issued) return;
      if (session) {
        confirmedRev = nextRev;
        token = nextToken;
        announce(nextRev);
        saved = { ...saved, ...pick(s, SESSION_FIELDS) };
      }
      if (d.ui) saved = { ...saved, ...pick(s, UI_FIELDS) };
    },
    dispose() {
      clearTimeout(timer);
      timer = null;
      stopped = true;
      try {
        channel?.close();
      } catch {
        // ignore
      }
    },
    get status() {
      return status;
    },
  };
}
