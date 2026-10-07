/* Browser checks for the last round of UI fixes, on the whole branch.

     - F.1  the Help and the in-app texts say what the app does: the
            missing-species p-value is the exact Poisson-binomial tail.

   Usage:  npm run build && node e2e/final-ui.e2e.mjs
           (or through e2e/run-all.mjs; BASE_URL skips the server,
           E2E_ONLY=<regex> runs only the matching scenarios) */

import {
  startServer,
  stopServer,
  launchBrowser,
  newPage,
  openTab,
  check,
  finish,
} from "./harness.mjs";

/** The text of the Help section whose title is `title`, spaces folded. */
const helpSection = (page, title) =>
  page.evaluate((title) => {
    const h = [...document.querySelectorAll("h2, h3")].find((e) => e.textContent.trim() === title);
    const section = h?.closest("section") || h?.parentElement?.parentElement;
    return (section?.innerText || "").replace(/\s+/g, " ");
  }, title);

await startServer();
const browser = await launchBrowser();

/* One fresh page per scenario. A scenario that throws is reported as a
   failed check and the others still run. */
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
async function scenario(name, run, { contextOptions } = {}) {
  if (ONLY && !ONLY.test(name)) return;
  const { ctx, page, errors } = await newPage(browser, contextOptions);
  try {
    await run(page, ctx);
  } catch (e) {
    check(false, `${name} runs to the end`, String(e).split("\n")[0]);
  }
  check(errors.length === 0, `${name} no JS error`, errors[0] || "");
  await ctx.close();
}

try {
  /* F.1 — texts. Criterion 04's p-value has been the exact
     Poisson-binomial tail since the second wave; the Help still called
     it a one-sided normal approximation. */
  await scenario("F.1 texts", async (page) => {
    await openTab(page, "Help");
    const criteria = await helpSection(page, "Validation criteria");
    const c04 = criteria.match(/04 Missing source species(.*?)05 Points above/)?.[1] || "";
    check(
      /P\(X ≥ observed misses\)/.test(c04) && !/normal approximation/.test(c04),
      "F.1 Help, criterion 04: the p-value is the exact Poisson-binomial tail",
      (c04.match(/Across the full source profile[^.]*\.[^.]*\./)?.[0] || "(no criterion 04 text)").slice(0, 240),
    );
    // The curated events TSV starts with "#" lines: pandas and R read it
    // with their defaults only once those are skipped, and comment="#"
    // cuts a note at its first "#".
    const tabs = await helpSection(page, "Tabs walkthrough");
    const eventsTsv = tabs.match(/Events TSV — every matched event(.*?)Samples TSV/)?.[1] || "";
    check(
      /skiprows=n/.test(eventsTsv) && /skip = n/.test(eventsTsv) && /rather than pass comment="#"/.test(eventsTsv),
      "F.1 Help, Events TSV: how to read it in pandas and R (skip the # lines, not comment=\"#\")",
      eventsTsv.match(/To read the file[^;]*/)?.[0] || "(no reading advice)",
    );
  });
} finally {
  await browser.close();
  stopServer();
}

finish();
