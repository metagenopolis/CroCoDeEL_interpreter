/* ---------- the browser's copy of the session (IndexedDB) ----------

   One database, one key → value object store; the records and what they
   hold are described in src/persistence.js. IndexedDB gives hundreds of
   MB to GBs (vs localStorage's ~5–10 MB) and structured-cloned writes,
   with no JSON.stringify / LZ compression. Sessions stored by the first
   versions under localStorage keys, then under the single "main" record,
   are migrated once, on boot.

   Every write of the session records (writeSession) runs in ONE
   readwrite transaction that first reads the stored revision: if it is
   not the one this page last read or wrote, another tab has changed the
   session since, and nothing is written — the caller stops saving and
   says so. The abundance table is written afterwards, on its own (a full
   quota on the largest record must not cost the curation), and the UI
   state on its own too, unchecked.

   A failed write rejects. A write the browser refuses at commit — a full
   quota — aborts the transaction WITHOUT any error event: the previous
   version listened to `error` only, so its save promise never settled,
   the failure went unseen, and the work was gone after a reload. */

import LZString from "lz-string";
import {
  ALL_DIRTY,
  LEGACY_MAIN_KEY,
  RECORD_KEYS,
  abundanceRecord,
  forgetLostTable,
  sessionFromLegacyMain,
  sessionFromRecords,
  sessionWrites,
  uiRecord,
} from "./persistence.js";

export const DB_NAME = "crocodeel-interpreter";
const DB_VERSION = 1;
const STORE = "kv";
// Legacy localStorage keys — read once during the migration and removed
// afterwards. The prefix flagged LZ-compressed payloads.
const LEGACY_KEY = "crocodeel-interpreter-v1";
const LEGACY_KEY_AB = "crocodeel-interpreter-v1-ab";
const LEGACY_COMPRESSED_PREFIX = "lz:";

/** This page's name in the curation record and in the notices it sends
    the other tabs. */
export const WRITER_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** True when the current browser exposes IndexedDB. Without it the app
    runs in memory, and says the session is not saved. */
export function indexedDBSupported() {
  return typeof window !== "undefined" && !!window.indexedDB;
}

/** Open (or create) the session database. The handle is cached at module
    scope so that reads and writes skip the open round-trip, and so that
    a save started while the page is being hidden can open its
    transaction synchronously (writeSessionNow). The cache is cleared on
    the connection's `close` / `versionchange` events so we recover if
    another tab upgrades the schema. */
let dbHandlePromise = null;
let dbHandle = null;
export function openDB() {
  if (dbHandlePromise) return dbHandlePromise;
  const thisPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = window.indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      const forget = () => {
        if (dbHandlePromise === thisPromise) {
          dbHandlePromise = null;
          dbHandle = null;
        }
      };
      // If another tab opens the DB with a higher version, our handle is
      // invalidated — drop it and let the next call re-open.
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          // ignore
        }
        forget();
      };
      db.onclose = forget;
      if (dbHandlePromise === thisPromise) dbHandle = db;
      resolve(db);
    };
    req.onerror = () => {
      if (dbHandlePromise === thisPromise) dbHandlePromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      if (dbHandlePromise === thisPromise) dbHandlePromise = null;
      reject(new Error("IndexedDB open blocked — close other tabs running this app"));
    };
  });
  dbHandlePromise = thisPromise;
  return thisPromise;
}

/** Run `fn(db)`: at once when the database is open, after opening it
    otherwise. A synchronous throw (a closed connection) rejects. */
function withDB(fn) {
  const run = (db) => {
    try {
      return Promise.resolve(fn(db));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  return dbHandle ? run(dbHandle) : openDB().then(run);
}

/** Settles with the transaction: resolves on `complete`, rejects on
    `abort` — which also follows a failed request — with the reason. */
function settled(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error || new DOMException("The browser aborted the write.", "AbortError"));
  });
}

export function idbGet(key) {
  return withDB((db) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    return settled(tx).then(() => req.result ?? null);
  });
}

