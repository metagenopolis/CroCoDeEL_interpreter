/* Browser checks for the diagnostics fixes (work package a2-diagnostics).

   Each scenario loads small crafted files through the upload cards, so the
   expected outcome is known exactly:

     1. an event whose target is missing from the abundance table is "not
        evaluable" in Guided validation — never PROBABLY NOT CONTAMINATED.

   Runs on its own (`node e2e/a2-diagnostics.e2e.mjs`, which starts a
   preview server unless BASE_URL is set) or through e2e/run-all.mjs. */

import {
  startServer,
  stopServer,
  launchBrowser,
  newPage,
  openTab,
  tsvInput,
  check,
  finish,
} from "./harness.mjs";

const tsvFile = (name, lines) => ({
  name,
  mimeType: "text/tab-separated-values",
  buffer: Buffer.from(lines.join("\n") + "\n"),
});

/** 30 species; SRC spans four decades, TGT holds 10 % of SRC on sp_0..sp_19
    plus natives of its own, OTHER is unrelated. */
function abundanceLines() {
  const lines = ["species\tSRC\tTGT\tOTHER"];
  for (let i = 0; i < 30; i++) {
    const src = 10 ** (-4 * (i / 29));
    const tgt = i < 20 ? 0.1 * src : i % 2 ? 0.5 : 0;
    lines.push(`sp_${i}\t${src.toPrecision(6)}\t${tgt.toPrecision(6)}\t${(i % 3) + 1}`);
  }
  return lines;
}
const ON_LINE = Array.from({ length: 20 }, (_, i) => `sp_${i}`).join(",");

/** Load an events file and an abundance file through the upload cards. */
async function loadFiles(page, events, abundance) {
  await tsvInput(page, 0).setInputFiles(events);
  await page
    .getByRole("button", { name: /^Validate$/ })
    .first()
    .waitFor({ state: "visible", timeout: 60000 });
  await tsvInput(page, 1).setInputFiles(abundance);
  await page.waitForTimeout(2000);
}

await startServer();
const browser = await launchBrowser();
try {
  /* ------------- 1. target missing from the abundance table → not evaluable
     After a CroCoDeEL -s2 run (sources and targets in two tables) with only
     one table loaded, every event has a sample missing from the table. Its
     empty scatter used to score "0 species on the line" — a fail — and the
     panel announced PROBABLY NOT CONTAMINATED. */
  {
    const { ctx, page, errors } = await newPage(browser);
    await loadFiles(
      page,
      tsvFile("contamination_events.tsv", [
        "source\ttarget\trate\tprobability\tcontamination_specific_species",
        // Highest probability first, so Guided validation opens on it.
        `SRC\tNOT_IN_TABLE\t0.1\t0.99\t${ON_LINE}`,
        `SRC\tTGT\t0.1\t0.60\t${ON_LINE}`,
      ]),
      tsvFile("species_abundance.tsv", abundanceLines()),
    );
    await openTab(page, "Validate");
    const text = await page.locator("body").innerText();
    check(
      /not evaluable/i.test(text),
      "a pair missing from the abundance table is shown as not evaluable",
    );
    check(
      !/PROBABLY NOT CONTAMINATED/i.test(text),
      "…and is not graded PROBABLY NOT CONTAMINATED",
    );
    check(
      /Target sample "NOT_IN_TABLE" not found/i.test(text),
      "the panel says which sample is missing",
    );

    // The resolvable event of the same files is still graded normally.
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(800);
    const next = await page.locator("body").innerText();
    check(
      /CONTAMINATED — CroCoDeEL is probably right|POSSIBLY NOT CONTAMINATED|PROBABLY NOT CONTAMINATED/i.test(next) &&
        !/NOT EVALUABLE/.test(next),
      "the next, resolvable event gets a grade",
    );
    check(errors.length === 0, "no JS error on a missing-sample event", errors[0] || "");
    await ctx.close();
  }
} finally {
  await browser.close();
  stopServer();
}
finish();
