# CroCoDeEL Interpretation Interface

A browser-based curation interface for contamination events reported by [CroCoDeEL](https://github.com/metagenopolis/CroCoDeEL). Load a `contamination_events.tsv` and the matching `species_abundance.tsv` (and optionally a sample metadata file and a plate map), walk every flagged event through a scatterplot and seven diagnostic criteria with full sample/plate context, then commit a two-layer curation: an **event evaluation** (true positive / false positive / uncertain / pending) and, on the target sample, a **sample-level verdict** with an optional **keep / suppress** action. Export a curated TSV, a self-contained HTML report, or a full session JSON.

> **Live:** https://metagenopolis.github.io/CroCoDeEL_interpreter/
>
> Everything runs client-side &mdash; **no data ever leaves the browser**. The session is auto-persisted to `IndexedDB` (no upload, no server).

The in-app **Help** tab is the authoritative reference for tabs, curation model, diagnostic criteria, file format aliases, keyboard shortcuts and configuration.

## Bundled datasets

Loadable in one click from the **Datasets** tab. Several ship with curated `metadata.tsv` and / or `plate_map.tsv` so the same-individual and proximity criteria can score. A welcome-tour demo (Lou et al. 2023, P3 cohort) is also bundled.

## Input formats

All files are TSV. Column names are matched against several aliases (case-insensitive); the in-app **Help** tab carries the full table. Numbers use `.` as decimal separator and the whole cell must be a number: a file saved with a decimal comma (`0,87`) is refused (events) or reported (abundance) rather than misread. An empty cell or `NA` / `N/A` / `NaN` / `null` / `None` / `-` means no value.

- `contamination_events.tsv` &mdash; **required.** CroCoDeEL output: `source`, `target`, `rate`, `probability`, `contamination_specific_species`. Header lines starting with `#` are parsed as run metadata. The curated events TSV of the Export tab loads here too (so do the curated files of earlier versions, whose columns were named `contamination_rate` and `introduced_species`): its `verdict` and `notes` columns are restored, its `action` column is read but not applied. The samples' verdicts and keep / suppress actions are not restored, so review the Samples tab before exporting the curated abundance table.
- `species_abundance.tsv` &mdash; **required for the scatterplots and diagnostic checks.** Wide format: first column = species id, remaining columns = sample ids.
- `metadata.tsv` &mdash; *optional.* Unlocks the same-individual criterion and sample-context filters. Recognised fields include `sample_id`, `sample_name`, `subject_id`, `timepoint`, `biome`, `low_biomass`, `low_sequencing_depth`, `group_id`. A header must match a recognised name or alias exactly, ignoring case, spaces, `_`, `-` and `.` (`Subject ID` is `subject_id`; `age_group` is not `group_id`), and the metadata card shows which header was read for each field. Extra columns surface as generic pills.
- `plate_map.tsv` &mdash; *optional.* Unlocks the Plate tab and adjacency filters. Columns: `sample_id`, `plate`, `well` (alphanumeric or `row` + `column`), matched like the metadata headers.

## Exports

The **Export** tab writes files meant to load, unchanged, in the next tool:

- `contamination_events_curated.tsv` &mdash; CroCoDeEL's own five columns first, under its names and with its number formatting, below the run's `#` parameter line and a `# study:` line, so CroCoDeEL reads the file back (e.g. to plot the curated events with `plot_conta`); then `introduced_pct`, `verdict`, `action` (the target sample's keep / suppress) and `notes`. It reloads here with its evaluations and notes.
- `species_abundance_curated.tsv` &mdash; the abundance table without the samples whose action is Suppress (and, by default, without the species observed only in those samples). Every remaining column holds the input file's own values (counts stay integers, nothing is renormalised) under the input's first header and in its species order, and the file holds the data only: CroCoDeEL, `pandas.read_csv(path, sep="\t", index_col=0)` and R's `read.delim` read it with their default options. The suppressed samples, the date and the study go to a separate provenance text file. Values written with more than 15 significant digits may differ in their last digit; a session saved by an earlier version, which lacks the input's column totals, exports relative abundances instead (the card says so). The abundance card's Download writes the whole table the same way.
- `samples_curated.tsv` &mdash; one row per sample: metadata, plate position, event counts, and the sample's verdict and action as every view shows them, each followed by its origin (`verdict_origin`, `action_origin`: `manual`, `automatic` when the events that target the sample decide it, `default` for the Not contaminated + Keep of a sample no event targets).

Units are the same in every export: rates are fractions, as in CroCoDeEL's files; the introduced share (`introduced_pct`, `max_target_introduced_pct`, the graph's `max_introduced_pct`) is a percentage of the target's species.

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

> Goulet L. et al., *CroCoDeEL: accurate control-free detection of cross-sample contamination in metagenomic data*, Nature Communications 2026. [doi.org/10.1038/s41467-026-72637-9](https://doi.org/10.1038/s41467-026-72637-9)

See [`CITATION.cff`](https://github.com/metagenopolis/CroCoDeEL/blob/main/CITATION.cff) in CroCoDeEL repository for the full author list and a machine-readable record.

## License

GNU General Public License v3.0 &mdash; see [`COPYING`](./COPYING).