export function idbSet(key, value) {
  return withDB((db) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    return settled(tx);
  });
}

export function idbDel(key) {
  return withDB((db) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    return settled(tx);
  });
}

/** Every record, in one read. */
function readRecords(db) {
  const tx = db.transaction(STORE, "readonly");
  const store = tx.objectStore(STORE);
  const out = {};
  for (const key of [...Object.values(RECORD_KEYS), LEGACY_MAIN_KEY]) {
    const req = store.get(key);
    req.onsuccess = () => {
      out[key] = req.result ?? null;
    };
  }
  return settled(tx).then(() => out);
}

/** The curation record as written: with the revision, this page's id and
    the time. */
const stamped = (record, rev) => ({
  ...record,
  rev,
  writer: WRITER_ID,
  savedAt: new Date().toISOString(),
});

function putAll(store, { puts, dels }, rev) {
  for (const [key, value] of puts) {
    store.put(key === RECORD_KEYS.curation ? stamped(value, rev) : value, key);
  }
  for (const key of dels) store.delete(key);
}

/* --------------------------------------------- the revision, mirrored */

/** The session's revision is mirrored in localStorage by every tab that
    writes it. A page being hidden for good writes without the revision
    check (writeSessionNow: its IndexedDB callbacks may never run), and
    without BroadcastChannel nothing told it that another tab had written
    since: its older copy then replaced that tab's work. localStorage is
    read synchronously, in that last moment (peekRev). */
const REV_KEY = "crocodeel-interpreter-rev";

/** Mirror `rev`. It never goes back — a tab that read the session just
    before another wrote it must not hide that write — unless `reset`:
    nothing is stored at all (a deleted database). A mirror left ahead
    by a last write that failed is caught up by the next write. */
function mirrorRev(rev, reset = false) {
  try {
    const known = peekRev();
    if (reset || known === null || rev > known) {
      window.localStorage.setItem(REV_KEY, String(rev));
    }
  } catch {
    // no localStorage: the channel and the revision check remain
  }
}

