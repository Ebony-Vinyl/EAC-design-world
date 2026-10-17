---
name: motion-showreel
description: "Motion Designer Showreel — motion design template. A 15-second motion designer showreel at 128 BPM, rebuilt from the viral original: an Open Design mark opener, a stretching wordmark, six easing curves, a morphing shape, a truchet field, a 3D point cloud, kinetic type and an end card."
od:
  mode: video
  scenario: video
  preview:
    type: html
    entry: example.html
---

# Motion Designer Showreel

A 15-second motion designer showreel at 128 BPM, rebuilt from the viral original: an Open Design mark opener, a stretching wordmark, six easing curves, a morphing shape, a truchet field, a 3D point cloud, kinetic type and an end card. `example.html` is the finished reference — start from it.

## Source
A remake of a viral post by @stephanlivera: https://x.com/stephanlivera/status/2103315922098470926 (2.25M views · 17K likes · 13K bookmarks on X (as of 2026-10-05)). The composition is
rebuilt in code from the published piece; the soundtrack is original.

## Reference files
Copy `example.html`, `assets/archivo-OFL.txt`, `assets/archivo-condensed-black.ttf`, `assets/archivo-expanded-black.ttf`, `assets/archivo-extrabold.ttf`, `assets/gsap.min.js`, `assets/instrument-serif-OFL.txt`, `assets/instrument-serif-italic.ttf`, `assets/jetbrains-mono-OFL.txt`, `assets/jetbrains-mono-bold.ttf`, `assets/jetbrains-mono-medium.ttf`, `assets/soundtrack.mp3` into the composition, preserving the `assets/` path.
Font licenses travel with their fonts. Use these frozen local bytes; no runtime
script or font CDN is needed.

## Art direction
- Hard colour cuts in the Open Design palette: near-black `#202020`, Open Design green `#87EA5C`, paper `#FAFAFA`, deep green `#007106` and pale green `#D0FFB5`; ink `#26251E`.
- Fonts (SIL OFL, bundled): Archivo Expanded Black and Condensed Black for display type, Archivo ExtraBold, Instrument Serif Italic for the role line, JetBrains Mono for the HUD.
- HUD on every frame: corner marks, brand and "MOTION REEL — 2026", chapter label, timecode, 60 FPS, 128 BPM with four beat squares, BAR n/8 and a progress line.

## Beat map (15s)
- 0–2.0s IDENTITY: rays burst from a dot and spin, the Open Design mark draws on and fills with a flash, orbiting type, a paper circle wipe.
- 2.0–3.5s the wordmark slides in on two lines, squeezes and settles; "motion designer" in serif italic.
- 3.5–5.5s EASING: "Six ways to get from A to B." — linear, ease-in-out, expo-out, back-out, elastic, bounce.
- 5.5–7.45s MORPHING: circle → triangle → star → squircle with green echoes and twelve satellites.
- 7.45–9.75s SYSTEMS: a paper tile splits into a truchet field crossed by a green wave.
- 9.75–11.2s DEPTH: a point plane folds into a lantern, then a torus.
- 11.2–13.1s KINETIC TYPE: EASE / IN. / EASE / OUT. / NEVER / LINEAR.
- 13.1–15s END: a white ring rolls out, the spinning Open Design mark with confetti settles beside the stacked wordmark, role line and footer.

## Adapting the template
- Swap `CFG.brand`, `CFG.role`, footer copy and palette to the brief; keep the seven chapters on the 128 BPM grid.

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
`assets/soundtrack.mp3` is an original 15-second score made for this template
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
