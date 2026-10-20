# Media execution

Dependency-light Node ESM; requires `ffmpeg` and `ffprobe` on PATH. Browser
capture additionally requires root-installed `playwright`, plus Edge on Windows
or a system Chromium on macOS/Linux (Playwright bundled Chromium otherwise).
`EAC_BROWSER` / `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` selects an installed
Chromium executable explicitly. Desktop capture needs Windows (gdigrab) or
macOS (avfoundation) with Screen Recording permission; voice needs Windows
(SAPI) or macOS (`say`) with installed system voices. Missing providers and
media throw; no placeholder output.

Exports from `src/media/index.mjs`:

- `probeMedia(path, { signal? }?)`: duration, dimensions, fps, hasVideo, hasAudio, size,
  absolute path, and original ffprobe `streams` / `format`.
- `analyzeMedia(path, { signal? }?)`: probe metadata plus decoded black/frozen intervals and
  audio mean/peak dB. Content analysis covers the first 120 seconds; returns
  `analyzedDuration` and open interval starts.
- `analyzeBeats(path, { bpm?, signal? }?)`: measured onset grid, BPM, confidence 0..1,
  full duration and analyzedDuration. First 120 seconds, mono 8 kHz.
  Autocorrelation searches 50..200 BPM; a supplied BPM (30..300) fixes tempo.
  Silence returns no beats and zero confidence, unknown tempo is null.
- `recordBrowser({ url, actions?, outputDir, width?, height?, signal? })`: opens an
  actual browser, captures the page and performs click/fill/wait/scroll actions.
  Returns probe metadata for a uniquely named MP4. Captures approximately
  10 real frames/sec with measured frame durations; encodes at 30 fps.
  No browser audio. Begins after DOM content loads. Defaults 1280x720.
  Selectors use Playwright syntax; scroll selector targets an element, otherwise
  the window. Wait defaults to 1000 ms, scroll deltaY defaults to 600.
- `recordDesktop({ outputPath, duration, fps?, signal? })`: captures the full
  desktop, including cursor, to video without system audio. Windows uses
  gdigrab; macOS uses avfoundation, discovering the screen device index from
  `-list_devices` (override with `EAC_SCREEN_DEVICE`) and clamping fps to the
  1..30 range those devices advertise. Both need Screen Recording permission.
  Duration 0.1..600 seconds, fps 1..60 Windows / 1..30 macOS (default 30).
  On macOS the capture is scaled to at most 1920 px wide, because avfoundation
  reports the display in physical pixels (a Retina screen would otherwise
  record at 2x); `EAC_SCREEN_MAX_WIDTH` changes that cap and `0` keeps the
  native size.
- `synthesizeVoice({ text, outputPath, voice?, rate?, signal? })`: real system
  speech. Windows uses SAPI through `scripts/voice.ps1` (UTF-8 text passed
  through a file, never interpolated into PowerShell code); macOS uses `say`
  with the text as a positional argument after `--`, producing AIFF that FFmpeg
  converts to WAV. Named voice must exist (macOS, see `say -v '?'`); omitted
  voice uses the OS default. Rate is an integer -10..10, default 0; macOS maps
  it onto a words-per-minute range around the 175 wpm default.
  WAV is generated then converted by FFmpeg to the requested audio extension.
- `composeMusic({ outputPath, duration, bpm?, seed?, signal? })`: original stereo music
  synthesized locally with drums, bass, minor chords and a seeded melody.
  Deterministic PCM for the same arguments; WAV is lossless, other audio
  extensions are encoded with FFmpeg. Duration 0.1..600, BPM 30..300
  (default 112), seed is a string or number (default 1).
- `renderTimeline({ project, outputPath, onProgress?, signal? })`: MP4/MOV/MKV
  H.264 output. Progress callbacks receive monotonic fractions in [0,1];
  1 means published. Throwing callbacks propagate. AbortSignal terminates the
  encoder and rejects with AbortError, preserving an existing output.
