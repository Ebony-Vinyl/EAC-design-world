# Shotcraft Backend Library

The portable snapshot lives under `vendor/video-shotcraft`. It imports 150
previewed styles from 124 upstream recipes at revision
`43bd349a136651865ecfa6ea1cf012f6e957d304`. The local picker supplies 59
recommendations and Chinese category labels. Code, recipe text, shared fixtures,
textures, license and research attribution are retained from the pinned checkout.

`src/shotcraft-library.mjs` owns the import read surface. `getTemplates`,
`getTemplate` and `resolveTemplate` in `src/catalog.mjs` recognize `sc-*` IDs.
The library API and tool endpoints expose the same entries as `kind: motion`
and `source: video-shotcraft`.

## Metadata Contract

Each entry includes `category` (Chinese), `categoryId`, `recommended` (boolean),
`recommendedUse`, `recipe`, `energy`, `use`, `description`, `tags` and numeric
`duration`, `fps`, `width`, `height` measured from the actual preview MP4.
`durationLabel` preserves the upstream recipe's descriptive timing, including
multi-style timings. `composition` records the upstream implementation's standard
1920x1080, 30fps authoring format separately from the preview dimensions.

`preview` and `thumbnail` are local `/vendor/video-shotcraft/media/*.mp4` and
`/vendor/video-shotcraft/poster/*.jpg` URLs. No original absolute workstation
path is required at runtime. Missing files produce null preview/thumbnail fields.
Existing vendor HTTP routes serve the files with byte-range support.

`library_list` searches Chinese category, recipe, energy, use, recommendation
label and existing name/description/tags/source fields. For example:

```json
{"kind":"motion","query":"video-shotcraft","limit":200}
{"kind":"template","query":"文字与字卡"}
{"kind":"motion","query":"ui-to-brand-morph"}
```

## Read And Render Behavior

```json
{"kind":"motion","id":"sc-blur-slide","source":true}
{"kind":"template","id":"sc-blur-slide","resource":"demos/_fixtures/Look.tsx"}
```

`library_read` returns full recipe `content`, `sourceFiles`, and `resources`.
With `source: true`, `sources` contains the actual upstream TSX files and text.
The `resource` argument can read only a listed local text resource, including
shared fixtures, authoring helpers and attribution. Paths are checked against
the real vendor directory; traversal and escaping symlinks are rejected.

`template_read` supports the same IDs. Its default `content` is the recipe;
with `source: true`, `content` is the first implementation and `sources` includes
all implementation files for that recipe. Multi-style recipes share source
directories; read the recipe and the source filenames before choosing a variant.

The upstream examples are Remotion React/TSX compositions, not `renderAt(t)` or
`__seek(t)` HTML. They have `entry: null`, `renderable: false`,
`available: false` and `status: requires-dependencies`. `sourceAvailable`
indicates that recipe and implementation files exist. EAC's renderer rejects
these entries without an explicitly supplied customized HTML composition.
Preview MP4 playback works locally without installing Remotion.

`asset_import` also accepts a registered Shotcraft `templateId` instead of a
`path`. It resolves only the real local MP4 preview, probes it, and imports it
into the existing project's normal asset collection:

```json
{"projectId":"existing-project-id","templateId":"sc-blur-slide"}
```

Exactly one of `path` or `templateId` is required. Non-Shotcraft IDs,
unregistered IDs and missing local previews are rejected. Existing `path`
imports keep their behavior. Imported footage can be arranged with
`timeline_plan` / `timeline_update` and rendered with a normal `render` job.
This imports the example video; its TSX remains a separate authoring reference.

To reuse TSX, follow the upstream `demos/README.md`: register the selected
component and duration in a Remotion project; copy its fixtures and, where
applicable, `_textures` to `public/textures/live`. Some examples need
`@remotion/motion-blur`. Requirements are returned on each entry. Remotion's
runtime and its separate license are not supplied by this integration.

## Reproduce The Import

Clone the upstream checkout into `.eac/sources/video-shotcraft`, then check out
the pinned revision above. Supply a picker whose sibling `shotcraft/media` and
`shotcraft/poster` folders contain all referenced MP4s and JPGs:

```powershell
node scripts/import-shotcraft.mjs --source .eac/sources/video-shotcraft --picker "D:\path\shotcraft-picker.html"
```

FFprobe must be on PATH, or supplied with `--ffprobe`. `--destination` selects
another repository root. The importer validates the Apache license and exact
revision before copying, parses the picker JSON without executing HTML, verifies
its card/style/category mapping against the upstream catalog, follows explicit
recipe implementation paths, probes every video, and records file hashes.
It refuses an existing destination and stages a complete import before exposing
the catalog. If Windows locks a directory rename, it publishes files first and
the catalog last. `--link-media` stores same-volume MP4/JPG media using NTFS
hard links when a second physical copy is impractical. These are normal files,
not runtime path references: deleting the original directory does not remove
the imported files. Editing either hard-linked name changes the same bytes;
customized footage should be saved to a separate file. It neither installs
packages nor runs upstream scripts.

See `THIRD_PARTY_NOTICES.md`, the upstream license and
`vendor/video-shotcraft/EAC-PROVENANCE.json` for source and media records.