/** The last revision any tab wrote, as mirrored; null when unknown. */
export function peekRev() {
  try {
    const v = window.localStorage.getItem(REV_KEY);
    const n = v == null ? NaN : Number(v);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------- legacy localStorage */

/** Read a single legacy localStorage key, transparently decompressing
    the LZ-UTF16 payload if the prefix is present. Null if the key is
    missing or the parse / decompress fails. */
function readLegacyKey(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    if (raw.startsWith(LEGACY_COMPRESSED_PREFIX)) {
      const decompressed = LZString.decompressFromUTF16(
        raw.slice(LEGACY_COMPRESSED_PREFIX.length),
      );
      if (!decompressed) return null;
      return JSON.parse(decompressed);
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function removeLegacyKeys() {
  try {
    window.localStorage.removeItem(LEGACY_KEY);
    window.localStorage.removeItem(LEGACY_KEY_AB);
  } catch {
    // ignore
  }
}

/** Write a session of an earlier layout as the current records, in one
    transaction, unless another tab has done it first (then nothing is
    written and false comes back). The "main" record goes in the same
    transaction (sessionWrites deletes it with every write of the events
    record). The abundance record of the "main" layout already has the
    current shape and stays; one read from localStorage (`abFromLocal`)
    is written. */
function migrateSession(db, session, abFromLocal) {
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  let migrated = false;
  const get = store.get(RECORD_KEYS.curation);
  get.onsuccess = () => {
    if (get.result) return;
    migrated = true;
    putAll(store, sessionWrites(session, { ...ALL_DIRTY, ab: false }, null), 1);
    store.put({ ...uiRecord(session), savedAt: new Date().toISOString() }, RECORD_KEYS.ui);
    if (abFromLocal) store.put(abundanceRecord(abFromLocal, null), RECORD_KEYS.ab);
  };
  return settled(tx).then(() => {
    if (migrated) mirrorRev(1);
    return migrated;
  });
}

/** Stop naming a lost abundance table (persistence.js' forgetLostTable),
    in one transaction that reads the records again. Resolves true when
    it did. */
function repairLostTable(db, rev, token) {
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  let repaired = false;
  const cur = store.get(RECORD_KEYS.curation);
  const ab = store.get(RECORD_KEYS.ab);
  // Requests complete in order: the curation has been read by now.
  ab.onsuccess = () => {
    const fix = forgetLostTable(cur.result, ab.result, rev, token);
    if (!fix) return;
    store.put(fix.curation, RECORD_KEYS.curation);
    if (fix.deleteAb) store.delete(RECORD_KEYS.ab);
    repaired = true;
  };
  return settled(tx).then(() => repaired);
}

/** The stored session, read on boot: { session, rev, abToken, inRecords }
    — `session` null when nothing is stored, `rev` the revision the next
    write must find, `abToken` the token of the stored abundance table.
    A session of an earlier layout is migrated first. `inRecords` is
    false when that migration failed (a full quota aborts it): the
    session is then read from the earlier layout as it is, and the
    current records do not hold it — the autosave must write every one
    of them at its first save. Starting it from that session instead
    wrote only the curation and UI records at the first change; from
    then on the boot read the current records alone, and the events,
    the metadata and the plate map, left in "main", were lost at the
    next reload. A session that comes back without its abundance table
    (abLost) stops naming it (repairLostTable), so that its notice is
    shown once. Rejects when the database cannot be opened or read (the
    app then runs in memory). */
export async function readStoredSession() {
  const db = await openDB();
  let records = await readRecords(db);
  if (!records.curation) {
    let session = sessionFromLegacyMain(records[LEGACY_MAIN_KEY], records.ab);
    let abFromLocal = null;
    let fromLocal = false;
    if (!session && !records[LEGACY_MAIN_KEY]) {
      const main = readLegacyKey(LEGACY_KEY);
      if (main) {
        abFromLocal = readLegacyKey(LEGACY_KEY_AB) || main.ab || null;
        session = sessionFromLegacyMain(main, abFromLocal);
        fromLocal = !!session;
      }
    }
    if (!session) {
      mirrorRev(0, true);
      return { session: null, rev: 0, abToken: null, inRecords: true };
    }
    try {
      await migrateSession(db, session, fromLocal ? abFromLocal : null);
      if (fromLocal) removeLegacyKeys();
    } catch (e) {
      // Read it as it is; the first save writes every current record
      // (and drops the earlier layout's copies: writeSession).
      console.warn("[crocodeel] session migration failed:", e?.message);
      mirrorRev(0, true);
      return { session, rev: 0, abToken: null, inRecords: false };
    }
    records = await readRecords(db);
  }
  const session = sessionFromRecords(records);
  const rev = records.curation?.rev ?? 0;
  let abToken = records.curation?.abToken ?? null;
  if (session?.abLost) {
    // The session came back without its table: AppMain says so, once.
    try {
      if (await repairLostTable(db, rev, abToken)) abToken = null;
    } catch (e) {
      console.warn("[crocodeel] could not forget the lost abundance table:", e?.message);
    }
  }
  // Known from now on (a deleted localStorage loses the mirror).
  mirrorRev(rev);
  return { session, rev, abToken, inRecords: true };
}

/** Write the session records (persistence.js' sessionWrites) in one
    transaction, if the stored revision is still `expectedRev`: resolves
    { status: "ok", rev } with the new revision, or
    { status: "conflict", rev } with the stored one — another tab wrote
    since, and nothing was written. Rejects when the write fails. A write
    of the events record also drops what is left of the earlier layouts
    — "main" in the same transaction, the localStorage keys once it has
    committed — which only a failed migration leaves behind. */
export function writeSession(writes, expectedRev) {
  return withDB((db) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const rev = expectedRev + 1;
    let conflict = null;
    const get = store.get(RECORD_KEYS.curation);
    get.onsuccess = () => {
      const stored = get.result?.rev ?? 0;
      if (stored !== expectedRev) {
        conflict = stored;
        return;
      }
      putAll(store, writes, rev);
    };
    return settled(tx).then(() => {
      if (conflict !== null) return { status: "conflict", rev: conflict };
      mirrorRev(rev);
      if (writes.dels.includes(LEGACY_MAIN_KEY)) removeLegacyKeys();
      return { status: "ok", rev };
    });
  });
}

/** The same writes, plus the abundance table and the UI state, issued
    synchronously and committed at once — for a page being hidden for
    good (pagehide), whose callbacks may never run: a revision check
    would need one. The caller checks the mirrored revision first
    (peekRev); the revision written is the next one, mirrored at once.
    Returns false when the database is not open. */
export function writeSessionNow({ writes, rev, ab, ui }) {
  if (!dbHandle) return false;
  try {
    const tx = dbHandle.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (writes) putAll(store, writes, rev);
    if (ab) store.put(ab, RECORD_KEYS.ab);
    if (ui) store.put({ ...ui, savedAt: new Date().toISOString() }, RECORD_KEYS.ui);
    if (typeof tx.commit === "function") tx.commit();
    if (writes) mirrorRev(rev);
    return true;
  } catch {
    return false;
  }
}

/** Write the abundance record (persistence.js' abundanceRecord). With
    `expectedRev` — the autosave writing again a table whose write
    failed — only if the stored revision is still that one, in the same
    transaction: resolves { status: "conflict", rev } with nothing
    written when another tab has written the session since (its curation
    record names its own table), { status: "ok", named } otherwise.
    `named` is false when the curation record no longer names the
    table's token: a tab that opened the session meanwhile found it
    without its table and stopped naming it (forgetLostTable). */
export function writeAb(record, expectedRev) {
  if (expectedRev == null) return idbSet(RECORD_KEYS.ab, record);
  return withDB((db) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let conflict = null;
    let named = false;
    const get = store.get(RECORD_KEYS.curation);
    get.onsuccess = () => {
      const stored = get.result?.rev ?? 0;
      if (stored !== expectedRev) {
        conflict = stored;
        return;
      }
      named = (get.result?.abToken ?? null) === (record.storageToken ?? null);
      store.put(record, RECORD_KEYS.ab);
    };
    return settled(tx).then(() =>
      conflict !== null ? { status: "conflict", rev: conflict } : { status: "ok", named },
    );
  });
}

/** Delete the abundance record: after a failed write, so that an older
    table is never restored with the newer session. */
export function deleteAb() {
  return idbDel(RECORD_KEYS.ab);
}

/** Write the UI record. */
export function writeUi(ui) {
  return idbSet(RECORD_KEYS.ui, { ...ui, savedAt: new Date().toISOString() });
}

/** The channel on which tabs announce their saves (null without
    BroadcastChannel). */
export function openSessionChannel() {
  return typeof BroadcastChannel === "function" ? new BroadcastChannel(DB_NAME) : null;
}

/** The backend of the autosave (src/autosave.js). */
export const idbBackend = {
  writer: WRITER_ID,
  writeSession,
  writeSessionNow,
  peekRev,
  writeAb,
  deleteAb,
  writeUi,
  openChannel: openSessionChannel,
};

/** What this browser has stored, read without migrating anything — for
    the error screen, which offers it as a session JSON. Null when
    nothing is stored or storage cannot be read. */
export async function readStoredSessionForRescue() {
  if (!indexedDBSupported()) return null;
  try {
    const db = await openDB();
    const records = await readRecords(db);
    return records.curation
      ? sessionFromRecords(records)
      : sessionFromLegacyMain(records[LEGACY_MAIN_KEY], records.ab);
  } catch {
    return null;
  }
}

/** Delete the whole database (the error screen's last resort). */
export function deleteStoredSession() {
  return new Promise((resolve) => {
    try {
      if (dbHandle) dbHandle.close();
    } catch {
      // ignore
    }
    dbHandle = null;
    dbHandlePromise = null;
    try {
      const req = window.indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
