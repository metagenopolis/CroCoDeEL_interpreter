/* End-to-end smoke test.

   The unit suite covers pure functions; this covers the things only a real
   browser can catch — and that have actually bitten:

     - a hook called after an early return, which throws "Rendered more
       hooks than during the previous render" and, with no route
       boundaries, unmounts the whole app to a blank page;
     - an error object rendered as a React child, which took the app down
       when a session file failed to parse;
     - any tab that throws on mount;
     - the export path, end to end, including the numbers in the file.

   Deliberately plain `playwright` and a node script rather than
   @playwright/test: no extra config, no extra runner, and the script owns
   its own server so `npm run test:e2e` behaves identically on a laptop and
   in CI. The server, the browser and the checks are e2e/harness.mjs's, as
   in every other suite.

   Usage:  npm run build && npm run test:e2e
           BASE_URL=http://host/path/ npm run test:e2e   (skip the server) */

import { readFileSync } from "node:fs";
import {
  startServer,
  stopServer,
  launchBrowser,
  newPage as openPage,
  loadDemo,
  tsvInput,
  check,
  finish,
} from "./harness.mjs";

/* ------------------------------------------------------------------ main */
await startServer();
const browser = await launchBrowser();

/** A fresh context that records every page error and console error
    (harness.mjs). */
const newPage = () => openPage(browser);