- `remapTranscriptToTimeline({ segments, clips, assetId })`: pure source-transcript
  to output-caption mapping, returning sorted `{ start, end, text }` rows.
  See caption burn-in below. This helper has no signal or media dependencies.
- `qualityCheck({ path, expectedDuration?, signal? })`: full decode, duration validation
  (tolerance max of 150 ms or two frames), and content analysis.
  Returns `{ ok, errors, warnings, ...analysis }`. Missing/unprobeable inputs
  throw. Decode/content-analysis failures populate errors (analysis is null
  if content analysis could not complete). Cancellation always rejects with
  AbortError instead of becoming a quality failure. Black/static/quiet content
  produces warnings because it can be intentional. Supports files up to one hour; content analysis is sampled to
  the first 120 seconds, while decode validation covers the entire file.

Render project:

```js
const project = {
  id: 'demo', title: 'Demo', width: 1280, height: 720, fps: 30, quality: 'production',
  clips: [
    { id: 'a', assetId: 'asset-a', path: 'D:/shots/scene.mp4',
      kind: 'video', start: 0, duration: 4, sourceIn: 0, volume: 1, track: 0 },
    { id: 'b', path: 'D:/shots/still.png', kind: 'image',
      start: 4, duration: 2, track: 0 },
  ],
  musicPath: 'D:/audio/music.wav',
  voicePath: 'D:/audio/voice.wav',
};
```

Clip paths are required; assetId/id/title are metadata, not asset resolvers.
All times are seconds. Defaults: start/sourceIn/track 0, volume 1.
Dimensions must be even, 16..3840 on each axis, including 2160x3840 portrait
4K; fps integer 1..60. Quality defaults to `draft` (H.264 CRF 20, fast preset).
`production` uses CRF 17 and medium preset; other quality values are rejected.
Timeline duration is max(start + duration), up to 3600 seconds, 1..128 clips.
Clips must fit their source (one output frame tolerance); image sourceIn is 0.
Black fills timeline gaps. Images and video preserve aspect ratio with black
letterboxing. Higher track numbers cover lower ones; later list entries win
ties. Each visual occupies the full canvas including its letterbox.
Original video audio and audio clips are trimmed, volume-adjusted and delayed
to their starts. Silent video is supported. Music loops at gain 0.22, voice
plays once from zero at gain 1. When both are present, voice controls sidechain
compression of the music (10 ms attack, 250 ms release, 8:1 ratio).
The voice control stream is padded with silence so the music can recover
and continue after the narration ends. Original clip audio is not ducked.
The final mix uses single-pass `loudnorm=I=-16:TP=-1.5:LRA=11` and 48 kHz
resampling. The integrated target is approximate for short or highly dynamic
material; silent content stays silent. AAC encoding can slightly change peaks.
Video-only timelines have no audio stream. Audio-only timelines have a black
video canvas. Inputs cannot equal the output path.

## Caption burn-in

`renderTimeline` accepts optional `project.captions` in output timeline seconds
and `project.subtitleStyle`. Captions require FFmpeg built with libass (`ass`
filter), with no additional Node packages. Omitted or empty captions leave the
existing video graph and audio processing unchanged.

```js
project.captions = [
  { start: 0.5, end: 2.8, text: 'Chinese, commas, "quotes" and apostrophes are literal.' },
];
project.subtitleStyle = {
  fontFamily: 'Microsoft YaHei',
  fontSize: 36,
  color: '#ffffff',
  background: '#00000099',
  position: 'bottom',
};
```

Defaults are Microsoft YaHei (installed-font fallback through libass), white
text, black outline, no box, bottom center, and 5% vertical / 4% horizontal
margins. Font size defaults to 5% of output height, minimum 8 pixels.
`fontSize` accepts 1..512 pixels; `position` accepts `bottom` or `top`.
Colors accept CSS `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA` and the names
white, black, transparent, red, green, blue, yellow, cyan and magenta.
An opaque or translucent `background` adds a box; `transparent` keeps the outline.
Font names cannot contain ASS field delimiters or control characters.

