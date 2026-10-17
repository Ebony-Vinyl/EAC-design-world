# Third Party Notices

This project is licensed AGPL-3.0-or-later. Root `LICENSE` contains its full text.

## 15 Motion Design Styles

- Source: https://github.com/Vincentwei1021/mg-styles-15
- Pinned commit: `49052d80bfaf9fa8412cc9710530e5e95a3b8d8c`
- License: MIT. Copyright (c) 2026 Vincentwei1021.
- Full text and per-asset provenance remain in `vendor/mg-styles-15`.
- Fonts are not included upstream; see `assets/fonts/README.md`.
- Audio instrument samples and image textures retain their own upstream notices.

## Local Motion Skills

The maintainer supplied local copies of the `motion-promo-film` and
`motion-promo-film-v2` authoring skills.

They are copied under distinct `vendor` directories as local reference and template material.
Their presence is not a grant of redistribution rights for every constituent asset.
The classic skill's optional `templates/lib/motion.js` is marked PolyForm Noncommercial
by its own `POLYFORM-NOTE.md`. It and its optional plus-template consumer are excluded
from this public repository and Release packages. EAC's default classic entry uses the
base template. The retained note documents the excluded component's original terms.

## Font distribution

Alibaba PuHuiTi 3 and Alimama ShuHeiTi font binaries are not redistributed in
Release media assets. Their license records remain under `vendor/fonts/licenses/`;
obtain those optional fonts from the official providers using the provisioning script.
OFL/HarmonyOS fonts retain the original notices shipped with their source records.

## Other Inspiration

Video-Use, HyperFrames, Manim, Remotion, OpenMontage and FFmpeg are referenced for
workflow ideas. No licensing claim is made on behalf of those projects. Their names
do not mean their complete engines or commercial services are embedded here.

FFmpeg is invoked as an independently installed executable. Node dependencies
retain their original licenses and bundled notices.

## OpenDesign content library

- Source snapshot: OpenDesign (`https://github.com/nexu-io/open-design`), version 0.25.1.
- Upstream repository license: Apache-2.0 (`vendor/open-design/UPSTREAM-LICENSE.txt`).
- Pinned revision: upstream package version `0.25.1`. The snapshot ships no `.git`,
  so the revision is pinned additionally by a content digest over every imported
  file: `sha256:6cb6bbca75b4c1da6e34254eb01ab507575d9c1f3ea490e12e57a79147a105c5`.
  Recorded in `vendor/open-design/PROVENANCE.json` and `vendor/open-design/catalog.json`.
- Imported by `scripts/import-open-design.mjs`; indexed by `src/open-design-library.mjs`.
  Only content directories were copied — no upstream application tree, `node_modules`
  or `.git`. Every catalog entry carries its own `license`, `licenseSource` and
  `sourceUrl`; see `vendor/open-design/catalog.json` for per-item provenance.

Imported counts (real, from the catalog, not estimated):

| Collection | Count |
| --- | --- |
| Design systems (`design-systems/**`) | 152 |
| Templates total | 517 |
| — examples (`plugins/_official/examples`) | 188 |
| — design templates (`design-templates`) | 115 |
| — video templates (`plugins/_official/video-templates`) | 63 |
| — image templates (`plugins/_official/image-templates`) | 45 |
| — video prompt templates (`prompt-templates/video`) | 58 |
| — image prompt templates (`prompt-templates/image`) | 48 |
| Skills (`skills`) | 169 |
| Atoms (`plugins/_official/atoms`) | 13 |
| Scenarios (`plugins/_official/scenarios`) | 14 |
| Total entries | 865 |

Per-item license summary: MIT 431, Apache-2.0 288, CC-BY-4.0 144. Two image
prompt templates record an original X/Twitter post rather than an SPDX license
(`od-pi-profile-avatar-seedream-high-fashion-dreamy-portrait`,
`od-pi-social-media-post-seedream-squishcraft-kids-clay-ad`); these are flagged
`redistributable: false`. Their prompt text and local preview media are excluded
from public Git and Release files; catalog entries resolve only to attribution stubs.
The recorded upstream digest describes the imported snapshot before this publication filter.

### Upstream content sources represented in the catalog

- `nexu-io/open-design` — repository content: design systems, examples,
  design templates, skills, atoms, scenarios (Apache-2.0; per-item licenses recorded).
- `nexu-io/html-video` and `heygen-com/hyperframes` — 23 HyperFrames video
  templates, Apache-2.0; several forked from `heygen-com/hyperframes`
  `registry/examples/*`, one derived from `nateherkai/hyperframes-student-kit` (MIT).
  Directory summary: `vendor/open-design/HYPERFRAMES-ATTRIBUTIONS.md`.
- `YouMind-OpenLab/awesome-seedance-2-prompts` — video prompt templates, CC-BY-4.0.
- `YouMind-OpenLab/awesome-gpt-image-2` — image prompt templates, CC-BY-4.0.
- `joeylee12629-star/open-design` and `xiaoTN/zelda-style-image-prompt` — image
  template sources recorded per item.
- Design systems are OpenDesign bundled fixtures derived from curated
  `DESIGN.md`, `tokens.css` and `components.html`; brand-referencing packages are
  aesthetic inspirations, not official assets of the brands they reference.
  `vendor/open-design/design-systems-README.md` records the upstream attribution.

Attribution is preserved per item in `catalog.json` (`provenance`, `attribution`,
`licenseSource`, `sourceUrl`); the notices above are the directory-level summary
required by the upstream licenses.

