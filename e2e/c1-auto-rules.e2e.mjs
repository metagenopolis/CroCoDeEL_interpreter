/* Browser checks for the switches of the automatic sample decisions
   (Configuration → Automatic sample decisions; src/curation.js):

     verdictFromEvents     a sample's verdict follows its events (R1)
     suppressContaminated  Suppress goes with Contaminated (R2)
     neverTargetedDefault  Not contaminated + Keep by default for a sample
                           no event targets (R3)

   For each switch, on the demo: switched off while the session holds
   values of that rule, a question gives their count and offers Clear
   them / Keep them as my decisions / Cancel — the Samples tab, the
   Overview counts and the Export card follow the answer, and values set
   by hand are never touched; switched on again, the rule is applied to
   every sample and a notice says what it added. With every rule off, no
   path that evaluates events sets an automatic sample value. The rules
   are saved with the session: a reload, a session JSON round trip, a
   file without them (all on), another events file (carried over: the
   session's own; started fresh: the last choice made in Configuration),
   a new session (the same last choice), and a second tab, which must
   not switch them back.

   The sample state is read back from the session the app autosaves to
   IndexedDB (src/persistence.js), automatic flags included.

   Usage:  npm run build && node e2e/c1-auto-rules.e2e.mjs
           (or through e2e/run-all.mjs; BASE_URL skips the server,
           E2E_ONLY=<regex> runs only the matching scenarios) */

import { readFileSync } from "node:fs";
import {
  BASE,
  startServer,
  stopServer,
  launchBrowser,
  newPage,
  trackErrors,
  loadDemo,
  openTab,
  overviewStats,
  tsvInput,
  check,
  finish,
} from "./harness.mjs";

const RULES = ["verdictFromEvents", "suppressContaminated", "neverTargetedDefault"];
const ALL_ON = { verdictFromEvents: true, suppressContaminated: true, neverTargetedDefault: true };
// The demo: 91 samples, all in its abundance table; 16 of them are an
// event's target, so 75 are no event's target.
const NEVER_TARGETED = 75;

/* ------------------------------------------------------------- helpers */

/** The session stored by the app (IndexedDB), once the autosave has
    caught up: its sample curation and automatic rules. */
async function storedSession(page) {
  const since = await page.evaluate(() => Date.now());
  let latest = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const cur = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open("crocodeel-interpreter");
          req.onerror = () => resolve(null);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("kv")) return resolve(null);
            const get = db.transaction("kv", "readonly").objectStore("kv").get("curation");
            get.onsuccess = () => {
              db.close();
              resolve(get.result || null);
            };
            get.onerror = () => resolve(null);
          };
        }),
    );
    if (cur && Date.parse(cur.savedAt) > since) return cur;
    latest = cur;
    if (i >= 12 && latest) return latest;
  }
  throw new Error("no autosaved session found");
}
const storedCuration = async (page) => (await storedSession(page)).sampleCuration || {};
const show = (v) => JSON.stringify(v ?? null);

const VERDICT_BUTTON = {
  tp: "mark as true positive",
  fp: "mark as false positive",
  u: "mark as uncertain",
};
/** Click a quick evaluation button on the Events-table row source → target. */
async function clickEvent(page, source, target, kind) {
  await openTab(page, "Events");
  const title = VERDICT_BUTTON[kind];
  const idx = await page.evaluate(
    ([s, t, title]) =>
      [...document.querySelectorAll(`button[title="${title}"]`)].findIndex((b) => {
        const cells = [...b.closest("tr").querySelectorAll("td")].map((td) =>
          td.innerText.trim().split(/\s+/)[0],
        );
        const si = cells.indexOf(s);
        return si >= 0 && cells.indexOf(t, si + 1) > si;
      }),
    [source, target, title],
  );
  if (idx < 0) throw new Error(`no Events-table row for ${source} → ${target}`);
  await page.locator(`button[title="${title}"]`).nth(idx).click();
  await page.waitForTimeout(150);
}

/** The Samples-tab row of sample `id`. */
function sampleRow(page, id) {
  return page
    .locator("tr")
    .filter({ has: page.locator('button[aria-label="Set verdict to Pending"]') })
    .filter({ has: page.getByText(id, { exact: true }) });
}

async function setSampleVerdict(page, id, label) {
  await openTab(page, "Samples");
  await sampleRow(page, id).locator(`button[aria-label="Set verdict to ${label}"]`).click();
  await page.waitForTimeout(200);
}

/** The tags under the Samples tab's chips: { verdict: {automatic,
    default}, action: {automatic, default} }. */
async function sampleMarks(page) {
  await openTab(page, "Samples");
  return page.evaluate(() => {
    const out = { verdict: { automatic: 0, default: 0 }, action: { automatic: 0, default: 0 } };
    for (const mark of document.querySelectorAll("[data-auto-mark]")) {
      const chip = mark.parentElement.querySelector("button");
      const kind = chip?.hasAttribute("data-verdict-chip") ? "verdict" : "action";
      out[kind][mark.getAttribute("data-auto-mark")]++;
    }
    return out;
  });
}

