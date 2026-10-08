import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ALL_DIRTY,
  RECORD_KEYS,
  checkStoredSession,
  curationRecord,
  dirtyRecords,
  sessionFromLegacyMain,
  sessionFromPayload,
  sessionFromRecords,
  sessionToJSON,
  sessionWrites,
  upgradedSession,
} from "../src/persistence.js";
import { createAutosave, SAVE_DELAY_MS } from "../src/autosave.js";
import { DEFAULT_CURATION_RULES, SAMPLE_CURATION_VERSION } from "../src/curation.js";

/* The automatic rules are saved with the session (src/persistence.js):
   in the curation record — so that switching one is a change of the
   curation, checked against the other tabs like an evaluation — and in
   the session JSON (curation_rules), read back and checked by
   sessionFromPayload. A session without them, every session saved
   before the switches, has every rule on. */

const R1_OFF = { verdictFromEvents: false, suppressContaminated: true, neverTargetedDefault: true };
const ALL_OFF = { verdictFromEvents: false, suppressContaminated: false, neverTargetedDefault: false };

const session = (patch = {}) => ({
  rawEvents: [
    { id: 0, source: "A", target: "B", rate: 0.1, score: 0.9, introduced: ["x"], verdict: "true_positive", notes: "" },
    { id: 1, source: "C", target: "D", rate: 0.2, score: 0.8, introduced: ["y"], verdict: "false_positive", notes: "" },
  ],
  runMetadata: null,
  eventsWarnings: [],
  ab: null,
  metadata: null,
  plateMap: null,
  sampleCuration: {},
  sampleCurationVersion: SAMPLE_CURATION_VERSION,
  curationRules: DEFAULT_CURATION_RULES,
  analysisTitle: "",
  tab: "overview",
  selId: null,
  filter: { q: "" },
  sort: { by: "score", dir: "desc" },
  ...patch,
});

const defaults = () => ({
  q: "",
  minScore: 0,
  minRate: 0,
  minIntroduced: 0,
  verdicts: ["pending", "true_positive", "false_positive", "uncertain"],
  sampleVerdicts: ["pending", "contaminated", "correct", "uncertain"],
  sampleVerdictsSide: "either",
  subject: "any",
  group: "any",
  adjacent: "any",
  scopeSamples: null,
  scopeSide: "either",
  lowAbFilter: true,
});
const read = (json) => sessionFromPayload(json, { defaults: defaults() });

/** The records a save of `s` writes, as IndexedDB keeps them (clones). */
function stored(s) {
  const records = {};
  for (const [k, v] of sessionWrites(s, ALL_DIRTY, null).puts) records[k] = structuredClone(v);
  records[RECORD_KEYS.ui] = { tab: s.tab, selId: s.selId, filter: s.filter, sort: s.sort };
  return records;
}

describe("the curation record", () => {
  it("holds the rules, and gives them back", () => {
    const rec = curationRecord(session({ curationRules: R1_OFF }), null);
    expect(rec.curationRules).toEqual(R1_OFF);
    const back = sessionFromRecords(stored(session({ curationRules: R1_OFF })));
    expect(back.curationRules).toEqual(R1_OFF);
  });

  it("of an earlier version, without the rules, has every rule on", () => {
    const records = stored(session());
    delete records[RECORD_KEYS.curation].curationRules;
    expect(sessionFromRecords(records).curationRules).toBe(DEFAULT_CURATION_RULES);
    // The first layout ("main") predates them too.
    const main = { ...session(), curationRules: undefined };
    expect(sessionFromLegacyMain(main, null).curationRules).toBe(DEFAULT_CURATION_RULES);
    expect(upgradedSession(sessionFromLegacyMain(main, null)).session.curationRules).toBe(
      DEFAULT_CURATION_RULES,
    );
  });

  it("is rewritten, alone, when a rule is switched", () => {
    const s = session();
    const next = { ...s, curationRules: R1_OFF };
    expect(dirtyRecords(s, next)).toEqual({
      events: false,
      ab: false,
      metadata: false,
      plate: false,
      curation: true,
      ui: false,
    });
    const { puts, dels } = sessionWrites(next, dirtyRecords(s, next), null);
    expect(puts.map(([k]) => k)).toEqual([RECORD_KEYS.curation]);
    expect(puts[0][1].curationRules).toEqual(R1_OFF);
    expect(dels).toEqual([]);
  });

  it("read back on boot, keeps the object the session was read with: no write at boot", () => {
    const back = sessionFromRecords(stored(session({ curationRules: R1_OFF })));
    const checked = checkStoredSession(back);
    expect(checked.session).toBe(back);
    expect(checked.notes).toEqual([]);
    expect(dirtyRecords(back, checked.session).curation).toBe(false);
  });

  it("a stored session with rules off is not recomputed by the boot's upgrade", () => {
    const back = sessionFromRecords(stored(session({ curationRules: ALL_OFF })));
    const up = upgradedSession(back);
    expect(up.session.sampleCuration).toEqual({});
    expect(up.session.curationRules).toEqual(ALL_OFF);
  });
});

