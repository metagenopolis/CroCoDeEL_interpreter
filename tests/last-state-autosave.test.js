import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAutosave, SAVE_DELAY_MS } from "../src/autosave.js";
import { RECORD_KEYS, newerLegacyMain } from "../src/persistence.js";

/* A tab still running the previous version (open since before the
   update) saves its "main" record, which the next boot brings in when it
   is newer than the curation record (newerLegacyMain). A save of this
   version made after it hid it: its curation record was newer, the boot
   took that save for one it had superseded, and the earlier tab's work
   was lost without a word. A checked write (src/storage.js, writeSession)
   now reads that record and stops this tab instead; the last save of a
   page going away cannot read anything, and writes in the curation
   record the time of this tab's last checked write, not its own, so that
   such a save, made since, stays the newer one. */

/** An in-memory backend that stamps like src/storage.js: a checked write
    stamps the time of the write and returns it, the last save of a page
    going away writes the time it is given (now when none is). */
function memoryStore(clock) {
  const records = {};
  const nows = [];
  const checks = [];
  const backend = {
    writer: "this-tab",
    async writeSession({ puts, dels }, expectedRev, checkedAt) {
      checks.push(checkedAt);
      const stored = records[RECORD_KEYS.curation];
      const seen = stored ?? (checkedAt ? { savedAt: checkedAt } : null);
      if ((stored?.rev ?? 0) !== expectedRev || newerLegacyMain(records.main, seen)) {
        return { status: "conflict", rev: stored?.rev ?? 0 };
      }
      const rev = expectedRev + 1;
      const savedAt = clock();
      for (const [k, v] of puts) records[k] = k === RECORD_KEYS.curation ? { ...v, rev, savedAt } : v;
      for (const k of dels) delete records[k];
      return { status: "ok", rev, savedAt };
    },
    writeSessionNow({ writes, rev, savedAt }) {
      nows.push(savedAt);
      if (writes) {
        for (const [k, v] of writes.puts) {
          records[k] = k === RECORD_KEYS.curation ? { ...v, rev, savedAt: savedAt ?? clock() } : v;
        }
        for (const k of writes.dels) delete records[k];
      }
      return true;
    },
    peekRev: () => records[RECORD_KEYS.curation]?.rev ?? null,
    async writeAb() {
      return { status: "ok", named: true };
    },
    async deleteAb() {},
    async writeUi() {},
  };
  return { records, nows, checks, backend };
}

const event = (id, verdict = "pending") => ({
  id,
  source: "A",
  target: "B",
  rate: 0.1,
  score: 0.9,
  introduced: ["x"],
  verdict,
  notes: "",
});
// An evaluation builds a new event and keeps everything else as it was
// (the species list, the parser's warnings: by reference), as AppMain
// does: the events record is not written again.
const EVENTS = [event(0), event(1)];
const WARNINGS = [];
const session = (verdicts) => ({
  rawEvents: EVENTS.map((e, i) => (verdicts[i] === e.verdict ? e : { ...e, verdict: verdicts[i] })),
  runMetadata: null,
  eventsWarnings: WARNINGS,
  ab: null,
  metadata: null,
  plateMap: null,
  sampleCuration: {},
  sampleCurationVersion: 2,
  analysisTitle: "",
  tab: "overview",
  selId: null,
  filter: { q: "" },
  sort: { by: "score", dir: "desc" },
});

let time;
const clock = () => new Date(Date.UTC(2026, 9, 7, 10, 0, time++)).toISOString();
beforeEach(() => {
  vi.useFakeTimers();
  time = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

/** A tab started from the stored session, as AppMain starts it. */
function tab(store, initial) {
  const cur = store.records[RECORD_KEYS.curation];
  const statuses = [];
  const saver = createAutosave({
    backend: store.backend,
    initialState: initial,
    rev: cur?.rev ?? 0,
    checkedAt: cur?.savedAt ?? null,
    onStatus: (s) => statuses.push(s.state),
  });
  return { saver, statuses };
}

describe("a checked write, after a save of the earlier version", () => {
  it("gets the time of the boot's read, which stands for the curation record's while none is stored", async () => {
    const store = memoryStore(clock);
    const readAt = clock();
    const statuses = [];
    const saver = createAutosave({
      backend: store.backend,
      initialState: null,
      checkedAt: readAt,
      onStatus: (st) => statuses.push(st.state),
    });
    // The earlier version's tab loads files after this tab's boot.
    store.records.main = { savedAt: clock(), rawEvents: [event(0, "true_positive")] };
    saver.update(session(["uncertain", "pending"]));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(store.checks).toEqual([readAt]);
    expect(statuses.at(-1)).toBe("conflict");
    expect(store.records[RECORD_KEYS.curation]).toBeUndefined();
  });
});

describe("the last save of a page going away, after a save of the earlier version", () => {
  it("writes the time of the boot's read when nothing was written since", () => {
    const store = memoryStore(clock);
    store.records[RECORD_KEYS.curation] = { rev: 4, savedAt: clock() };
    const booted = store.records[RECORD_KEYS.curation].savedAt;
    const { saver } = tab(store, session(["pending", "pending"]));
    // The earlier version's tab saves; then this tab changes something
    // and is reloaded at once.
    store.records.main = { savedAt: clock(), rawEvents: [event(0, "true_positive")] };
    saver.update(session(["false_positive", "pending"]));
    saver.flushOnPageHide();
    expect(store.nows).toEqual([booted]);
    expect(store.records[RECORD_KEYS.curation].rev).toBe(5);
    // The next boot finds that save the newer one, and brings it in.
    expect(newerLegacyMain(store.records.main, store.records[RECORD_KEYS.curation])).toBe(true);
  });

  it("writes the time of this tab's last checked write", async () => {
    const store = memoryStore(clock);
    store.records[RECORD_KEYS.curation] = { rev: 1, savedAt: clock() };
    const { saver } = tab(store, session(["pending", "pending"]));
    saver.update(session(["true_positive", "pending"]));
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    const checked = store.records[RECORD_KEYS.curation].savedAt;
    expect(store.records[RECORD_KEYS.curation].rev).toBe(2);
    store.records.main = { savedAt: clock(), rawEvents: [event(1, "true_positive")] };
    saver.update(session(["true_positive", "false_positive"]));
    saver.flushOnPageHide();
    expect(store.nows).toEqual([checked]);
    expect(newerLegacyMain(store.records.main, store.records[RECORD_KEYS.curation])).toBe(true);
  });
});
