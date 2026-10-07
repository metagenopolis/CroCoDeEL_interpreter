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
     - the curated events TSV of the Export tab reloads with its verdicts
       and notes, a note starting with a quote included;
     - the metadata download reloads to the same relatedness;
     - metadata kept by a session of an earlier version (substring
       mapping) is read again with the current rules, on session import
       and on a reload from IndexedDB;
     - the plate card keeps its column mapping and warnings through a
       Plate tab edit and a page reload;
     - a hand-edited session whose card warnings are not a list loads;
     - a comma-separated events file is refused with a short message, and
       the session it would have replaced stays;
     - the cards name a repeated sample id and an unreadable well, and
       keep their lines across a page reload;
     - header-only, repeated-column and negative abundance tables, and the
       fields the session keeps to rebuild the original values.

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

/** AGED_METADATA as an earlier version stored it in a session: its
    substring pass read age_group as the group_id ("group"). */
function legacyAgedMetadata() {
  const md = parseMetadata(AGED_METADATA);
  const bySample = {};
  for (const [id, m] of Object.entries(md.bySample)) {
    bySample[id] = { ...m, groupId: m.extra.age_group };
  }
  const { warnings: _none, ...rest } = md;
  return { ...rest, cols: { ...md.cols, groupId: "age_group" }, bySample, hasGroupIdCol: true };
}

/** Put `metadata` into the session IndexedDB holds (its own record, see
    src/persistence.js), as an earlier version would have saved it. */
