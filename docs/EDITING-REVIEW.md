# Cadence — Editorial Review & Punch-List

_Reviewer: Head of Video Editing / Editorial Lead. Scope: the current editing
capability, stress-tested from an editor's chair. This is a critical sign-off
review — it is blunt on purpose and it drives the build. No code was changed._

---

## 1. Verdict

Cadence is an impressively coherent **skeleton** of a prompt-native editor, but it
is **not yet something a creator would ship a finished cut from**. The edits-as-code
spine is genuinely good: one Zod-validated `EditDoc`, pure doc-in/doc-out
operations, and a real ffmpeg export plan. Where it falls down is the thing an
editor actually cares about — **what the preview promises is not always what the
export delivers**, and several "supported" features are honored on only one of the
two surfaces. The headline gaps: **transitions between video cuts don't render on
export** (only slideshows get xfade), **caption fonts/weights are preview-only**,
**kinetic `pop`/`bounce` titles and callout zoom are preview-only**, **overlays
(captions/titles) don't ripple when you trim/split/reorder the footage under them**,
and **captions/speed break each other's source-time math**. Add the reported
music-on-slideshow attach/duration problem and you have a tool that demos
beautifully and then surprises you at render. It's a strong Wave-1 foundation that
needs a focused "preview == export" hardening pass before any creator ships with it.

---

## 2. Correctness / Fidelity Issues

Ordered by how badly they'll burn an editor. Every item cites the file/function.

### 2.1 Transitions between video cuts are silently dropped on export — **preview≠export**
- `set_transition` (`packages/director/src/edits.ts` `setTransition`) sets
  `transitionType` + `transitionInSec` on **video** clips too.
- The canvas/Stage honor it via `transitionMotion`/`transitionOpacity`
  (`packages/core/src/grade.ts`), so the **preview shows a crossfade/slide/wipe**.
- But `buildExportPlan` (`packages/render-ffmpeg/src/plan.ts`) only emits `xfade`
  in the **slideshow branch** (`allImage && hasCrossfade`). The **`allVideo` cut+concat
  branch** does a plain `concat` with **no xfade at all** — every transition between
  video cuts becomes a **hard cut on export**. "Dip to black between clips" previews
  as a dip and renders as a jump. This is the single most damaging fidelity gap.
- Worse: because highlight/filler cuts are laid **back-to-back with no overlap**, a
  `transitionInSec` crossfade on such a clip previews as a **fade up from the black
  background** (there's no outgoing clip beneath it), not a real A/B dissolve — so
  even the preview is wrong for cut sequences.

### 2.2 Caption/title font family AND weight are preview-only — **preview≠export**
- `TextClip.fontFamily` / `fontWeight` (`packages/core/src/schema.ts`) and
  `style_captions` (`edits.ts`) set the face + weight; the Stage and canvas honor
  them (`fontWeightToCss`, CSS `font-family`).
- `oneDrawtext` (`plan.ts`) emits **no `fontfile=`/`font=` and no weight** — the
  schema comment on `CAPTION_FONTS` admits "export falls back to the platform's
  default drawtext font." So "bold Montserrat yellow captions" previews correctly
  and **exports in the default drawtext font at default weight**. A creator styling
  captions is being lied to by the preview.

### 2.3 Kinetic `pop`/`bounce` titles and the kinetic scale-in are preview-only — **preview≠export**
- `add_kinetic_title` supports `kinetic`/`pop`/`bounce` (`edits.ts`,
  `grade.ts textKinetic`). The preview animates all three.
- `oneDrawtext` (`plan.ts`) only special-cases `a.style === "kinetic"` for the
  **slide (x/y)**, and its own comment notes "the scale-in is a preview/canvas
  nicety." So on export: `pop` (fromX/fromY = 0) renders **static**, `bounce`
  renders **static** (the export never reads the `bounce` easing), and even
  `kinetic` **slides but never scales in**. Animated titles largely don't animate on
  export.

### 2.4 Overlays don't reflow when you edit the footage under them — **structural correctness**
- The direct-timeline ops (`apps/web/src/lib/edit-ops.ts`: `trimClip`, `splitClip`,
  `reorderClip`, `rippleDeleteClip`) only re-lay **main sequential tracks**
  (`reflowTrack`/`reflowMainTracks`). Captions, titles, b-roll, fades, music sit on
  **overlay tracks with absolute timeline times** and are **left where they were**.
- Result: ripple-delete or trim a mid-timeline clip and **every caption/title after
  it is now out of sync** with the footage. This is exactly the kind of silent
  desync an editor will not forgive. Same problem in the doc-level `removeMediaFromDoc`
  / `moveMediaInDoc` (`apps/web/src/lib/doc.ts`).

### 2.5 Captions break after a speed change, and don't map source-time through speed — **preview≠export & internal inconsistency**
- `addCaptions` (`edits.ts`) computes the clip's source window as
  `srcStart = clip.sourceIn; srcEnd = clip.sourceIn + clip.duration` — it **ignores
  `clip.speed`**. The real source span is `duration * speed` (`sourceSpanSec` in
  `engine.ts`). So on any retimed clip, captions map the wrong transcript segments
  and drift. Order-of-operations dependent (caption before/after speed) → different
  results.

### 2.6 Multi-video captions use only the first clip's transcript — **wrong captions**
- `sourceVideo(project)` (`packages/director/src/tools.ts`) returns the **first**
  video + **its** transcript; `captionsTool` feeds that single transcript to
  `addCaptions`, which then matches its segment times against **every** video clip's
  `[sourceIn, sourceIn+duration]`. On a combined multi-video timeline
  (`combinedVideoDoc`), clip B gets clip A's words wherever the source ranges
  numerically overlap. Multi-video captioning is effectively broken.

### 2.7 Multi-video audio concat is fragile — **export can fail or desync**
- The `allVideo` branch (`plan.ts`) concats with `concat=n=…:v=1:a=1`, taking each
  clip's `[idx:a]`. If **any** source video has **no audio stream** (common with
  screen-recorded or muted clips), ffmpeg's concat with `a=1` fails outright.
  Mismatched sample rates/channel layouts across sources will also desync — there's
  no `aformat`/`aresample` normalization before concat.

