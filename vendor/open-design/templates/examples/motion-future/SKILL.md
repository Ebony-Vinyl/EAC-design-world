---
name: motion-future
description: "The Future Is Already Here — motion design template. A 20-second electric-blue tech reel, rebuilt from the viral original: 3D cubes, a word tunnel, liquid chrome type, a FUTURE.EXE desktop, a countdown, glass objects and a chrome FUTURE hero, cut to 120 BPM."
od:
  mode: video
  scenario: video
  preview:
    type: html
    entry: example.html
---

# The Future Is Already Here

A 20-second electric-blue tech reel, rebuilt from the viral original: 3D cubes, a word tunnel, liquid chrome type, a FUTURE.EXE desktop, a countdown, glass objects and a chrome FUTURE hero, cut to 120 BPM. `example.html` is the finished reference — start from it.

## Source
A remake of a viral post by Douyin: https://www.douyin.com/video/7690393045783346918 (6,439 likes · 2,164 saves · 1,285 shares on Douyin (as of 2026-10-12)). The composition is
rebuilt in code from the published piece; the soundtrack is original.

## Reference files
Copy `example.html`, `assets/gsap.min.js`, `assets/three-addons.js`, `assets/unbounded-black-glyphs.js`, `assets/jetbrains-mono-OFL.txt`, `assets/jetbrains-mono-subset.ttf`, `assets/soundtrack.mp3`, `assets/three.min.js.gz`, `assets/unbounded-OFL.txt`, `assets/unbounded-subset.ttf` into the composition, preserving the `assets/` path.
Font licenses travel with their fonts. Use these frozen local bytes; no runtime
script or font CDN is needed.

The gallery loads `assets/three.min.js`. The frozen reference package carries
the same Three.js bytes compressed as `assets/three.min.js.gz` to fit the
per-file budget. Before rendering, decompress it into the composition:
`gzip -dc "<reference-root>/assets/three.min.js.gz" > "<composition-root>/assets/three.min.js"`.
Both placeholders are the actual reference and composition directories in this
task. Keep the HTML script URL pointing to the decompressed `.js` file.

## Art direction
- Electric blue, black, white and chrome; heavy display type Unbounded Black with JetBrains Mono for the HUD (both SIL OFL, bundled).
- Three.js for the 3D layer (`#gl`) under a 2D overlay canvas (`#ui`). All scenes are readable code inside `example.html`.
- `assets/three-addons.js` holds the three.js add-ons the film needs (RoomEnvironment, FontLoader, TextGeometry), unbundled. `assets/unbounded-black-glyphs.js` holds Unbounded Black outlines for every 3D word: A–Z, a–z, 0–9 and common punctuation.
- The original is a 62s Chinese post; this reference is a 20s English highlight cut.

## Beat map (20s)
- 0–1.5 cubes 1→4→64 · 1.5–2.5 SIGNAL · 2.5–4.0 retina + 97.2% · 4.0–5.0 word tunnel WAKE UP · 5.0–6.0 THE FUTURE · 6.0–6.5 liquid chrome FUTURE
- 6.5–7.5 AL READY / HERE · 7.5–9.0 FUTURE.EXE desktop · 9.0–9.5 LOADING 99% · 9.5–11.0 3·2·1 · 11.0–13.0 PRISM / BOLT / PLANET / MIND
- 13.0–14.0 ring vortex · 14.0–14.5 checker grid · 14.5–18.5 chrome FUTURE hero · 18.5–20.0 glitch → END OF TRANSMISSION

## Adapting the template
- Change the copy in `CFG` at the top of `example.html`: `brand`, `headline`, `hero` (the chrome 3D word, scaled to fit when longer than FUTURE), `heroLine`, `date`, `signal`, `wake`, `awaken`, `tags`, `objects` and `endLine`.
- Keep hard cuts on the 120 BPM grid, the scene order in `EDIT` and the chrome hero. Scene code lives in the same file, grouped by scene.
- 3D words support Latin letters, digits and common punctuation; the bundled display font covers Latin only.

## How the reference is built
- One composition root with canvas layers. A single `render(t)` draws the
  whole frame from the master timeline time `t`; constants at the top hold copy,
  palette and timing so the film can be re-themed in one place.
- Every visible value is a pure function of `t` (eases, springs or keyframes
  evaluated from time). No state carries between frames.

## Preview and video export
Keep the stage edge to edge in both gallery and MP4 capture. Playback controls
are an overlay that stays transparent until hovered or focused; never reserve
stage space for them or include them in the poster. Inside an Open Design
project the motion source player fits the stage and owns the controls, so the
preview shell yields its own fit and controls there.

The GSAP master timeline is the only clock. Render every visible layer from
its current time in the per-frame loop: export seeks suppress timeline
callbacks. Schedule the next animation frame before drawing so one failed
frame cannot stop the loop. Backward seeks must reproduce identical frames.
Await bundled fonts before playback and signal preview-ready at a legible hero
frame. Preserve `window.__timelines` and the composition's timing attributes.
Avoid large canvas gradients and per-pixel noise: they make every captured
frame expensive and slow the MP4 export.

## Sound
`assets/soundtrack.mp3` is an original 20-second score made for this template
and timed to its beats; no audio from the source video is used.
The music is part of the look being remade. These rules replace the general
sound guidance for this remake; apply the first one that matches the brief:

1. The user asks for no music: remove the `<audio>` element, do not copy the
   file, and freeze `motionDelivery.audio` as `silent`.
2. The user supplies an audio file and asks to use it: copy it into the film's
   `assets/` and point `<audio id="soundtrack">` at it.
3. Otherwise keep this score, including when the brief asks for different
   music, a genre or a mood. This flow cannot generate music: never generate,
   download or synthesize audio, and do not add voiceover.

Under rules 2 and 3, freeze `motionDelivery.audio` as `required`.

Keep `id="soundtrack"`, `data-start="0"` and a numeric `data-volume`. Set
`data-duration` to the shorter of the music and the film (the film's length
when the music's length is unknown); the export fades the music out there.
Never use `loop`: in a film longer than the music, the music plays once and the
rest is silent.

Do not add a music note to the final reply. Only when a music or voiceover
request could not be met, say so in one short sentence.

The `<audio>` element stays inside the composition root; the desktop exporter
mixes its local file into the MP4. Preview sound starts with the film; when the
browser blocks autoplay, the first click or key press turns it on, and Sound off
mutes it. Sound follows the master timeline, including pause and backward
seeks. Keep it silent during frame capture and in sandboxed gallery thumbnails.
