# Cadence — Feature Wave G (PM spec)

> **Author:** Product Manager (Cadence). **Read-only analysis + this doc only — no code changed.**
> **Date:** 2026-09-13.
> **Wave G candidate:** (1) Vector **Shapes** clip kind, (2) **PiP / split-screen Layout** presets,
> (3) one-click **Auto-color** (white balance / auto levels), (4) video **Stabilization** (ffmpeg vidstab two-pass).
> **Grounded in:** `docs/COMPETITIVE-FEATURES.md`, `packages/core/src/schema.ts`,
> `packages/core/src/grade.ts`, `packages/director/src/tools.ts` (65 tools), `packages/director/src/edits.ts`,
> `packages/render-node/src/canvas-engine.ts`, `packages/render-ffmpeg/src/{plan,export,text-overlays}.ts`,
> `CHANGELOG.md`, `FEATURES.md`.

---

## The one rule that governs everything below

The codebase enforces **"one pure helper → preview / node-canvas / export parity."** Pure resolvers live in
`packages/core/src/grade.ts` (`valueAt`, `textKinetic`, `transitionStyle`, `cursorPositionAt`,
`calloutTransform`/`calloutScreenRect`, `captionAnchorY`, `cssFilter`). Three consumers must agree:

- **Browser preview** — `apps/web` Stage (CSS/DOM).
- **Node canvas** — `packages/render-node/src/canvas-engine.ts` `drawContentClip` switch (one `case` per clip kind).
- **ffmpeg export** — `packages/render-ffmpeg/src/plan.ts` `buildExportPlan`, single spawn in `export.ts` `runExport`.

Two shipped patterns matter for Wave G:
1. **PNG-overlay pipeline** (S4.25): text/callout clips that ffmpeg can't draw natively are rasterized by the
   canvas engine to transparent PNGs (`text-overlays.ts` → `renderTextClipPng`/`renderCalloutLabelPng`) and
   overlaid time-gated. **This gives pixel-exact parity for any raster overlay** — the key de-risker for Shapes.
2. **Export-only, documented-no-preview** flags: `doc.loudnorm`, `doc.cleanAudio` (schema.ts lines ~1055/1067)
   are applied only at export with a "preview unchanged" note. **This is the precedent Stabilization must follow.**