/** The "N of M" of the Export tab's curated abundance card. */
async function curatedCard(page) {
  await openTab(page, "Export");
  const text = await page.locator("body").innerText();
  const m = text.match(/Curated abundance table — (\d+) of (\d+) samples/);
  return m ? `${m[1]} of ${m[2]}` : null;
}

/** What the Export tab's curated abundance card says the table drops. */
async function curatedCardText(page) {
  await openTab(page, "Export");
  const text = await page.locator("body").innerText();
  return text.match(/Curated abundance table — \d+ of \d+ samples\s*\n([^\n]*)/)?.[1] || "";
}

async function openConfig(page) {
  const dialog = page.getByRole("dialog", { name: "Configuration" });
  if ((await dialog.count()) === 0) {
    await page.getByRole("button", { name: "Open configuration" }).click();
    await dialog.waitFor({ timeout: 10000 });
  }
  return dialog;
}
async function closeConfig(page) {
  const dialog = page.getByRole("dialog", { name: "Configuration" });
  if ((await dialog.count()) > 0) {
    await dialog.getByRole("button", { name: "Close" }).last().click();
    await page.waitForTimeout(200);
  }
}
const ruleSwitch = (page, rule) => page.locator(`input[data-curation-rule="${rule}"]`);

/** Which rules the Configuration dialog shows on. */
async function shownRules(page) {
  await openConfig(page);
  const out = {};
  for (const r of RULES) out[r] = await ruleSwitch(page, r).isChecked();
  await closeConfig(page);
  return out;
}

/** Switch `rule` off in Configuration. When the question opens, answer it
    with `choice` ("Clear them", "Keep them as my decisions", "Cancel").
    Returns the question's text, or null when none opened. */
async function switchOff(page, rule, choice) {
  await openConfig(page);
  await ruleSwitch(page, rule).click();
  await page.waitForTimeout(300);
  const question = page.getByRole("dialog", { name: /^Switch off/ });
  let text = null;
  if ((await question.count()) > 0) {
    text = (await question.innerText()).replace(/\s+/g, " ");
    await question.getByRole("button", { name: choice, exact: true }).click();
    await page.waitForTimeout(300);
  }
  return text;
}

/** Switch `rule` on in Configuration; returns the notice's text. */
async function switchOn(page, rule) {
  await openConfig(page);
  await ruleSwitch(page, rule).click();
  await page.waitForTimeout(300);
  const notice = page.locator(`[data-rules-notice="${rule}"]`);
  return (await notice.count()) ? (await notice.innerText()).replace(/\s+/g, " ") : null;
}

async function openBulkDialog(page) {
  await openTab(page, "Events");
  await page.locator('button[aria-label="Bulk apply evaluation"]').first().click();
  await page.getByText(/Action on samples targeted/i).waitFor({ timeout: 20000 });
  return page
    .locator("div")
    .filter({ has: page.getByText(/Action on samples targeted/i) })
    .filter({ has: page.getByRole("button", { name: /^Apply to \d+ events?$/ }) })
    .last();
}

/** Click a node of the Network graph; resolves once its popover is open. */
async function openNodePopover(page, id) {
  await openTab(page, "Network");
  await page.waitForTimeout(1200);
  const found = await page.evaluate((id) => {
    const label = [...document.querySelectorAll("svg g > text")].find(
      (t) => t.textContent.trim() === id,
    );
    const circle = label?.parentElement.querySelector("circle");
    if (!circle) return false;
    const r = circle.getBoundingClientRect();
    circle.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
      }),
    );
    return true;
  }, id);
  if (!found) throw new Error(`no Network node labelled ${id}`);
  await page.getByText(/^Apply to events targeting$/i).waitFor({ timeout: 10000 });
  return page
    .locator("div")
    .filter({ has: page.getByText(/^Apply to events targeting$/i) })
    .filter({ has: page.getByRole("button", { name: /^Apply$/ }) })
    .last();
}

/** Click a download button and return the file's text (null if none). */
async function download(page, button) {
  const [file] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
    button.click(),
  ]);
  return file ? readFileSync(await file.path(), "utf8") : null;
}

/** Import a session JSON through the files bar, confirming the question
    a session holding curation asks first. */
async function importSession(page, json) {
  await page
    .locator('input[accept*="json"]')
    .first()
    .setInputFiles({
      name: "session.json",
      mimeType: "application/json",
      buffer: Buffer.from(typeof json === "string" ? json : JSON.stringify(json)),
    });
  await page.waitForTimeout(1500);
  const ask = page.getByRole("dialog", { name: "Replace your session with the imported one?" });
  if ((await ask.count()) > 0) {
    await ask.getByRole("button", { name: "Replace session" }).click();
    await page.waitForTimeout(1000);
  }
}

/** Some curation on the demo: TP on 63D250 → 63D9 and 83D88 → NC3 (both
    automatic Contaminated + Suppress), FP on 63D29 → 63D40 (automatic
    Not contaminated), Uncertain on 58M → 58D7 (automatic Uncertain), and
    58D47 made Contaminated by hand (its Suppress automatic). */
