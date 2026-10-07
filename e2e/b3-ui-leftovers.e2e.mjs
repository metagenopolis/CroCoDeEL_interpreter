/* UI leftovers of the review, as a curator meets them in the browser.

     - B3.2  the criterion cards say why a value is missing when the table
             is loaded (too few species on the line or in the pair, no
             rate), and the scatter's error box describes the sample-name
             matching that is actually done (case and blanks ignored);
     - B3.3  a cascade is found when the events file spells the shared
             sample differently from the abundance table;
     - B3.4  a biom-style table, whose header line starts with "#", is
             refused with the line to fix, and loads once it is fixed;
     - B3.5  the Pending chip of a sample no event targets does not send
             the curator to its events, and the Help does not count the
             plate among the plate map's required columns.

   Usage:  npm run build && node e2e/b3-ui-leftovers.e2e.mjs
           (or through e2e/run-all.mjs; BASE_URL skips the server,
           E2E_ONLY=<regex> runs only the matching scenarios) */

import { readFileSync } from "node:fs";
import {
  startServer,
  stopServer,
  launchBrowser,
  newPage,
  loadDemo,
  openTab,
  tsvInput,
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
  await page.waitForTimeout(1500);
}

const EVENTS_HEADER = "source\ttarget\trate\tprobability\tcontamination_specific_species";
const tsv = (rows) => rows.map((r) => (Array.isArray(r) ? r.join("\t") : r)).join("\n");

/** The criterion cards of Guided validation, "01 …" to "06 …". */
async function criterionCards(page) {
  const texts = await page.locator("button[aria-expanded]").allInnerTexts();
  return texts
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => /^0[1-6] /.test(t));
}

/** Open the event of the Events table row `id` in Guided validation. */
async function openEvent(page, id) {
  await openTab(page, "Events");
  await page.locator(`tr[data-event-row="${id}"]`).click();
  await page.waitForTimeout(1000);
}

/** The Samples-tab row of sample `id`. */
function sampleRow(page, id) {
  return page
    .locator("tr")
    .filter({ has: page.locator('button[aria-label="Set verdict to Pending"]') })
    .filter({ has: page.getByText(id, { exact: true }) });
}

await startServer();
const browser = await launchBrowser();

/* One fresh page per scenario. A scenario that throws is reported as a
   failed check and the others still run. */
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
async function scenario(name, run, { demo: withDemo = false } = {}) {
  if (ONLY && !ONLY.test(name)) return;
  const { ctx, page, errors } = await newPage(browser);
  try {
    if (withDemo) await loadDemo(page);
    await run(page);
  } catch (e) {
    check(false, `${name} runs to the end`, String(e).split("\n")[0]);
  }
  check(errors.length === 0, `${name} no JS error`, errors[0] || "");
  await ctx.close();
}

