/* Browser checks for the last round of UI fixes, on the whole branch.

     - F.1  the Help and the in-app texts say what the app does: the
            missing-species p-value is the exact Poisson-binomial tail;
            the curated events TSV is read in pandas and R by skipping its
            "#" lines, and filtered on its verdict / action columns; the
            Events table's Target verdict / action chips are editable; a
            reloaded export gives back the same counts, with the exceptions
            named;
     - F.2  the Reset question counts the curation as the other questions
            that would lose it do: automatic sample values are not
            decisions;
     - F.3  without storage the header says nothing is auto-saved;
     - F.4  in the dark theme, the Not saved banner, the load errors and
            the buttons of a tab that crashed are readable.

   Usage:  npm run build && node e2e/final-ui.e2e.mjs
           (or through e2e/run-all.mjs; BASE_URL skips the server,
           E2E_ONLY=<regex> runs only the matching scenarios) */

import {
  BASE,
  startServer,
  stopServer,
  launchBrowser,
  newPage,
  trackErrors,
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

/** The WCAG contrast ratio of the text of `locator` on the background it
    is drawn on (the first box, from itself up, with an opaque one). */
const contrast = (locator) =>
  locator.evaluate((el) => {
    const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    let bg = null;
    for (let p = el; p && !bg; p = p.parentElement) {
      const c = rgb(getComputedStyle(p).backgroundColor);
      if (c.length === 3 || (c.length === 4 && c[3] === 1)) bg = c.slice(0, 3);
    }
    const fg = rgb(getComputedStyle(el).color).slice(0, 3);
    const [hi, lo] = [lum(fg), lum(bg || [255, 255, 255])].sort((x, y) => y - x);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  });

/** Change the stored record `key` in IndexedDB with `edit`, the body of a
    function of the record `r` that returns the new one. */
const editRecord = (page, key, edit) =>
  page.evaluate(
    ([key, edit]) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("crocodeel-interpreter");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("kv", "readwrite");
          const store = tx.objectStore("kv");
          const get = store.get(key);
          get.onsuccess = () => store.put(new Function("r", edit)(get.result), key);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => reject(tx.error);
        };
      }),
    [key, edit],
  );

await startServer();
const browser = await launchBrowser();