describe("the session JSON", () => {
  it("writes curation_rules and reads it back", () => {
    const json = JSON.parse(JSON.stringify(sessionToJSON(session({ curationRules: ALL_OFF }))));
    expect(json.curation_rules).toEqual(ALL_OFF);
    const r = read(json);
    expect(r.ok).toBe(true);
    expect(r.session.curationRules).toEqual(ALL_OFF);
    // Every rule off: the TP targeting B derives nothing on import.
    expect(r.session.sampleCuration).toEqual({});
  });

  it("writes every rule for a session that has none", () => {
    expect(sessionToJSON(session({ curationRules: undefined })).curation_rules).toEqual(
      DEFAULT_CURATION_RULES,
    );
  });

  it("without curation_rules (every earlier file) has every rule on", () => {
    const json = JSON.parse(JSON.stringify(sessionToJSON(session())));
    delete json.curation_rules;
    const r = read(json);
    expect(r.ok).toBe(true);
    expect(r.session.curationRules).toBe(DEFAULT_CURATION_RULES);
    expect(r.session.sampleCuration.B).toMatchObject({ verdict: "contaminated", verdictAuto: true });
  });

  it("fills in a rule the file does not give, as on", () => {
    const json = JSON.parse(JSON.stringify(sessionToJSON(session())));
    json.curation_rules = { verdictFromEvents: false };
    const r = read(json);
    expect(r.ok).toBe(true);
    expect(r.session.curationRules).toEqual(R1_OFF);
  });

  it("refuses rules that are not true / false, saying where", () => {
    const json = JSON.parse(JSON.stringify(sessionToJSON(session())));
    json.curation_rules = { verdictFromEvents: "no" };
    let r = read(json);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/curation_rules: "verdictFromEvents" is neither true nor false/);
    json.curation_rules = "off";
    r = read(json);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/"curation_rules" must give each automatic rule/);
  });

  it("refuses a key that names no rule, saying which: a misspelt rule is not read as on", () => {
    // In the spelling of the rest of the file: it used to import with
    // every rule on, without a word.
    const json = JSON.parse(JSON.stringify(sessionToJSON(session())));
    json.curation_rules = { verdict_from_events: false, suppress_contaminated: false };
    let r = read(json);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(
      /curation_rules: "verdict_from_events" is not an automatic rule \(they are verdictFromEvents, suppressContaminated, neverTargetedDefault\)/,
    );
    expect(r.errors.join(" ")).toMatch(/"suppress_contaminated" is not an automatic rule/);
    // An extra key next to the three rules: it used to be kept, saved and
    // exported again.
    json.curation_rules = { ...ALL_OFF, extra: 1 };
    r = read(json);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/curation_rules: "extra" is not an automatic rule/);
  });

  it("reads back exactly the three rules", () => {
    const json = JSON.parse(JSON.stringify(sessionToJSON(session({ curationRules: { ...R1_OFF, extra: 1 } }))));
    expect(json.curation_rules).toEqual(R1_OFF);
    const r = read(json);
    expect(r.ok).toBe(true);
    expect(Object.keys(r.session.curationRules).sort()).toEqual(Object.keys(R1_OFF).sort());
  });

  it("drops a key that names no rule from a stored session, and says so", () => {
    const back = sessionFromRecords(stored(session({ curationRules: R1_OFF })));
    const checked = checkStoredSession({ ...back, curationRules: { ...R1_OFF, extra: 1 } });
    expect(checked.session.curationRules).toEqual(R1_OFF);
    expect(checked.notes.join(" ")).toMatch(/curation_rules: "extra" is not an automatic rule/);
  });

  it("keeps a verdict a hand-edited file flags automatic for a rule that is off, as the curator's", () => {
    const json = JSON.parse(JSON.stringify(sessionToJSON(session({ curationRules: R1_OFF }))));
    json.sample_curation = { D: { verdict: "uncertain", verdictAuto: true } };
    const r = read(json);
    expect(r.ok).toBe(true);
    expect(r.session.sampleCuration.D).toEqual({ verdict: "uncertain" });
    expect(r.session.sampleCuration.B).toBeUndefined();
  });
});

