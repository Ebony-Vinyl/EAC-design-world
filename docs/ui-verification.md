# UI Verification

Scope: `ui/api.js`, `ui/main.jsx`, `ui/styles.css`, `plugin/client.js`, template picker
verification scripts, and this document. The composer integration uses the installed
Harness client slots. Server and media-engine behavior is unchanged by this layout work.
No user assets are deleted or rewritten by this UI work.

## Implemented

- Production workspace, template gallery/picker, media preview, project outputs,
  SRT viewer/downloads, transcription, rough cut, music, and job queue remain.
  External editor controls, connection settings, sidebar promotion, related styles,
  and handoff verification fixtures have been removed. No sidebar editor is added.
- Settings display and submit only `outputRoot`, `quality`, and `ttsVoice`.
  The UI lists production capabilities and supported production jobs.
- Speech selection uses imported audio stream metadata, excludes silent videos,
  permits audio transcription, and restricts rough cut to videos.
- `生成时间线字幕` submits `captions` with exactly `{ assetId }` from the selected
  speech asset. It requires existing transcript segments and a timeline using that
  asset. The workflow displays real job state, errors, timeline caption count,
  and expandable timestamped caption text. Completed caption jobs show their count.
- Source SRT remains the original transcription. Timeline captions use the engine's
  source-to-timeline mapping after rough cut and are burned into project renders.
  The existing project video preview and job/output download links expose the result.
  Mapping, revision guards, and encoding are implemented by the parent engine.
- Render/produce `review.path` is included in output discovery. Real keyframe contact
  sheets appear in job output links and the asset/output browser, whose image viewer
  previews the actual generated file.
- Existing project revision protection prevents older poll snapshots from replacing
  a newer project. Submission responses also cannot replace a job already refreshed
  from the server, preventing a completed task reverting to queued. Failed requests
  refresh state. Task progress and errors reflect actual backend values.
- Optional music sends trimmed `musicPath`; following music omits `bpm`, allowing
  measured tempo. Standalone media/beat analysis sends the selected `assetId`.
  Media analysis is not presented as semantic understanding.
- Source-shortage, transcription review, nested production, and render QA warnings
  remain visible.

## Run

```powershell
npm run build
npm test
node ui/verify.mjs
```

For the composer/template-only regression checks (no media production or live chat
messages), run:

```powershell
node scripts/verify-picker.mjs
```

This runner serves the actual production build on a temporary port with a read-only
catalog/state fixture, exercises the parent/iframe protocol, and closes its server
and browser. Evidence is written to `artifacts/composer/verification.json` and PNGs.
The installed Harness integration can be inspected with
`node scripts/harness-qa.mjs picker` (an already-open desktop debugger on port 9232).

The runner serves the production build using actual
`startServer({ engine, port: 0 })` with isolated temporary data/output. It closes
the browser, server, and engine in `finally`; it does not bind or stop port 4173.
It requires FFmpeg, a Playwright-capable browser, Windows speech synthesis, and
the installed local transcription model. Generated media, screenshots, and
`verification.json` remain in the temporary directory printed by the runner.

## Browser Coverage

- Real word-aligned ASR, exact asset/language request, and byte-identical SRT
  viewer/download.
- Actual rough-cut timeline mutation and human-review warning.
- A real failed caption job on the temporary project's empty timeline, with
  workflow error rendering, followed by a successful browser-submitted caption
  job on the restored rough cut.
- Exact `{ assetId }` caption request, mapped captions matching the engine helper,
  visible count/text, and disabled generation for an unused transcript source.
- Actual project render, video decoding in the preview, and decoded pixel comparison
  against a caption-free render to establish visible subtitle burn-in.
- Actual media analysis, measured beats, source-shortage warning, custom-music
  production, playable output, and render QA warnings.
- Caption success/failure in the job queue, SRT/output browsing, production-only
  settings request keys, and absence of removed editor copy in rendered views.
- Actual 12-frame 4x3 review-sheet metadata/file, discovery from both render and
  produce results, and decoded image preview at mobile width.
- Template picker thumbnails, filtering, and `eac:template` selection message.
- Desktop 1440px and mobile 390px/320px overflow checks and screenshots.

Only SRT read-error and empty-file states use explicit HTTP response fixtures.
ASR, caption jobs, subtitle mapping, renders, and music production use real services.
The installed tiny ASR model has the accuracy limits reported by its capability;
transcripts, cuts, and caption placement still require human review.

## Verified Result

Final run on October 17, 2026:

- `npm run build`: passed.
- `npm test`: 64 passed, 0 failed, 0 skipped.
- `node ui/verify.mjs`: 18 checks passed; no browser runtime errors.
- Real caption burn-in changed 675 lower-frame pixels versus the caption-free
  render. The browser also played and sought within the actual output video.
- Final screenshots were inspected after resize layout settled. Desktop and
  mobile controls fit, including the expanded mapped-caption list and actual
  12-frame review-sheet image dialog.
- Production UI/API/style source scan found no removed editor references or
  fabricated semantic-analysis copy.

Evidence: `D:\tmp\eac-ui-MFqccI\verification.json`, with
`studio-captioned.png`, `captions-mapped-mobile.png`, `workflow-desktop.png`,
`workflow-mobile.png`, `srt-mobile.png`, `review-sheet-mobile.png`, and
`template-picker.png` in that directory.
The temporary server was closed after verification.

## Composer layout verification — October 17, 2026

- Replaced the full iframe in `conversation.composer.dock` with compact controls
  in `conversation.input.left`. The host's own `Menu` opens upward in a portal;
  normal and editing modes switch correctly, and Design is reserved/disabled.
- The host `Modal` holds the full template library. Its measured panel was
  1080 × 744px in the running desktop application; the iframe was 1080 × 566px
  before removing its redundant brand header/footer. The panel itself did not
  scroll. The updated picker reserves its only scrolling area for the grid.
- In a blank, existing session, four recommendations mount beside the owning
  composer card. Measured card and recommendation widths both equaled 835.84px;
  the iframe height follows content reports. The seat is hidden while typing or
  while the modal is open, and is removed when its owning control is unmounted.
- Live desktop interactions passed: open mode menu, normal/edit switching,
  initial “浏览全部模板”, search “玻璃”, choose “极光玻璃”, automatic close,
  restore the selected card, close inner preview then outer modal with Escape,
  and return to the original session with its draft unchanged. No chat was sent.
- `npm test`: 64 passed. After client lifecycle fixes and final label polish,
  `node --test tests/plugin.test.mjs`: 12 passed.
- `npm run build`: passed. `node scripts/verify-picker.mjs`: 6 grouped checks passed,
  including 1024/680/390/320px, project-independent picker selection, exact parent
  messages, nested Escape, four recommendations and iframe height, with no page errors.
- Browser screenshots were visually checked for the actual picker build at desktop
  and 320px. Live desktop screen capture was unavailable in this execution context;
  live-host validation used accessible controls, message results and DOM measurements.
  `node ui/verify.mjs` was not repeated for this composer-only change; the prior media
  verification above remains the evidence for those unchanged flows. A final rerun of
  `node scripts/harness-qa.mjs picker` could not connect (`ECONNREFUSED 127.0.0.1:9232`)
  after the desktop debug endpoint became unavailable; it did not re-launch the app
  or alter the earlier recorded live interaction results.

Latest evidence: `artifacts/composer/verification.json`, `picker-1024.png`,
`picker-320.png`, and `recommendations-836.png`.
