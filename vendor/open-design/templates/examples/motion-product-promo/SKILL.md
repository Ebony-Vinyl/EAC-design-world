---
name: motion-product-promo
description: "Product Promo — motion design template. A 15-second product promo rebuilt from the viral original with a fictional brand: a halftone mascot asks 'Got something to sell?', product cards pop onto blue, a phone store fills in, a checkout board is stamped 'Handled.' and the wordmark closes it."
od:
  mode: video
  scenario: video
  preview:
    type: html
    entry: example.html
---

# Product Promo

A 15-second product promo rebuilt from the viral original with a fictional brand: a halftone mascot asks "Got something to sell?", product cards pop onto blue, a phone store fills in, a checkout board is stamped "Handled." and the wordmark closes it. `example.html` is the finished reference — start from it.

## Source
A remake of a viral post by @achxvi: https://x.com/achxvi/status/2103918792845963545 (1.14M views · 9.1K likes · 8.2K bookmarks on X (as of 2026-10-13)). The composition is
rebuilt in code from the published piece; the soundtrack is original. The original promotes a real company; this remake uses the fictional brand Pennyflow.

## Reference files
Copy `example.html`, `assets/fraunces-OFL.txt`, `assets/fraunces-bold.ttf`, `assets/gsap.min.js`, `assets/instrument-serif-OFL.txt`, `assets/instrument-serif-italic.ttf`, `assets/inter-OFL.txt`, `assets/inter-regular.ttf`, `assets/inter-semibold.ttf`, `assets/jetbrains-mono-OFL.txt`, `assets/jetbrains-mono-regular.ttf`, `assets/soundtrack.mp3` into the composition, preserving the `assets/` path.
Font licenses travel with their fonts. Use these frozen local bytes; no runtime
script or font CDN is needed.

## Art direction
- White `#FFFFFF`, blue `#1F70F3`, ink `#111111`, a light board `#FBFBFB` and near-black `#060606`.
- Fonts (SIL OFL, bundled): Inter Regular and SemiBold for headlines and UI, Fraunces Bold for the wordmark, Instrument Serif Italic for the accent words, JetBrains Mono for labels and the HUD.
- The mascot is a girl with two buns, a rounded bob, fringe locks and a hair clip; she nods and hops on the beat, blinks, follows what appears, and hops with a squash on each reveal.
- The mascot and the product objects are drawn in grey at quarter resolution and ordered-dithered into a halftone, one `halftone()` pass per layer.
- HUD: the chapter label top left, the brand and a 60 fps timecode top right; hidden on the end card.

## Beat map (15s)
- 0–2.45s HOOK: the mascot slides in and whispers "psst…"; "Got something / to sell?" with a blue underline; the question's dot swells into blue.
- 2.45–4.45s ANYTHING: the mascot rises; course, ebook and app cards pop in one by one.
- 4.45–6.95s STORE: a whip to white; "Pennyflow turns it into / a store / in minutes."; a phone store fills in (address, LIVE, avatar, products); the cursor clicks Get it now.
- 6.95–11.2s HANDLED: the camera pulls out of the express-pay button onto a checkout bento: the card number is typed, $9 / month, the workbook upsell, VAT, payouts counting up, Paid, check badges and the "Handled." stamp.
- 11.2–13.3s FLOW: on black, "You create." / "We handle the", the mascot winking and grinning.
- 13.3–15s END: a dithered wipe; "flow." becomes the wordmark's tail, the letters drop in, the head pops up behind it; tagline, Start selling and the footer.

## Character and close
- `SPEECH` lists the visual mouth gestures' start, length and openness; `mouth(t)` opens the mouth and nods the head alongside the copy. These are visual gestures only: the soundtrack is background music, with no voice or simulated speech.
- At the close, "flow." springs out of "We handle the", travels to centre stage and pops into the wordmark's tail while the other letters drop in; the head peeks out from behind the wordmark, hops up and winks.

## Adapting the template
- Swap `CFG.brand`, `CFG.domain`, `CFG.store`, the card, product and checkout copy, prices and palette; keep the six chapters on their timing, and retime `SPEECH` to new lines.

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
`assets/soundtrack.mp3` is an original 15-second background music track made
for this template and timed to its beats, with no voice or simulated speech;
no audio from the source video is used.
The percussion is a quiet, sparse pulse beneath the melody, with no hi-hat,
clap pattern or extra kick impacts on transitions. Preserve this balance.
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
