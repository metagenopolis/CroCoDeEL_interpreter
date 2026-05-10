# CroCoDeEL Interpretation Interface

A browser-based curation interface for [CroCoDeEL](https://github.com/metagenopolis/CroCoDeEL) contamination calls. Load a `contamination_events.tsv` and the matching `species_abundance.tsv` (and optionally a sample metadata file and a plate map), walk every flagged event through a scatterplot and seven diagnostic criteria with full sample/plate context, then commit a two-layer curation: an **event evaluation** (true positive / false positive / uncertain / pending) and, on the target sample, a **sample-level verdict** (contaminated / correct / uncertain / pending) with an optional **keep / suppress** action. Export a curated TSV, a self-contained HTML report, or a full session JSON.

> **Live:** https://metagenopolis.github.io/CroCoDeEL_interpreter/
>
> Everything runs client-side &mdash; **no data ever leaves the browser**. The session is auto-persisted to `IndexedDB` (no upload, no server).

## Tabs

- **Overview** &mdash; run parameters, headline counts (events, mean rate, mean introduced %), connected-components count, optional **To suppress / To keep** cards, top events by probability, rate, and species impact.
- **Samples** &mdash; per-sample cockpit. The table lists every sample with: id (+ optional sample\_name shown below it), a collapsible *Context* cell aggregating every metadata pill (subj / tp / grp / biome / control / low biomass / low seq depth / plate position), two per-side **Events as source** and **Events as target** columns showing counts + per-side TP/FP/Uncertain/Pending breakdown (the target column also carries a max-rate badge and side-aware → Scatter / → Events / → Network drill-ins, mirrored on the source column for source-side events), a verdict picker (Pending / Contaminated / Not contaminated / Uncertain) and a Keep / Suppress action picker. Each column header carries *all / none* buttons that expand or collapse every visible row at once. Sample-context search bar with autocomplete + two numeric *count event source* / *count event target* counters. Bulk-apply dialog layers pre-conditions (current verdict / action multi-select, context dropdowns, per-side event counts, max rate / probability / introduced) on top of the visible-samples scope. Keyboard navigation: ↑↓ step through the sorted list, ←→ jump to the previous/next sample whose action is still unset, **K** = Keep, **S** = Suppress. Samples that are never the target of any event are auto-tagged *Not contaminated* + *Keep* (existing curator decisions are never overwritten).
- **Events** &mdash; every column sortable. Filter bar (shared across all event-centric tabs) for text search, log-scaled rate slider, probability slider, introduced-% slider, multi-select evaluation popover, sample-verdict popover (Beaker icon, side-aware: source / target / either), action popover, sample-context filters (same/different subject, same/different group, plate adjacency). Inline editable **target verdict** and **target action** chips on every row. Clicking a row jumps into Validate.
- **Scatter** &mdash; gallery of source-vs-target thumbnails, sortable by probability, rate, introduced %, evaluation, target verdict, target action, or sample id; a *Color contamination-line points* checkbox toggles the salmon highlight on the line points across every card. Click a verdict button on a card to commit the event evaluation, the *Verdict on target sample* and the *Action on target sample* in one popover. Toggle to **Explore new pairs** to add manually-curated events for pairs CroCoDeEL did not flag.
- **Validate** &mdash; per-event scatterplot in log-log space with the contamination line drawn at `log10(rate)`, the seven diagnostic criteria with PASS/FAIL + numerical values, plate position, sample relatedness, cascade chain when detected, and an aggregate FP-suggestion banner when the event is most likely a longitudinal pair. The evaluation panel below the plot has three sections side-by-side: *Evaluation (event)*, *Verdict on target sample*, *Action on target sample*. Click an introduced-species chip to pin the matching point on the plot (violet ring + name / target / source readout); a checkbox under the metric tiles toggles the salmon highlight on contamination-line points so the line shape can be read on its own.
- **Network** &mdash; force-directed graph of events with two color schemes: *Exploration* (edges by rate, nodes by topological role) and *Curation* (edges by event evaluation, node fill = sample-level verdict, node border = sample-level action). Click an edge to open the event in Validate; click a node to open a bulk popover that applies an event evaluation, a sample-level verdict and a sample-level action to the events targeting that sample, plus three drill-ins → Scatter / → Events / → Samples scoped to the connected component.
- **Plate** &mdash; visualize events on the physical plate layout (when `plate_map.tsv` is provided); adjacent-well events are highlighted as suspect well-to-well leakage. Both 96-well and 384-well formats are auto-detected.
- **Export** &mdash; the same filter bar scopes the download. Curated TSV (one row per event with `verdict / action / introduced_pct / introduced_species / notes` columns; the `verdict` column name is preserved for backwards compatibility with downstream tools, even though the UI now calls the field "evaluation"), self-contained HTML report (per-event scatterplot, full diagnostic checklist + numerical values, source/target sample metadata + plate position, "Filter applied" banner, dataset-context summary), or a full session JSON for round-trip.
- **Datasets** &mdash; load any of the bundled studies (see below) with one click. Searchable, profiler tag, with-metadata / with-plate-map toggles.
- **Learn** &mdash; the seven diagnostic criteria explained, with the four canonical contamination patterns from the CroCoDeEL paper.
- **Help** &mdash; keyboard shortcuts, file format reference, configuration, FAQ, and the guided tour.

A floating *Back to Samples* chip appears on every other tab when you've drilled in from the Samples tab, so you can return in one click. The Samples table restores its sort, page, scroll position and context filters on return.

## Two-layer curation: event vs sample

The interface tracks two independent curation layers so curators can disagree with themselves between them.

- **Event evaluation** &mdash; per-event call: *true positive / false positive / uncertain / pending*. Answers *"is this specific CroCoDeEL flag a real cross-contamination?"* Set from the Events table, the Scatter card popover, the Network edge popover, or one-by-one in Validate.
- **Sample-level verdict** &mdash; per-sample call: *contaminated / correct / uncertain / pending*. Answers *"is this sample as a whole compromised?"* A sample can be marked contaminated even when each individual event targeting it is uncertain, and conversely a sample can be marked correct despite a TP event flowing into it (e.g. when the rate is negligible). Set from the Samples table, the Scatter card popover, the Validate panel, the Network node popover, or via the bulk-apply dialogs.
- **Sample-level action** (opt-in) &mdash; *keep* (acknowledge but preserve) or *suppress* (drop from analyses). Lives on the sample, not the event &mdash; one decision per target sample regardless of how many events target it. Surfaces as a read-only badge in the Events table's *target action* column, as a halo on TP scatter cards, and as the node border in the Network's curation scheme.

## Diagnostic criteria

Each event is scored against six data-driven criteria plus *same individual* (counted when metadata is loaded, headline becomes 6/6 → 7/7) and an informational *plate proximity* check. Aggregate score is shown next to the scatterplot to inform &mdash; not replace &mdash; your evaluation.

| # | Criterion | Threshold | Source |
| --- | --- | --- | --- |
| 01 | Straight contamination line | R&sup2; > 0.8 of the linear fit on log-log | abundance |
| 02 | Enough species on the line | n > 10 species | abundance |
| 03 | Line spans many decades | decade range &ge; 1.5 | abundance |
| 04 | Abundant source species present in target | observed misses within Poisson sampling noise (p &ge; 0.05, &lambda; = N &times; rate &times; source, N &asymp; 1/LOD) | abundance |
| 05 | No points clearly above the line | max distance < 0.5 decade above (cascade-aware) | abundance |
| 06 | Source / target profiles are distinct | Spearman &rho; < 0.7 across full profiles | abundance |
| 07 | Source and target are different individuals | `subject_id` (or `group_id`) mismatch | metadata |
| 08 | Plate proximity (informational) | Chebyshev well distance &mdash; not counted | plate map |

Criterion 04 is the strongest red flag for a false positive; criteria 06 + 07 together commonly flag longitudinal pairs that CroCoDeEL mistook for contamination. Criterion 08 is purely informational and never enters the score.

## Suppress / keep action layer

Beyond the evaluation, every target sample carries a downstream action.

- **Suppress** &mdash; drop the contaminated sample from the analysis.
- **Keep** &mdash; acknowledge the contamination but leave the sample in the study (small enough to ignore).

The action lives on the sample, not on the event &mdash; so when several events target the same sample the action is set once. It lands in the exported TSV (`action` column) and the HTML report. Samples that are never the target of an event are auto-tagged *correct + keep* on the Samples tab (existing curator decisions are never overwritten).

## Configuration

- **Theme** &mdash; Light / Dark / Auto-OS (`prefers-color-scheme`) / Auto-time (user-defined day/night hours).
- **Items per page** &mdash; events table (default 100), scatterplot gallery (50), samples table (100), datasets list (50).

Theme, items-per-page and other UI preferences are persisted to `localStorage`; the full session (events, sample-level curation, abundance, metadata, plate map, UI state) is persisted to `IndexedDB` (object store `kv` in the database `crocodeel-interpreter`), which gives us hundreds of MB to GBs of headroom for large abundance tables and asynchronous writes that don't block the main thread. Sessions stored under the legacy localStorage keys are migrated transparently on first load. The app refuses to boot if IndexedDB is unavailable (e.g. very old browsers, certain private-mode contexts) and shows a *browser not supported* screen instead. Use **Download session** on the files bar to export the entire state as a JSON, and **Import session** to restore it &mdash; useful for sharing a curation in progress with a colleague.

## Bundled datasets

Loadable from the **Datasets** tab. Several ship with curated `metadata.tsv` so the same-individual criterion can score.

| Accession | Study | Notes |
| --- | --- | --- |
| **PRJEB33500** | Meslier et al. 2020 (Mediterranean diet) | + metadata (subject\_id, timepoint, sex) |
| **PRJEB6337** | Qin et al. 2014 (liver cirrhosis) | + metadata (subject\_id from HV/HD/LV/LD aliases) |
| **PRJNA352475** | Ferretti et al. 2018 (mother-infant transmission) | + metadata (subject\_id, timepoint, biome) |
| **PRJNA698986 P2 / P3** | Lou et al. 2023 (early-life metagenomes) | + metadata (subject\_id, DOL timepoint) + plate map |
| **PRJEB10878 / PRJEB12449 / PRJEB32731 / PRJEB83730** | various | abundance + events only |
| **PRJNA763023 / PRJDB4176 (&times; 4 profilers)** | synthetic contamination benchmarks | abundance + events |

Plus the **welcome-tour demo** (the P3 cohort with curated metadata, plate map, and pre-walked evaluations).

## Input formats

All files are TSV (tab-separated). Column names are matched against several aliases (case-insensitive); the in-app **Help** tab has the full list.

### `contamination_events.tsv` (required)

Output of CroCoDeEL. Recognized columns:

| canonical name | aliases | notes |
| --- | --- | --- |
| `source` | `contamination_source`, `source_sample` | required |
| `target` | `contaminated_sample`, `target_sample`, `contaminated` | required |
| `rate` | `contamination_rate`, `estimated_rate` | required &mdash; relative abundance fraction (0&ndash;1) |
| `probability` | `score`, `rf_score`, `proba` | required &mdash; RF model probability |
| `contamination_specific_species` | `introduced_species`, `species_specifically_introduced`, `species` | comma-separated list |

Header lines starting with `#` are parsed as run metadata (e.g. `# crocodeel version: 1.2.1 | probability_cutoff: 0.5 | rate_cutoff: 0.0`).

### `species_abundance.tsv` (required)

Wide format: first column is the species ID, remaining columns are sample IDs. Values are absolute or relative abundances (auto-normalized per sample). The interface can boot without it &mdash; the events table will render and evaluations can be entered &mdash; but the scatterplots and six of the seven diagnostic criteria depend on it, so curation without an abundance table reduces to taking CroCoDeEL's call at face value.

### `metadata.tsv` (optional, unlocks criterion 07 and sample-context filters)

| canonical name | aliases | type |
| --- | --- | --- |
| `sample_id` | `sample`, `sampleid`, `id` | string &mdash; required |
| `sample_name` | `name`, `display_name`, `label`, `alias` | string &mdash; cosmetic label |
| `subject_id` | `subject`, `patient_id`, `host`, `individual` | string |
| `timepoint` | `time_point`, `time`, `day`, `week`, `visit` | string |
| `biome` | `body_site`, `bodysite`, `tissue`, `sample_site` | string &mdash; values matching `control` / `blank` / `negative` flag the sample as a negative control |
| `low_biomass` | `is_low_biomass`, `lowbiomass` | bool |
| `low_sequencing_depth` | `is_low_sequencing_depth`, `low_seq_depth`, `low_depth` | bool |
| `group_id` | `group`, `family_id`, `cage_id`, `household_id` | string |

Any extra columns are surfaced as generic key:value pills on samples.

### `plate_map.tsv` (optional, unlocks the Plate tab and adjacency filters)

| canonical name | aliases |
| --- | --- |
| `sample_id` | `sample`, `id` |
| `plate` | `plate_id`, `plate_name` |
| `well` | `position`, `well_id`, `pos` |

The `well` column accepts either an alphanumeric label (`A07`) or a `row` + `column` pair.

## Keyboard shortcuts

**Validate tab** &mdash; `T` true positive · `F` false positive · `U` uncertain · `P` reset to pending · `←` / `→` previous / next pending event · `↑` / `↓` previous / next event in the queue · `?` toggle in-app cheatsheet.

**Samples tab** &mdash; click a row to focus it, then `↑` / `↓` step through the sorted list · `←` / `→` jump to the previous / next sample whose action is still unset · `K` set Keep · `S` set Suppress (when the action layer is enabled).

Shortcuts back off when the focus is in a text field or a bulk-apply dialog is open.

## Getting started

```bash
npm install
npm run dev          # Vite dev server on http://localhost:5173
```

A welcome dialog offers the guided tour on first visit; you can replay it anytime from the **Help** tab.

### Build for production

```bash
npm run build        # static bundle in dist/
npm run preview      # preview the production build locally
```

The output is fully static and can be served from any HTTP host. The build embeds the git short hash + build date as compile-time constants (visible as a chip in the header that links to the corresponding GitHub commit).

### Deployment

The repository ships with `.github/workflows/deploy.yml` &mdash; pushing to `main` automatically builds the bundle and deploys it to GitHub Pages. The Vite `base` is set to `/CroCoDeEL_interpreter/` to match the public URL.

## Tech stack

- React 18 + Vite
- Tailwind CSS (with CSS variables for the dark theme)
- D3 for color interpolation and the network force-layout
- `react-range` for dual-thumb sliders
- `lucide-react` icons
- IndexedDB for the full session, with a one-shot migration from the legacy `lz-string`-compressed `localStorage` payload

## Citing

If the interface contributes to a publication, please cite CroCoDeEL itself:

> Goulet L. et al., *Cross-sample Contamination Detection and Estimation of its Level (CroCoDeEL)*, Nature Communications 2026. [doi.org/10.1038/s41467-026-72637-9](https://doi.org/10.1038/s41467-026-72637-9)

See [`CITATION.cff`](./CITATION.cff) for the full author list and a machine-readable record.

## License

GNU General Public License v3.0 &mdash; see [`COPYING`](./COPYING).
