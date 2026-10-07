# CroCoDeEL Interpretation Interface

A browser-based curation interface for contamination events reported by [CroCoDeEL](https://github.com/metagenopolis/CroCoDeEL). Load a `contamination_events.tsv` and the matching `species_abundance.tsv` (and optionally a sample metadata file and a plate map), walk every flagged event through a scatterplot and seven diagnostic criteria with full sample/plate context, then commit a two-layer curation: an **event evaluation** (true positive / false positive / uncertain / pending) and, on the target sample, a **sample-level verdict** with an optional **keep / suppress** action. Export a curated TSV, a self-contained HTML report, or a full session JSON.

> **Live:** https://metagenopolis.github.io/CroCoDeEL_interpreter/
>
> Everything runs client-side &mdash; **no data ever leaves the browser**. The session is auto-persisted to `IndexedDB` (no upload, no server).

The in-app **Help** tab is the authoritative reference for tabs, curation model, diagnostic criteria, file format aliases, keyboard shortcuts and configuration.

## Bundled datasets

Loadable in one click from the **Datasets** tab. Several ship with curated `metadata.tsv` and / or `plate_map.tsv` so the same-individual and proximity criteria can score. A welcome-tour demo (Lou et al. 2023, P3 cohort) is also bundled.

## Input formats

All files are TSV. Column names are matched against several aliases (case-insensitive); the in-app **Help** tab carries the full table. Numbers use `.` as decimal separator and the whole cell must be a number: a file saved with a decimal comma (`0,87`) is refused (events) or reported (abundance) rather than misread. An empty cell or `NA` / `N/A` / `NaN` / `null` / `None` / `-` means no value. Lines starting with `#` are comments wherever they are, as in CroCoDeEL. A header line that itself starts with `#` (`#OTU ID` from `biom convert`, `#consensus_taxonomy` from mOTUs, `#SampleID` in a QIIME mapping file) is refused with the line to fix when the line read in its place is not a header (a row of numbers in the abundance table, no sample id column in the metadata or the plate map), since CroCoDeEL would skip it too and read the first data row as the header: remove the `#` before running CroCoDeEL and loading the table. An abundance header whose sample ids are numbers is read as it is, as CroCoDeEL reads it, when its first cell names the species column (`species`, `OTU_ID`, `clade_name`, `id_mgs`…, or the first cell of the `#` line), the `#` line named in a warning; otherwise the message also says to delete the `#` line if the line under it is the header. An empty header cell is named `Unnamed: N` (N counted from 0), as CroCoDeEL (pandas) names it; one at the end of the header line with no value under it is ignored. A sample or species id that names a property of every JavaScript object (`__proto__`, `constructor`, `toString`, `hasOwnProperty`, `valueOf`…) is refused, named, by every file and by the session import: rename it in every file. In the abundance table a `#` inside a line also starts a comment (outside a quoted cell), as pandas' `comment="#"` reads it in CroCoDeEL; a warning names the first such line. Every file the interface writes quotes a cell that holds a `#` (as R's `write.table` quotes its ids), so an id such as `Plate#1_A01` loads back whole, here and in CroCoDeEL.

