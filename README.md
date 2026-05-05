# CroCoDeEL Interpretation Interface

A browser-based curation interface for [CroCoDeEL](https://github.com/metagenopolis/CroCoDeEL) contamination calls. Load a `contamination_events.tsv` and the matching `species_abundance.tsv` (and optionally a sample metadata file and a plate map), walk every flagged event through a scatterplot and seven diagnostic criteria with full sample/plate context, then commit a verdict (true positive / false positive / uncertain / pending) and, for true positives, an optional **keep / suppress** action. Export a curated TSV, a self-contained HTML report, or a full session JSON.

> **Live:** https://metagenopolis.github.io/CroCoDeEL_interpreter/
>
> Everything runs client-side &mdash; **no data ever leaves the browser**. The session is auto-persisted to `localStorage`.

## Tabs

- **Overview** &mdash; run parameters, headline counts (events, mean rate, mean introduced %), connected-components count, optional **To suppress / To keep** cards, top events by probability, rate, and species impact.
- **Events table** &mdash; every column sortable. Filter bar (shared across all event-centric tabs) for text search, log-scaled rate slider, probability slider, introduced-% slider, multi-select verdict popover, action popover, sample-context filters (same/different subject, same/different group, plate adjacency).
- **Guided validation** &mdash; per-event scatterplot in log-log space with the contamination line drawn at `log10(rate)`, the seven diagnostic criteria with PASS/FAIL + numerical values, plate position, sample relatedness, cascade chain when detected, and an aggregate FP-suggestion banner when the event is most likely a longitudinal pair. Click an introduced-species chip to pin the matching point on the plot (violet ring + name / target / source readout); a checkbox under the metric tiles toggles the salmon highlight on contamination-line points so the line shape can be read on its own.
- **Network** &mdash; force-directed graph of events; arrow thickness scales with rate, color encodes verdict, salmon nodes mark cascade samples; click a plate panel to jump straight to the corresponding event in Validate.
- **Plate** &mdash; visualize events on the physical plate layout (when `plate_map.tsv` is provided); adjacent-well events are highlighted as suspect well-to-well leakage.
- **Explore pairs** &mdash; pick any pair of samples (even pairs CroCoDeEL did not flag) to inspect their scatterplot; add the pair as a manually-curated event to catch false negatives.
- **Datasets** &mdash; load any of the bundled studies (see below) with one click. Searchable, profiler tag, with-metadata / with-plate-map toggles.
- **Export** &mdash; the same filter bar scopes the download. Curated TSV (one row per event, with `verdict / action / introduced_pct / introduced_species / notes` columns), self-contained HTML report (per-event scatterplot, full diagnostic checklist + numerical values, source/target sample metadata + plate position, "Filter applied" banner, dataset-context summary), or a full session JSON for round-trip.
- **Learn** &mdash; the seven diagnostic criteria explained, with the four canonical contamination patterns from the CroCoDeEL paper.
- **Help** &mdash; keyboard shortcuts, file format reference, configuration, FAQ, and the guided tour.

## Diagnostic criteria

Each event is scored against seven criteria; the aggregate verdict (`X / 7`) is shown next to the scatterplot.

| # | Criterion | Threshold | Source |
| --- | --- | --- | --- |
| 01 | Straight contamination line | R&sup2; > 0.8 of the linear fit on log-log | abundance |
| 02 | Enough species on the line | n > 10 species | abundance |
| 03 | Line spans many decades | decade range &ge; 1.5 | abundance |
| 04 | Abundant source species present in target | observed misses within Poisson sampling noise (p &ge; 0.05, λ = N &times; rate &times; source, N &asymp; 1/LOD) | abundance |
| 05 | No points clearly above the line | max distance < 0.5 decade above (cascade-aware) | abundance |
| 06 | Source / target profiles are distinct | Spearman &rho; < 0.7 across full profiles | abundance |
| 07 | Source and target are different individuals | `subject_id` (or `group_id`) mismatch | metadata |

Criterion 07 is only scored when sample metadata is loaded (denominator becomes 7 instead of 6). Criterion 04 is the strongest red flag for a false positive; criteria 06 + 07 together commonly flag longitudinal pairs that CroCoDeEL mistook for contamination.

## Suppress / keep action layer (opt-in)

Beyond the verdict, true-positive events can carry a downstream action. Actions only apply to TP &mdash; FP / Uncertain / Pending events have no action.

- **Suppress** &mdash; drop the contaminated sample from the analysis (default for TP without an explicit action).
- **Keep** &mdash; acknowledge the contamination but leave the sample in the study (small enough to ignore).

Enable in **Configuration** (gear icon, top right). The action lands in the exported TSV (`action` column) and the HTML report.

## Configuration

- **Theme** &mdash; Light / Dark / Auto-OS (`prefers-color-scheme`) / Auto-time (user-defined day/night hours).
- **Suppress / keep action** &mdash; opt in to the action layer described above.
- **Items per page** &mdash; events table, scatterplot gallery, datasets list.

All preferences and the active session are persisted to `localStorage`. Use **Download session** on the files bar to export the entire state (events, curation, abundance, metadata, plate map, UI state) as a JSON, and **Import session** to restore it &mdash; useful for sharing a curation in progress with a colleague.

## Bundled datasets

Loadable from the **Datasets** tab. Several ship with curated `metadata.tsv` so the same-individual criterion can score.

| Accession | Study | Notes |
| --- | --- | --- |
| **PRJEB33500** | Meslier et al. 2020 (Mediterranean diet) | + metadata (subject_id, timepoint, sex) |
| **PRJEB6337** | Qin et al. 2014 (liver cirrhosis) | + metadata (subject_id from HV/HD/LV/LD aliases) |
| **PRJNA352475** | Ferretti et al. 2018 (mother-infant transmission) | + metadata (subject_id, timepoint, biome) |
| **PRJNA698986 P2 / P3** | Lou et al. 2023 (early-life metagenomes) | + metadata (subject_id, DOL timepoint) + plate map |
| **PRJEB10878 / PRJEB12449 / PRJEB32731 / PRJEB83730** | various | abundance + events only |
| **PRJNA763023 / PRJDB4176 (&times; 4 profilers)** | synthetic contamination benchmarks | abundance + events |

Plus the **welcome-tour demo** (the P3 cohort with curated metadata, plate map, and pre-walked verdicts).

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

Wide format: first column is the species ID, remaining columns are sample IDs. Values are absolute or relative abundances (auto-normalized per sample). The interface can boot without it &mdash; the events table will render and verdicts can be entered &mdash; but the scatterplots, the Decontaminate tab and six of the seven diagnostic criteria depend on it, so curation without an abundance table reduces to taking CroCoDeEL's call at face value.

### `metadata.tsv` (optional, unlocks criterion 07 and sample-context filters)

| canonical name | aliases | type |
| --- | --- | --- |
| `sample_id` | `sample`, `sampleid`, `id` | string &mdash; required |
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

## Citing

If the interface contributes to a publication, please cite CroCoDeEL itself (see `CITATION.cff`).

## License

GNU General Public License v3.0 &mdash; see [`COPYING`](./COPYING).
