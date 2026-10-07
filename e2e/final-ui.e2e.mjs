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
            the buttons of a tab that crashed are readable;
     - F.5  a warning quoting a long word wraps inside its banner;
     - F.6  samples named constructor, toString or __proto__ do not break
            the Network or the Samples tab;
     - F.7  the Samples tab tags a never-targeted sample's values "default",
            as the exports do, and the tags add no width to its columns;
     - F.8  the Samples tab and the Events table cut an id only where they
            have no room left, wrapping it first: ids just over the old
            caps, the benchmarks' ids and names over 12 characters read
            whole;
     - F.9  a metadata file without a subject column loads, with a
            warning;
     - F.10 the low-abundance filter can be switched from Guided
            validation;
     - F.11 the web fonts are served with the app: no request leaves it.

   Usage:  npm run build && node e2e/final-ui.e2e.mjs
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
  tsvInput,
  check,
  finish,
} from "./harness.mjs";

const demo = (name) => readFileSync(`public/demo/${name}`, "utf8");

/** Upload `text` through the i-th file card (0 events, 1 abundance,
    2 metadata, 3 plate map). */
async function upload(page, i, name, text) {
  await tsvInput(page, i).setInputFiles({
    name,
    mimeType: "text/tab-separated-values",
    buffer: Buffer.from(text),
  });
  await page.waitForTimeout(1500);
}

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

/** The ids (and names) of the Samples tab or of the Events table (source
    and target of each row), the first `limit` rows: the text, whether it
    is cut (clipped on its line, or lines hidden under its last one), the
    text shown (the characters inside its box, … where they stop) and its
    lines. A table id is [data-table-id]; the name under it, its
    span.truncate. */
const tableIds = (page, tab, limit = Infinity) =>
  page.evaluate(
    ({ tab, limit }) => {
      const state = (el) => {
        if (!el) return null;
        const box = el.getBoundingClientRect();
        const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
        let shown = "";
        if (cut) {
          const range = document.createRange();
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            for (let i = 0; i < n.length; i++) {
              range.setStart(n, i);
              range.setEnd(n, i + 1);
              const r = range.getBoundingClientRect();
              if (r.bottom <= box.bottom + 0.5 && r.right <= box.right + 0.5) shown += n.data[i];
            }
          }
          shown += "…";
        }
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
        return { text: el.textContent, cut, shown: cut ? shown : el.textContent, lines: Math.round(box.height / lh) };
      };
      const rows =
        tab === "Samples"
          ? [...document.querySelectorAll('tr[id^="samplerow-"]')]
          : [...document.querySelectorAll("tr[data-event-row]")];
      return rows.slice(0, limit).flatMap((tr) => {
        const td = tr.querySelectorAll("td");
        const cells = tab === "Samples" ? [td[0]] : [td[0], td[2]];
        return cells.map((cell) => {
          // (Before the ids wrapped, the id was the cell's first
          // span.truncate and the name its second.)
          const wrapped = cell.querySelector("[data-table-id]");
          const lines = [...cell.querySelectorAll("span.truncate")];
          return {
            id: state(wrapped || lines[0]),
            name: state(wrapped ? lines[0] : lines[1]),
          };
        });
      });
    },
    { tab, limit },
  );

/** How far the page scrolls sideways (≤ 0: it does not). */
const pageScroll = (page) => page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);