Also non-negotiable (the repo's own rule, COMPETITIVE-FEATURES.md #13): **every new capability ships a Director
tool AND a manual control.** All four features below owe a tool (`add_shape`, `add_layout`, `auto_color`,
`stabilize`) or they violate parity by definition.

---

## 1. Validation — is this the right set? Ranking + P1 flags

**Verdict: a good, coherent, faithful wave — but re-order it, and treat Stabilization as the swappable slot.**

Ranked by (user value × ease × parity confidence), best first:

| # | Feature | Value | Effort | Parity risk | Verdict |
|---|---------|-------|--------|-------------|---------|
| **1** | **PiP / split-screen Layouts** | **High** (reaction, side-by-side, grid — the social staple; COMPETITIVE §1 marks Cadence ❌ "manual only") | **Low** | **None** — emits only existing `transform` values on existing tracks; zero new render code | **Ship first.** Highest ROI, lowest risk. |
| **2** | **Vector Shapes** | **High** (annotations, backgrounds, lower-third bars, arrows for tutorials/demos; COMPETITIVE §3 marks Cadence 🟡 "callout only") | **Med** | **Low** — reuses the PNG-overlay pipeline for canvas↔export parity | **Ship.** New clip kind is the main cost. |
| **3** | **Auto-color** | **High** (one-click quality; the classic "make it look right" button; COMPETITIVE §5 ❌) | **Med** | **Low — if built as analysis→bake** (see PRD): write into the existing `ColorGrade`, which already has full parity | **Ship**, built the cheap way. |
| **4** | **Stabilization** | **Med-High** (valued, but only for shaky handheld source) | **High** | **High** — genuinely export-only (no faithful preview), needs a **second ffmpeg pass** the current single-spawn `runExport` doesn't do, and depends on `vidstab` being compiled into bundled `ffmpeg-static` | **Ship last / swappable.** |

**P1 items that should JOIN or be ready to REPLACE #4:**

- **Text out-animation (COMPETITIVE #11) — recommend as the replacement if Stabilization slips.** Titles animate
  *in* only today (`TextAnim.style`, schema.ts ~106; `textKinetic` in grade.ts). Mirroring that one pure helper for
  an *out* phase is low-risk, high-parity, closes a real P1, and needs no new ffmpeg pass. If Stabilization's
  two-pass work or vidstab-availability check blows the session budget, **swap in text out-animation.**
- **Director-tool parity (COMPETITIVE #13)** is not a separate feature — it is a **hard requirement inside all four
  PRDs.** Doing Wave G correctly (each with a tool) discharges most of #13 for shapes/layouts.

**Deliberately NOT pulled into Wave G** (correct calls, noted for the record):
- *Auto-edit-to-beat (#14)* — high "magic," but higher effort and a different subsystem (highlight + beats); its own wave.
- *GIF / alpha export (#17)* — a Deliver-room delivery feature, disjoint from these four; separate wave.
- *Karaoke (#8), Clean-audio (#10)* — **already shipped** (S4.29–S4.32); do not re-propose.

**One-session feasibility:** Layouts + Shapes + Auto-color are comfortably implementable and testable in one
session across the disjoint Engine (`packages/**`) / Web (`apps/web/**`) split. Stabilization is the only item
that risks the budget; keep text-out-animation staged as the fallback.

---

## 2. PRDs

Each feature must land: (a) an engine helper/pure fn, (b) node-canvas + preview + export agreement (or a
documented export-only exception), (c) a Director tool, (d) a manual UI control.

### G1 — PiP / split-screen Layout presets

**User story:** *"As a creator I select two (or three/four) clips and pick a layout — side-by-side, PiP corner,
top/bottom, or 2×2 grid — and Cadence positions them correctly without me hand-tuning transforms."*

**How it works (engine-light):** a **pure `layoutTransforms(meta, preset, n)`** helper (new, in
`packages/director/src/edits.ts`, alongside `addBroll` which already corner-positions a PiP via `transform`)
returns a `Transform[]` (x/y/scale) for each slot given the composition `meta.width/height`. `add_layout` assigns
those transforms to the chosen clips, placing overlays on their own visual tracks (array order = z-order, per
schema.ts Track docs). **No schema change, no new render path** — it only writes `Transform` fields the canvas,
Stage, and export already honor identically. This is why parity risk is zero.

**Presets (defaults):**
- `2up` (side-by-side): each clip `scale` to half-width, x at 25% / 75%, y centered. Gap 0.
- `topbottom`: half-height, stacked.
- `pip-corner` (default corner `bottom-right`, default `size` 0.3 of frame — matches `add_broll` defaults): main clip full-frame, second clip scaled + inset with the safe-margin the callout/caption code already uses.
- `3up`: three equal columns (or 1 large + 2 stacked — pick columns as default, simplest).
- `grid` (2×2): four quadrants; with 3 clips, last quadrant stays background color.

**Acceptance criteria ("done"):**
- `add_layout({ preset, clipIds?, gap?, size? })` tool exists and is registered in `DIRECTOR_TOOLS`
  (`tools.ts` ~1558). Omitting `clipIds` uses the current selection / first N main clips.
- A **Layouts picker** in the Design room (or Edit) shows the 5 presets with a thumbnail; clicking applies via the
  undoable commit path (like every other room control).
- Applied transforms render **identically** in preview, `npm run verify` canvas probe, and the exported `.mp4`.
- Re-selecting a preset re-flows cleanly (idempotent); "Reset layout" returns clips to full-frame (`transform` default).

**Parity requirement:** trivially satisfied — output is only `Transform` values already covered by the three
renderers. Add a verify case that asserts the N slots' transforms match `layoutTransforms` to 1e-6.

---

### G2 — Vector Shapes clip kind (rect / ellipse / line / arrow)

**User story:** *"As an editor I drop a rectangle behind my lower-third, an arrow pointing at a UI element, or a
progress bar, styled with fill/stroke/opacity, and it renders in preview and export."*

**How it works (engine + schema + UI):**
- **Schema:** add a `ShapeClip` to the discriminated union `Clip` (schema.ts ~936) with:
  `kind:"shape"`, `shape:"rect"|"ellipse"|"line"|"arrow"`, geometry `{x,y,w,h}` (composition px, top-left, like
  `Mask`/`CalloutClip`/`RegionFx` already use), `fill?:HexColor`, `stroke?:{color,width}`, `radius?` (rect
  corners), `opacity` via the standard `Transform` (reuse `Transform.prefault({})` so keyframes/animate work for
  free), and `transitionIn/Out/Type` (reuse the shared transition fields, like `SolidClip`). All optional/defaulted
  so existing docs stay valid (the additive-schema convention every clip follows).
- **Canvas:** add a `drawShape(ctx, clip)` and a `case "shape"` in `drawContentClip`
  (`canvas-engine.ts` ~723). This is the **single source of truth** for the pixels.
- **Export parity via the PNG pipeline (the key decision):** do **not** hand-map to `drawbox` (it can't do
  ellipse/line/arrow). Instead extend `text-overlays.ts` (`docNeedsTextOverlays` → also true for shapes) and add
  `renderShapePng(doc, clip)` in `render-node` mirroring `renderTextClipPng`/`renderCalloutLabelPng`; `buildExportPlan`
  overlays the transparent PNG time-gated. **Same canvas code draws preview and the export PNG ⇒ pixel-exact parity
  for all four shape types**, exactly as text/callouts already do (S4.25).
- **Director tool:** `add_shape({ shape, x, y, w, h, fill?, stroke?, color?, radius?, atSec?, durationSec? })`.
- **UI:** a **Shapes row** in the Design room (rect/ellipse/line/arrow swatches) that inserts a shape at a safe
  default rect, then lets the user drag/resize on the Stage (reuse the callout/caption on-preview placement).

**Defaults:** rect 400×120 centered-ish, `fill` = accent-neutral `#ffffffcc`? — no: default to a semi-opaque dark
panel `#000000` at `Transform.opacity` 0.5 for "background bar"; stroke width 0 (fill-only). Arrow/line default
`stroke.color` `#ffcf70` (the callout amber), `stroke.width` 6, no fill. Default duration 3s (matches title default).

**Acceptance criteria ("done"):**
- `ShapeClip` parses; all existing docs still parse (additive test).
- A shape drawn in preview matches the exported frame pixel-for-pixel (verify real-encode check, like check 64).
- Keyframes/`animate` (x/y/scale/rotation/opacity) work on a shape because it carries a standard `Transform`
  (reuses `valueAt` — no new animation code).
- `add_shape` registered in `DIRECTOR_TOOLS`; a prompt ("put a red arrow at…") and the Shapes row both produce the
  same clip.

**Parity requirement:** one canvas `drawShape` feeds both the live canvas and the export PNG; export never diverges
because it reuses the same rasterizer. Line/arrow geometry (angle from `{x,y,w,h}` bounding box) is computed once,
in the shared draw fn.

---

### G3 — One-click Auto-color (white balance / auto levels)

**User story:** *"As a creator I press Auto-color and the shot's white balance and levels are corrected — brighter,
neutral whites, punchy but not blown — without me touching sliders."*

**How it works — build it as ANALYSIS → BAKE, not a new render filter (the parity-free path):**
- ffmpeg has no faithful one-shot auto-WB filter, and CSS/canvas have no auto-levels primitive — so a *new render
  filter* would break parity three ways. Instead: **sample one representative frame** (the canvas engine already
  rasterizes frames server-side for the PNG-overlay path and for `npm run verify`), compute **gray-world white
  balance** + **black/white-point stretch** (histogram percentiles, e.g. 1%/99%), and **write the result into the
  clip's existing `ColorGrade`** (`brightness`, `contrast`, `saturation`, `warmth`, and/or `curves`). Those fields
  **already** preview via `cssFilter` (grade.ts ~116), draw on canvas, and export via `eqFromLook`/`warmColorbalance`/
  `curvesFilter` (plan.ts ~116/133/157). **Parity is inherited for free.**
- **Pure helper:** `computeAutoColor(frameStats) → Partial<ColorGrade>` (deterministic, unit-testable, no ffmpeg).
- **Director tool:** `auto_color({ clipId?, strength? })` — omit `clipId` = main clips; `strength` 0..1 (default 1)
  scales how far toward the computed correction (so it's dial-able, and 0 = no-op).
- **UI:** an **"Auto color"** button in the Design → Color section (next to Looks / manual grade), applied through the
  undoable commit; shows what it set (so the user can then nudge the normal grade sliders).

**Defaults:** `strength` 0.85 (correction that reads as "corrected," not clinical); clamp so `brightness`/`contrast`
stay within the schema's ranges and never crush to pure black/white (faithful — tone remap only, no content change).

**Acceptance criteria ("done"):**
- `computeAutoColor` is pure + deterministic (same frame ⇒ same grade); covered by a unit test with a known
  color-cast fixture asserting the cast is reduced.
- Pressing Auto-color visibly neutralizes a warm/cool cast in preview and the change **matches on export** (because
  it's a standard `ColorGrade`).
- `auto_color` registered in `DIRECTOR_TOOLS`; result is a normal grade the user can further edit or undo.
- Idempotent-ish: running twice does not runaway (second run computes near-neutral on the already-corrected sample —
  document that it samples the *source* frame, so re-running re-derives from source, not compounding).

**Parity requirement:** no new renderer code — the whole feature reduces to writing existing `ColorGrade` fields,
whose parity is already shipped and tested.

---

### G4 — Stabilization (ffmpeg vidstab two-pass)

**User story:** *"As a creator with shaky handheld footage I press Stabilize and the export is smooth."*

**How it works (engine — the heavy one):**
- **Schema:** additive per-clip `stabilize?: { enabled, smoothing? }` on `VideoClip` (defaulted-off, like
  `chroma`/`mask`), OR a doc-level flag if applied globally — **per-clip is correct** (you stabilize specific shaky
  clips). Follow the additive-optional convention so existing docs are byte-identical.
- **Export-only, TWO passes (the real work):** vidstab needs `vidstabdetect` (analysis → writes a `.trf` transforms
  file) **then** `vidstabtransform` (applies it). Today `runExport` (`export.ts` ~60) does a **single** `spawnFfmpeg`.
  Stabilization requires a **new pre-pass**: for each stabilized source, spawn `vidstabdetect` to a temp `.trf`
  (cleaned up like the PNG temp dir), then reference it in the main plan's per-clip filter chain
  (`vidstabtransform=input=<trf>:smoothing=…`, plus the usual `unsharp` vidstab recommends). This is the biggest
  architectural deviation in the wave and the main schedule risk.
- **No preview parity — this is the documented exception.** You cannot faithfully stabilize in CSS/canvas preview.
  Follow the `loudnorm`/`cleanAudio` precedent exactly: apply at export, and show a **"applied on export — preview
  unchanged"** note in the UI and the tool summary. The canvas/Stage render the un-stabilized clip.
- **Director tool:** `stabilize({ clipId?, smoothing?, on? })`.
- **UI:** a **"Stabilize"** button in the Edit/clip inspector (video clips) with a strength/smoothing control and the
  honest export-only badge.

**Defaults:** `smoothing` ≈ 10 (frames; vidstab's balanced default), `on` true. Optional light `unsharp` after
transform (vidstab's standard recommendation) — keep it faithful (no content synthesis).

**Acceptance criteria ("done"):**
- `stabilize` sets the flag; UI + tool both reachable; **preview is explicitly unchanged with a visible note.**
- Export of a stabilized clip runs the detect pass, produces a valid non-empty `.mp4`, and the `.trf` temp is
  cleaned up.
- **Pre-flight capability check:** if bundled `ffmpeg-static` lacks `vidstab`, the export **fails gracefully with a
  clear message** (mirroring the `FfmpegNotFoundError` / gated-provider pattern) — never a raw ffmpeg crash.
- No-op safety: enabling stabilize on a doc with no video source is a clean no-op.

**Parity requirement (relaxed, documented):** export-only, matching `loudnorm`/`cleanAudio`. The "one helper"
discipline still applies to the plan-building side (a pure `stabilizeFilters(clip)` that emits the transform-pass
filter string, unit-tested), even though there is no preview counterpart.

**Risk flag:** vidstab-in-`ffmpeg-static` is unverified in this repo. **QA must confirm `ffmpeg -filters | grep
vidstab` on the bundled binary before this ships.** If absent, G4 is blocked → execute the G4→text-out-animation swap.

---

## 3. Edge cases & failure modes (must degrade gracefully)

**G1 Layouts**
- 1 clip selected for a 2-up/grid → fill remaining slots with the doc background (or refuse with a clear message);
  do not crash. Default: apply to the 1 clip and leave empty slots as background.
- More clips than slots → use the first N, leave the rest on their tracks untouched (documented).
- Non-16:9 comps (9:16, 1:1) → `layoutTransforms` must read `meta.width/height`, not hardcode; verify on a vertical doc.
- Overlapping with existing keyframed transforms → applying a layout overwrites static transform; warn if the clip
  has keyframes (they'd fight the preset).
- Idempotent re-apply and a "reset to full-frame" path.

**G2 Shapes**
- Zero or negative size (`w`/`h` ≤ 0) → schema `.positive()` rejects; the tool/UI must clamp to a min (e.g. 4px)
  rather than throw at the user.
- Shape fully off-canvas → allowed (partial reveal); must not break the export PNG bounds (clamp PNG to comp size).
- `fill` and `stroke.width` both absent → nothing visible; default to a fill so an inserted shape is never invisible.
- Line/arrow with w=0 or h=0 (perfectly vertical/horizontal) → angle math must not divide-by-zero.
- A shape-only doc (no media) → must still export (the audioless/text-only export paths already handle this; add a
  verify case).
- Very many shapes → PNG-overlay count scales like captions; fine, but keep one PNG per shape (not per frame).

**G3 Auto-color**
- Pure-black / blown-white / single-color frames (title cards, solids) → percentile stretch degenerates; guard
  against divide-by-zero and clamp to a no-op grade rather than extreme values.
- Applied to a `SolidClip`/`TextClip` (no photographic content) → skip or no-op (only grade video/image clips).
- Already-graded clip → document that it samples the **source** frame so re-running re-derives (no compounding).
- `strength` 0 → exact no-op (byte-identical doc).
- No decodable frame (missing media) → fail with a clear "still processing / add footage" message, like
  `sourceVideo()` does in tools.ts.

**G4 Stabilization**
- **All-image / audio-only / no-video doc → no-op** (nothing to stabilize; explicit in acceptance criteria).
- vidstab missing from the binary → graceful, actionable error (see G4 pre-flight).
- Very short clip (< a few frames) → detect pass may produce a trivial `.trf`; ensure transform pass still exits 0.
- Interaction with `speed`/`reversed`/`freezeAtSec` on the same clip → define order (stabilize the source before
  retime) and test the combo, or document as unsupported-together for this wave.
- Temp `.trf` cleanup on export failure (finally-block, like the PNG temp dir).
- Two-pass ~doubles decode time for stabilized clips → surface progress; don't appear hung.

**Cross-cutting**
- Every new tool must appear in `DIRECTOR_TOOLS` (`tools.ts` ~1558) or it's invisible to the Director (parity break).
- Additive schema only — a doc authored before Wave G must parse and render byte-identically (the repo's standing rule).

---

## 4. Definition of Done / QA checklist

Gates the repo already runs: `npm run typecheck`, `npm run verify` (real-frame + real-encode checks, currently 64),
`npm run evals` (agentic loop), `npm run test:e2e` (Playwright drives the real app).

**Global (all four)**
- [ ] `npm run typecheck` clean (root + web) and `next build` clean.
- [ ] A pre-Wave-G `EditDoc` fixture still parses and renders byte-identically (backward-compat).
- [ ] Each feature has BOTH a Director tool (in `DIRECTOR_TOOLS`) and a manual UI control; a prompt and the button
      produce the same doc.
- [ ] Each new/changed control routes through the undoable commit path (undo/redo works).
- [ ] Every claim of faithfulness holds: no content invention — retime/reposition/regrade/recomposite only.

**G1 Layouts**
- [ ] Verify case: `layoutTransforms` output for 2up/3up/grid/pip/topbottom matches expected slot transforms (1e-6)
      on both a 16:9 and a 9:16 comp.
- [ ] Preview, canvas probe, and exported `.mp4` show the same arrangement.
- [ ] 1-clip and N>slots cases handled without crash; reset-to-full-frame works.

**G2 Shapes**
- [ ] `ShapeClip` added to the `Clip` union; additive-parse test green.
- [ ] Real-encode verify check (extend check 64) burns a doc with rect+ellipse+line+arrow → exit 0, non-empty `.mp4`.
- [ ] Pixel spot-check: a shape's preview frame == the exported frame (same canvas rasterizer).
- [ ] `animate`/keyframes on a shape work via `valueAt` (no new anim code).
- [ ] Shape-only (no media) doc exports.

**G3 Auto-color**
- [ ] Unit test: `computeAutoColor` on a known warm-cast fixture reduces the cast; deterministic; `strength` 0 = no-op.
- [ ] Preview change == export change (it's a standard `ColorGrade`).
- [ ] No-op / clamp on solids, text, single-color, and missing-frame inputs (no NaN/extreme grade).

**G4 Stabilization**
- [ ] **Pre-flight:** confirm `vidstab` is in the bundled `ffmpeg-static` (`-filters | grep vidstab`). If absent →
      block G4, execute the text-out-animation swap, and record it here.
- [ ] Export of a stabilized clip runs detect+transform, exits 0, produces non-empty `.mp4`, cleans up `.trf`.
- [ ] Graceful error when vidstab is unavailable (clear message, no raw crash).
- [ ] No-op on an all-image / no-video doc.
- [ ] UI + tool summary both carry the "applied on export — preview unchanged" note (loudnorm/cleanAudio precedent).

**Docs**
- [ ] `FEATURES.md` + `CHANGELOG.md` updated (one verified line per slice, per repo convention).
- [ ] Any export-only or preview-approximation limits are documented in the schema comment for that field (matches
      how `curves`/`lut`/`cleanAudio` document their limits).
</content>
</invoke>