### 2.8 Speed can read past end-of-source → clip runs short → concat desync
- `setSpeed` (`edits.ts`) keeps the **timeline** `duration` fixed and only changes
  `speed`; export reads `-t sourceSpanSec = duration*speed` (`plan.ts` allVideo).
  Fast speeds (e.g. 2×) demand `2×duration` seconds of source; if the source doesn't
  have it, ffmpeg truncates the segment, the segment lands shorter than its timeline
  slot, and everything after it in the concat slides earlier. No guard checks
  available source (`maxTimelineDuration` exists in `edit-ops.ts` but the Director's
  `setSpeed` doesn't use it).

### 2.9 "Make it 4K" — semantics now correct, but preview still doesn't show it
- `setQuality` (`edits.ts`) was fixed to anchor on the **long edge**
  (`3840/longEdge`), so vertical 9:16 now targets 2160×3840 and landscape 3840×2160
  (the old ~6836px overshoot is gone — good). Remaining honest gap: the **preview
  stays at source resolution** (documented), so "4K" is invisible until export. Also
  `Math.max(1, scale)` means Cadence **never downscales** a huge source to a smaller
  "standard" target — "standard quality" on a 6K source is a no-op, not a 1080p
  downscale, which may surprise users.

### 2.10 Callout zoom is preview-only — **preview≠export**
- `CalloutClip.zoom` magnifies the composited content in the canvas/Stage
  (`calloutTransform`), but `calloutFilters` (`plan.ts`) draws only a `drawbox`
  border/dim/label — its own comment: "drawbox can't magnify… the export keeps the
  faithful highlight." "Zoom into the sidebar" previews as a punch-in and exports as
  just a box. Cursor motion is also **eased in preview, linear on export**
  (`cursorFilters` vs `cursorPositionAt`), and the cursor glyph is a **real arrow
  polygon on canvas** but a **`➤` text glyph on export** (font-fallback dependent).

### 2.11 VFX overlays: approximate, not matched — **preview≠export (cosmetic)**
- Grain: canvas = seeded static per-frame noise; export = `noise=…:allf=t+u`
  (temporal) — different texture. Light-leak: canvas = a **corner diagonal gradient**;
  export = a **full-frame** warm `blend=screen@0.16` — different placement/intensity.
  Vignette matches reasonably. These won't ruin a cut but they won't match the
  preview either.

### 2.12 Audio hard-cuts (pops) and no per-clip mute persistence
- Cut sequences concat audio with no crossfade/fade → **audible clicks at every
  cut**. Also "mute" in the inspector/audio room is `volume = 0`
  (`edit-ops.ts setClipVolume`), with **no schema `muted` field** (noted in
  CHANGELOG S3.6) — un-muting relies on a UI-held `premute` ref that is **lost on
  reload/save**.

---

## 3. Known User-Reported Bug: music on a PHOTO slideshow

**Symptom:** upload music to a photo slideshow and it "doesn't clearly attach," and
you "can't set its duration."

### Traced code path
1. **Upload** → `Editor.handleFiles` (`apps/web/src/components/Editor.tsx`),
   `audios.length > 0` branch: it registers the file in `mediaList`/`urls`/`files`
   and prints `"…Say 'add background music' to lay it under your video."` — it
   **never touches the edit-doc**. Nothing appears on the timeline; there is no
   music track yet.
2. **Attach** is a *separate, second* action: RoomPanel Audio room's **"Use as
   music"** pill → `onAction("add background music")` → `handleSend` → `/api/director`.
3. **Director** (`stub-director.ts`) matches `/\bmusic\b/` → `musicTool.execute({})`
   (`tools.ts`). `add_music`'s input schema exposes only `mediaId` + `volume` — **no
   duration/start**. It calls `audioAsset(project)` (first audio asset) → `addMusic`.
4. **`addMusic`** (`edits.ts`): pushes the asset into `doc.media`, drops any old
   `music` track, and creates one clip with `duration = docDurationSec(clone) || …`
   — i.e. **pinned to the slideshow's length**, `start = 0`, `volume = 0.28`.
5. **Export** (`plan.ts`, slideshow branch): images produce `videoLabel = vxf`,
   `audioLabel` stays `null`; `collectAudioClips` picks up the music clip, delays it
   by `start`, and `amix`es it in. So it *does* render — the failure is entirely in
   **attach clarity + duration control**, not the render.

### Root cause (blunt)
Two compounding problems, neither of which is a render failure:

1. **Uploading audio never attaches it.** `handleFiles`'s audio branch mutates only
   `mediaList` and shows a **video-centric hint** ("lay it under your video") — on a
   **photo** slideshow there is no video, no music track is created, no waveform, no
   Applied-status change, and the guidance doesn't match the project. The user
   reasonably concludes nothing happened. Attaching requires discovering a second
   action ("Use as music" / typing a command).
2. **The music clip's duration is not settable.** `addMusic` hard-codes
   `duration = docDurationSec` and `add_music`'s tool schema has **no
   duration/offset input**; the Audio room exposes only a **volume** slider. There
   is no way to trim the music to a shorter cut, offset its start, or extend the
   slideshow to the song — so a song longer/shorter than the slideshow can't be
   fitted. (The clip *is* a normal audio clip and technically trimmable in
   `CutsStrip`, but nothing tells the user that, and `add_music` re-creates it
   full-length every time.)

Also latent and worth fixing in the same pass: **re-running `make_slideshow`
silently drops the music** — `buildSlideshowDoc` (`slideshow.ts`) returns a fresh
doc with only image/title tracks, discarding the `music` track.

### Exact fix
- **Attach on upload.** In `Editor.handleFiles` (audio branch), when the project
  already has visual media, immediately `commit(addMusic(doc, asset, …))` (music) or
  `addVoiceover` per user choice, instead of only registering it — and make the
  confirmation copy media-aware ("laid under your slideshow"). At minimum, auto-open
  the Audio room and light up the music clip so the attach is visible.
- **Make duration real.** Add `durationSec`, `startSec`, and `sourceIn` to the
  `add_music` tool input schema (`tools.ts`) and thread them into `addMusic`
  (`edits.ts`, which already accepts `startSec`); default the clip `duration` to
  `min(asset.durationSec, docDurationSec)` rather than always the timeline length.
  Add a **Music length / start** control to the Audio room (`RoomPanel.tsx`) beside
  the existing volume slider, and/or surface a "fit slideshow to music" affordance.
- **Stop dropping music.** Have `make_slideshow` (or the `slideshowTool` commit
  path) **carry over an existing `music`/`voiceover` track** when rebuilding, or
  re-apply it after the rebuild.

---

## 4. Missing Table-Stakes (a pro will notice within five minutes)

- **Real A/B transitions on export for video cuts** (see 2.1) — the #1 gap.
- **Bundled caption fonts** so styled captions export as designed (see 2.2).
- **Overlay ripple** — captions/titles/music that follow the footage when you
  trim/split/reorder/ripple-delete (see 2.4).
- **Audio crossfades / fades on cuts** — hard audio cuts pop (see 2.12).
- **Multi-line / word-wrapped captions** — `addCaptions` truncates a long segment
  with `…` (`edits.ts`), so long captions are just cut off; no wrapping, no
  karaoke/word-level highlight.
- **Music/voiceover trimming + fades** — no fade-in/out, no loop-to-length, no
  ducking envelope beyond a single static duck volume.
- **Export progress + cancel** — the export button just says "Rendering…" with no
  progress, ETA, or cancel; a long render looks hung.
- **Persisted markers & real per-clip mute** — markers live only in `Editor` state
  (not in the schema), lost on save/reload; mute is `volume=0` with no schema field.
- **Keyframes / opacity / position animation** for anything other than the canned
  Ken Burns and kinetic presets.
- **Safe-area / title guides**, snapping to safe margins for captions & titles.
- **Real source-length guards** on speed and trims so edits can't read past EOF.

---

## 5. Prioritized MUST-FIX Punch-List

### P0 — block the release on these (preview lies to the editor / silent data loss)
- **P0-1 · Video-cut transitions on export.** `packages/render-ffmpeg/src/plan.ts`
  (`buildExportPlan` allVideo branch). Overlap adjacent cuts and chain `xfade`
  (reuse `xfadeTransition`) instead of a bare `concat`, honoring each clip's
  `transitionType`/`transitionInSec`. Fix the preview too so a crossfade on
  back-to-back cuts reads as A/B, not a fade-from-black.
- **P0-2 · Overlay ripple.** `apps/web/src/lib/edit-ops.ts` (`trimClip`,
  `splitClip`, `reorderClip`, `rippleDeleteClip`) + `apps/web/src/lib/doc.ts`. When a
  main-track structural edit shifts the timeline, shift the dependent overlay clips
  (captions/titles/fades) by the same delta so they stay in sync.
- **P0-3 · Music-on-slideshow attach + duration** (Section 3).
  `apps/web/src/components/Editor.tsx` (auto-attach on upload),
  `packages/director/src/{tools.ts,edits.ts}` (duration/start on `add_music`),
  `apps/web/src/components/RoomPanel.tsx` (length control), and carry music through
  `slideshow.ts` rebuilds.
- **P0-4 · Caption fonts/weights on export.** `packages/render-ffmpeg/src/plan.ts`
  (`oneDrawtext`) + bundle TTFs. Emit `fontfile=`/weighted face so styled captions
  render as previewed (or, until fonts ship, **tell the user in the UI** that export
  uses a default font).

### P1 — fix before a wide beta (wrong output in common flows)
- **P1-1 · Caption source-time honors speed.** `edits.ts addCaptions` — use
  `sourceSpanSec` (`duration*speed`) for the source window.
- **P1-2 · Multi-video captions.** `tools.ts` (`sourceVideo`/`captionsTool`) +
  `edits.ts addCaptions` — caption **per clip** with **that clip's** transcript, not
  a single first-clip transcript.
- **P1-3 · Multi-video audio concat robustness.** `plan.ts` allVideo branch —
  `aformat`/`aresample` normalize, and synthesize silent audio for clips with no
  audio stream so `concat a=1` can't fail.
- **P1-4 · Speed source-length guard.** `edits.ts setSpeed` — clamp against
  `maxTimelineDuration`/available source so fast speeds can't read past EOF and
  desync the concat.
- **P1-5 · Kinetic pop/bounce + scale-in on export.** `plan.ts oneDrawtext` — drive
  `pop`/`bounce`/scale from the same `textKinetic` math, or drop the styles from the
  Director until export supports them (don't offer what you can't render).
- **P1-6 · Audio crossfade on cuts.** `plan.ts` — `acrossfade`/short `afade` at cut
  boundaries to kill pops.

### P2 — polish / honesty (won't block, will annoy)
- **P2-1 · Callout zoom on export** or clearly label it preview-only (`plan.ts`).
- **P2-2 · VFX parity** (grain/light-leak) between canvas and ffmpeg (`plan.ts` +
  `canvas-engine.ts`).
- **P2-3 · Persist markers + first-class `muted`** in the schema (`schema.ts`),
  wired through `edit-ops.ts`/`Editor.tsx`.
- **P2-4 · Export progress/cancel UI** (`Editor.tsx exportDoc` + `/api/export`).
- **P2-5 · Caption wrapping** (multi-line, no `…` truncation) in `addCaptions`.
- **P2-6 · "standard" quality can downscale** huge sources (`edits.ts setQuality`).

---

## 6. Wave Plan (verify-gated, non-colliding, ownership-partitioned)

Ownership rule respected throughout: **Owner A = schema/core/director/render**
(`packages/*`), **Owner B = apps/web** (`apps/web/*`). Within a wave the two owners
touch disjoint trees so build agents don't collide. Each wave ends on the existing
gate: `npm run typecheck` + `npm run verify` (+ new checks) + `npm run test:unit` +
`apps/web` `next build` clean, plus the noted E2E.

### Wave 2 — "Preview == Export" fidelity (the release-blockers)
- **Owner A (`packages/*`):**
  - P0-1 video-cut `xfade` on export (`render-ffmpeg/plan.ts`) + preview crossfade
    correctness (`core/grade.ts` if needed). New verify check: allVideo doc with a
    `set_transition` yields `xfade` in the args.
  - P0-4 caption fonts/weights on export: bundle TTFs, emit `fontfile=` in
    `oneDrawtext`. New verify check asserting a weighted `fontfile` in the plan.
  - P1-5 kinetic pop/bounce/scale on export (same file).
- **Owner B (`apps/web/*`):**
  - P0-2 overlay ripple in `lib/edit-ops.ts` + `lib/doc.ts`. New unit tests: trim a
    mid clip → trailing caption `start` shifts by the delta.
  - If P0-4 fonts slip, add the interim "export uses a default font" notice in the
    caption-styling UI.
- **Gate add:** E2E asserts a video highlight + `dip to black` transition survives
  export-plan inspection; unit tests for overlay ripple.

### Wave 3 — Correct output in real multi-clip / retimed flows
- **Owner A (`packages/*`):**
  - P0-3 (director half): `add_music` duration/start schema + `addMusic` defaults
    (`director/tools.ts`, `director/edits.ts`); carry music through `slideshow.ts`.
  - P1-1 caption source-time honors speed; P1-2 per-clip multi-video captions
    (`director/edits.ts`, `director/tools.ts`).
  - P1-3 audio concat normalization + silent-fill; P1-4 speed source guard;
    P1-6 audio crossfade (`render-ffmpeg/plan.ts`). New verify checks for each.
- **Owner B (`apps/web/*`):**
  - P0-3 (app half): auto-attach audio on upload + media-aware copy
    (`components/Editor.tsx`); Music length/start control in the Audio room
    (`components/RoomPanel.tsx`).
- **Gate add:** E2E — photo slideshow + upload music → music track visible + present
  in export plan; multi-video project → per-clip captions.

### Wave 4 — Table-stakes depth & honesty polish
- **Owner A (`packages/*`):**
  - P2-3 first-class `muted` + persisted `markers` in `core/schema.ts` (+ migration
    note); P2-1 callout zoom on export or explicit preview-only flag; P2-2 VFX
    parity; P2-5 caption wrapping (`director/edits.ts`); P2-6 downscale in
    `setQuality`.
- **Owner B (`apps/web/*`):**
  - Wire `muted`/`markers` through `lib/edit-ops.ts` + `Editor.tsx`/`CutsStrip.tsx`;
    P2-4 export progress + cancel (`Editor.tsx`, `/api/export`); music/voiceover
    fade + duck-envelope controls in `RoomPanel.tsx`.
- **Gate add:** unit tests for `muted`/marker round-trip through save; E2E export
  shows progress and completes.

### Wave 5 (stretch) — Pro depth
Keyframes / opacity & position animation, karaoke word-level captions, safe-area
guides, real audio ducking envelope. Owner A lands schema + render + director tools;
Owner B lands the timeline UI — same partition, same gate.

---

_End of review. The P0 punch-list is the block-list; the music-on-slideshow root
cause is in Section 3._