async function curateSome(page) {
  await clickEvent(page, "63D250", "63D9", "tp");
  await clickEvent(page, "83D88", "NC3", "tp");
  await clickEvent(page, "63D29", "63D40", "fp");
  await clickEvent(page, "58M", "58D7", "u");
  await setSampleVerdict(page, "58D47", "Contaminated");
}
const AUTO_C_S = { verdict: "contaminated", verdictAuto: true, action: "suppress", actionAuto: true };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

await startServer();
const browser = await launchBrowser();

/* One fresh page per scenario. A scenario that throws is reported as a
   failed check and the others still run. E2E_ONLY=<regex> runs only the
   scenarios whose name matches. */
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
async function scenario(name, run, { demo = true } = {}) {
  if (ONLY && !ONLY.test(name)) return;
  const { ctx, page, errors } = await newPage(browser);
  try {
    if (demo) await loadDemo(page);
    await run(page, ctx, errors);
  } catch (e) {
    check(false, `${name} runs to the end`, String(e).split("\n")[0]);
  }
  check(errors.length === 0, `${name}: no JS error`, errors[0] || "");
  await ctx.close();
}

try {
  /* ------------------------------------------------ R1: verdict from events */
  await scenario("R1 off, Clear, then on", async (page) => {
    await curateSome(page);
    const before = await storedCuration(page);
    let s = await overviewStats(page);
    check(
      same(before["63D9"], AUTO_C_S) && s.suppress === 3 && (await curatedCard(page)) === "88 of 91",
      "R1 setup: two automatic Contaminated + Suppress, 3 to suppress, 88 of 91 kept",
      `63D9=${show(before["63D9"])} suppress=${s.suppress}`,
    );
    const allOnCard = await curatedCardText(page);
    check(
      /^The abundance table with the 3 samples set to Suppress removed — which includes every sample you marked Contaminated without then choosing Keep/.test(allOnCard) &&
        !/switched off/.test(allOnCard),
      "all on: the Export card says a Contaminated sample without Keep is dropped",
      allOnCard,
    );

    const cancelled = await switchOff(page, "verdictFromEvents", "Cancel");
    check(
      (await ruleSwitch(page, "verdictFromEvents").isChecked()) &&
        same(await storedCuration(page), before) &&
        (await storedSession(page)).curationRules?.verdictFromEvents === true,
      "R1 Cancel keeps the switch on and the curation as it was",
      cancelled,
    );

    const text = await switchOff(page, "verdictFromEvents", "Clear them");
    check(
      /4 samples have a verdict derived from their events \(2 Contaminated, 1 Not contaminated, 1 Uncertain\)/.test(text) &&
        /the Suppress that went with the 2 automatic Contaminated verdicts goes too/.test(text),
      "R1 off asks first, with the count of the verdicts and of the paired Suppress",
      text,
    );
    check(!(await ruleSwitch(page, "verdictFromEvents").isChecked()), "R1 Clear switches the rule off");
    await closeConfig(page);
    const sc = await storedCuration(page);
    check(
      ["63D9", "NC3", "63D40", "58D7"].every((id) => sc[id] === undefined) &&
        same(sc["58D47"], { verdict: "contaminated", action: "suppress", actionAuto: true }),
      "R1 Clear: the automatic verdicts and their Suppress are gone; the verdict set by hand stays",
      show(sc),
    );
    const marks = await sampleMarks(page);
    check(
      marks.verdict.automatic === 0 && marks.action.automatic === 1,
      "R1 Clear: the Samples tab tags no automatic verdict (58D47's Suppress is still the rule's)",
      show(marks),
    );
    s = await overviewStats(page);
    const card = await curatedCard(page);
    check(
      s.suppress === 1 && s.keep === 0 && card === "90 of 91",
      "R1 Clear: Overview 1 to suppress, Export keeps 90 of 91",
      `suppress=${s.suppress} keep=${s.keep} card=${card}`,
    );
    check(
      (await storedSession(page)).curationRules?.verdictFromEvents === false,
      "R1 Clear: the switch is saved with the session",
    );

    // A TP while R1 is off sets no sample verdict.
    await clickEvent(page, "58M", "58D28", "tp");
    check((await storedCuration(page))["58D28"] === undefined, "R1 off: a TP click sets no sample verdict");

    const notice = await switchOn(page, "verdictFromEvents");
    check(
      /5 samples got an automatic verdict from their events \(3 Contaminated, 1 Not contaminated, 1 Uncertain\)/.test(notice) &&
        /3 of them are Contaminated, paired with Suppress/.test(notice),
      "R1 on applies the rule to every sample and says what it added",
      notice,
    );
    await page.locator('[data-rules-notice] button[aria-label="Dismiss"]').click();
    check((await page.locator("[data-rules-notice]").count()) === 0, "the notice can be dismissed");
    await closeConfig(page);
    const back = await storedCuration(page);
    s = await overviewStats(page);
    check(
      same(back["63D9"], AUTO_C_S) &&
        same(back["58D28"], AUTO_C_S) &&
        same(back["58D47"], before["58D47"]) &&
        s.suppress === 4,
      "R1 on: the automatic values are back (58D28's too), the value set by hand untouched",
      `${show(back["63D9"])} ${show(back["58D47"])} suppress=${s.suppress}`,
    );
  });

  await scenario("R1 off, Keep", async (page) => {
    await curateSome(page);
    const text = await switchOff(page, "verdictFromEvents", "Keep them as my decisions");
    check(/^Switch off/.test(text || ""), "R1 off with values asks first");
    await closeConfig(page);
    const sc = await storedCuration(page);
    check(
      same(sc["63D9"], { verdict: "contaminated", action: "suppress", actionAuto: true }) &&
        same(sc["63D40"], { verdict: "correct" }) &&
        same(sc["58D7"], { verdict: "uncertain" }),
      "R1 Keep: the verdicts stay, set by hand; the paired Suppress stays the rule's",
      show(sc),
    );
    const marks = await sampleMarks(page);
    const s = await overviewStats(page);
    check(
      marks.verdict.automatic === 0 && marks.action.automatic === 3 && s.suppress === 3,
      "R1 Keep: no automatic verdict tagged, still 3 to suppress",
      `${show(marks)} suppress=${s.suppress}`,
    );
    // With the verdict rule off, the curator's verdict cleared leaves the
    // sample Pending, and its chip says so.
    await openTab(page, "Samples");
    const pending = sampleRow(page, "63D40").locator('button[aria-label="Set verdict to Pending"]');
    const title = await pending.getAttribute("title");
    check(
      /it is then Pending \(the sample verdict from the events is switched off in Configuration\)/.test(title || ""),
      "R1 off: Pending on a verdict set by hand says it then has none",
      title,
    );
    await pending.click();
    await page.waitForTimeout(300);
    check((await storedCuration(page))["63D40"] === undefined, "…and leaves 63D40 with no verdict");
    const notice = await switchOn(page, "verdictFromEvents");
    check(
      /1 sample got an automatic verdict from its events \(1 Not contaminated\)/.test(notice || ""),
      "R1 on after Keep adds only what no verdict of yours covers",
      notice,
    );
    await closeConfig(page);
    const after = await storedCuration(page);
    check(
      same(after["63D9"], sc["63D9"]) && same(after["63D40"], { verdict: "correct", verdictAuto: true }),
      "R1 on after Keep: the kept verdicts stay yours, nothing is duplicated",
      show(after),
    );
  });

  /* ------------------------------------------ R2: Suppress with Contaminated */
  await scenario("R2 off, Clear, then on", async (page) => {
    await clickEvent(page, "63D250", "63D9", "tp");
    await clickEvent(page, "83D88", "NC3", "tp");
    // 72D17: Contaminated and Suppress, both set by hand.
    await setSampleVerdict(page, "72D17", "Contaminated");
    await sampleRow(page, "72D17").locator('button[aria-label="Suppress 72D17"]').click();
    await page.waitForTimeout(300);
    let s = await overviewStats(page);
    check(s.suppress === 3, "R2 setup: 3 to suppress", `suppress=${s.suppress}`);

    await switchOff(page, "suppressContaminated", "Cancel");
    check(await ruleSwitch(page, "suppressContaminated").isChecked(), "R2 Cancel keeps the switch on");

    const text = await switchOff(page, "suppressContaminated", "Clear them");
    check(
      /2 Contaminated samples have the automatic Suppress/.test(text || "") &&
        /come back into the curated abundance table/.test(text || ""),
      "R2 off asks first, with the count of the automatic Suppress",
      text,
    );
    await closeConfig(page);
    const sc = await storedCuration(page);
    check(
      same(sc["63D9"], { verdict: "contaminated", verdictAuto: true }) &&
        same(sc["72D17"], { verdict: "contaminated", action: "suppress" }),
      "R2 Clear: the automatic Suppress goes; the Suppress set by hand stays",
      show(sc),
    );
    const marks = await sampleMarks(page);
    s = await overviewStats(page);
    const card = await curatedCard(page);
    check(
      marks.action.automatic === 0 && s.suppress === 1 && card === "90 of 91",
      "R2 Clear: no automatic action tagged, 1 to suppress, 90 of 91 kept",
      `${show(marks)} suppress=${s.suppress} card=${card}`,
    );
    // 63D9 and NC3 are Contaminated with no action, and stay in the
    // curated table: the card must not say that Contaminated brings
    // Suppress.
    const cardText = await curatedCardText(page);
    check(
      /^The abundance table with the 1 sample set to Suppress removed\. Suppress paired with Contaminated is switched off in Configuration: a Contaminated sample you have not set to Suppress stays in this table\./.test(cardText) &&
        !/which includes every sample you marked Contaminated/.test(cardText),
      "R2 off: the Export card says a Contaminated sample without Suppress stays in the curated table",
      cardText,
    );
    // With R2 off, a TP makes its target Contaminated and nothing else.
    await clickEvent(page, "58M", "58D7", "tp");
    check(
      same((await storedCuration(page))["58D7"], { verdict: "contaminated", verdictAuto: true }),
      "R2 off: a TP click adds no Suppress",
    );
    const notice = await switchOn(page, "suppressContaminated");
    check(
      /3 Contaminated samples now have the automatic Suppress/.test(notice || ""),
      "R2 on pairs every Contaminated sample without an action of yours, and says so",
      notice,
    );
    await closeConfig(page);
    s = await overviewStats(page);
    check(s.suppress === 4, "R2 on: 4 to suppress", `suppress=${s.suppress}`);
  });

  await scenario("R2 off, Keep", async (page) => {
    await clickEvent(page, "63D250", "63D9", "tp");
    await switchOff(page, "suppressContaminated", "Keep them as my decisions");
    await closeConfig(page);
    const sc = await storedCuration(page);
    const marks = await sampleMarks(page);
    const s = await overviewStats(page);
    check(
      same(sc["63D9"], { verdict: "contaminated", verdictAuto: true, action: "suppress" }) &&
        marks.action.automatic === 0 &&
        s.suppress === 1,
      "R2 Keep: the Suppress stays, set by hand (no auto tag), still 1 to suppress",
      `${show(sc["63D9"])} ${show(marks)} suppress=${s.suppress}`,
    );
    const notice = await switchOn(page, "suppressContaminated");
    check(/nothing was suppressed/.test(notice || ""), "R2 on after Keep adds nothing", notice);
  });

  /* ------------------------------- R3: default of samples no event targets */
  await scenario("R3 off, Clear, then on", async (page) => {
    let marks = await sampleMarks(page);
    check(
      marks.verdict.default === NEVER_TARGETED && marks.action.default === NEVER_TARGETED,
      "R3 setup: every sample no event targets shows the default Not contaminated + Keep",
      show(marks),
    );
    await switchOff(page, "neverTargetedDefault", "Cancel");
    check(await ruleSwitch(page, "neverTargetedDefault").isChecked(), "R3 Cancel keeps the switch on");
    const text = await switchOff(page, "neverTargetedDefault", "Clear them");
    check(
      new RegExp(`${NEVER_TARGETED} samples no event targets show a default value, not a decision \\(${NEVER_TARGETED} Not contaminated, ${NEVER_TARGETED} Keep\\)`).test(text || "") &&
        /stay in the curated abundance table/.test(text || ""),
      "R3 off asks first, with the count of the defaults",
      text,
    );
    await closeConfig(page);
    marks = await sampleMarks(page);
    const row = sampleRow(page, "40D89");
    const pendingActive = await row
      .locator('button[aria-label="Set verdict to Pending"]')
      .evaluate((b) => b.style.background !== "var(--bg-card)");
    const s = await overviewStats(page);
    const card = await curatedCard(page);
    check(
      marks.verdict.default === 0 && marks.action.default === 0 && pendingActive,
      "R3 Clear: no default tagged; a sample no event targets is Pending",
      show(marks),
    );
    check(
      s.keep === 0 && s.suppress === 0 && card === "91 of 91",
      "R3 Clear: Overview 0 / 0, Export keeps 91 of 91",
      `keep=${s.keep} suppress=${s.suppress} card=${card}`,
    );
    check(same(await storedCuration(page), {}), "R3 Clear stores nothing");
    const notice = await switchOn(page, "neverTargetedDefault");
    check(
      new RegExp(`${NEVER_TARGETED} samples no event targets are Not contaminated \\+ Keep by default again`).test(notice || ""),
      "R3 on shows the defaults again, and says so",
      notice,
    );
    await closeConfig(page);
    marks = await sampleMarks(page);
    check(marks.verdict.default === NEVER_TARGETED, "R3 on: the defaults are back", show(marks));
  });

  await scenario("R3 off, Keep", async (page) => {
    await switchOff(page, "neverTargetedDefault", "Keep them as my decisions");
    await closeConfig(page);
    const sc = await storedCuration(page);
    const kept = Object.values(sc).filter((c) => same(c, { verdict: "correct", action: "keep" })).length;
    const marks = await sampleMarks(page);
    let s = await overviewStats(page);
    check(
      kept === NEVER_TARGETED && marks.verdict.default === 0 && s.keep === NEVER_TARGETED,
      "R3 Keep: written as Not contaminated + Keep set by hand, counted as Keep decisions",
      `kept=${kept} ${show(marks)} keep=${s.keep}`,
    );
    const notice = await switchOn(page, "neverTargetedDefault");
    check(/no default to show/.test(notice || ""), "R3 on after Keep adds nothing", notice);
    await closeConfig(page);
    s = await overviewStats(page);
    check(s.keep === NEVER_TARGETED, "R3 on after Keep: nothing duplicated", `keep=${s.keep}`);
  });

  /* A sample the events file and the abundance table spell differently
     (the events' 69M, a source no event targets; the table's 69m) is one
     sample: one row of the Samples tab, one Keep in the Overview. The
     question that switches the default off counted it twice. */
  await scenario("R3 counts a sample once, whatever its spelling", async (page) => {
    const ab = readFileSync("public/demo/species_abundance.tsv", "utf8").split("\n");
    ab[0] = ab[0]
      .split("\t")
      .map((s) => (s === "69M" ? "69m" : s))
      .join("\t");
    await tsvInput(page, 1).setInputFiles({
      name: "species_abundance.tsv",
      mimeType: "text/tab-separated-values",
      buffer: Buffer.from(ab.join("\n")),
    });
    await page.waitForTimeout(2000);
    const text = await switchOff(page, "neverTargetedDefault", "Keep them as my decisions");
    check(
      new RegExp(`^.*${NEVER_TARGETED} samples no event targets show a default value, not a decision \\(${NEVER_TARGETED} Not contaminated, ${NEVER_TARGETED} Keep\\)`).test(text || ""),
      "R3 off asks with the count of the samples, 69M / 69m once",
      text,
    );
    await closeConfig(page);
    const s = await overviewStats(page);
    check(s.keep === NEVER_TARGETED, "R3 Keep: as many Keep decisions as the question said", `keep=${s.keep}`);
  });

  /* One value of a rule, and one rule off at a time: the question and the
     notice speak of one sample, and the samples report's legend says what
     "auto" can mark under the rules left on. */
  await scenario("texts with one value, one rule off", async (page) => {
    await clickEvent(page, "63D250", "63D9", "tp"); // automatic Contaminated + Suppress
    const question = await switchOff(page, "verdictFromEvents", "Clear them");
    check(
      /1 sample has a verdict derived from its events \(1 Contaminated\)\. Keep them as my decisions: the verdict stays, as yours, without the auto tag; the Suppress paired with it stays automatic\. Clear them: this sample goes back to Pending, and the Suppress that went with its automatic Contaminated verdict goes too: it comes back into the curated abundance table\./.test(question || ""),
      "R1 off with one value: the question speaks of one sample",
      question,
    );
    await closeConfig(page);
    await openTab(page, "Export");
    const legendOf = (html) => (html || "").match(/In the table, <em>auto<\/em>.*?(?=<\/div>)/)?.[0] || (html || "").match(/Every verdict and action.*?(?=<\/div>)/)?.[0] || "";
    let legend = legendOf(await download(page, page.getByRole("button", { name: "Download samples HTML" }).first()));
    check(
      legend ===
        "In the table, <em>auto</em> marks an action set by a rule — the Suppress that goes with a Contaminated verdict — and <em>default</em> the Not contaminated + Keep of a sample no event targets; the others were set by hand. Automatic rules switched off for this session (Configuration): Sample verdict from the event evaluations.",
      "R1 off: the samples report's legend says auto marks an action",
      legend,
    );
    const notice = await switchOn(page, "verdictFromEvents");
    check(
      /^“Sample verdict from the event evaluations” switched on\. 1 sample got an automatic verdict from its events \(1 Contaminated\); it is paired with Suppress and leaves the curated abundance table\. Verdicts you set by hand are unchanged\./.test(notice || ""),
      "R1 on with one value: the notice speaks of one sample",
      notice,
    );
    await switchOff(page, "suppressContaminated", "Clear them");
    await closeConfig(page);
    await openTab(page, "Export");
    legend = legendOf(await download(page, page.getByRole("button", { name: "Download samples HTML" }).first()));
    check(
      legend ===
        "In the table, <em>auto</em> marks a verdict set by a rule — a verdict derived from the event evaluations — and <em>default</em> the Not contaminated + Keep of a sample no event targets; the others were set by hand. Automatic rules switched off for this session (Configuration): Suppress paired with Contaminated.",
      "R2 off: the samples report's legend says auto marks a verdict",
      legend,
    );
  });

  /* ------------------------------------------------------- every rule off */
  await scenario("all rules off", async (page) => {
    // Nothing evaluated yet: R1 and R2 have no value, so no question.
    await openConfig(page);
    await ruleSwitch(page, "verdictFromEvents").click();
    await page.waitForTimeout(300);
    check(
      (await page.getByRole("dialog", { name: /^Switch off/ }).count()) === 0 &&
        !(await ruleSwitch(page, "verdictFromEvents").isChecked()),
      "a rule with no value in the session is switched off without a question",
    );
    await switchOff(page, "suppressContaminated", "Clear them");
    await switchOff(page, "neverTargetedDefault", "Clear them");
    await closeConfig(page);

    // The negative-control preset only marks the events.
    let bulk = await openBulkDialog(page);
    const preset = bulk.getByRole("button", { name: /Mark all events targeting a negative control as TP/ });
    check(
      /sample verdicts left to you/.test(await preset.innerText()),
      "the NC preset says the sample verdicts are left to the curator",
      await preset.innerText(),
    );
    await preset.click();
    const ask = page.getByRole("dialog", { name: /toward NC as true positive/ });
    const askText = await ask.innerText();
    check(/verdicts are left to you/.test(askText), "…and so does its confirmation", askText.replace(/\s+/g, " "));
    await ask.getByRole("button", { name: /^Mark \d+ as TP$/ }).click();
    await page.waitForTimeout(500);
    check(same(await storedCuration(page), {}), "the NC preset sets no sample value");

    await clickEvent(page, "63D250", "63D9", "tp");
    check(same(await storedCuration(page), {}), "a TP click sets no sample value");

    const pop = await openNodePopover(page, "72D17");
    const labels = await pop.getByRole("button", { name: "(no change)" }).count();
    check(
      labels === 2 && (await pop.getByRole("button", { name: /^Automatic$/ }).count()) === 0,
      "the Network popover's Automatic options read (no change)",
      `labels=${labels}`,
    );
    await pop.getByRole("button", { name: /^Apply$/ }).click(); // TP, defaults
    await page.getByRole("button", { name: /^Apply to \d+$/ }).click();
    await page.waitForTimeout(500);
    check(same(await storedCuration(page), {}), "the Network popover's Automatic sets no sample value");

    await openTab(page, "Scatter");
    await page.getByRole("button", { name: /^Explore new pairs$/ }).first().click();
    await page.waitForTimeout(800);
    const pick = async (placeholder, id) => {
      const input = page.locator(`input[placeholder="${placeholder}"]`);
      await input.click();
      await input.fill(id);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
    };
    await pick("Type to search… e.g. ERS848718", "63D250");
    await pick("Pick from neighbors / same subject / others…", "40D89");
    check(
      (await page.getByRole("button", { name: "(no change)" }).count()) >= 1,
      "Explore new pairs' automatic target verdict reads (no change)",
    );
    await page.getByRole("button", { name: /Save as new contamination event/ }).click(); // TP
    await page.waitForTimeout(600);
    check(same(await storedCuration(page), {}), "Explore new pairs (TP) sets no sample value");

    bulk = await openBulkDialog(page);
    check(
      (await bulk.getByRole("button", { name: "(no change)" }).count()) === 2 &&
        (await bulk.getByRole("button", { name: /^Automatic$/ }).count()) === 0,
      "the bulk dialog's Automatic options read (no change)",
    );
    await bulk.getByRole("button", { name: /^True positive$/ }).first().click();
    await bulk.getByRole("button", { name: /^Apply to \d+ events?$/ }).click();
    const confirm = page.getByRole("dialog", { name: /^Apply "true positive"/ });
    const confirmText = (await confirm.innerText()).replace(/\s+/g, " ");
    check(
      /verdict → unchanged \(the sample verdict from the events is switched off/.test(confirmText) &&
        /action → unchanged/.test(confirmText),
      "the bulk confirmation says the target verdicts and actions are unchanged",
      confirmText,
    );
    await page.getByRole("button", { name: /^Apply to \d+$/ }).click();
    await page.waitForTimeout(600);
    const s = await overviewStats(page);
    const marks = await sampleMarks(page);
    check(
      same(await storedCuration(page), {}) &&
        s.tp === 25 &&
        s.suppress === 0 &&
        s.keep === 0 &&
        marks.verdict.automatic + marks.verdict.default + marks.action.automatic + marks.action.default === 0,
      "bulk TP sets no sample value: every event TP, nothing to suppress, no tag",
      `tp=${s.tp} suppress=${s.suppress} keep=${s.keep} ${show(marks)}`,
    );
    // Nothing to suppress: the curated abundance card must not advise
    // marking a sample Contaminated to drop it.
    const cardText = await curatedCardText(page);
    check(
      /^The abundance table with every sample set to Suppress removed\. Nothing is set to suppress yet, so this would export every sample — set a sample's action to Suppress from the Samples, Validate or Network tab\. Suppress paired with Contaminated is switched off in Configuration/.test(cardText) &&
        !/defaults its action to Suppress/.test(cardText),
      "with Suppress paired with Contaminated off, the Export card does not say Contaminated brings Suppress",
      cardText,
    );
    // The samples report says which rules are off; the samples TSV names
    // no automatic or default origin.
    await openTab(page, "Export");
    const html = await download(page, page.getByRole("button", { name: "Download samples HTML" }).first());
    check(
      /Every verdict and action in the table was set by hand\. Automatic rules switched off for this session/.test(html || ""),
      "the samples HTML report's legend says the rules are off",
    );
    const tsv = await download(page, page.getByRole("button", { name: "Download samples TSV" }).first());
    const rows = (tsv || "").split("\n").map((l) => l.split("\t"));
    const vo = rows[0].indexOf("verdict_origin");
    const ao = rows[0].indexOf("action_origin");
    check(
      rows.length > 90 && rows.slice(1).every((r) => r[vo] === "" && r[ao] === ""),
      "the samples TSV has no automatic or default origin",
    );
  });

  /* Another events file: carried over, the session keeps its own rules;
     started fresh, it is a new session, with the last choice made in
     Configuration. */
  await scenario("another events file", async (page) => {
    // The last choice made in Configuration: R1 off (nothing to clear).
    await switchOff(page, "verdictFromEvents", "Clear them");
    await closeConfig(page);
    // A session with every rule on (a file without curation_rules), then
    // some curation, so that replacing its events asks first.
    const json = JSON.parse(
      await download(page, page.getByRole("button", { name: /^Download session$/ }).first()),
    );
    delete json.curation_rules;
    await importSession(page, json);
    check(same(await shownRules(page), ALL_ON), "the imported session has every rule on");
    await clickEvent(page, "63D250", "63D9", "tp");
    const replace = async (choice) => {
      await tsvInput(page, 0).setInputFiles({
        name: "contamination_events.tsv",
        mimeType: "text/tab-separated-values",
        buffer: readFileSync("public/demo/contamination_events.tsv"),
      });
      await page.waitForTimeout(1500);
      const ask = page.getByRole("dialog", { name: "Replace the events file?" });
      await ask.getByRole("button", { name: choice, exact: true }).click();
      await page.waitForTimeout(1000);
    };
    await replace("Carry over");
    let sc = await storedCuration(page);
    check(
      same(await shownRules(page), ALL_ON) && same(sc["63D9"], AUTO_C_S),
      "carried over to another events file, the session keeps its own rules",
      show(sc["63D9"]),
    );
    await replace("Start fresh");
    check(
      same(await shownRules(page), { ...ALL_ON, verdictFromEvents: false }),
      "started fresh, it is a new session with the last choice made in Configuration",
    );
    await clickEvent(page, "63D250", "63D9", "tp");
    sc = await storedCuration(page);
    check(sc["63D9"] === undefined, "…under which a TP sets no sample verdict", show(sc["63D9"]));
  });

  /* ---------------------------------------------------------- persistence */
  await scenario("saved with the session", async (page, ctx) => {
    await switchOff(page, "verdictFromEvents", "Clear them");
    await switchOff(page, "neverTargetedDefault", "Clear them");
    await closeConfig(page);
    const want = { verdictFromEvents: false, suppressContaminated: true, neverTargetedDefault: false };
    check(same((await storedSession(page)).curationRules, want), "the rules are in the stored curation record");
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    check(same(await shownRules(page), want), "a reload keeps the rules");

    // The session JSON carries them, and an import gives them back.
    const json = JSON.parse(
      await download(page, page.getByRole("button", { name: /^Download session$/ }).first()),
    );
    check(same(json.curation_rules, want), "the session JSON writes curation_rules", show(json.curation_rules));
    const other = await ctx.browser().newContext({ viewport: { width: 1500, height: 1000 } });
    const page2 = await other.newPage();
    const errors2 = trackErrors(page2);
    await page2.addInitScript(() => localStorage.setItem("crocodeel-tutorial-seen", "1"));
    await page2.goto(BASE, { waitUntil: "networkidle" });
    await importSession(page2, json);
    check(same(await shownRules(page2), want), "an imported session JSON keeps its rules");
    // A file without the field (every earlier one): every rule on.
    const older = { ...json };
    delete older.curation_rules;
    await importSession(page2, older);
    check(same(await shownRules(page2), ALL_ON), "a session JSON without curation_rules has every rule on");
    check(errors2.length === 0, "importing: no JS error", errors2[0] || "");
    await other.close();

    // The last choice made in Configuration (R1 and R3 off, in this
    // browser) is a new session's: importing a session with every rule on
    // does not change it.
    await importSession(page, older);
    check(same(await shownRules(page), ALL_ON), "the imported session has its own rules (all on)");
    await page.getByRole("button", { name: /^Clear session$/ }).first().click();
    await page.getByRole("dialog", { name: "Clear the entire session?" }).getByRole("button", { name: "Clear session" }).click();
    await page.waitForTimeout(800);
    await loadDemo(page);
    check(same(await shownRules(page), want), "a new session (Clear session, then the demo) starts with the last choice");
  });

  /* Two tabs: a rule switched in one is a change of the curation, which
     the other must not overwrite with its older copy. */
  await scenario("two tabs", async (page, ctx) => {
    await page.waitForTimeout(1500);
    const other = await ctx.newPage();
    const errors2 = trackErrors(other);
    await other.goto(BASE, { waitUntil: "networkidle" });
    await other.waitForTimeout(2000);
    await switchOff(page, "neverTargetedDefault", "Clear them");
    await closeConfig(page);
    await page.waitForTimeout(1200);
    await clickEvent(other, "63D250", "63D9", "tp");
    await other.waitForTimeout(1500);
    check(
      (await other.locator('[data-save-banner="conflict"]').count()) === 1,
      "the other tab stops saving and says the session was changed in another tab",
    );
    check(
      (await storedSession(page)).curationRules?.neverTargetedDefault === false,
      "the switch made in the first tab stays stored",
    );
    check(errors2.length === 0, "two tabs: no JS error in the second", errors2[0] || "");
  });

  /* The FAQ answers a curator reads to stop these decisions name the
     switches. */
  await scenario("the Help FAQ names the switches", async (page) => {
    await openTab(page, "Help");
    const faq = (await page.locator("#h-faq").innerText()).replace(/\s+/g, " ");
    check(
      /your call is never overridden — see the "Event vs sample curation" section above\. To make every sample verdict yourself, switch off Sample verdict from the event evaluations in Configuration/.test(faq),
      "FAQ evaluation vs verdict: the sample verdict from the events can be switched off",
      faq.match(/A TP event makes its target Contaminated[^?]*/)?.[0] || faq.slice(0, 300),
    );
    check(
      /can switch this default off — Not contaminated \+ Keep for samples no event targets: such a sample is then Pending with no action until you decide/.test(faq),
      "FAQ never-targeted default: the default can be switched off",
      faq.match(/A sample that is never the target[^?]*/)?.[0] || "",
    );
  });
} finally {
  await browser.close();
  stopServer();
}
finish();
