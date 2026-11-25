# Catalogisti — 3D & Peliprojektien kirjasto

Open [Catalogisti](index.html) in a regular browser or host the static bundle on
GitHub Pages. On Windows, `Open_Asset_Browser.cmd` at the project root opens a
local browser tab with CORS support for large local 3D model files:

```powershell
python tools/asset_catalog/serve.py
```

Click **+ Tuo kansio** (or drag and drop a project folder onto the grid) to
connect your own local model folder for any game or project — even when
viewing Catalogisti on GitHub Pages. Subfolders inside your imported folder
appear automatically under **Projektit ja kansiot**, and `.glb` files stay
locally in your browser without uploading. Choose a version or a project texture
in an asset's inspector panel, use **Laatuarvio** checkboxes (*Voitais
kokeilla pienentää vielä kolmioita*, *Toinen samanlainen modelli on jo*), and
export your review decisions with **Vie**.

## Modly weapon parts

The batch manifest is at `source_art/mindflower_weapon_parts/manifest.json`.
The local catalog links each entry to its importable Modly workflow. Each
workflow feeds the same source image into TripoSG and TRELLIS.2 GGUF Texture
Mesh, and feeds the TripoSG mesh into Texture Mesh. Use the named image in
`references/` if Modly asks to locate the source after moving this project.

```powershell
python tools/asset_catalog/weapon_workflows.py
python tools/asset_catalog/build.py
```

Place each resulting GLB in `source_art/mindflower_weapon_parts/models/`
using the manifest's `file_id` and the `.glb` extension. The next catalog
build associates it with its source views and measures the actual result. Check
the 3D silhouette, texture, game scale and sockets before approving a part.

## Review workflow

Review the asset, a particular GLB, or a texture separately. Decisions are
**Hyväksytty**, **Generoi uudelleen** and **Poistoehdotus**. A removal flag is a
review decision. Save your notes and use **Vie arviot** to download them.
**Tuo arviot** merges by newest update. To share decisions on GitHub, replace
`asset_catalog/reviews.json` with the export and rebuild. A GLB replaced with
different bytes gets its own review. Texture decisions use their repository path.

## Inventory and publishing

```powershell
python -m pip install Pillow
python tools/asset_catalog/build.py --refresh-modly "$env:USERPROFILE/Documents/Modly/workspace"
python tools/asset_catalog/build.py --pages scratch/asset-catalog-pages
```

The builder scans the Mindflower tree and keeps an audit of scanned GLBs and glTFs
in `inventory.json`. Scratch, third-party demos, animation-only files and terrain
are excluded from the catalog. Two identified working variants are explicitly
retained in the listing. The separate Modly snapshot uses workspace-relative paths
and contains the V15 sets and identifiable steampunk parts. The snapshot can be
rebuilt without contacting Modly, from original files and the local run history.

Use `--stage-modly-previews` together with `--refresh-modly` to copy selected
existing Prepare for Game outputs to `hosted_models/`. This makes those particular
versions available on Pages. The choices use the recorded output, the configured
virtual size and triangle budget. They remain candidates for visual review. The
remaining external versions require the workspace files to be provided locally.
GLB files selected for the hosted build contain embedded material textures.

The installed Modly processing engine also has a local batch entry point.
`tools/asset_catalog/prepare_local.py` accepts the installed API directory and
the Modly workspace. Run it with a Python environment that already supplies
Modly's mesh dependencies. The receipt lives beside the derived GLBs at
`source_art/asset_catalog_modly_prepared/batch.json`. The batch publishes a
candidate only after measuring its triangle count and scale and checking the
source material channels and named sockets. Files marked over budget require
retopology and texture reprojection review.

The Pages workflow builds only the static catalog artifact. In the GitHub repo,
set **Settings → Pages → Source → GitHub Actions** and run **Mindflower Asset
Catalog** from the default branch. The **publish** checkbox controls deployment.
The workflow output also provides a downloadable artifact. Check the repository
audience before selecting publish, since the artifact includes actual review
models and selected production textures.

## Reading the metrics

- Polygon count is the triangulated geometry referenced by glTF's default scene.
  Counts include repeated mesh nodes. Bounds use transformed accessor boxes in
  X × Y × Z. These are estimates for rigid rest pose. An uncalibrated model's
  file dimensions are distinct from its intended in-game size.
- Material tags come from source descriptions, filenames or material names.
  Unlabelled materials require visual identification.
- Bound GLB channels and separate file maps have independent evidence. A height
  map inferred from a source texture is surface relief. Gaussian records report
  point counts.
- A Modly badge requires a recorded successful Prepare for Game run. A bake badge
  means a baked GLB exists. Review decisions, fitting, rigs, LODs, and Godot
  validation are tracked separately from the processing stage.
- The hosted artifact includes the explicitly linked weapon references.
  Unlinked source sheets and ground assets are omitted from hosted media.