try {
  /* ---------------------------------------- 1. boot + every tab renders */
  {
    const { ctx, page, errors } = await newPage();
    check(errors.length === 0, "the page boots clean", errors[0] || "");
    await loadDemo(page);
    check(errors.length === 0, "the demo dataset loads", errors[0] || "");

    for (const tab of [
      "Overview",
      "Samples",
      "Events",
      "Scatter",
      "Validate",
      "Network",
      "Plate",
      "Export",
    ]) {
      const before = errors.length;
      await page.getByRole("button", { name: new RegExp(`^${tab}$`) }).first().click();
      await page.waitForTimeout(900);
      const text = (await page.locator("body").innerText()).trim();
      check(
        errors.length === before && text.length > 400,
        `tab ${tab} renders`,
        errors.slice(before).join(" | ") || (text.length <= 400 ? "near-blank page" : ""),
      );
    }
    await ctx.close();
  }

  /* ------------- 2. regression: hooks after an early return in ScatterTab
     Sitting on the Scatter tab with no abundance table and then loading one
     is exactly what the tab's own notice tells the user to do. It used to
     change the hook count between two renders and blank the app. */
  {
    const { ctx, page, errors } = await newPage();
    await tsvInput(page, 0).setInputFiles("public/demo/contamination_events.tsv");
    await page
      .getByRole("button", { name: /^Scatter$/ })
      .first()
      .waitFor({ state: "visible", timeout: 60000 });
    await page.getByRole("button", { name: /^Scatter$/ }).first().click();
    await page.waitForTimeout(800);
    const notice = await page.locator("body").innerText();
    check(
      /require the abundance table/i.test(notice),
      "Scatter tab explains it needs the abundance table",
    );

    const before = errors.length;
    await tsvInput(page, 1).setInputFiles("public/demo/species_abundance.tsv");
    await page.waitForTimeout(4000);
    const after = (await page.locator("body").innerText()).trim();
    const hookCrash = errors
      .slice(before)
      .some((e) => /Rendered more hooks|Minified React error #(300|310)/.test(e));
    check(!hookCrash, "loading the abundance table there does not crash", errors.slice(before)[0] || "");
    check(after.length > 500, "the app is still rendered afterwards", `body=${after.length} chars`);
    await ctx.close();
  }

  /* --------- 3. regression: an error object rendered as a React child
     A session file that fails to parse must report the failure, not take
     the application down with it. */
  {
    const { ctx, page, errors } = await newPage();
    await page
      .locator('input[accept*="json"]')
      .first()
      .setInputFiles({
        name: "session.json",
        mimeType: "application/json",
        buffer: Buffer.from("not json at all"),
      });
    await page.waitForTimeout(2500);
    const body = await page.locator("body").innerText();
    check(
      /Failed to import session/i.test(body),
      "a broken session file reports the failure",
    );
    check(
      !/Something went wrong while rendering/i.test(body),
      "the error boundary did not have to catch it",
    );
    check(
      !errors.some((e) => /not valid as a React child/i.test(e)),
      "no 'objects are not valid as a React child'",
      errors.find((e) => /React child/i.test(e)) || "",
    );
    await ctx.close();
  }

  /* ------------------------------ 4. curated abundance export, end to end */
  {
    const { ctx, page, errors } = await newPage();
    await loadDemo(page);
    await page.getByRole("button", { name: /^Samples$/ }).first().click();
    // Marking a sample Contaminated defaults its action to Suppress, which
    // is what the export acts on.
    const contaminated = page.locator('button[title="Verdict: Contaminated"]');
    await contaminated.first().waitFor({ state: "visible", timeout: 60000 });
    await contaminated.nth(0).click();
    await page.waitForTimeout(500);
    await contaminated.nth(1).click();
    await page.waitForTimeout(800);

    await page.getByRole("button", { name: /^Export$/ }).first().click();
    await page.waitForTimeout(1500);
    const title = await page.locator("body").innerText();
    const m = title.match(/Curated abundance table — (\d+) of (\d+) samples/);
    check(!!m, "the export card reports the sample counts", m ? m[0] : "not found");
    if (m) {
      check(
        Number(m[2]) - Number(m[1]) === 2,
        "exactly the two suppressed samples are dropped",
        `${m[1]}/${m[2]}`,
      );
    }

    // One click, two files: the table and its provenance.
    const files = {};
    const both = new Promise((resolve) => {
      const onDownload = async (d) => {
        files[d.suggestedFilename()] = readFileSync(await d.path(), "utf8");
        if (Object.keys(files).length === 2) {
          page.off("download", onDownload);
          resolve();
        }
      };
      page.on("download", onDownload);
    });
    await page
      .getByRole("button", { name: /Download curated abundance TSV/i })
      .first()
      .click();
    await Promise.race([both, page.waitForTimeout(30000)]);
    const download = files["species_abundance_curated.tsv"];
    check(download != null, "the curated abundance TSV downloads");
    let missing = [];
    if (download != null) {
      const text = download;
      const rows = text
        .split("\n")
        .filter((l) => l.length)
        .map((l) => l.split("\t"));
      // The table holds the data only: a "#" line is a data row to pandas'
      // read_csv(sep="\t", index_col=0) and to R's read.delim.
      check(!rows.some((r) => r[0].startsWith("#")), "the curated table has no # line");
      // Each remaining column is the input's column: the same first header,
      // the species in the input's order, the input's own values — no
      // fractions, no renormalisation.
      const input = readFileSync("public/demo/species_abundance.tsv", "utf8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.split("\t"));
      const inCol = new Map(input[0].map((h, j) => [h, j]));
      const inRow = new Map(input.slice(1).map((r) => [r[0], r]));
      const pos = new Map(input.slice(1).map((r, i) => [r[0], i]));
      const header = rows[0];
      missing = input[0].slice(1).filter((s) => !header.includes(s));
      const idx = rows.slice(1).map((r) => pos.get(r[0]));
      check(
        header[0] === input[0][0] &&
          missing.length === 2 &&
          idx.every((p, i) => p !== undefined && (i === 0 || p > idx[i - 1])),
        "it keeps the input's first header and species order, without the 2 suppressed columns",
        `${header[0]}; without ${missing.join(", ")}`,
      );
      let exact = 0;
      let long = 0;
      let worst = 0;
      let worstSteps = 0;
      let bad = null;
      // How many doubles apart two positive numbers are (1: neighbours).
      const bits = (x) => new BigInt64Array(new Float64Array([x]).buffer)[0];
      const doublesApart = (a, b) => {
        const d = bits(a) - bits(b);
        return Number(d < 0n ? -d : d);
      };
      for (const r of rows.slice(1)) {
        const src = inRow.get(r[0]);
        for (let j = 1; j < header.length; j++) {
          const raw = src[inCol.get(header[j])];
          const v = Number(raw);
          const w = Number(r[j]);
          const digits = v === 0 ? 0 : v.toExponential().split("e")[0].replace(".", "").length;
          if (digits <= 15) {
            if (w === v) exact++;
            else bad = bad || `${r[0]} / ${header[j]}: ${r[j]} for ${raw}`;
          } else {
            long++;
            worst = Math.max(worst, Math.abs(w - v) / v);
            worstSteps = Math.max(worstSteps, doublesApart(w, v));
          }
        }
      }
      check(
        !bad && exact > 0,
        "every remaining column equals the input column: each value up to 15 significant digits exactly",
        bad || `${exact} values`,
      );
      // Rebuilt from the parser's fractions: when two neighbouring doubles
      // make the same fraction, a value written with 16 or 17 digits comes
      // back as the one next to it (relative difference about 2e-16).
      check(
        worstSteps <= 1 && worst < 2.3e-16,
        "and each value written with 16 or 17 significant digits as the same double or the next one",
        `${long} values, at most ${worstSteps} double apart, worst relative difference ${worst.toExponential(2)}`,
      );
    }
    // The provenance left the table for a text file of its own, written
    // by the same click.
    const provenanceText = files["species_abundance_curated.provenance.txt"] || "";
    check(
      /^Suppressed samples \(2\)/m.test(provenanceText) &&
        missing.length === 2 &&
        missing.every((s) => provenanceText.split("\n").includes(s)),
      "the same click writes the provenance file, which records the suppressed ids",
      provenanceText.split("\n").find((l) => l.startsWith("Suppressed")) || "no provenance file",
    );
    check(errors.length === 0, "no JS error across the export flow", errors[0] || "");
    await ctx.close();
  }

  /* ------------------------- 5. pin a species by clicking a scatter point */
  {
    const { ctx, page, errors } = await newPage();
    await loadDemo(page);
    await page.getByRole("button", { name: /^Validate$/ }).first().click();
    await page.waitForTimeout(2500);

    const rings = () => page.locator('svg circle[stroke="#423089"]').count();
    check((await rings()) === 0, "no species is pinned to start with");

    // Click by coordinate: the dots overlap, so Playwright's actionability
    // check on an individual <circle> never settles.
    const at = await page.evaluate(() => {
      const svg = [...document.querySelectorAll("svg")].find(
        (s) => s.querySelectorAll("circle").length > 50,
      );
      const c = svg
        ? [...svg.querySelectorAll("circle")].find(
            (x) => x.style.cursor === "pointer" && x.querySelector("title"),
          )
        : null;
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    check(!!at, "the scatter renders clickable points");
    if (at) {
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(600);
      check((await rings()) === 1, "clicking a point pins that species");
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(600);
      check((await rings()) === 0, "clicking it again unpins it");
    }
    check(errors.length === 0, "no JS error while pinning", errors[0] || "");
    await ctx.close();
  }

  /* --------------------------------- 6. contamination graph export */
  {
    const { ctx, page, errors } = await newPage();
    await loadDemo(page);
    await page.getByRole("button", { name: /^Export$/ }).first().click();
    await page.waitForTimeout(1500);
    const card = await page.locator("body").innerText();
    const counts = card.match(/Contamination graph — (\d+) nodes?, (\d+) edges?/);
    check(!!counts, "the graph card reports node and edge counts", counts ? counts[0] : "");

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
      page.getByRole("button", { name: /Download GraphML/i }).first().click(),
    ]);
    check(!!download, "the GraphML downloads");
    if (download && counts) {
      const xml = readFileSync(await download.path(), "utf8");
      // Parse it rather than pattern-match: a malformed file is the whole
      // failure mode, and Gephi would just refuse to open it.
      const parsed = await page.evaluate((text) => {
        const doc = new DOMParser().parseFromString(text, "application/xml");
        if (doc.querySelector("parsererror")) return { error: true };
        const declared = new Set(
          [...doc.getElementsByTagName("key")].map((k) => k.getAttribute("id")),
        );
        return {
          directed: doc.querySelector("graph")?.getAttribute("edgedefault"),
          nodes: doc.getElementsByTagName("node").length,
          edges: doc.getElementsByTagName("edge").length,
          orphan: [...doc.getElementsByTagName("data")].filter(
            (d) => !declared.has(d.getAttribute("key")),
          ).length,
        };
      }, xml);
      check(!parsed.error, "the GraphML is well-formed XML");
      check(parsed.directed === "directed", "the graph is declared directed");
      check(
        String(parsed.nodes) === counts[1] && String(parsed.edges) === counts[2],
        "the file matches the counts shown on the card",
        `file ${parsed.nodes}/${parsed.edges} vs card ${counts[1]}/${counts[2]}`,
      );
      check(parsed.orphan === 0, "every <data> resolves to a declared key");
    }
    check(errors.length === 0, "no JS error across the graph export", errors[0] || "");
    await ctx.close();
  }

  /* ------------- 7. regression: sample side effects of event verdicts
     The target samples were collected inside a setRawEvents updater, which
     React may run only at the next render: the sample verdict / action was
     then silently skipped. Bulk apply never reached a single sample, and
     one TP click in four or so did not flag its target. */
  {
    const tsvRows = (path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .slice(1)
        .map((l) => l.split("\t"));
    const demoEvents = tsvRows("public/demo/contamination_events.tsv");
    const targets = new Set(demoEvents.map((c) => c[1]));
    const controls = new Set(
      tsvRows("public/demo/metadata.tsv")
        .filter((c) => c[3] === "control")
        .map((c) => c[0]),
    );
    const ncTargets = [...targets].filter((t) => controls.has(t));

    const overview = async (page) => {
      await page.getByRole("button", { name: /^Overview$/ }).first().click();
      await page.waitForTimeout(800);
      const text = await page.locator("body").innerText();
      const stat = (re) => Number(text.match(re)?.[1] ?? NaN);
      return {
        tp: stat(/Validated \(TP\)\s*(\d+)/i),
        keep: stat(/Samples to keep\s*(\d+)/i),
        suppress: stat(/Samples to suppress\s*(\d+)/i),
      };
    };
    const openBulkDialog = async (page) => {
      await page.getByRole("button", { name: /^Events$/ }).first().click();
      await page.waitForTimeout(1200);
      await page.locator('button[aria-label="Bulk apply evaluation"]').first().click();
      await page.getByText(/Action on samples targeted/i).waitFor({ timeout: 20000 });
      return page
        .locator("div")
        .filter({ has: page.getByText(/Action on samples targeted/i) })
        .filter({ has: page.getByRole("button", { name: /^Apply to \d+ events?$/ }) })
        .last();
    };

    // 7a. bulk apply: TP + target Contaminated + target Keep
    {
      const { ctx, page, errors } = await newPage();
      await loadDemo(page);
      const dialog = await openBulkDialog(page);
      await dialog.getByRole("button", { name: /^True positive$/ }).first().click();
      await dialog.getByRole("button", { name: /^Contaminated$/ }).first().click();
      await dialog.getByRole("button", { name: /^Keep$/ }).first().click();
      await dialog.getByRole("button", { name: /^Apply to \d+ events?$/ }).click();
      await page.getByRole("button", { name: /^Apply to \d+$/ }).click();
      await page.waitForTimeout(1000);
      const s = await overview(page);
      check(s.tp === demoEvents.length, "bulk apply marks every matched event TP", `TP=${s.tp}`);
      check(
        s.keep === targets.size && s.suppress === 0,
        "bulk apply sets Keep on every target sample",
        `keep=${s.keep} suppress=${s.suppress}, expected keep=${targets.size}`,
      );
      await page.getByRole("button", { name: /^Samples$/ }).first().click();
      await page.waitForTimeout(1200);
      const flagged = await page.evaluate(
        () =>
          [...document.querySelectorAll('button[title="Verdict: Contaminated"]')].filter(
            (b) => getComputedStyle(b).backgroundColor !== "rgb(255, 255, 255)",
          ).length,
      );
      check(
        flagged === targets.size,
        "bulk apply marks every target sample Contaminated",
        `${flagged} of ${targets.size}`,
      );
      check(errors.length === 0, "no JS error across the bulk apply", errors[0] || "");
      await ctx.close();
    }

    // 7b. one TP click per event: each target gets Contaminated → Suppress
    {
      const { ctx, page, errors } = await newPage();
      await loadDemo(page);
      await page.getByRole("button", { name: /^Events$/ }).first().click();
      await page.waitForTimeout(1200);
      const buttons = page.locator('button[title="mark as true positive"]');
      const n = await buttons.count();
      for (let i = 0; i < n; i++) {
        await buttons.nth(i).click();
        await page.waitForTimeout(150);
      }
      const s = await overview(page);
      check(s.tp === demoEvents.length, "every event is marked TP one click at a time", `TP=${s.tp}`);
      check(
        s.suppress === targets.size,
        "each TP click flags its target sample for suppression",
        `suppress=${s.suppress}, expected ${targets.size}`,
      );
      check(errors.length === 0, "no JS error across the TP clicks", errors[0] || "");
      await ctx.close();
    }

    // 7c. preset: events toward a negative control → TP + NC Contaminated
    {
      const { ctx, page, errors } = await newPage();
      await loadDemo(page);
      await openBulkDialog(page);
      await page
        .getByRole("button", { name: /Mark all events targeting a negative control as TP/i })
        .click();
      await page.getByRole("button", { name: /^Mark \d+ as TP$/ }).click();
      await page.waitForTimeout(1000);
      const s = await overview(page);
      check(
        ncTargets.length > 0 && s.suppress === ncTargets.length,
        "the negative-control preset flags the NC targets Contaminated",
        `suppress=${s.suppress}, expected ${ncTargets.length}`,
      );
      check(errors.length === 0, "no JS error across the NC preset", errors[0] || "");
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  stopServer();
}
finish();