Caption times must be finite numbers in 0..3600 with `end > start`; text must
be a string of at most 20000 characters. At most 100000 rows / 2000000 text
characters are accepted. Invalid rows/styles reject before encoding or replacing
output. Cue ends are clamped to the timeline; cues outside it and blank text are
ignored. Times round upwards to ASS centiseconds; intervals shorter than that
precision may disappear. Newlines become caption line breaks. Chinese and
punctuation remain UTF-8; literal braces and backslashes cannot execute ASS
overrides or escape sequences. A zero-width word joiner after each literal
backslash protects it without changing its visible character.

Burn-in runs after all visual tracks. The UTF-8 ASS script lives in the unique
render staging directory and is removed on success, failure or cancellation.
FFmpeg runs with that directory as its working directory and a fixed
`ass=filename=captions.ass` filter. Absolute paths, drive colons, Unicode,
apostrophes and other path characters never enter the subtitle filter syntax.
Audio encoding, mixing, ducking and loudness processing retain their existing settings.

```js
project.captions = remapTranscriptToTimeline({
  segments: transcript.segments,
  clips: project.clips,
  assetId: 'asset-a',
});
```

The pure helper intersects each source segment with each matching asset's
non-image clip, then translates by `clip.start - clip.sourceIn`. Output rows
stay within those intersections, sorted by start/end. Adjacent or overlapping
rows with identical text from the same source segment merge when they overlap or
continue forwards through the source. Distinct sentences and adjacent replays
that jump backwards in the source remain separate. Inputs are never mutated.
Matching clips default start/sourceIn to zero and need positive duration.

Complete, ordered `words: [{ start, end, word }]` alignment permits selecting
whole intersecting words and original punctuation, including zero-duration
punctuation. Words must reconstruct the original text and fit their segment;
missing, incomplete or unusable alignment retains the full sentence in each
bounded intersection. Text is never truncated by a time-to-character ratio.
Aligned cuts containing only silence produce no caption. Overlapping captions
from distinct source segments remain distinct rather than discarding speech.

Files are staged in a unique directory beside the output, probed, and renamed
on success. Temporary files are removed on completion/failure. Explicit output
paths replace existing files only after successful encoding. FFmpeg/ffprobe
always use spawn argument arrays, shell:false, hidden windows and bounded
timeouts/output. Chinese, spaces and quote characters in paths are supported.
Probe timeout 30 s; analysis 180 s; render/quality decode at most 15 min.
Browser: 100 actions, 10 s action timeout, 30 s navigation/launch timeout,
90 s total explicit waits, 120 s session deadline, 150 s total capture bound.
SAPI timeout 5 min.
Every async media export accepts an optional AbortSignal. Path-based functions accept it
inside an optional second argument; the other functions accept it in their
options object. All previous call signatures remain valid.
Already aborted requests create no work. Active FFmpeg, ffprobe and SAPI
processes are terminated on abort and awaited before temporary-file cleanup.
Composition and beat analysis yield at regular intervals so cancellation can
interrupt CPU work, including WAV generation before any encoder is launched.
Browser capture runs in `browser-worker.mjs`; cancellation/timeout first asks
the worker to close Edge and flush its profile. After 1 s, an unresponsive
worker/browser process tree on Windows is forcibly terminated, including
launch/navigation and pending actions. This uses system `taskkill.exe` with
argument arrays and a 10 s termination bound; no shell is involved. Cleanup
retries transient Windows file locks for up to 750 ms.
Cancellation is checked again before publishing. The final filesystem rename
is the commit point: a cancellation arriving after publication cannot undo it.
All processes exit before their promise settles. No network speech/music
provider or separately installed music package is used.

Run verification from the workspace root:

```powershell
node --test tests/media.test.mjs
node --test tests/media-captions.test.mjs
```