/** Load a dataset bundled in the Datasets tab (its card's short title). */
async function loadDataset(page, title) {
  await openTab(page, "Datasets");
  await page.getByText(title, { exact: true }).first().waitFor({ timeout: 30000 });
  await page.evaluate((title) => {
    const el = [...document.querySelectorAll("div")].find(
      (e) => e.children.length === 0 && e.textContent.trim() === title,
    );
    let card = el;
    while (card && !card.querySelector("button")) card = card.parentElement;
    [...card.querySelectorAll("button")].find((b) => /Load this dataset/.test(b.textContent)).click();
  }, title);
  await page.waitForFunction(
    () => !document.querySelector('[role="status"]') && /Validated \(TP\)/i.test(document.body.innerText),
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(1500);
}

/** `text` (a demo TSV) with the sample ids of `columns` renamed. */
function renamed(text, columns, rename) {
  return text
    .split("\n")
    .map((line, i) => {
      if (!line || line.startsWith("#") || i === 0 || /^source\t/.test(line)) return line;
      const cells = line.split("\t");
      for (const c of columns) cells[c] = rename(cells[c]);
      return cells.join("\t");
    })
    .join("\n");
}
function renamedAbundance(rename) {
  const [header, ...rows] = demo("species_abundance.tsv").split("\n");
  const cells = header.split("\t");
  return [[cells[0], ...cells.slice(1).map(rename)].join("\t"), ...rows].join("\n");
}

/** Summary of a list of tableIds states: how many are cut, and whether
    two different texts read the same. */
const summary = (states) => {
  const list = states.filter(Boolean);
  const cut = list.filter((x) => x.cut);
  const texts = new Set(list.map((x) => x.text));
  const shown = new Set(list.map((x) => x.shown));
  return {
    n: list.length,
    cut: cut.length,
    apart: shown.size === texts.size,
    detail: `${cut.length} of ${list.length} cut ("${cut[0]?.text ?? ""}" → "${cut[0]?.shown ?? ""}"), ${shown.size} texts for ${texts.size}`,
  };
};

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

  /* F.5 — a warning that quotes a long word wraps inside its banner. The
     "match NOTHING" warning quotes the events' first introduced species:
     a GTDB taxon name has nothing to break a line on, and ran past the
     banner. */
  await scenario(
    "F.5 long words in the banners",
    async (page) => {
      const taxon =
        "d__Bacteria;p__Firmicutes_A;c__Clostridia;o__Oscillospirales;f__Ruminococcaceae;" +
        "g__Faecalibacterium;s__Faecalibacterium_prausnitzii_GCF_000162015.1_ASM16201v1_genomic_sequence_v2";
      const events = demo("contamination_events.tsv")
        .split("\n")
        .map((l) => {
          if (!l || l.startsWith("#") || l.startsWith("source\t")) return l;
          const cells = l.split("\t");
          cells[4] = taxon;
          return cells.join("\t");
        })
        .join("\n");
      await upload(page, 0, "contamination_events.tsv", events);
      await upload(page, 1, "species_abundance.tsv", demo("species_abundance.tsv"));
      const fit = await page.evaluate(() => {
        const li = [...document.querySelectorAll("li")].find((e) => /match NOTHING/.test(e.textContent));
        if (!li) return null;
        const box = li.closest("div.rounded-sm").getBoundingClientRect();
        const right = Math.max(...[...li.getClientRects()].map((r) => r.right));
        return { past: Math.round(right - box.right), quoted: li.textContent.includes("GCF_000162015") };
      });
      check(
        fit && fit.quoted && fit.past <= 0,
        "F.5 the data-warnings banner wraps a long taxon name inside its box",
        JSON.stringify(fit),
      );
    },
    { contextOptions: { viewport: { width: 1024, height: 900 } } },
  );

  /* F.6 — samples named after an Object property. The network keyed its
     maps by sample id in plain objects: "constructor" found the prototype's
     function, so the Network tab failed with "node not found:
     constructor"; "__proto__" broke the Samples tab too (its richness was
     Object.prototype, which React cannot render). */
  for (const ids of [
    ["S1", "S2", "S3", "S4", "X1", "constructor", "toString"],
    ["S1", "S2", "S3", "S4", "__proto__", "C1", "toString"],
  ]) {
    await scenario(
      `F.6 sample ids ${ids.slice(4).join(", ")}`,
      async (page) => {
        const odd = ids[4] === "X1" ? "constructor" : "__proto__";
        let seed = 11;
        const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        const ab = [["species", ...ids].join("\t")];
        for (let i = 0; i < 40; i++) {
          ab.push([`sp${i}`, ...ids.map(() => (rnd() < 0.3 ? 0 : Math.round(rnd() * 1000)))].join("\t"));
        }
        const events = [
          "source\ttarget\trate\tprobability\tcontamination_specific_species",
          `S1\t${ids[4]}\t0.1\t0.9\tsp1,sp2,sp3`,
          `S2\t${odd}\t0.1\t0.9\tsp4,sp5`,
          "toString\tS4\t0.1\t0.9\tsp6,sp7",
          `${odd}\tS3\t0.1\t0.9\tsp8`,
        ].join("\n");
        await upload(page, 0, "contamination_events.tsv", events);
        await upload(page, 1, "species_abundance.tsv", ab.join("\n"));
        await upload(page, 2, "metadata.tsv", ["sample_id\tsubject_id", ...ids.map((s, i) => `${s}\tsubj${i % 3}`)].join("\n"));
        await upload(page, 3, "plate_map.tsv", ["sample_id\twell", ...ids.map((s, i) => `${s}\tA${i + 1}`)].join("\n"));
        const failed = [];
        for (const tab of ["Overview", "Samples", "Events", "Scatter", "Validate", "Network", "Plate", "Export"]) {
          await openTab(page, tab);
          await page.waitForTimeout(tab === "Network" ? 1500 : 300);
          if (await page.locator("[data-tab-error]").count()) {
            failed.push(`${tab}: ${(await page.locator("[data-tab-error] pre").first().innerText()).slice(0, 80)}`);
          }
        }
        check(failed.length === 0, `F.6 ${odd}, toString: every tab renders`, failed.join(" | "));
        await openTab(page, "Network");
        await page.waitForTimeout(1500);
        const nodes = await page.evaluate(() => {
          const circles = [...document.querySelectorAll("svg circle")];
          return {
            nan: circles.filter((c) => /NaN/.test(`${c.getAttribute("cx")} ${c.getAttribute("cy")} ${c.getAttribute("r")}`)).length,
            labels: [...document.querySelectorAll("svg g > text")].map((t) => t.textContent),
          };
        });
        check(
          nodes.nan === 0 && [odd, "toString"].every((id) => nodes.labels.includes(id)),
          `F.6 ${odd}, toString: the network draws their nodes, labelled`,
          JSON.stringify(nodes),
        );
      },
      // The abundance parser keeps its rows in plain objects, so a column
      // named "__proto__" is read as non-numeric (the abundance card says
      // so) and its scatterplots get NaN coordinates: a parsing limit, not
      // a tab that fails.
      { expectedErrors: ids.includes("__proto__") ? /attribute c[xy]: Expected length, "NaN"/ : null },
    );
  }

  /* F.7 — one vocabulary for where a sample value comes from: the samples
     TSV and the samples HTML report write "default" for the Not
     contaminated + Keep of a sample no event targets, and the Samples tab
     tagged it "auto" (58D13). The tags sat beside the chips and widened
     the Verdict and Action columns from 133 / 69 to 165 / 109 px at
     1024 px; they now sit under them. */
  await scenario(
    "F.7 auto and default tags",
    async (page) => {
      await loadDemo(page);
      await openTab(page, "Events");
      await page.locator('tr[data-event-row="0"] button[title="mark as true positive"]').click(); // 63D250 → 63D9
      await page.waitForTimeout(400);
      await openTab(page, "Samples");
      const row = (id) =>
        page
          .locator("tr")
          .filter({ has: page.locator('button[aria-label="Set verdict to Pending"]') })
          .filter({ has: page.getByText(id, { exact: true }) });
      const tags = (id) =>
        row(id)
          .locator("[data-auto-mark]")
          .evaluateAll((els) => els.map((el) => `${el.getAttribute("data-auto-mark")}:${el.textContent}`));
      const never = await tags("58D13");
      const targeted = await tags("63D9");
      check(
        never.join(",") === "default:default,default:default" && targeted.join(",") === "automatic:auto,automatic:auto",
        "F.7 Samples tab: a never-targeted sample's Not contaminated + Keep are tagged default, a TP target's values auto",
        `58D13 ${never.join(",")} | 63D9 ${targeted.join(",")}`,
      );
      const widths = await page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll("thead th")]
            .filter((th) => /^(Verdict|Action)/i.test(th.textContent.trim()))
            .map((th) => [th.textContent.trim().split(/\s/)[0].toLowerCase(), Math.round(th.getBoundingClientRect().width)]),
        ),
      );
      check(
        widths.verdict <= 140 && widths.action <= 80,
        "F.7 the tags add no width to the Verdict and Action columns at 1024 px",
        JSON.stringify(widths),
      );
    },
    { contextOptions: { viewport: { width: 1024, height: 900 } } },
  );

  /* F.8 — an id is cut only where its table has no room left. The
     tables shared their width between their columns in proportion to
     their content, so ids over a fixed cap were cut to 12 characters
     though the table had room, and distinct samples read the same: on
     the bundled MetaPhlAn4 benchmark at 1024 px every Samples-tab id
     read "conta_source_case_001_0.…" (39 texts for 100 ids), and at
     1500 px the Events table cut all of them (49 texts for 84 ids). */
  await scenario(
    "F.8 benchmark ids",
    async (page) => {
      await loadDataset(page, "PRJNA763023+PRJDB4176 — MetaPhlAn4 (raw + filter 20×)");
      await openTab(page, "Samples");
      let ids = summary((await tableIds(page, "Samples", 100)).map((c) => c.id));
      let scroll = await pageScroll(page);
      check(
        ids.n === 100 && ids.cut === 0 && ids.apart && scroll <= 0,
        "F.8 MetaPhlAn4, Samples tab at 1024 px: every id whole, no two the same, no page scroll",
        `${ids.detail}; page ${scroll} px`,
      );
      await page.setViewportSize({ width: 1500, height: 1000 });
      await openTab(page, "Events");
      ids = summary((await tableIds(page, "Events", 100)).map((c) => c.id));
      scroll = await pageScroll(page);
      check(
        ids.n === 200 && ids.cut === 0 && ids.apart && scroll <= 0,
        "F.8 MetaPhlAn4, Events table at 1500 px: every id whole (wrapped), no two the same, no page scroll",
        `${ids.detail}; page ${scroll} px`,
      );
    },
    { contextOptions: { viewport: { width: 1024, height: 900 } } },
  );

  /* F.8 — ids just over the old caps, and names over 12 characters: the
     demo with every id prefixed "COHORT2024_STOOL_EXTRACTION_" (31 to 34
     characters) had 78 of 91 ids cut by 8 px in the Samples tab at 1280
     px (23 texts for 91 ids); with a 22-character sample_name, every name
     was cut, in both tables, though the table had room. */
  await scenario(
    "F.8 ids and names just over the caps",
    async (page) => {
      const prefixed = (id) => `COHORT2024_STOOL_EXTRACTION_${id}`;
      await upload(page, 0, "contamination_events.tsv", renamed(demo("contamination_events.tsv"), [0, 1], prefixed));
      await upload(page, 1, "species_abundance.tsv", renamedAbundance(prefixed));
      await upload(page, 2, "metadata.tsv", renamed(demo("metadata.tsv"), [0], prefixed));
      await upload(page, 3, "plate_map.tsv", renamed(demo("plate_map.tsv"), [0], prefixed));
      for (const tab of ["Samples", "Events"]) {
        await openTab(page, tab);
        const ids = summary((await tableIds(page, tab)).map((c) => c.id));
        const scroll = await pageScroll(page);
        check(
          ids.n === (tab === "Samples" ? 91 : 48) && ids.cut === 0 && ids.apart && scroll <= 0,
          `F.8 31- to 34-character ids, ${tab} at 1280 px: every id whole, no two the same, no page scroll`,
          `${ids.detail}; page ${scroll} px`,
        );
      }
      // Names of 21 to 22 characters, short ids, at 1500 px.
      await page.setViewportSize({ width: 1500, height: 1000 });
      const md = demo("metadata.tsv").split("\n");
      const named = [
        `${md[0]}\tsample_name`,
        ...md
          .slice(1)
          .filter(Boolean)
          .map((line) => `${line}\t${`Patient_${line.split("\t")[0]}_stool_DNA`.slice(0, 22)}`),
      ].join("\n");
      await upload(page, 0, "contamination_events.tsv", demo("contamination_events.tsv"));
      await upload(page, 1, "species_abundance.tsv", demo("species_abundance.tsv"));
      await upload(page, 2, "metadata.tsv", named);
      await upload(page, 3, "plate_map.tsv", demo("plate_map.tsv"));
      for (const tab of ["Samples", "Events"]) {
        await openTab(page, tab);
        const names = summary((await tableIds(page, tab)).map((c) => c.name));
        check(
          names.n === (tab === "Samples" ? 91 : 48) && names.cut === 0,
          `F.8 22-character names, ${tab} at 1500 px: every name whole`,
          names.detail,
        );
      }
    },
    { contextOptions: { viewport: { width: 1280, height: 900 } } },
  );

  /* F.9 — a metadata file without a subject column (NCBI BioSample's
     host is the host organism) was refused whole: "subject_id column not
     found", although the Help and the card call only sample_id
     mandatory. It loads, with a warning, relatedness unknown. */
  await scenario("F.9 metadata without a subject", async (page) => {
    await loadDemo(page);
    const md = demo("metadata.tsv").split("\n").filter(Boolean);
    const header = md[0].split("\t");
    const biome = header.indexOf("biome");
    const biosample = [
      "sample_id\thost\tbiome",
      ...md.slice(1).map((line) => {
        const cells = line.split("\t");
        return `${cells[0]}\tHomo sapiens\t${cells[biome]}`;
      }),
    ].join("\n");
    await upload(page, 2, "metadata.tsv", biosample);
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const errors = (await page.locator('[role="alert"]').allInnerTexts()).join(" ");
    const warning = body.match(/Metadata: subject_id column not found: [^]*?No two samples count as the same subject\./)?.[0];
    check(
      /91 samples annotated/.test(body) && !/Metadata:/.test(errors) && !!warning,
      "F.9 a metadata file with host and biome but no subject loads, with a warning",
      (warning || errors || "(not loaded)").slice(0, 200),
    );
  });

  /* F.10 — CroCoDeEL's low-abundance filter can be switched from Guided
     validation, where its note shows the state, not only from Overview ›
     Run parameters; both read one state. */
  await scenario("F.10 low-abundance filter from Validate", async (page) => {
    const events = demo("contamination_events.tsv").replace(
      "filtering_ab_thr_factor: None",
      "filtering_ab_thr_factor: 20.0",
    );
    await upload(page, 0, "contamination_events.tsv", events);
    await upload(page, 1, "species_abundance.tsv", demo("species_abundance.tsv"));
    await openTab(page, "Validate");
    const note = () => page.locator("[data-low-ab-switch]").locator("xpath=..");
    const before = (await note().count()) ? await note().innerText() : "";
    await page.locator("[data-low-ab-switch]").click();
    await page.waitForTimeout(800);
    const after = await note().innerText();
    await openTab(page, "Overview");
    const box = page.getByRole("checkbox", { name: /low-abundance filter to the diagnostics/i });
    const offInOverview = (await box.count()) === 1 && !(await box.isChecked());
    await openTab(page, "Validate");
    await page.locator("[data-low-ab-switch]").click();
    await page.waitForTimeout(800);
    const back = await note().innerText();
    check(
      /After CroCoDeEL's low-abundance filter \(20×\)/.test(before) && /switch off$/.test(before) &&
        /switched off/.test(after) && /switch on$/.test(after) && offInOverview &&
        /After CroCoDeEL's low-abundance filter \(20×\)/.test(back),
      "F.10 Guided validation switches the filter off and on, and the Overview box follows",
      JSON.stringify({ before, after, offInOverview, back }),
    );
  });

  /* F.11 — the web fonts come with the app. They were imported from
     fonts.googleapis.com: every visit made a third-party request, and
     where it failed (offline, a proxy, a blocked CDN) the text fell back
     to other fonts — the Events table then scrolled the page by 20 px at
     1500 px, and six layout checks of the b3 suite failed. */
  await scenario("F.11 fonts served with the app", async (page) => {
    const elsewhere = [];
    page.on("request", (r) => {
      if (new URL(r.url()).origin !== new URL(BASE).origin) elsewhere.push(r.url());
    });
    await page.reload({ waitUntil: "networkidle" });
    await loadDemo(page);
    await openTab(page, "Events");
    const faces = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, ""));
    });
    check(
      elsewhere.length === 0 && faces.includes("Raleway") && faces.includes("Nunito Sans"),
      "F.11 Raleway and Nunito Sans load from the app itself, nothing from another origin",
      JSON.stringify({ elsewhere: elsewhere.slice(0, 3), faces }),
    );
  });

} finally {
  await browser.close();
  stopServer();
}

finish();
