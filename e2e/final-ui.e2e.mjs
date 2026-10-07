/* Browser checks for the last round of UI fixes, on the whole branch.

     - F.1  the Help and the in-app texts say what the app does: the
            missing-species p-value is the exact Poisson-binomial tail;
            the curated events TSV is read in pandas and R by skipping its
            "#" lines, and filtered on its verdict / action columns; the
            Events table's Target verdict / action chips are editable.

   Usage:  npm run build && node e2e/final-ui.e2e.mjs
           (or through e2e/run-all.mjs; BASE_URL skips the server,
           E2E_ONLY=<regex> runs only the matching scenarios) */

import {
  startServer,
  stopServer,
  launchBrowser,
  newPage,
  loadDemo,
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

  /* F.1 — the Events table's Target verdict and Target action cells are
     chips that set the target's values; the Help called them read-only
     badges, and their headers said "Set from the Samples tab". */
  await scenario("F.1 editable target columns", async (page) => {
    await loadDemo(page);
    await openTab(page, "Help");
    const tabs = await helpSection(page, "Tabs walkthrough");
    const events = tabs.match(/Events table Filterable list(.*?)Scatterplots/)?.[1] || "";
    check(
      /Target verdict \(sample-level verdict of the event's target, editable inline/.test(events) && !/read-only/.test(events),
      "F.1 Help, Events table: Target verdict and Target action are editable inline",
      events.match(/Target verdict[^.]*\./)?.[0] || "(no Events table text)",
    );
    await openTab(page, "Events");
    const titles = await page.locator("thead th").evaluateAll((ths) =>
      ths.filter((th) => /^Target (verdict|action)/i.test(th.textContent.trim())).map((th) => th.title),
    );
    check(
      titles.length === 2 && titles.every((t) => /Its chips set it/.test(t) && !/Set from the Samples tab/.test(t)),
      "F.1 Events table: the Target verdict / action headers say their chips set the value",
      titles.join(" | "),
    );
  });

  /* F.1 — the events TSV's column is "verdict": the Export card and the
     guided tour told to filter on an "evaluation" column. */
  await scenario("F.1 verdict column", async (page) => {
    await openTab(page, "Help");
    await page.getByRole("button", { name: /Restart guided tour/ }).first().click();
    await page.waitForTimeout(1500);
    const panel = page.locator("aside", { hasText: "Guided tour" });
    let step = "";
    for (let i = 0; i < 40 && !/^Export your curated report/.test(step); i++) {
      await panel.getByRole("button", { name: /^Next/ }).click();
      await page.waitForTimeout(700);
      step = (await panel.innerText())
        .replace(/\s+/g, " ")
        .replace(/^.*?(Export your curated report)/, "$1");
    }
    check(
      /Export your curated report/.test(step) && /then introduced_pct, verdict, action, notes/.test(step) &&
        /on the verdict \/ action columns/.test(step) && !/evaluation \/ action/.test(step),
      "F.1 guided tour: the events TSV's columns are introduced_pct, verdict, action, notes",
      step.slice(0, 200),
    );
    await page.getByRole("button", { name: "Skip tour" }).click();
    await openTab(page, "Export");
    const card = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const desc = card.match(/Events TSV — \d+ events? (.*?)Download events TSV/)?.[1] || "";
    check(
      /on the verdict \/ action columns/.test(desc) && !/evaluation \/ action/.test(desc),
      "F.1 Export card: filter on the verdict / action columns",
      desc.slice(0, 200),
    );
  });
} finally {
  await browser.close();
  stopServer();
}

finish();
