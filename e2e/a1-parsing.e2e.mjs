/* Input parsing, as a curator meets it in the browser.

   The unit tests (tests/a1-parsing*.test.js) pin the parsers down; these
   checks follow the same files through the upload cards to what the app
   then shows:

     - an events file saved with decimal commas is refused, with the cell
       to fix, and nothing is loaded (it used to load with rates of 7 or 0);
     - an abundance table with decimal commas says so in the banner;
     - a metadata column such as age_group no longer makes two different
       subjects "same group", and the metadata card shows which header
       was read for which field;
     - a plate map given as row + column loads (it used to be refused);
     - the curated events TSV of the Export tab reloads with its verdicts;
     - the metadata download reloads to the same relatedness;
     - a hand-edited session whose card warnings are not a list loads.

   Usage:  node e2e/a1-parsing.e2e.mjs          (starts a preview server)
           BASE_URL=http://host/path/ node e2e/a1-parsing.e2e.mjs */

import { readFileSync } from "node:fs";
import { parseEvents, parseMetadata } from "../src/parsing.js";
import {
  startServer,
  stopServer,
  launchBrowser,
  newPage,
  loadDemo,
  openTab,
  overviewStats,
  tsvInput,
  tsvRows,
  check,
  finish,
} from "./harness.mjs";

const demo = (name) => readFileSync(`public/demo/${name}`, "utf8");

/** Upload `text` as a file through the i-th upload card (0 events,
    1 abundance, 2 metadata, 3 plate map). */
async function upload(page, i, name, text) {
  await tsvInput(page, i).setInputFiles({
    name,
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from(text),
  });
  await page.waitForTimeout(2000);
}

/** The relatedness pills of the Events table, by label. */
async function relatednessPills(page) {
  await openTab(page, "Events");
  const pills = page.locator("table td span");
  return {
    sameGroup: await pills.filter({ hasText: /^same group$/ }).count(),
    related: await pills.filter({ hasText: /^related$/ }).count(),
  };
}

/** The metadata (or plate map) upload card. */
function card(page, label) {
  return page
    .locator("div.rounded-sm")
    .filter({ has: page.getByText(label, { exact: true }) })
    .filter({ has: page.getByRole("button", { name: /^(Replace|Select file)$/ }) })
    .last();
}

/** The text of the metadata (or plate map) upload card. */
async function cardText(page, label) {
  return card(page, label).innerText();
}

/** Import a session JSON through the "Import session" button. */
async function importSession(page, json) {
  await page.locator('input[accept*="json"]').first().setInputFiles({
    name: "session.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(json)),
  });
  await page.waitForTimeout(3000);
}

/** A session JSON as exportJSON writes it: the demo events, plus `extra`
    (metadata, plate_map, ...). */
function sessionJSON(extra) {
  const { events, runMetadata } = parseEvents(demo("contamination_events.tsv"));
  return {
    generated: new Date().toISOString(),
    schema_version: 2,
    analysis_title: "session",
    run_metadata: runMetadata,
    metadata: null,
    plate_map: null,
    abundance: null,
    sample_curation: {},
    ui_state: { tab: "overview" },
    events: events.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      contamination_rate: e.rate,
      probability: e.score,
      introduced_species: e.introduced,
      verdict: e.verdict,
      notes: e.notes,
    })),
    ...extra,
  };
}

// The demo metadata, re-written the way a LIMS export might give it:
// aliased headers, no group column, and an age band per biome.
const ageBand = { "infant gut": "0-1y", "maternal gut": "adult" };
const demoMetadata = tsvRows("public/demo/metadata.tsv");
const AGED_METADATA = [
  ["SampleID", "patient", "visit", "biome", "age_group"],
  ...demoMetadata.map((c) => [c[0], c[1], c[2], c[3], ageBand[c[3]] || ""]),
]
  .map((r) => r.join("\t"))
  .join("\n");

