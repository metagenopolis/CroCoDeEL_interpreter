import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAutosave, RETRY_AFTER_FAILURE_MS, SAVE_DELAY_MS } from "../src/autosave.js";
import { RECORD_KEYS, forgetLostTable, sessionFromRecords } from "../src/persistence.js";

/* The autosave (src/autosave.js) while the abundance table's write keeps
   failing (a full quota). The curation record written with the table
   names its token; the table is retried later. Once the first pause was
   over, every tab switch counted the waiting table as a change of the
   session: the curation record was written again, its revision bumped,
   and every other open tab said "This session was changed in another
   tab" and stopped saving, although nobody had changed the curation. */

/** An in-memory backend that behaves like src/storage.js. */
function memoryStore() {
  const records = {};
  const channels = [];
  const store = {
    records,
    writes: [],
    failAb: false,
    backend(writer, { channel = true } = {}) {
      return {
        writer,
        async writeSession({ puts, dels }, expectedRev) {
          const stored = records[RECORD_KEYS.curation]?.rev ?? 0;
          if (stored !== expectedRev) return { status: "conflict", rev: stored };
          const rev = expectedRev + 1;
          for (const [k, v] of puts) {
            records[k] = structuredClone(k === RECORD_KEYS.curation ? { ...v, rev, writer } : v);
          }
          for (const k of dels) delete records[k];
          store.writes.push({ writer, keys: [...puts.map(([k]) => k), ...dels.map((k) => `-${k}`)] });
          return { status: "ok", rev };
        },
        writeSessionNow() {
          return false;
        },
        peekRev() {
          return records[RECORD_KEYS.curation]?.rev ?? null;
        },
        // With a revision, as storage.js does: checked in the same
        // transaction, nothing written on a mismatch; `named` says
        // whether the curation record names the table's token.
        async writeAb(record, expectedRev) {
          if (expectedRev != null) {
            const stored = records[RECORD_KEYS.curation]?.rev ?? 0;
            if (stored !== expectedRev) return { status: "conflict", rev: stored };
          }
          store.writes.push({ writer, keys: [expectedRev != null ? "ab (retry)" : "ab"] });
          if (store.failAb) throw new DOMException("The write was aborted", "AbortError");
          records[RECORD_KEYS.ab] = structuredClone(record);
          return {
            status: "ok",
            named: (records[RECORD_KEYS.curation]?.abToken ?? null) === (record.storageToken ?? null),
          };
        },
        async deleteAb() {
          delete records[RECORD_KEYS.ab];
        },
        async writeUi(ui) {
          records[RECORD_KEYS.ui] = structuredClone(ui);
          store.writes.push({ writer, keys: ["ui"] });
        },
        openChannel: channel
          ? () => {
              const ch = {
                onmessage: null,
                postMessage(data) {
                  for (const other of channels) if (other !== ch) other.onmessage?.({ data });
                },
                close() {},
              };
              channels.push(ch);
              return ch;
            }
          : undefined,
      };
    },
  };
  return store;
}