- `contamination_events.tsv` &mdash; **required.** CroCoDeEL output: `source`, `target`, `rate`, `probability`, `contamination_specific_species`. Header lines starting with `#` are parsed as run metadata. The curated events TSV of the Export tab loads here too (so do the curated files of earlier versions, whose columns were named `contamination_rate` and `introduced_species`): its `verdict`, `notes`, `sample_verdict`, `action` and `origin` columns are restored (a target's verdict and action when its rows agree; `origin` marks the events you added by hand), so an export reloaded into an empty session gives back the same evaluations, notes, events added by hand and target verdicts and actions, and with them the same counts and curated abundance table, unless a sample no event targets has a verdict or an action of its own: those, like the notes of the samples, are only in the session JSON. A curated file of an earlier version has no `sample_verdict`: a target with a true-positive event and no action in it comes back suppressed, and the banner names those targets. Notes come back on one line. Its `# study:` line names the study when the session has no title. An events file without CroCoDeEL's run header, carried over into a session, leaves the session's run parameters (and so its diagnostics) in place. Loading another events file into a session that holds curation asks first, saying how many of your events the new file does not have: carry the evaluations over to the new file (matched by source and target; the events you added by hand are kept, and stay yours when the new file has their pair), start fresh, or cancel.
- `species_abundance.tsv` &mdash; **required for the scatterplots and diagnostic checks.** Wide format: first column = species id, remaining columns = sample ids. A header with one cell fewer than the rows, as R's `write.table` writes it (no cell above the row names), names samples only: the first cell of each row is its species, as CroCoDeEL (pandas) reads it; the card says so and the downloads keep that layout. Rows that end with one tab more than the header line (an empty cell under no header) are read as the header says, with a warning: CroCoDeEL (pandas) reads such a table as one without a species cell and names every sample one column off. A tab at the end of every line, the header's included, under a header that starts with a sample (R's layout saved from a spreadsheet with an empty last column) shifts nothing: CroCoDeEL reads it right, and so does the interface. A table CroCoDeEL cannot read at all (pandas stops on a first row two cells or more longer than the header, or on a later row longer than every line above it) still loads, with a warning naming that line, and cells past the header are left out; R's layout whose rows end with tabs its header line lacks is read without a cell above the species.
- `metadata.tsv` &mdash; *optional.* Unlocks the same-individual criterion and sample-context filters. Only `sample_id` is required; recognised fields include `sample_name`, `subject_id`, `timepoint`, `biome`, `low_biomass`, `low_sequencing_depth`, `group_id`. A file without a subject column loads with a warning, and no two of its samples count as the same subject (a `host` column is the host organism, not a subject: the subject is `host_subject_id`). A header must match a recognised name or alias exactly, ignoring case, spaces, `_`, `-` and `.` (`Subject ID` is `subject_id`; `age_group` is not `group_id`), and the metadata card shows which header was read for each field. Extra columns surface as generic pills.
- `plate_map.tsv` &mdash; *optional.* Unlocks the Plate tab and adjacency filters. Columns: `sample_id`, `well` (alphanumeric or `row` + `column`) and, optionally, `plate` (without it every sample is on one plate, `P1`), matched like the metadata headers.

## Exports

The **Export** tab writes files meant to load, unchanged, in the next tool:

- `contamination_events_curated.tsv` &mdash; CroCoDeEL's own five columns first, under its names and with its number formatting, below the run's `#` parameter line and a `# study:` line, so CroCoDeEL reads the file back (e.g. to plot the curated events with `plot_conta`); then `introduced_pct`, `verdict`, `action` (the target sample's keep / suppress), `notes`, `sample_verdict` (the target sample's verdict: `contaminated`, `correct` for Not contaminated, `uncertain`) and `origin` (`manual` for an event added by hand). It reloads here with its evaluations, notes, target verdicts and actions, and the events added by hand. In pandas or R, skip the leading `#` lines rather than pass `comment="#"`, which cuts a note at a bare `#` in a file an earlier version exported: with `n` the number of lines that start with `#` at the top (none to two), `pandas.read_csv(path, sep="\t", skiprows=n)` or `read.delim(path, skip = n)`. A cell holding a `"` or a `#` is quoted the CSV way (`"5"" tube"`, `"well #3"`), which pandas, R and CroCoDeEL read back as written.
- `species_abundance_curated.tsv` &mdash; the abundance table without the samples whose action is Suppress (and, by default, without the species observed only in those samples). Every remaining column holds the input file's own values (counts stay integers, nothing is renormalised) under the input's first header (or none, for a header written without one by R's `write.table`) and in its species order, and the file holds the data only: CroCoDeEL, `pandas.read_csv(path, sep="\t", index_col=0)` and R's `read.delim` read it with their default options. The same click writes its provenance next to it, `species_abundance_curated.provenance.txt`: the suppressed samples, the species dropped with them, the date and the study of that very table. A value written with up to 15 significant digits comes back exactly; one written with 16 or 17 comes back as the same double or, when the double next to it makes the same relative abundance, as that one (a relative difference of about 2e-16, which can change its last one or two digits). The abundance card's Download writes the whole table the same way. A session saved by an earlier version, which lacks the input's column totals, exports both as relative abundances instead, and the Export card and the abundance card say so.
- `samples_curated.tsv` &mdash; one row per sample: metadata, plate position, event counts, and the sample's verdict and action as every view shows them, each followed by its origin (`verdict_origin`, `action_origin`: `manual`; `automatic` when the rule sets it — the verdict the events that target the sample call for, or the Suppress that goes with a Contaminated verdict, one set by hand included; `default` for the Not contaminated + Keep of a sample no event targets), then the notes and the study (the session's title, on every row). `is_control`, `is_low_biomass` and `is_low_sequencing_depth` are empty where the metadata does not say (no metadata, no row, no column, an empty cell); `max_target_rate` is written as CroCoDeEL writes a rate, every digit kept. The header is the first line, so pandas and R read it with their default options.

The contamination graph (GraphML, or a node + edge CSV pair) carries the same origins next to each sample's verdict and action (`sample_verdict_origin`, `sample_action_origin`).

Units: rates are fractions in the TSV and graph files, as in CroCoDeEL's files (`0.704`), and percentages with a `%` sign in the HTML reports, as on screen (`70.40%`); the introduced share (`introduced_pct`, `max_target_introduced_pct`, the graph's `max_introduced_pct`, the reports' introduced %) is a percentage of the target's species in every export.

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

The repository ships with `.github/workflows/deploy.yml` &mdash; pushing to `main` runs the tests (`.github/workflows/test.yml`: lint of the rules of hooks, unit tests, build, then every browser suite), and once they pass builds the bundle and deploys it to GitHub Pages. Pull requests run the same tests. Locally, `npm run test:e2e` runs the browser suites four at a time (`E2E_JOBS` sets how many; `node e2e/run-all.mjs <suite> …` runs only those). The Vite `base` is set to `/CroCoDeEL_interpreter/` to match the public URL.

## Tech stack

- React 18 + Vite
- Tailwind CSS (with CSS variables for the dark theme)
- D3 for color interpolation and the network force-layout
- `react-range` for dual-thumb sliders
- `lucide-react` icons
- Raleway and Nunito Sans, served with the app (`public/fonts`, SIL Open Font License), so the interface itself makes no request to another site; only the optional **Run CroCoDeEL** page downloads Pyodide and CroCoDeEL's Python packages from jsDelivr / PyPI, and your files stay in the browser there too
- IndexedDB for the session, one record per part (inputs, curation, UI state) so that a click rewrites only what it changed, with a one-shot migration from earlier layouts (including the legacy `lz-string`-compressed `localStorage` payload); without IndexedDB (or with site data blocked) the app runs in memory and says the session is not saved

## Citing

If the interface contributes to a publication, please cite CroCoDeEL itself:

> Goulet L. et al., *CroCoDeEL: accurate control-free detection of cross-sample contamination in metagenomic data*, Nature Communications 2026. [doi.org/10.1038/s41467-026-72637-9](https://doi.org/10.1038/s41467-026-72637-9)

See [`CITATION.cff`](https://github.com/metagenopolis/CroCoDeEL/blob/main/CITATION.cff) in CroCoDeEL repository for the full author list and a machine-readable record.

## License

GNU General Public License v3.0 &mdash; see [`COPYING`](./COPYING).
