import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAutosave, RETRY_AFTER_FAILURE_MS, SAVE_DELAY_MS } from "../src/autosave.js";
import { RECORD_KEYS, sessionFromRecords } from "../src/persistence.js";

/* The autosave (src/autosave.js) against an in-memory backend that
   behaves like src/storage.js: the session records are written in one
   "transaction" that checks the stored revision first. */

function memoryStore() {
  const records = {};
  const channels = [];
  const store = {
    records,
    writes: [],
    failNext: null,
    failAb: false,
    backend(writer) {
      return {
        writer,
        async writeSession({ puts, dels }, expectedRev) {
          if (store.failNext) {
            const e = store.failNext;
            store.failNext = null;
            throw e;
          }
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
        writeSessionNow({ writes, rev, ab, ui }) {
          if (writes) {
            for (const [k, v] of writes.puts) {
              records[k] = structuredClone(k === RECORD_KEYS.curation ? { ...v, rev, writer } : v);
            }
            for (const k of writes.dels) delete records[k];
          }
          if (ab) records[RECORD_KEYS.ab] = structuredClone(ab);
          if (ui) records[RECORD_KEYS.ui] = structuredClone(ui);
          store.writes.push({ writer, keys: ["now"] });
          return true;
        },
        async writeAb(record) {
          if (store.failAb) throw new DOMException("full", "QuotaExceededError");
          records[RECORD_KEYS.ab] = structuredClone(record);
          store.writes.push({ writer, keys: ["ab"] });
        },
        async deleteAb() {
          delete records[RECORD_KEYS.ab];
        },
        async writeUi(ui) {
          records[RECORD_KEYS.ui] = structuredClone(ui);
          store.writes.push({ writer, keys: ["ui"] });
        },
        openChannel() {
          const ch = {
            onmessage: null,
            postMessage(data) {
              for (const other of channels) if (other !== ch) other.onmessage?.({ data });
            },
            close() {},
          };
          channels.push(ch);
          return ch;
        },
      };
    },
  };
  return store;
}

const session = () => ({
  rawEvents: [
    { id: 0, source: "A", target: "B", rate: 0.1, score: 0.9, introduced: ["x"], verdict: "pending", notes: "" },
    { id: 1, source: "C", target: "B", rate: 0.2, score: 0.8, introduced: ["y"], verdict: "pending", notes: "" },
  ],
  runMetadata: null,
  eventsWarnings: [],
  ab: { samples: ["A", "B", "C"], species: ["x", "y"], matrix: { x: { A: 1 }, y: { B: 1 } }, logRange: { min: -1, max: 0 } },
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

/** Let the debounce fire and the writes (promises) settle. */
async function settle(ms = SAVE_DELAY_MS + 10) {
  await vi.advanceTimersByTimeAsync(ms);
}

let store;
beforeEach(() => {
  vi.useFakeTimers();
  store = memoryStore();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A tab: an autosave started from what the store holds. */
function openTab(writer, start) {
  const statuses = [];
  const stored = store.records[RECORD_KEYS.curation] ? sessionFromRecords(store.records) : null;
  const saver = createAutosave({
    backend: store.backend(writer),
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

describe("autosave — writes only what changed (B1.3a)", () => {
  it("writes every record once, then the UI record for a tab switch and the curation record for an evaluation", async () => {
    const a = openTab("A", null);
    a.change(session());
    await settle();
    expect(store.writes.map((w) => w.keys.sort())).toEqual([
      ["-main", "-metadata", "-plate", "curation", "events"],
      ["ab"],
      ["ui"],
    ]);
    expect(a.last().state).toBe("saved");
    store.writes.length = 0;

    a.change({ tab: "network" });
    await settle();
    expect(store.writes.map((w) => w.keys)).toEqual([["ui"]]);
    store.writes.length = 0;

    a.change({ rawEvents: a.state.rawEvents.map((e) => (e.id === 0 ? { ...e, verdict: "true_positive" } : e)) });
    await settle();
    expect(store.writes.map((w) => w.keys)).toEqual([["curation"]]);
    expect(sessionFromRecords(store.records).rawEvents[0].verdict).toBe("true_positive");
  });

  it("writes nothing for an empty state when nothing is stored", async () => {
    const a = openTab("A", null);
    a.change({ ...session(), rawEvents: [], ab: null, tab: "help" });
    await settle();
    expect(store.writes).toEqual([]);
  });

  it("debounces a burst of changes into one write", async () => {
    const a = openTab("A", null);
    a.change(session());
    await settle();
    store.writes.length = 0;
    for (const t of ["table", "scatter", "validate", "network"]) {
      a.change({ tab: t });
      await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS / 3);
    }
    await settle();
    expect(store.writes).toEqual([{ writer: "A", keys: ["ui"] }]);
    expect(store.records.ui.tab).toBe("network");
  });

  it("clearing the events keeps the abundance table stored (B1.5)", async () => {
    const a = openTab("A", null);
    a.change(session());
    await settle();
    a.change({ rawEvents: [], sampleCuration: {} });
    await settle();
    const back = sessionFromRecords(store.records);
    expect(back.rawEvents).toEqual([]);
    expect(back.ab.samples).toEqual(["A", "B", "C"]);
  });
});

describe("autosave — two tabs (B1.3b)", () => {
  it("a tab with an older copy cannot overwrite the newer session, and says so", async () => {
    const a = openTab("A", null);
    a.change(session());
    await settle();
    const b = openTab("B");
    // B hears A's next save at once (the session channel)...
    a.change({ rawEvents: a.state.rawEvents.map((e) => ({ ...e, verdict: "true_positive" })) });
    await settle();
    expect(b.last()?.state).toBe("conflict");
    // ...and writes nothing afterwards, not even its UI state.
    store.writes.length = 0;
    b.change({ tab: "network" });
    await settle();
    expect(store.writes).toEqual([]);
    const back = sessionFromRecords(store.records);
    expect(back.rawEvents.every((e) => e.verdict === "true_positive")).toBe(true);
  });

  it("without the channel, the revision check stops the older tab's write", async () => {
    const a = openTab("A", null);
    a.change(session());
    await settle();
    const b = openTab("B");
    b.saver.dispose(); // no channel: only the revision check is left
    const b2 = createAutosave({
      backend: { ...store.backend("B2"), openChannel: undefined },
      initialState: b.state,
      rev: store.records.curation.rev,
      onStatus: (s) => b.statuses.push(s),
    });
    a.change({ rawEvents: a.state.rawEvents.map((e) => ({ ...e, verdict: "true_positive" })) });
    await settle();
    b2.update({ ...b.state, rawEvents: b.state.rawEvents.map((e) => ({ ...e, verdict: "false_positive" })) });
    await settle();
    expect(b.last().state).toBe("conflict");
    expect(sessionFromRecords(store.records).rawEvents.map((e) => e.verdict)).toEqual(["true_positive", "true_positive"]);
  });

  it("a UI-only change in one tab does not make the other one stale", async () => {
    const a = openTab("A", null);
    a.change(session());
    await settle();
    const b = openTab("B");
    b.change({ tab: "network" });
    await settle();
    a.change({ rawEvents: a.state.rawEvents.map((e) => (e.id === 1 ? { ...e, verdict: "uncertain" } : e)) });
    await settle();
    expect(a.last().state).toBe("saved");
    expect(sessionFromRecords(store.records).rawEvents[1].verdict).toBe("uncertain");
  });
});

describe("autosave — page hidden or closed (B1.3c)", () => {
  it("pagehide writes the pending change at once, synchronously, and counts it as written", async () => {
    const a = openTab("A", null);
    a.change(session());
    await settle();
    const rev = store.records.curation.rev;
    a.change({ rawEvents: a.state.rawEvents.map((e) => (e.id === 0 ? { ...e, verdict: "true_positive" } : e)) });
    // No timer fired: the debounce is still pending.
    a.saver.flushOnPageHide();
    expect(store.records.curation.rev).toBe(rev + 1);
    expect(sessionFromRecords(store.records).rawEvents[0].verdict).toBe("true_positive");
    // Restored from the back-forward cache, it goes on from that revision.
    a.change({ tab: "export", rawEvents: a.state.rawEvents.map((e) => ({ ...e, notes: "n" })) });
    await settle();
    expect(a.last().state).toBe("saved");
  });

  it("visibilitychange to hidden writes at once, with the revision check", async () => {
    const a = openTab("A", null);
    a.change(session());
    a.saver.flushNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.records.curation?.rev).toBe(1);
  });
});

describe("autosave — failures (B1.3d)", () => {
  it("a failed write is reported, retried on the next change after a pause, and cleared by a success", async () => {
    const a = openTab("A", null);
    a.change(session());
    await settle();
    store.failNext = new DOMException("The write was aborted", "AbortError");
    a.change({ tab: "validate", rawEvents: a.state.rawEvents.map((e) => ({ ...e, verdict: "true_positive" })) });
    await settle();
    expect(a.last()).toMatchObject({ state: "failed" });
    expect(a.last().error).toMatch(/refused the write/);
    // A change right away: not retried yet.
    store.writes.length = 0;
    a.change({ selId: 1 });
    await settle();
    expect(store.writes).toEqual([]);
    expect(a.last().state).toBe("failed");
    await settle(RETRY_AFTER_FAILURE_MS);
    expect(a.last().state).toBe("saved");
    expect(sessionFromRecords(store.records).rawEvents[0].verdict).toBe("true_positive");
  });

  it("a quota error on the abundance table keeps the curation saved and says the table is not", async () => {
    store.failAb = true;
    const a = openTab("A", null);
    a.change(session());
    await settle();
    expect(a.last()).toMatchObject({ state: "saved", abFailed: true });
    expect(sessionFromRecords(store.records).abLost).toBe(true);
    store.failAb = false;
    a.change({ tab: "table" });
    await settle(RETRY_AFTER_FAILURE_MS);
    expect(a.last()).toMatchObject({ state: "saved", abFailed: false });
    expect(sessionFromRecords(store.records).ab.samples).toEqual(["A", "B", "C"]);
  });

  it("without storage nothing is written and the state stays unavailable (B1.3e)", async () => {
    const statuses = [];
    const saver = createAutosave({
      backend: store.backend("A"),
      initialState: null,
      available: false,
      onStatus: (s) => statuses.push(s),
    });
    expect(saver.status.state).toBe("unavailable");
    saver.update(session());
    saver.flushOnPageHide();
    await settle();
    expect(store.writes).toEqual([]);
    expect(statuses).toEqual([]);
  });
});