try {
  /* B3.2 — S1 → S2 has one species on its line and two in the pair: no R²,
     no spread, no ρ. S3 → S2 has no rate, hence no line to put points
     above. S9 → S2 names a sample the table does not have. The table is
     loaded in all three cases: none of the cards may say it is required. */
  await scenario("B3.2 criterion cards and scatter error", async (page) => {
    await upload(
      page,
      0,
      "events.tsv",
      tsv([
        EVENTS_HEADER,
        ["S1", "S2", "0.1", "0.9", "sp1"],
        ["S3", "S2", "NA", "0.8", "sp1,sp2"],
        ["S9", "S2", "0.1", "0.7", "sp1"],
      ]),
    );
    await upload(
      page,
      1,
      "species_abundance.tsv",
      tsv([
        ["species", "S1", "S2", "S3"],
        ["sp1", "50", "5", "30"],
        ["sp2", "50", "95", "70"],
        ["sp3", "0", "0", "10"],
        ["sp4", "0", "0", "20"],
      ]),
    );

    await openEvent(page, 0);
    let cards = await criterionCards(page);
    const card = (n) => cards.find((c) => c.startsWith(n)) || "";
    check(
      card("01") === "01 Only 1 species on the line — at least 2 needed" &&
        card("03") === "03 Only 1 species on the line — at least 2 needed",
      "B3.2 cards 01 and 03 say the line has too few species",
      `${card("01")} | ${card("03")}`,
    );
    check(
      card("06") === "06 Only 2 species in source and target — ρ needs at least 3",
      "B3.2 card 06 says the pair has too few species for ρ",
      card("06"),
    );
    check(
      cards.length === 6 && !cards.some((c) => /abundance table required/.test(c)),
      "B3.2 no card says the loaded table is required",
      cards.join(" | "),
    );

    await openEvent(page, 1);
    cards = await criterionCards(page);
    check(
      card("05") === "05 No contamination line — the event's rate is 0",
      "B3.2 card 05 says the event has no rate",
      card("05"),
    );

    await openEvent(page, 2);
    const body = await page.locator("body").innerText();
    check(
      body.includes('Source sample "S9" not found in abundance table') &&
        body.includes(
          "Check that the sample IDs in contamination_events.tsv match the column names in species_abundance.tsv. Letter case and spaces around an ID are ignored; any other difference is not.",
        ) &&
        !/case-sensitive/.test(body),
      "B3.2 the scatter error box describes the matching actually done",
      body.match(/Check that[^\n]*/)?.[0] || "(no hint)",
    );
    cards = await criterionCards(page);
    check(
      cards.length === 6 &&
        cards.every((c) => c.endsWith("not evaluable — sample missing from the abundance table")),
      "B3.2 a sample missing from the table still reads not evaluable",
      cards[0] || "(no card)",
    );
  });

  /* B3.3 — C → "a " brought six marker species into A, which passed them
     on to B: A → B has them above its line, and C → "a " explains them,
     though the events file writes A as "a ". */
  await scenario("B3.3 cascade through a sample spelled differently", async (page) => {
    const rows = [["species", "C", "A", "B"]];
    for (let i = 0; i < 20; i++) {
      const a = 10 ** (-3 * (i / 19));
      rows.push([`s_${i}`, 0, a, 0.05 * a]);
    }
    for (let i = 0; i < 6; i++) {
      const c = 10 ** (-1 - i / 3);
      rows.push([`m_${i}`, c, 0.2 * c, 0.0005 * 0.2 * c]);
    }
    const line = rows.slice(1, 21).map((r) => r[0]).join(",");
    const markers = rows.slice(21).map((r) => r[0]).join(",");
    await upload(
      page,
      0,
      "events.tsv",
      tsv([EVENTS_HEADER, ["C", "a ", "0.2", "0.6", markers], ["A", "B", "0.05", "0.9", line]]),
    );
    await upload(page, 1, "species_abundance.tsv", tsv(rows));
    await openEvent(page, 1);
    const body = await page.locator("body").innerText();
    check(
      /Cascade detected/i.test(body) && /upstream contamination from\s+C\b/.test(body),
      "B3.3 A → B shows the cascade through C → \"a \"",
      body.match(/[^\n]*upstream contamination[^\n]*/)?.[0] || "(no cascade banner)",
    );
    await openTab(page, "Scatter");
    const pills = await page.getByText(/^cascade$/).count();
    check(pills === 1, "B3.3 the gallery marks A → B as a cascade", `${pills} cascade pill(s)`);
  });

  /* B3.5 — 63D250 is a source only: its Not contaminated is the default
     for a sample no event targets, and its Pending chip has no events to
     send the curator to. 63D9, made Contaminated by a TP, still has. The
     Help no longer counts the plate among the required columns. */
  await scenario(
    "B3.5 texts",
    async (page) => {
      await openTab(page, "Samples");
      const pendingTitle = (id) =>
        sampleRow(page, id)
          .locator('button[aria-label="Set verdict to Pending"]')
          .getAttribute("title");
      let t = await pendingTitle("63D250");
      check(
        t ===
          "Pending changes nothing here: 63D250's verdict is automatic (Not contaminated: no event targets it). Pick a verdict to set your own",
        "B3.5 a never-targeted sample's Pending chip does not send the curator to its events",
        t,
      );
      await openEvent(page, 0); // 63D250 → 63D9
      await page.keyboard.press("t");
      await page.waitForTimeout(600);
      await openTab(page, "Samples");
      t = await pendingTitle("63D9");
      check(
        /^Pending changes nothing here: 63D9's verdict is automatic \(Contaminated: an event that targets it is TP\)\. Evaluate its events to change it, or pick a verdict to set your own$/.test(
          t,
        ),
        "B3.5 a targeted sample's automatic verdict still points to its events",
        t,
      );

      await openTab(page, "Help");
      const help = await page.locator("#h-plate").innerText();
      check(
        help.includes("Two columns are mandatory: sample id and well coordinate") &&
          help.includes("A plate name column is optional: without it every sample is placed on one plate, P1.") &&
          !/Three columns/.test(help),
        "B3.5 the Help says the plate column is optional",
        help.split("\n").find((l) => /columns/i.test(l)) || "",
      );
      const plateRow = page.locator("#h-plate tr").filter({ has: page.locator("code", { hasText: /^plate$/ }) });
      const tags = await plateRow.locator("td").first().innerText();
      check(
        !/mandatory/.test(tags) && /recognized/.test(tags),
        "B3.5 the Help's plate row is tagged recognized, not mandatory",
        tags.replace(/\s+/g, " "),
      );
    },
    { demo: true },
  );

  /* B3.4 — the demo table written as `biom convert --to-tsv` writes it:
     refused with the line to fix, then loaded once the "#" is removed. */
  await scenario("B3.4 biom-style table", async (page) => {
    const lines = demo("species_abundance.tsv").split("\n");
    const header = lines[0].split("\t");
    const biom = [
      "# Constructed from biom file",
      ["#OTU ID", ...header.slice(1)].join("\t"),
      ...lines.slice(1),
    ].join("\n");
    await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
    await upload(page, 1, "species_abundance.tsv", biom);
    let body = await page.locator("body").innerText();
    check(
      body.includes(
        `Abundance file: Line 2 looks like the header ("#OTU ID", "${header[1]}", "${header[2]}", …) but starts with "#", which marks a comment line, here as in CroCoDeEL`,
      ) && body.includes('Remove the "#" at the start of line 2 and load the file again.'),
      "B3.4 a biom-style table is refused with the line to fix",
      body.match(/Abundance file:[^\n]*/)?.[0] || "(no error)",
    );
    check(
      !/\d+ samples × \d+ species/.test(body),
      "B3.4 nothing is loaded from the refused table",
      body.match(/\d+ samples × \d+ species/)?.[0] || "",
    );
    await upload(page, 1, "species_abundance.tsv", biom.replace("\n#OTU ID", "\nOTU ID"));
    body = await page.locator("body").innerText();
    check(
      /91 samples × 927 species/.test(body) && !/Abundance file:/.test(body),
      "B3.4 the same table loads once the # is removed",
      body.match(/\d+ samples × \d+ species/)?.[0] || "(not loaded)",
    );
  });
} finally {
  await browser.close();
  stopServer();
}
finish();