/* One fresh page per scenario. A scenario that throws is reported as a
   failed check and the others still run. */
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
async function scenario(name, run, { contextOptions, expectedErrors = null } = {}) {
  if (ONLY && !ONLY.test(name)) return;
  const { ctx, page, errors } = await newPage(browser, contextOptions);
  try {
    await run(page, ctx);
  } catch (e) {
    check(false, `${name} runs to the end`, String(e).split("\n")[0]);
  }
  // A scenario that breaks a tab on purpose names the errors it expects.
  const unexpected = errors.filter((e) => !expectedErrors || !expectedErrors.test(e));
  check(unexpected.length === 0, `${name} no JS error`, unexpected[0] || "");
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
    // Reloaded into an empty session, the export gives back the same
    // counts only when no sample verdict was set by hand and no sample
    // no event targets has an action of its own (Suppress by hand on 58M,
    // Contaminated by hand on 40D89: to suppress 3 before, 1 after).
    const eventsFile = await helpSection(page, "contamination_events.tsv");
    const reload = eventsFile.match(/Reloading the curated events TSV(.*?)only the session JSON/)?.[1] || "";
    check(
      /gives back the same counts and the same curated abundance table — unless you set a sample's verdict by hand or gave a sample no event targets an action of its own/.test(reload),
      "F.1 Help, contamination_events.tsv: a reloaded export gives back the same counts unless…",
      reload.slice(0, 240),
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

  /* F.2 — the Reset question counts what the other questions that would
     lose the curation count: one TP read "1 event evaluation and 0
     notes, plus 1 sample-level verdict / action" (the target's automatic
     Contaminated + Suppress) where replacing the session said "1
     evaluation". */
  await scenario("F.2 reset question", async (page) => {
    await loadDemo(page);
    await openTab(page, "Events");
    await page.locator('button[title="mark as true positive"]').first().click();
    await page.waitForTimeout(400);
    await openTab(page, "Validate");
    await page.getByRole("button", { name: /Reset all evaluations/ }).first().click();
    const reset = page.getByRole("dialog", { name: "Reset all curation work?" });
    const resetText = ((await reset.count()) ? await reset.innerText() : "").replace(/\s+/g, " ");
    await reset.getByRole("button", { name: "Cancel" }).click();
    // The guided tour replaces the session with the demo's, and asks.
    await openTab(page, "Help");
    await page.getByRole("button", { name: /Restart guided tour/ }).first().click();
    const replace = page.getByRole("dialog", { name: "Replace your session with the demo dataset?" });
    const replaceText = ((await replace.count()) ? await replace.innerText() : "").replace(/\s+/g, " ");
    await replace.getByRole("button", { name: "Cancel" }).click();
    check(
      /Your session holds 1 evaluation\./.test(resetText) && !/sample-level verdict/.test(resetText) &&
        /1 evaluation\b/.test(replaceText) && !/sample decision/.test(replaceText),
      "F.2 Reset counts one TP as 1 evaluation, as replacing the session does",
      `reset: "${resetText.slice(0, 160)}" | replace: "${replaceText.slice(0, 160)}"`,
    );
    // A verdict set by hand is a decision, and still counted.
    await openTab(page, "Samples");
    await page
      .locator("tr")
      .filter({ has: page.locator('button[aria-label="Set verdict to Pending"]') })
      .filter({ has: page.getByText("63D40", { exact: true }) })
      .locator('button[aria-label="Set verdict to Uncertain"]')
      .click();
    await page.waitForTimeout(300);
    await openTab(page, "Validate");
    await page.getByRole("button", { name: /Reset all evaluations/ }).first().click();
    const again = ((await reset.count()) ? await reset.innerText() : "").replace(/\s+/g, " ");
    await reset.getByRole("button", { name: "Cancel" }).click();
    check(
      /Your session holds 1 evaluation and 1 sample decision\./.test(again),
      "F.2 …and a verdict set by hand as a sample decision",
      again.slice(0, 120),
    );
  });

  /* F.3 — without storage the header no longer promises an auto-save:
     its green chip said "Your work is auto-saved locally so you can close
     the tab and come back anytime" right above the red "Not saved — …
     lost when you close or reload it" banner. */
  await scenario("F.3 auto-save note", async (page) => {
    const note = page.locator("[data-autosave-note]");
    check(
      /auto-saved locally so you can close the tab/.test(await note.innerText()),
      "F.3 with storage, the header says the work is auto-saved",
      await note.innerText(),
    );
  });
  await scenario(
    "F.3 auto-save note without storage",
    async (_page, ctx) => {
      const page = await ctx.newPage();
      const errors = trackErrors(page);
      await page.addInitScript(() => localStorage.setItem("crocodeel-tutorial-seen", "1"));
      await page.addInitScript(() =>
        Object.defineProperty(window, "indexedDB", { get: () => undefined, configurable: true }),
      );
      await page.goto(BASE, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);
      const note = page.locator("[data-autosave-note]");
      const text = (await note.count()) ? await note.innerText() : "";
      check(
        (await page.locator('[data-save-banner="unavailable"]').count()) === 1 &&
          (await note.getAttribute("data-autosave-note")) === "unavailable" &&
          /nothing is auto-saved/.test(text) && !/close the tab and come back/.test(text),
        "F.3 without IndexedDB, the header says nothing is auto-saved, as the banner does",
        text,
      );
      check(errors.filter((e) => !/IndexedDB/.test(e)).length === 0, "F.3 without IndexedDB, no JS error", errors[0] || "");
    },
  );

  /* F.4 — the warnings that the work is not saved, and the way out of a
     tab that crashed, readable in the dark theme: the red banner's text
     was #8a2422 on #321614 (1.9:1), the crash screen's Go to Export and
     Download session #275662 on the card (2.0:1). WCAG asks 4.5:1. */
  await scenario(
    "F.4 dark theme alerts",
    async (_page, ctx) => {
      const page = await ctx.newPage();
      const errors = trackErrors(page);
      await page.addInitScript(() => {
        localStorage.setItem("crocodeel-tutorial-seen", "1");
        localStorage.setItem("crocodeel-theme", "dark");
        Object.defineProperty(window, "indexedDB", { get: () => undefined, configurable: true });
      });
      await page.goto(BASE, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);
      const banner = page.locator('[data-save-banner="unavailable"]');
      const ratios = [
        await contrast(banner.locator("strong").first()),
        await contrast(banner.getByText(/IndexedDB is missing/)),
      ];
      // A load error shows in the same colours (the metadata card refuses
      // a file without a sample column).
      await page.getByRole("button", { name: /load demo/i }).first().click();
      await page.getByRole("button", { name: /^Validate$/ }).first().waitFor({ timeout: 60000 });
      await page
        .locator('input[accept*=".tsv"]')
        .nth(2)
        .setInputFiles({ name: "metadata.tsv", mimeType: "text/tab-separated-values", buffer: Buffer.from("foo\tbar\nS1\tx\n") });
      await page.waitForTimeout(1000);
      const err = page.locator('[role="alert"]').filter({ hasText: "Metadata:" });
      ratios.push((await err.count()) ? await contrast(err.getByText(/Metadata:/)) : 0);
      check(
        ratios.every((r) => r >= 4.5),
        "F.4 dark theme: the Not saved banner and the load error are readable (≥ 4.5:1)",
        ratios.join(", "),
      );
      check(errors.filter((e) => !/IndexedDB/.test(e)).length === 0, "F.4 without IndexedDB, no JS error", errors[0] || "");
    },
  );
  await scenario("F.4 dark theme tab crash", async (page) => {
    await page.evaluate(() => localStorage.setItem("crocodeel-theme", "dark"));
    await loadDemo(page);
    await page.waitForTimeout(1200);
    // One stored well entry damaged: the Plate tab cannot render it.
    await editRecord(page, "plate", "r.bySample[Object.keys(r.bySample)[0]] = null; return r;");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await openTab(page, "Plate");
    const fallback = page.locator('[data-tab-error="Plate"]');
    const ratios = [];
    for (const name of ["Try again", "Go to Export", "Download session"]) {
      ratios.push(await contrast(fallback.getByRole("button", { name })));
    }
    check(
      ratios.every((r) => r >= 4.5),
      "F.4 dark theme: the crashed tab's Try again, Go to Export and Download session are readable (≥ 4.5:1)",
      ratios.join(", "),
    );
  }, { expectedErrors: /Cannot read properties of null|the Plate tab failed|The above error occurred/ });

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
