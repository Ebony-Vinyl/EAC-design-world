# Bundled Template Fonts

Latest validation: after the parent installed the original D3, Three.js,
simplex-noise, opentype.js and topojson packages, **13/15 MG styles pass**
the bounded render smoke. Remaining blockers are the 240 Blender plates and
Douyin Sans Bold. The source-render inventory in
`artifacts/fonts-check/all15/summary.json` was regenerated with these results.
Both promo templates also pass after restoring the v2 sample logo and
allowing tightly bounded GPU dithering differences. The earlier table below
records the initial font-only pass before those runtime fixes.

**This software uses HarmonyOS Sans SC. Copyright 2021 Huawei Device Co., Ltd.**
The original HarmonyOS Sans Fonts License Agreement is preserved in
`vendor/fonts/licenses/harmonyos-sans-LICENSE-update.txt`. All other original
licenses and copyright notices are also retained under `vendor/fonts/licenses/`.

```powershell
python -m pip install --target runtime/fonts/python fonttools brotli py7zr
python scripts/provision-fonts.py
python scripts/provision-fonts.py --check
python scripts/provision-fonts.py --smoke
```

The provisioner installs exact upstream families at the paths already declared
by the templates. It does not install or rename system fonts, change template
HTML/JS/CSS, change root npm packages, or run the unsafe vendored font helpers.
It changes font assets under `vendor/` and caches downloads under ignored
`runtime/fonts/`. `--smoke` writes only verification artifacts.

Downloads are limited to 60 MiB per file and 120 MiB of new payload per
invocation. A completely empty cache can require a second invocation: completed
downloads are retained and checked against the source manifest on resume.
This extension added **97.69 MiB of distinct upstream payloads**, reusing the
original Noto Serif SC, Resource Han Rounded, and promo caches. This figure
counts retained source inputs, not HTTP metadata probes or retries.

## Installed Families

| Sources | Exact Families |
| --- | --- |
| Google Fonts, pinned commit | Anton, Archivo italic, Bebas Neue, Caveat, Chakra Petch, Cormorant Garamond, DM Sans, Fredoka, IBM Plex Mono, Instrument Serif, Inter, JetBrains Mono, Long Cang, Luckiest Guy, LXGW Marker Gothic, Michroma, Noto Sans SC, Noto Serif SC, Poppins, Press Start 2P, Rajdhani, Sora, Unbounded, VT323, ZCOOL KuaiLe |
| Google Fonts, template-local files | Unbounded 800, Outfit 600, Fraunces at `opsz=72,wght=900,SOFT=100,WONK=1`, Mr Dafoe Regular |
| Alibaba official font CDN | Alibaba PuHuiTi 3.0 Regular/Medium/Bold/Heavy/Black; Alimama ShuHeiTi Bold |
| Huawei official design resources | HarmonyOS Sans SC variable font, unmodified |
| TakWolf official release `2026.10.16` | Fusion Pixel 12px Prop zh-Hans, 12px proportional |
| CyanoHao official release `v0.990` | Resource Han Rounded CN Bold/Heavy |
| Fontsource `5.2.5` | Promo JetBrains Mono 400/700; Instrument Serif 400 normal/italic; Noto Serif SC CSS subsets at true weights 400/700 |

Google Fonts are pinned to commit
`47d54ca1ebb14fd864695f1d39dc734f39017c33`. Full source URLs, checksums,
byte counts, output paths, font family/name records, variable axes, and
transformations are recorded in `vendor/fonts/manifest.json`. Subsequent runs
reject changes to the recorded source bytes.

Google OFL fonts used as template-local instances preserve their family/name
records. The upstream template CSS aliases `Fraunces Liquid` and `Outfit Morph`
still refer to genuine Fraunces and Outfit; no unrelated fonts are substituted.
Fusion Pixel is decompressed from WOFF2 into TTF without renaming it. Its
existing CSS alias `Fusion Pixel 12` is retained unchanged. The remaining
Google files, Alibaba files, Alimama file, and Resource Han Rounded files are
unmodified upstream TTFs.

Huawei's current official package contains a variable SC TTF. The provisioner
uses the same unchanged bytes at the five existing Light/Regular/Medium/Bold/
Black stylesheet paths; Chromium selects each requested weight from the
variable font. It does not generate modified static Huawei fonts. These paths
are hardlinked when supported: locally they share one file allocation and have
the same SHA-256. Systems without hardlinks receive ordinary identical copies.
There are **205 tracked-in-manifest assets, 142.71 MiB of unique bytes and
223.20 MiB summed across paths**. These totals include licenses and CSS.

Licenses differ: Google/Fusion/Resource Han fonts are OFL except Luckiest Guy
(Apache 2.0); Huawei and Alibaba/Alimama have their own agreements. Original
license text is preserved, including all Fusion Pixel component notices. ZIP
inputs are read by exact member name into memory, with size/type/path checks;
the Resource Han 7z extraction selects only known regular font members.

**Still missing:** `Douyin Sans`, expected at
`vendor/mg-styles-15/assets/fonts/cjk/douyinsans/DouyinSansBold.ttf`.
No usable official download with its original license was obtained in this
bounded pass. An unofficial npm listing without an adequate original license
was not used. The provisioner and offline check explicitly print this gap;
neither claims that all font families are installed.