// Pairs the old parser called "same group" through age_group: different
// subjects, same non-empty age band.
const subjectOf = Object.fromEntries(demoMetadata.map((c) => [c[0], c[1]]));
const bandOf = Object.fromEntries(demoMetadata.map((c) => [c[0], ageBand[c[3]] || ""]));
const demoEvents = tsvRows("public/demo/contamination_events.tsv");
const sameSubjectEvents = demoEvents.filter(
  ([s, t]) => subjectOf[s] && subjectOf[s] === subjectOf[t],
).length;
const sameBandOtherSubject = demoEvents.filter(
  ([s, t]) => subjectOf[s] && subjectOf[t] && subjectOf[s] !== subjectOf[t] && bandOf[s] && bandOf[s] === bandOf[t],
).length;

await startServer();
const browser = await launchBrowser();
try {
  /* ------------------ 1. events with decimal commas: refused, nothing loaded */
  {
    const { ctx, page, errors } = await newPage(browser);
    const lines = demo("contamination_events.tsv").split("\n");
    const comma = lines
      .map((l) => {
        if (!l || l.startsWith("#") || l.startsWith("source\t")) return l;
        const c = l.split("\t");
        c[2] = c[2].replace(".", ",");
        c[3] = c[3].replace(".", ",");
        return c.join("\t");
      })
      .join("\n");
    await upload(page, 0, "contamination_events.tsv", comma);
    const alert = (await page.locator('[role="alert"]').allInnerTexts()).join(" ");
    check(
      /Events file: Row 1 \(line 3\), column "rate": "[^"]*,[^"]*" is not a number/.test(alert),
      "a decimal-comma events file is refused, naming the row, line, column and value",
      alert.slice(0, 160),
    );
    check(
      alert.includes("looks like a decimal comma — re-export the file with '.' as decimal separator"),
      "the error says how to fix the file",
    );
    const body = await page.locator("body").innerText();
    check(!/events loaded/.test(body), "no event is loaded");
    check(
      await page.getByRole("button", { name: /^Validate$/ }).first().isDisabled(),
      "the data tabs stay disabled",
    );
    check(errors.length === 0, "no JS error on the refused file", errors[0] || "");
    await ctx.close();
  }

  /* ------------- 2. abundance with decimal commas: reported in the banner */
  {
    const { ctx, page, errors } = await newPage(browser);
    const lines = demo("species_abundance.tsv").split("\n");
    const comma = [lines[0], ...lines.slice(1).map((l) => l.replace(/(\d)\.(\d)/g, "$1,$2"))].join("\n");
    await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
    await upload(page, 1, "species_abundance.tsv", comma);
    const body = await page.locator("body").innerText();
    check(
      /Check the input files/.test(body) &&
        /non-empty cells were not numeric and were read as 0/.test(body) &&
        /look like a decimal comma/.test(body),
      "an abundance table with decimal commas is reported as such",
      (body.match(/[\d ,]+ non-empty cells[^\n]*/) || [""])[0].slice(0, 200),
    );
    check(errors.length === 0, "no JS error on the comma abundance table", errors[0] || "");
    await ctx.close();
  }

  /* --- 3. age_group is not a group; the card shows the column mapping */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadDemo(page);
    const before = await relatednessPills(page);
    check(
      before.sameGroup > 0,
      "the demo's own group_id gives 'same group' pills (the check can see them)",
      `same group ${before.sameGroup}`,
    );

    await upload(page, 2, "metadata.tsv", AGED_METADATA);
    const card = await cardText(page, "metadata.tsv");
    check(
      /Columns: sample_id · subject_id ← patient · timepoint ← visit · biome · other: age_group/.test(card),
      "the metadata card shows which header was read for which field",
      (card.match(/Columns:[^\n]*/) || [""])[0],
    );
    const after = await relatednessPills(page);
    check(
      after.sameGroup === 0,
      "two different subjects of one age band are not 'same group'",
      `same group ${after.sameGroup} (the substring match made ${sameBandOtherSubject})`,
    );
    check(
      after.related === sameSubjectEvents,
      "the same-subject pairs are still related, through the patient column",
      `related ${after.related} of ${sameSubjectEvents}`,
    );

    /* -- 4. the metadata download reloads to the same relatedness */
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
      page.locator('button[title="Download this file"]').nth(2).click(),
    ]);
    check(!!download, "the metadata downloads");
    if (download) {
      const text = readFileSync(await download.path(), "utf8");
      check(
        text.split("\n")[0] === "sample_id\tsubject_id\ttimepoint\tbiome\tage_group",
        "the download uses the canonical column names",
        JSON.stringify(text.split("\n")[0]),
      );
      await upload(page, 2, "metadata.tsv", text);
      const again = await relatednessPills(page);
      check(
        again.sameGroup === 0 && again.related === sameSubjectEvents,
        "reloading the download keeps the same relatedness",
        `same group ${again.sameGroup}, related ${again.related}`,
      );
    }
    check(errors.length === 0, "no JS error across the metadata checks", errors[0] || "");
    await ctx.close();
  }

  /* ---------------- 5. a plate map given as row + column loads */
  {
    const { ctx, page, errors } = await newPage(browser);
    const wellRows = tsvRows("public/demo/plate_map.tsv");
    const rowCol = [
      "sample_id\tplate\trow\tcolumn",
      ...wellRows.map(([id, plate, well]) => `${id}\t${plate}\t${well[0]}\t${Number(well.slice(1))}`),
    ].join("\n");
    await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
    await upload(page, 3, "plate_map.tsv", rowCol);
    const alert = (await page.locator('[role="alert"]').allInnerTexts()).join(" ");
    check(!/Plate map:/.test(alert), "the row + column plate map is accepted", alert.slice(0, 160));
    const card = await cardText(page, "plate_map.tsv");
    check(
      card.includes(`${wellRows.length} wells (8×12)`) &&
        card.includes("Columns: sample_id · plate · row · column"),
      "the plate card counts the wells and shows the row + column mapping",
      card.replace(/\s+/g, " ").slice(0, 200),
    );
    await openTab(page, "Plate");
    const plate = await page.locator("body").innerText();
    const used = Number(plate.match(/WELLS USED\s*(\d+)/i)?.[1]);
    const adjacent = Number(plate.match(/(\d+) adjacent-well/)?.[1]);
    check(used === wellRows.length, "the Plate tab shows every well", `wells used ${used}`);
    // Same placement as the demo's well-format file: 13 adjacent-well
    // events there, so the coordinates were read, not just counted.
    check(adjacent === 13, "the wells are where the well-format file puts them", `adjacent ${adjacent}`);
    check(errors.length === 0, "no JS error across the plate map checks", errors[0] || "");
    await ctx.close();
  }

  /* ------- 6. the curated events export reloads with its verdicts */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadDemo(page);
    await openTab(page, "Events");
    const tp = page.locator('button[title="mark as true positive"]');
    for (const i of [0, 1, 2]) {
      await tp.nth(i).click();
      await page.waitForTimeout(300);
    }
    const marked = (await overviewStats(page)).tp;
    await openTab(page, "Export");
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
      page.getByRole("button", { name: /Download events TSV/i }).first().click(),
    ]);
    check(!!download && marked === 3, "three events marked TP are exported", `TP ${marked}`);
    if (download) {
      const text = readFileSync(await download.path(), "utf8");
      await upload(page, 0, "contamination_events_curated.tsv", text);
      const s = await overviewStats(page);
      check(s.tp === 3, "reloading the curated TSV restores the verdicts", `TP ${s.tp}`);
    }
    check(errors.length === 0, "no JS error across the reload", errors[0] || "");
    await ctx.close();
  }

  /* -- 7. a hand-edited session whose card warnings are not a list */
  {
    const { ctx, page, errors } = await newPage(browser);
    const metadata = { ...parseMetadata(demo("metadata.tsv")), warnings: "2 sample ids appear twice" };
    await importSession(page, sessionJSON({ metadata }));
    const body = await page.locator("body").innerText();
    check(!/Something went wrong/.test(body), "the session loads instead of blanking the app");
    const text = await card(page, "metadata.tsv")
      .innerText({ timeout: 5000 })
      .catch(() => "");
    check(text.includes("Columns: sample_id · subject_id"), "the metadata card still shows its mapping");
    check(errors.length === 0, "no JS error on the odd warnings", errors[0] || "");
    await ctx.close();
  }
} finally {
  await browser.close();
  stopServer();
}

finish();
