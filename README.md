# CroCoDeEL Interpretation Console

A browser-based curation interface for [CroCoDeEL](https://github.com/metagenopolis/CroCoDeEL) contamination calls. Load a `contamination_events.tsv` (and optionally an abundance table, sample metadata, and a plate map) and walk through every flagged event, looking at the scatterplot, the 5-criteria diagnostic checks, and the well/sample context, then commit a verdict (true positive / false positive / uncertain) with notes. Export a curated TSV or a self-contained HTML report.

Everything runs client-side &mdash; no data ever leaves the browser.

## Features

- **Overview tab** &mdash; run parameters, headline counts (events, mean rate, mean introduced %), top/bottom 5 events by probability, rate, and species impact.
- **Events table** &mdash; sortable, filterable rows. Filters: text search, min probability, min rate (log-scaled 0.01% &ndash; 100%), min introduced %, verdict, hide-related-pairs, adjacent-only.
- **Guided validation** &mdash; per-event scatterplot in log-log space with the contamination line drawn at `log10(rate)`, plus 5 automatic diagnostic checks (line shape, n on line, decade range, missing source species, points above line).
- **Network tab** &mdash; force-directed graph of events; arrow thickness scales with rate, color encodes verdict, salmon nodes mark cascade samples.
- **Plate tab** &mdash; visualize events on the physical plate layout (when `plate_map.tsv` is provided); adjacent-well events are highlighted as suspect well-to-well leakage.
- **Bulk apply by criteria** &mdash; assign a single verdict to every event matching probability / rate / introduced % ranges plus the 5-criteria pass/fail filters.
- **Manual exploration** &mdash; pick any pair of samples to inspect their scatterplot, even pairs CroCoDeEL did not flag, and add the pair as a manually-curated event (useful for catching false negatives).
- **Three primary metrics** displayed everywhere events appear: probability, contamination rate, and introduced % (= introduced species / target's total species).
- **Export** &mdash; curated TSV (TP-only or all-except-FP), JSON audit trail, or a standalone HTML report with embedded plots.

## Input formats

All files are TSV (tab-separated). Column names are matched against several aliases (case-insensitive); see the in-app **Help** tab for the full list.

### `contamination_events.tsv` (required)

Output of CroCoDeEL. Recognized columns:

| canonical name | aliases | notes |
| --- | --- | --- |
| `source` | `contamination_source`, `source_sample` | required |
| `target` | `contaminated_sample`, `target_sample`, `contaminated` | required |
| `rate` | `contamination_rate`, `estimated_rate` | required &mdash; relative abundance fraction (0&ndash;1) |
| `probability` | `score`, `rf_score`, `proba` | required &mdash; RF model probability |
| `contamination_specific_species` | `introduced_species`, `species_specifically_introduced`, `species` | comma-separated list |

Header lines starting with `#` are parsed as run metadata (e.g. `# crocodeel version: ... | probability_cutoff: 0.5 | rate_cutoff: 0.0`).

### `species_abundance.tsv` (optional, but unlocks scatterplots and diagnostic checks)

Wide format: first column is the species ID, remaining columns are sample IDs. Values are absolute or relative abundances (auto-normalized per sample).

### `metadata.tsv` (optional)

Per-sample annotations. Recognized columns:

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

### `plate_map.tsv` (optional)

| canonical name | aliases |
| --- | --- |
| `sample_id` | `sample`, `id` |
| `plate` | `plate_id`, `plate_name` |
| `row` | letter or number (`A`&ndash;`H`) |
| `column` | `col`, number |

## Getting started

```bash
npm install
npm run dev          # Vite dev server on http://localhost:5173
```

There is a bundled demo dataset (P3 from Lou et al. 2023) accessible from the welcome banner &mdash; click **Load demo** to see the full workflow without uploading anything.

### Build for production

```bash
npm run build        # static bundle in dist/
npm run preview      # preview the production build
```

The output is fully static and can be served from any HTTP host (GitHub Pages, S3, nginx, etc.).

## Tech stack

- React 18 + Vite
- D3 for scatterplots and the network force-layout
- Tailwind CSS
- `react-range` for dual-thumb sliders
- `lucide-react` icons

## License

INRAE Metagenopolis &mdash; internal tool.
