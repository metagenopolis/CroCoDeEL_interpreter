# CroCoDeEL Interpretation Interface

A browser-based curation interface for [CroCoDeEL](https://github.com/metagenopolis/CroCoDeEL) contamination calls. Load a `contamination_events.tsv` and the matching `species_abundance.tsv` (and optionally a sample metadata file and a plate map), walk every flagged event through a scatterplot and seven diagnostic criteria with full sample/plate context, then commit a two-layer curation: an **event evaluation** (true positive / false positive / uncertain / pending) and, on the target sample, a **sample-level verdict** with an optional **keep / suppress** action. Export a curated TSV, a self-contained HTML report, or a full session JSON.

> **Live:** https://metagenopolis.github.io/CroCoDeEL_interpreter/
>
> Everything runs client-side &mdash; **no data ever leaves the browser**. The session is auto-persisted to `IndexedDB` (no upload, no server).

The in-app **Help** tab is the authoritative reference for tabs, curation model, diagnostic criteria, file format aliases, keyboard shortcuts and configuration.

## Bundled datasets

Loadable in one click from the **Datasets** tab. Several ship with curated `metadata.tsv` and / or `plate_map.tsv` so the same-individual and proximity criteria can score. A welcome-tour demo (Lou et al. 2023, P3 cohort) is also bundled.

## Input formats

All files are TSV. Column names are matched against several aliases (case-insensitive); the in-app **Help** tab carries the full table.

- `contamination_events.tsv` &mdash; **required.** CroCoDeEL output: `source`, `target`, `rate`, `probability`, `contamination_specific_species`. Header lines starting with `#` are parsed as run metadata.
- `species_abundance.tsv` &mdash; **required for the scatterplots and diagnostic checks.** Wide format: first column = species id, remaining columns = sample ids.
- `metadata.tsv` &mdash; *optional.* Unlocks the same-individual criterion and sample-context filters. Recognised fields include `sample_id`, `sample_name`, `subject_id`, `timepoint`, `biome`, `low_biomass`, `low_sequencing_depth`, `group_id`. Extra columns surface as generic pills.
- `plate_map.tsv` &mdash; *optional.* Unlocks the Plate tab and adjacency filters. Columns: `sample_id`, `plate`, `well` (alphanumeric or `row` + `column`).

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
