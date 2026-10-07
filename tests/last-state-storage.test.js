import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ALL_DIRTY, RECORD_KEYS, sessionWrites } from "../src/persistence.js";
import { readStoredSession, writeSession, writeSessionNow } from "../src/storage.js";

/* src/storage.js with a tab still running the previous version (open
   since before the update). That tab saves its "main" record, which the
   next boot brings in when it is newer than the curation record
   (newerLegacyMain). Once a tab of this version saved after it, the
   curation record was the newer one: the boot took that save for one it
   had superseded, kept "main" as it was, and the earlier tab's work was
   lost without a word. A checked write (writeSession) now reads "main"
   in its transaction, and such a save stops it; the last save of a page
   going away (writeSessionNow), which reads nothing, writes the time of
   the tab's last checked write instead of its own. */

/** Just enough of IndexedDB for src/storage.js: one store; the requests
    of a transaction run in order, after the current task, those issued
    from a callback within the same transaction, then `complete`. */
function fakeIndexedDB() {
  const data = new Map();
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    close() {},
    transaction() {
      const tx = { oncomplete: null, onabort: null, error: null, commit() {} };
      const queue = [];
      let scheduled = false;
      const later = (job) => {
        queue.push(job);
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          while (queue.length) queue.shift()();
          tx.oncomplete?.();
        }, 0);
      };
      tx.objectStore = () => ({
        get(key) {
          const req = { result: undefined, onsuccess: null };
          later(() => {
            req.result = data.has(key) ? structuredClone(data.get(key)) : undefined;
            req.onsuccess?.();
          });
          return req;
        },
        put(value, key) {
          later(() => data.set(key, structuredClone(value)));
        },
        delete(key) {
          later(() => data.delete(key));
        },
      });
      return tx;
    },
  };
  const indexedDB = {
    open() {
      const req = { result: null };
      setTimeout(() => {
        req.result = db;
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
  return { data, indexedDB };
}

const fake = fakeIndexedDB();
beforeAll(() => {
  window.indexedDB = fake.indexedDB;
});
beforeEach(() => {
  fake.data.clear();
  window.localStorage.clear();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const EVENTS = [0, 1, 2].map((id) => ({
  id,
  source: "S1",
  target: `T${id}`,
  rate: 0.1,
  score: 0.9,
  introduced: ["sp_a"],
  verdict: "pending",
  notes: "",
}));
const session = (verdicts = {}) => ({
  rawEvents: EVENTS.map((e) => (verdicts[e.id] ? { ...e, verdict: verdicts[e.id] } : e)),
  runMetadata: null,
  eventsWarnings: [],
  ab: null,
  metadata: null,
  plateMap: null,
  sampleCuration: {},
  sampleCurationVersion: 2,
  analysisTitle: "",
});
const CURATION_ONLY = { events: false, ab: false, metadata: false, plate: false, curation: true, ui: false };

/** The session as this version stores it (revision 1), then the "main"
    record of a tab of the previous version that saved after it, with
    event 2 marked true positive. */
async function storedThenEarlierTabSaves() {
  const first = await writeSession(sessionWrites(session({ 0: "true_positive" }), ALL_DIRTY, null), 0);
  const main = {
    version: 1,
    savedAt: new Date(Date.parse(first.savedAt) + 1000).toISOString(),
    rawEvents: session({ 0: "true_positive", 2: "true_positive" }).rawEvents,
    sampleCuration: {},
    analysisTitle: "",
  };
  fake.data.set("main", main);
  return { first, main };
}

describe("writeSession, after a save of the previous version", () => {
  it("writes nothing and reports a conflict when that save is the newer one", async () => {
    const { first } = await storedThenEarlierTabSaves();
    const res = await writeSession(sessionWrites(session({ 0: "true_positive", 1: "false_positive" }), CURATION_ONLY, null), first.rev);
    expect(res).toEqual({ status: "conflict", rev: 1 });
    expect(fake.data.get(RECORD_KEYS.curation)).toMatchObject({ rev: 1, savedAt: first.savedAt, verdicts: { 0: "true_positive" } });
    expect(fake.data.has("main")).toBe(true);
  });

  it("writes when that save is older than the stored session, and returns the time it wrote", async () => {
    const { first, main } = await storedThenEarlierTabSaves();
    fake.data.set("main", { ...main, savedAt: "2020-01-01T00:00:00.000Z" });
    const res = await writeSession(sessionWrites(session({ 0: "true_positive", 1: "false_positive" }), CURATION_ONLY, null), first.rev);
    expect(res.status).toBe("ok");
    expect(res.rev).toBe(2);
    expect(fake.data.get(RECORD_KEYS.curation)).toMatchObject({ rev: 2, savedAt: res.savedAt, verdicts: { 1: "false_positive" } });
    expect(res.savedAt >= first.savedAt).toBe(true);
  });
});

describe("a tab that found nothing stored, and a save of the previous version", () => {
  const earlierSession = (savedAt) => ({
    version: 1,
    savedAt,
    rawEvents: session({ 2: "true_positive" }).rawEvents,
    sampleCuration: {},
    analysisTitle: "",
  });

  it("stops at its first save when that save came after its read", async () => {
    const boot = await readStoredSession();
    expect(boot.session).toBeNull();
    expect(typeof boot.savedAt).toBe("string");
    // A tab of the previous version loads files, then this one does.
    fake.data.set("main", earlierSession(new Date(Date.parse(boot.savedAt) + 1000).toISOString()));
    const res = await writeSession(sessionWrites(session({ 0: "uncertain" }), ALL_DIRTY, null), 0, boot.savedAt);
    expect(res).toEqual({ status: "conflict", rev: 0 });
    expect(fake.data.has("main")).toBe(true);
    expect(fake.data.has(RECORD_KEYS.curation)).toBe(false);
    // The next boot opens that session.
    const next = await readStoredSession();
    expect(next.session.rawEvents.map((e) => e.verdict)).toEqual(["pending", "pending", "true_positive"]);
  });

  it("writes over one it read (a migration that failed), as before", async () => {
    const readAt = new Date().toISOString();
    fake.data.set("main", earlierSession(new Date(Date.parse(readAt) - 1000).toISOString()));
    const res = await writeSession(sessionWrites(session({ 0: "uncertain" }), ALL_DIRTY, null), 0, readAt);
    expect(res.status).toBe("ok");
    expect(fake.data.has("main")).toBe(false);
    expect(fake.data.get(RECORD_KEYS.curation).verdicts).toEqual({ 0: "uncertain" });
  });
});

describe("the last save of a page going away, after a save of the previous version", () => {
  it("writes the time it is given, and the next boot brings that save in", async () => {
    const { first, main } = await storedThenEarlierTabSaves();
    const issued = writeSessionNow({
      writes: sessionWrites(session({ 0: "true_positive", 1: "false_positive" }), CURATION_ONLY, null),
      rev: 2,
      savedAt: first.savedAt,
    });
    expect(issued).toBe(true);
    await tick();
    expect(fake.data.get(RECORD_KEYS.curation)).toMatchObject({ rev: 2, savedAt: first.savedAt });
    const boot = await readStoredSession();
    expect(boot.upgrade?.olderTabSavedAt).toBe(main.savedAt);
    expect(boot.session.rawEvents.map((e) => e.verdict)).toEqual(["true_positive", "pending", "true_positive"]);
    expect(fake.data.has("main")).toBe(false);
    // The time the boot read, for the autosave.
    expect(boot.savedAt).toBe(fake.data.get(RECORD_KEYS.curation).savedAt);
    expect(boot.rev).toBe(3);
  });

  it("writes the time of the write itself when it is given none", async () => {
    await writeSession(sessionWrites(session(), ALL_DIRTY, null), 0);
    const before = new Date().toISOString();
    writeSessionNow({ writes: sessionWrites(session({ 1: "uncertain" }), CURATION_ONLY, null), rev: 2, savedAt: null });
    await tick();
    expect(fake.data.get(RECORD_KEYS.curation).rev).toBe(2);
    expect(fake.data.get(RECORD_KEYS.curation).savedAt >= before).toBe(true);
  });
});