/* Two tabs: switching a rule in one is a change of the curation, which the
   other must not overwrite with its older copy. */
describe("the autosave", () => {
  let records;
  const backend = (writer) => ({
    writer,
    async writeSession({ puts, dels }, expectedRev) {
      const rev = records[RECORD_KEYS.curation]?.rev ?? 0;
      if (rev !== expectedRev) return { status: "conflict", rev };
      for (const [k, v] of puts) {
        records[k] = structuredClone(k === RECORD_KEYS.curation ? { ...v, rev: rev + 1 } : v);
      }
      for (const k of dels) delete records[k];
      return { status: "ok", rev: rev + 1 };
    },
    writeSessionNow: () => true,
    peekRev: () => records[RECORD_KEYS.curation]?.rev ?? null,
    async writeAb() {},
    async deleteAb() {},
    async writeUi(ui) {
      records[RECORD_KEYS.ui] = structuredClone(ui);
    },
  });
  const tab = (writer) => {
    const statuses = [];
    const initial = sessionFromRecords(records);
    const saver = createAutosave({
      backend: backend(writer),
      initialState: initial,
      rev: records[RECORD_KEYS.curation].rev,
      onStatus: (s) => statuses.push(s.state),
    });
    return { saver, statuses, initial };
  };
  beforeEach(() => {
    vi.useFakeTimers();
    records = {};
    for (const [k, v] of Object.entries(stored(session()))) records[k] = v;
    records[RECORD_KEYS.curation].rev = 1;
  });
  afterEach(() => vi.useRealTimers());

  it("writes a rule switched off, and the next boot reads it", async () => {
    const a = tab("a");
    a.saver.update({ ...a.initial, curationRules: R1_OFF });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(records[RECORD_KEYS.curation].rev).toBe(2);
    expect(sessionFromRecords(records).curationRules).toEqual(R1_OFF);
  });

  it("a tab that has not seen the switch stops saving instead of switching it back", async () => {
    const a = tab("a");
    const b = tab("b");
    a.saver.update({ ...a.initial, curationRules: R1_OFF });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    // Tab b, still with every rule on, evaluates an event.
    b.saver.update({
      ...b.initial,
      rawEvents: b.initial.rawEvents.map((e) => (e.id === 1 ? { ...e, verdict: "uncertain" } : e)),
    });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(b.statuses).toContain("conflict");
    expect(sessionFromRecords(records).curationRules).toEqual(R1_OFF);
  });

  it("writes nothing at boot for a session read back with its rules", async () => {
    records[RECORD_KEYS.curation].curationRules = ALL_OFF;
    const a = tab("a");
    a.saver.update(checkStoredSession(a.initial).session);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
    expect(records[RECORD_KEYS.curation].rev).toBe(1);
  });
});