const TABLE = Object.freeze({
  samples: ["A", "B", "C"],
  species: ["x", "y"],
  matrix: { x: { A: 1 }, y: { B: 1 } },
  logRange: { min: -1, max: 0 },
});
const session = () => ({
  rawEvents: [
    { id: 0, source: "A", target: "B", rate: 0.1, score: 0.9, introduced: ["x"], verdict: "pending", notes: "" },
    { id: 1, source: "C", target: "B", rate: 0.2, score: 0.8, introduced: ["y"], verdict: "pending", notes: "" },
  ],
  runMetadata: null,
  eventsWarnings: [],
  ab: TABLE,
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

const settle = (ms = SAVE_DELAY_MS + 10) => vi.advanceTimersByTimeAsync(ms);

let store;
beforeEach(() => {
  vi.useFakeTimers();
  store = memoryStore();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A tab: an autosave started from what the store holds. Its boot, as
    readStoredSession does it, stops naming a table that did not come
    back (forgetLostTable), so that the notice is shown once. */
function openTab(writer, start, options) {
  const statuses = [];
  let stored = store.records[RECORD_KEYS.curation] ? sessionFromRecords(store.records) : null;
  if (stored?.abLost) {
    const { rev, abToken } = store.records[RECORD_KEYS.curation];
    const fix = forgetLostTable(store.records[RECORD_KEYS.curation], store.records[RECORD_KEYS.ab], rev, abToken);
    if (fix) {
      store.records[RECORD_KEYS.curation] = fix.curation;
      if (fix.deleteAb) delete store.records[RECORD_KEYS.ab];
    }
  }
  const saver = createAutosave({
    backend: store.backend(writer, options),
    initialState: stored,
    rev: store.records[RECORD_KEYS.curation]?.rev ?? 0,
    abToken: store.records[RECORD_KEYS.curation]?.abToken ?? null,
    onStatus: (s) => statuses.push(s),
  });
  let state = start || stored;
  return {
    saver,
    statuses,
    get state() {
      return state;
    },
    change(patch) {
      state = { ...state, ...patch };
      saver.update(state);
    },
    last: () => statuses[statuses.length - 1],
  };
}

describe("autosave — a table whose write keeps failing", () => {
  it("is retried on its own: tab switches never rewrite the curation record", async () => {
    store.failAb = true;
    const a = openTab("A", null);
    a.change(session());
    await settle();
    expect(a.last()).toMatchObject({ state: "saved", abFailed: true });
    const rev = store.records.curation.rev;
    const token = store.records.curation.abToken;
    expect(token).toBeTruthy();
    store.writes.length = 0;
    // A only switches tabs, each time after the retry pause.
    for (const t of ["table", "help", "export"]) {
      await settle(RETRY_AFTER_FAILURE_MS + 500);
      a.change({ tab: t });
      await settle();
    }
    await settle(RETRY_AFTER_FAILURE_MS + 500);
    expect(store.records.curation.rev).toBe(rev);
    expect(store.writes.every((w) => w.keys[0] === "ui" || w.keys[0] === "ab (retry)")).toBe(true);
    expect(store.writes.some((w) => w.keys[0] === "ab (retry)")).toBe(true);
    expect(a.last()).toMatchObject({ state: "saved", abFailed: true });

    // Room again: the next retry writes the table under the token the
    // curation record names, still without a new revision.
    store.failAb = false;
    a.change({ tab: "table" });
    await settle(RETRY_AFTER_FAILURE_MS + 500);
    expect(a.last()).toMatchObject({ state: "saved", abFailed: false });
    expect(store.records.curation.rev).toBe(rev);
    expect(store.records.ab.storageToken).toBe(token);
    expect(sessionFromRecords(store.records).ab.samples).toEqual(["A", "B", "C"]);
    // Nothing is left to retry.
    store.writes.length = 0;
    await settle(RETRY_AFTER_FAILURE_MS * 2);
    expect(store.writes).toEqual([]);
  });

  it("leaves a tab opened meanwhile alone, until the table is back", async () => {
    store.failAb = true;
    const a = openTab("A", null);
    a.change(session());
    await settle();
    const rev = store.records.curation.rev;
    const token = store.records.curation.abToken;
    // Another tab opens the session, without its table: it says so once
    // and stops naming the table.
    const b = openTab("B");
    expect(b.state.ab).toBeNull();
    expect(store.records.curation.abToken).toBeNull();
    // A only switches tabs, each time after the retry pause, the table
    // still failing: B is never told the session changed.
    for (const t of ["table", "help", "export"]) {
      await settle(RETRY_AFTER_FAILURE_MS + 500);
      a.change({ tab: t });
      await settle();
    }
    expect(store.records.curation.rev).toBe(rev);
    expect(b.statuses.map((st) => st.state)).not.toContain("conflict");
    // Room again: the table is stored, and the curation record names it
    // again — the stored session has its table back, which B's copy
    // lacks: B is told.
    store.failAb = false;
    await settle(RETRY_AFTER_FAILURE_MS + 500);
    a.change({ tab: "table" });
    await settle(RETRY_AFTER_FAILURE_MS);
    expect(a.last()).toMatchObject({ state: "saved", abFailed: false });
    expect(store.records.curation.abToken).toBe(token);
    expect(store.records.ab.storageToken).toBe(token);
    expect(sessionFromRecords(store.records).ab.samples).toEqual(["A", "B", "C"]);
    expect(store.records.curation.rev).toBe(rev + 1);
    expect(b.last().state).toBe("conflict");
  });

  it("an evaluation meanwhile is written with the same token, then the table", async () => {
    store.failAb = true;
    const a = openTab("A", null);
    a.change(session());
    await settle();
    const token = store.records.curation.abToken;
    store.failAb = false;
    await settle(RETRY_AFTER_FAILURE_MS + 100);
    a.change({ rawEvents: a.state.rawEvents.map((e) => (e.id === 0 ? { ...e, verdict: "true_positive" } : e)) });
    await settle();
    expect(store.records.curation.abToken).toBe(token);
    const back = sessionFromRecords(store.records);
    expect(back.rawEvents[0].verdict).toBe("true_positive");
    expect(back.ab.samples).toEqual(["A", "B", "C"]);
  });

  it("a new table is written at once, with a new token, not deferred as the failed one", async () => {
    store.failAb = true;
    const a = openTab("A", null);
    a.change(session());
    await settle();
    const token = store.records.curation.abToken;
    store.failAb = false;
    a.change({ ab: { ...TABLE, samples: ["A", "B", "C"], logRange: { min: -2, max: 0 } } });
    await settle();
    expect(store.records.curation.abToken).not.toBe(token);
    expect(store.records.ab.storageToken).toBe(store.records.curation.abToken);
    expect(a.last()).toMatchObject({ state: "saved", abFailed: false });
  });

  it("is not written over a session another tab has saved since", async () => {
    store.failAb = true;
    // No channel: only the revision check tells A that B wrote.
    const a = openTab("A", null, { channel: false });
    a.change(session());
    await settle();
    const b = openTab("B");
    b.change({ ab: null, rawEvents: b.state.rawEvents.map((e) => ({ ...e, verdict: "false_positive" })) });
    await settle();
    expect(store.records.ab).toBeUndefined();
    store.failAb = false;
    await settle(RETRY_AFTER_FAILURE_MS + 100);
    a.change({ tab: "help" });
    await settle();
    expect(a.last().state).toBe("conflict");
    // B's session (without a table) is intact.
    expect(store.records.ab).toBeUndefined();
    expect(sessionFromRecords(store.records).rawEvents.map((e) => e.verdict)).toEqual(["false_positive", "false_positive"]);
  });
});