async function storeMetadata(page, metadata) {
  await page.evaluate(async (md) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("crocodeel-interpreter", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(md, "metadata");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, metadata);
}

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

  /* ------- 6. the curated events export reloads with its curation */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadDemo(page);
    await openTab(page, "Events");
    const mark = (title) => page.locator(`button[title="mark as ${title}"]`);
    for (const [title, i] of [
      ["true positive", 0],
      ["true positive", 1],
      ["true positive", 2],
      ["false positive", 3],
      ["false positive", 4],
      ["uncertain", 5],
    ]) {
      await mark(title).nth(i).click();
      await page.waitForTimeout(300);
    }
    // A note with quotes at both ends, a tab and a line break, as typed in
    // the Validate panel for the first event.
    await openTab(page, "Validate");
    await page
      .locator('textarea[placeholder^="Notes: related samples"]')
      .fill('"Quoted" first line\twith tab\nsecond line "end"');
    await page.waitForTimeout(1500);
    const marked = await overviewStats(page);
    const downloadEvents = async () => {
      await openTab(page, "Export");
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
        page.getByRole("button", { name: /Download events TSV/i }).first().click(),
      ]);
      return download ? readFileSync(await download.path(), "utf8") : null;
    };
    const text = await downloadEvents();
    check(
      !!text && marked.tp === 3 && marked.fp === 2,
      "the evaluated events are exported",
      `TP ${marked.tp}, FP ${marked.fp}`,
    );
    if (text) {
      await upload(page, 0, "contamination_events_curated.tsv", text);
      // The session holds curation: replacing its events asks first.
      // "Start fresh" keeps nothing of it, so what comes back is the
      // file's.
      await page
        .getByRole("dialog", { name: "Replace the events file?" })
        .getByRole("button", { name: "Start fresh" })
        .click();
      await page.waitForTimeout(500);
      const s = await overviewStats(page);
      check(s.tp === 3 && s.fp === 2, "reloading the curated TSV restores the verdicts", `TP ${s.tp}, FP ${s.fp}`);
      // Export again: every verdict and every note comes back as written.
      const again = await downloadEvents();
      const curation = (t) =>
        (t || "")
          .split("\n")
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => l.split("\t"))
          .map((c) => [c[0], c[1], c[6], c[8]].join(" | "))
          .sort();
      const first = curation(text);
      const second = curation(again);
      check(
        first.length === 25 && JSON.stringify(second) === JSON.stringify(first),
        "a second export after the reload gives the same verdicts and notes",
        second.find((l, i) => l !== first[i]) || "",
      );
      check(
        first.some((l) => l.endsWith('| """Quoted"" first line with tab second line ""end"""')),
        "a note starting with a quote is written quoted, so it reloads as typed",
        first.find((l) => l.includes("Quoted")) || "no such note",
      );
    }
    check(errors.length === 0, "no JS error across the reload", errors[0] || "");
    await ctx.close();
  }

  /* -- 7. metadata of an earlier version's session is read again */
  {
    const { ctx, page, errors } = await newPage(browser);
    await importSession(page, sessionJSON({ metadata: legacyAgedMetadata() }));
    const text = await cardText(page, "metadata.tsv");
    check(
      text.includes("Columns: sample_id · subject_id ← patient · timepoint ← visit · biome · other: age_group") &&
        text.includes("group_id is no longer read from age_group"),
      "an imported session's metadata is read with the current rules, and the card says what changed",
      text.replace(/\s+/g, " ").slice(0, 300),
    );
    const pills = await relatednessPills(page);
    check(
      pills.sameGroup === 0 && pills.related === sameSubjectEvents,
      "the age bands of an imported session no longer make two subjects 'same group'",
      `same group ${pills.sameGroup} (the stored mapping made ${sameBandOtherSubject}), related ${pills.related}`,
    );
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
      card(page, "metadata.tsv").locator('button[title="Download this file"]').click(),
    ]);
    const header = download ? readFileSync(await download.path(), "utf8").split("\n")[0] : null;
    check(
      header === "sample_id\tsubject_id\ttimepoint\tbiome\tage_group",
      "its download keeps age_group under its own name, not as group_id",
      JSON.stringify(header),
    );

    // The same stored metadata, restored from IndexedDB by a page reload.
    await page.waitForTimeout(2500); // let the auto-save settle first
    await storeMetadata(page, legacyAgedMetadata());
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(3000);
    const restored = await relatednessPills(page);
    const restoredCard = await cardText(page, "metadata.tsv");
    check(
      restored.sameGroup === 0 &&
        restored.related === sameSubjectEvents &&
        restoredCard.includes("group_id is no longer read from age_group"),
      "metadata restored from IndexedDB is read again too",
      `same group ${restored.sameGroup}, related ${restored.related}`,
    );
    check(errors.length === 0, "no JS error across the earlier-version session", errors[0] || "");
    await ctx.close();
  }

  /* -- 8. the plate card through a Plate tab edit and a page reload */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadDemo(page);
    const plate = [
      "sample_id\tplate\twell",
      "40D89\tP3\tA01",
      "58M\tP3\tC03",
      "58M\tP3\tC04",
      "NC3\tP3\tH06",
      "83D239\tP3\tZ99",
    ].join("\n");
    await upload(page, 3, "plate_map.tsv", plate);
    const unreadable = '1 row with no readable well was skipped (first on line 6: "Z99")';
    check(
      (await cardText(page, "plate_map.tsv")).includes(unreadable),
      "the plate card names the row whose well cannot be read",
    );
    // The metadata repeats a sample too.
    const md = demo("metadata.tsv").split("\n").filter((l) => l);
    await upload(page, 2, "metadata.tsv", [...md, md.find((l) => l.startsWith("58M\t"))].join("\n"));
    const repeated = 'sample id appears on more than one row ("58M")';
    check(
      (await cardText(page, "metadata.tsv")).includes(repeated),
      "the metadata card names the repeated sample id",
    );
    const before = await cardText(page, "plate_map.tsv");
    check(
      before.includes("Columns: sample_id · plate · well") && before.includes(repeated),
      "the plate card shows the mapping and the repeated id",
      before.replace(/\s+/g, " ").slice(0, 200),
    );
    await openTab(page, "Plate");
    const removes = page.locator('button[title="remove"]');
    if ((await removes.count()) === 0) {
      await page.getByRole("button", { name: /edit/i }).first().click();
      await page.waitForTimeout(800);
    }
    await removes.first().click();
    await page.waitForTimeout(1000);
    const after = await cardText(page, "plate_map.tsv");
    check(
      after.includes("2 wells (8×12)") &&
        after.includes("Columns: sample_id · plate · well") &&
        after.includes(repeated),
      "after a Plate tab edit the card still shows the mapping and the warning",
      after.replace(/\s+/g, " ").slice(0, 200),
    );
    await page.waitForTimeout(2500); // auto-save
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(3000);
    const reloaded = await cardText(page, "plate_map.tsv");
    check(
      reloaded.includes("2 wells (8×12)") &&
        reloaded.includes("Columns: sample_id · plate · well") &&
        reloaded.includes(repeated) &&
        reloaded.includes(unreadable),
      "the plate card's mapping and warnings survive a page reload",
      reloaded.replace(/\s+/g, " ").slice(0, 200),
    );
    const mdReloaded = await cardText(page, "metadata.tsv");
    check(
      mdReloaded.includes("Columns: sample_id · subject_id") && mdReloaded.includes(repeated),
      "so do the metadata card's",
      mdReloaded.replace(/\s+/g, " ").slice(0, 200),
    );
    check(errors.length === 0, "no JS error across the plate edit", errors[0] || "");
    await ctx.close();
  }

  /* -- 9. a hand-edited session whose card warnings are not a list */
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

  /* -- 10. a comma-separated events file: refused, saying why, briefly */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadDemo(page);
    await openTab(page, "Events");
    await page.locator('button[title="mark as true positive"]').first().click();
    await page.waitForTimeout(500);
    const csv = demo("contamination_events.tsv")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("\t").map((c) => (c.includes(",") ? `"${c}"` : c)).join(","))
      .join("\n");
    await upload(page, 0, "contamination_events.csv", csv);
    const alert = (await page.locator('[role="alert"]').allInnerTexts()).join(" ");
    check(
      alert.includes("The file is not tab-separated") && alert.length < 400,
      "a comma-separated events file is refused with a short message naming the separator",
      `${alert.length} characters: ${alert.slice(0, 160)}`,
    );
    const kept = await overviewStats(page);
    check(kept.tp === 1, "the refused file leaves the session as it was", `TP ${kept.tp}`);
    check(errors.length === 0, "no JS error on the CSV", errors[0] || "");
    await ctx.close();
  }

  /* -- 11. abundance tables in the browser, and what the session keeps */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadDemo(page);
    const lines = demo("species_abundance.tsv").split("\n").filter((l) => l);
    const alertText = async () => (await page.locator('[role="alert"]').allInnerTexts()).join(" ");

    await upload(page, 1, "species_abundance.tsv", lines[0]);
    check(
      /Abundance file: The abundance table has no species rows: only its header line \(91 sample columns\) was found/.test(
        await alertText(),
      ),
      "a header-only abundance table is refused",
      (await alertText()).slice(0, 160),
    );

    const head = lines[0].split("\t");
    const dupHeader = [...head.slice(0, -1), head[1]].join("\t");
    await upload(page, 1, "species_abundance.tsv", [dupHeader, ...lines.slice(1)].join("\n"));
    check(
      /1 sample column appears more than once in the abundance table \("40D89"\)/.test(await alertText()),
      "an abundance table repeating a sample column is refused, naming it",
      (await alertText()).slice(0, 160),
    );

    // One non-zero cell made negative.
    const cells = lines[1].split("\t");
    const k = cells.findIndex((c, j) => j > 0 && Number(c) > 0);
    cells[k] = `-${cells[k]}`;
    const negative = [lines[0], cells.join("\t"), ...lines.slice(2)].join("\n");
    await upload(page, 1, "species_abundance.tsv", negative);
    const banner = await page.locator("body").innerText();
    check(
      /Check the input files/.test(banner) && /1 cell holds a negative value and was read as 0/.test(banner),
      "a negative abundance is reported in the banner",
      (banner.match(/\d+ cells? holds? a negative[^\n]*/) || [""])[0].slice(0, 160),
    );

    // Counts: what an export needs to give them back is kept in the
    // session, across a page reload.
    const counts = lines
      .map((l, i) =>
        i === 0
          ? l
          : l
              .split("\t")
              .map((c, j) => (j === 0 ? c : String(Math.round(Number(c) * 1e7))))
              .join("\t"),
      )
      .join("\n");
    await upload(page, 1, "species_abundance.tsv", counts);
    const firstSum = counts
      .split("\n")
      .slice(1)
      .reduce((t, l) => t + Number(l.split("\t")[1]), 0);
    const storedAb = () =>
      page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open("crocodeel-interpreter", 1);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const ab = await new Promise((resolve, reject) => {
          const req = db.transaction("kv", "readonly").objectStore("kv").get("ab");
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        db.close();
        return ab
          ? {
              firstHeader: ab.firstHeader,
              sum: ab.colSums?.["40D89"],
              integer: Object.values(ab.integerCols || {}).every((v) => v === true),
            }
          : null;
      });
    await page.waitForTimeout(2500); // auto-save
    const saved = await storedAb();
    check(
      saved?.firstHeader === "id_mgs" && saved.sum === firstSum && saved.integer,
      "the session keeps the first header, the column sums and the integer flags",
      JSON.stringify(saved),
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(3500); // restore, then the first auto-save
    const again = await storedAb();
    check(
      JSON.stringify(again) === JSON.stringify(saved),
      "they are still there once the session is restored and saved again",
      JSON.stringify(again),
    );
    check(errors.length === 0, "no JS error across the abundance checks", errors[0] || "");
    await ctx.close();
  }
} finally {
  await browser.close();
  stopServer();
}

finish();
