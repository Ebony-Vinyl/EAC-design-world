# OpenDesign Integration Implementation Plan

**Goal:** Absorb OpenDesign's reusable content and authoring conventions into EAC, enable design creation and multi-format canvas previews, fix mode switching, and replace the scrolling settings workspace with top navigation.

**Architecture:** Retain the local Node/FFmpeg/Playwright engine and Harness plugin. Vendor upstream content with original licenses, index it through a library module, and expose real creation/artifact operations through HTTP and shared AI tools. Keep generator-only prompt templates explicit about external requirements. Use an isolated preview iframe, not an upstream daemon or remote Office viewer.

**Tech Stack:** Existing Node ESM, React 18, Vite, FFmpeg, Playwright, Harness slots. No git commit or publication is authorized.

## Contracts

- `src/open-design-library.mjs`: exports `openDesignTemplates`, `designSystems`, `creationModes`, and async `readLibraryItem({kind,id,source})`. Template IDs use `od-` prefix and existing safe ID syntax. Catalog entries have `kind` (`motion`, `website`, `deck`, `document`, `image`, `prompt`, `example`), `entry`/`prompt` when present, dimensions, license, provenance, thumbnail, and explicit runtime status. Original files live under `vendor/open-design/`.
- `GET /api/library`: `{ templates, designSystems, creationModes, provenance }`.
- `POST /api/tools/library_read`: `{kind,id,source?}`; supports design-system/template/skill.
- `POST /api/design/projects`: `{title,brief,kind,templateId?,designSystemId?,sessionId?}`. Supported kinds: website, deck, document, image, motion. Persistent project metadata.
- `POST /api/design/artifacts`: `{projectId,name,content,revision?}`; creates versioned local HTML/SVG/Markdown content without replacing existing revisions. Returns artifact with `id,name,kind,path,url,projectId,revision`.
- `GET /api/design/state?sessionId=...`: projects/artifacts for the design workspace; no session filter means all. `GET /api/design/artifacts/:id/content` returns authorized document text; `.../:id/preview` serves sandboxed HTML/media with appropriate MIME/CSP. `GET /api/design/artifacts/:id/download` returns original.
- Shared AI tools `library_read`, `design_project_create`, `design_artifact_save`, `design_state` dispatch to the same backend.
- `ui/DesignWorkspace.jsx`: self-contained fetches library and design state, creates design projects, previews artifact versions, accepts template/system selections. Exports default component accepting `sessionId`, optional `initialView` and `embedded`.
- UI root query `?view=design` mounts design workspace; `?view=canvas&sessionId=...` mounts compact preview workspace. `?view=templates&mode=design` uses the same composer picker position and posts `eac:template` with templateId/name/kind. `?view=workspace` renders the normal top-navigation workspace.
- Plugin selection persists mode `normal|edit|design`, template and creation type. Mode changes do not permanently dismiss recommendations; explicit close remains separate. Messages require exact source and loopback origin. Template selection stages a draft note only, never sends chat.

## Tasks

- [x] Import and index all portable upstream design systems, video/image templates, examples, design templates, skills, scenarios and atoms; retain licenses and generate per-item provenance. Verify counts and pin source revision.
- [x] Implement library API and shared tools, persistent design projects/artifacts with immutable revisions, safe preview/download, and compatible deterministic motion timeline bridge. Test traversal rejection, revisions and creation round-trip.
- [x] Add design library/workspace, design systems search/detail/token previews, canvas with video/HTML/slides/images/document views and responsive viewports; use top navigation in settings workspace with independently scrollable content.
- [x] Enable design mode, route composer picker by mode, fix recommendation state restoration, and add host canvas through supported slot when available (otherwise explicit docked panel). Add mode regression coverage.
- [x] Build and run existing/new tests; test actual local UI and host integration when available. Exercise video rendering through the compatibility bridge. Record imported counts and real unsupported runtime dependencies.

## Acceptance

1. Edit → normal → edit restores empty-draft recommendations; repeated switching and session changes work.
2. Design is selectable; choosing template/system preserves the existing draft and produces actionable AI context.
3. All imported items are searchable, with accurate licenses and source links; no unavailable external generator is reported as built in.
4. A saved website/deck/document/image/motion artifact can be reopened and previewed, with version history; native binary PPTX needs a generated HTML preview or is explicitly download-only.
5. Settings embed shows top navigation and avoids nested whole-page navigation/long scroll.
6. Existing video production tests continue passing. New tools also work through remote host proxy.