## Font Coverage

The full Noto Serif SC variable TTF supports MG02's actual weight 300 and the
other templates' weights without substituting another CJK family. The full
Noto Sans SC variable font serves its own exact family. Promo CSS downloads only
the upstream unicode-range subsets intersecting the bundled HTML, preserving
real weights 400/700. Re-run provisioning after editing promo text; characters
introduced solely at runtime can require additional subsets.

MG's existing `.gitignore` ignores TTF assets. When committing, force-add the
font output paths from `manifest.json`, including the four template-local files.
The ignore rules and git index were left unchanged.

## All 15 Smoke Results

Verified locally on October 17, 2026. Every MG catalog entry received an actual
sequential `src/render-template.mjs` call with
`{templateId, duration:0.5, fps:6, scale:0.25, outputPath}`.
Each successful preview is a three-frame, 480x270 H.264 MP4 with media QA,
determinism, and `productionReady: true`.

Separate browser audits load the actual template stylesheets and test each
required face using `document.fonts.load` plus Chromium's
`CSS.getPlatformFontsForNode`. A font check passes only if the requested face
loads and every tested glyph uses a custom font. Static inventory also checks
the upstream site's listed source/image/audio/shared files and local fonts.
There were **74/75 passing face checks; 14/15 styles have complete font checks;
7/15 styles passed the render smoke**.

| Style | Font Checks | Actual Render / Blocker |
| --- | --- | --- |
| `05-cel-boil` | 3/3 | BLOCKED: missing `simplex-noise` browser module |
| `03-isometric` | 7/7 | BLOCKED: missing `three` browser module |
| `01-flat-vector` | 3/3 | PASS |
| `02-line-art` | 2/2 | PASS |
| `04-3d-render` | 2/2 | BLOCKED: renderer Blender guard; all 240 required PNG plates absent |
| `08-morph` | 8/8 | FAIL: repeated-frame determinism check; no missing assets |
| `19-paperclip` | 6/6 | BLOCKED: missing D3/topojson browser libraries; `d3 is not defined` |
| `22-hud` | 9/9 | BLOCKED: missing D3/topojson/Three.js browser libraries |
| `06-collage` | 7/7 | PASS |
| `12-aurora-glass` | 7/7 | PASS |
| `09-bauhaus` | 3/3 | PASS |
| `10-synthwave` | 4/4 | BLOCKED: missing Three.js/simplex-noise/opentype browser modules |
| `20-pixel` | 2/2 | PASS |
| `07-liquid` | 5/5 | PASS |
| `18-hanazi` | 6/7 | BLOCKED: missing Douyin Sans Bold |

The successful 0.5-second previews prove bounded startup/render support, not a
complete 10-second production delivery or audio validation. Additional t=8.8
screenshots were visually inspected for the eight templates that initialized,
including MG08 despite its failed determinism test. The optional `?v5=1`
variants were not rendered in this pass.

## Exact Remaining Assets

| Category | Missing Paths / Evidence |
| --- | --- |
| Font | `/assets/fonts/cjk/douyinsans/DouyinSansBold.ttf` (MG18; also referenced by some optional v5 variants) |
| Blender | `/demos/04-3d-render/out/frames/0000.png` through `0239.png`; static audit confirms 240 absent plates |
| JavaScript dependency | `/node_modules/simplex-noise/dist/esm/simplex-noise.js` |
| JavaScript dependency | `/node_modules/three/build/three.module.js` and its `examples/jsm/postprocessing/{EffectComposer,RenderPass,ShaderPass,UnrealBloomPass}.js` imports |
| JavaScript dependency | `/node_modules/d3/dist/d3.min.js`, `/node_modules/topojson-client/dist/topojson-client.min.js` |
| JavaScript dependency | `/node_modules/opentype.js/dist/opentype.mjs` |
| Image / texture | None missing in this inventory/browser snapshot, apart from the separately categorized Blender plates |
| Runtime determinism | MG08: mean RGB difference `0.22992541152263374`, significant pixel ratio `0.00008487654320987654`; screenshots/metrics retained |

No missing font was replaced with another Chinese family, no image was
fabricated, no runtime library was installed outside this font scope, and no
renderer tolerance was changed.

## Evidence

`artifacts/fonts-check/all15/summary.json` contains every style's result.
Each style's directory contains `font-inventory.json`, including individual
face/platform-font checks, page errors, classified failed requests, and the
static missing-file inventory. Successful renders also have `preview.mp4` and
`template-report.json`. MG08 has `determinism-a.png`, `determinism-b.png`, and
`determinism.json`. `contact-sheet.jpg` shows the eight later-time screenshots.
Artifacts are local and ignored by git; this table preserves the findings.

The original classic and MG01/MG02 one-second renders passed. The parent has
subsequently repaired v2's compositor-tolerance check and restored `logo.jpg`,
and reports v2 deterministic and production-ready. That supersedes the earlier
v2 failure recorded during initial font provisioning. This all15 pass leaves
the parent's promo/runtime work unchanged.
