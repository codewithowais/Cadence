# Wave G — Editor's Spec: Shapes, Layouts, Auto-Color, Stabilize

**Author:** Senior video editor (CapCut / Premiere / Resolve), advising Cadence
**Audience:** Dev lead implementing Wave G
**Scope:** How these four features must *behave* to feel professional, from the editor's chair. This is a behavior spec with concrete numbers, not an implementation plan. It is written against the current codebase so it drops into the existing edits-as-code model.

## Grounding — what the code already gives us

I read these before writing. Numbers below are chosen to match how the engine already works, so preview (canvas) and export (ffmpeg) stay at parity.

- **`packages/core/src/schema.ts`** — the clip model. Every visual clip carries `transform {x, y, scale, rotation, opacity}` (lines 16-29), where `x,y` is the clip's **anchor/center in composition px** and `scale` is a uniform multiplier. Tracks are a `discriminatedUnion("kind", …)` of clip types (line 936); **array order is z-order** (Track docs, lines 948-985). Grade lives in `ColorGrade` (lines 61-90): `brightness/contrast/saturation` are **multipliers (1 = neutral)**, `warmth` 0..1, plus optional `hueShift` (deg), `curves`, `lut`. Closest things to shapes today: `SolidClip` (full-frame color fill, lines 800-812) and `CalloutClip` (a drawbox border + optional outside-dim + label + zoom, lines 861-887). **There is no vector-shape clip kind.**
- **`packages/director/src/edits.ts`** — pure doc-in/doc-out ops, each re-parsed through the schema. `addBroll` (lines 516-568) is the existing PiP: `size` is a **fraction 0.1–1** of the frame, `corner` anchors it with a **4% margin** (`margin = 0.04`), and the anchor is the **box center** (`cx/cy` tables, lines 534-547). `OVERLAY_TRACK_IDS` (lines 38-48) lists the non-magnetic lanes; `isMainVisualTrack` decides magnetic vs. free placement. `LOOK_PRESETS` (lines 129-144) shows the house grading vocabulary and typical magnitudes.
- **`packages/director/src/tools.ts`** — every capability is one typed Director tool (`DirectorTool<I>`, lines 121-126) that calls a pure op and `commit`s. This is where a `add_shape` / `apply_layout` / `auto_color` / `stabilize` tool each slot in.
- **`packages/render-ffmpeg/src/plan.ts`** — the pure EditDoc→ffmpeg filtergraph. PiP compositing (lines ~1400-1470): an overlay is scaled with **`scale=boxW:boxH:force_original_aspect_ratio=increase` then `crop=boxW:boxH`** (cover-fit, center crop, lines 1416-1417), and positioned with **`overlay = transform.x − boxW/2 : transform.y − boxH/2`** (center anchor → top-left overlay, lines 1466-1467). Grades map through `eqFromLook` / `warmColorbalance` / `curvesFilter` (lines 116-164). Callout borders use **`drawbox`** (lines 487-523). The bundled ffmpeg (`ffmpeg-static`) has **no drawtext/libfreetype** — all text is rasterized to transparent PNGs by the canvas engine and overlaid (file header, lines 12-19).
- **`packages/render-node/src/canvas-engine.ts`** — the canvas preview and the export's text/label rasterizer, so it is the parity anchor. `roundRect` fills/strokes for pills and callout borders (e.g. lines 358-361, 464-466); this is exactly the primitive shapes need.

**Two hard constraints that shape every decision below:**

1. **Faithfulness.** The whole system is "faithful": tone/geometry only, never generative redraw. Auto-color and stabilize must obey this — no invented pixels, no beautify.
2. **Preview↔export parity.** Anything drawn must render the same on the Skia canvas and in the ffmpeg graph. Shapes → canvas `roundRect`/paths + `drawbox`/`geq` overlays. Layouts → reuse the existing overlay center-anchor math. Auto-color → reuse `ColorGrade`. Stabilize is the exception (export-only; see §4).

---

## 1. SHAPES

### Why an editor needs these
90% of "graphics" in a talking-head, tutorial, or social edit are four primitives: a **backing bar** behind a lower-third, a **highlight box** around something on screen, a **progress/segment bar**, and an **arrow callout** pointing at a thing. We have `CalloutClip` (a hollow highlight box) and `SolidClip` (a full-frame fill), but no *filled, positioned, styled* vector object. That gap is what Wave G shapes fills.

### The shape set (ship all four)
`rect` (rectangle, incl. rounded / square / bar), `ellipse` (incl. circle), `line`, `arrow`. This covers the real jobs; anything fancier (polygons, speech bubbles) is a later wave.

### Data model — one new `ShapeClip` kind
Add a `kind: "shape"` clip to the union in `schema.ts`. Reuse the shared `Transform` so shapes move/scale/rotate/fade and **keyframe** exactly like every other clip (free reuse of `valueAt`, transitions, animate tool). Geometry is authored in **composition px** so it is resolution-independent within a project and survives `reframeTo`.

Fields an editor actually reaches for:

| Field | Type / range | Default | Notes |
|---|---|---|---|
| `shape` | `rect \| ellipse \| line \| arrow` | `rect` | discriminant within the clip |
| `x, y` (via `transform`) | comp px | center of frame | **center anchor**, matching PiP/overlay convention |
| `w, h` | px > 0 | see per-shape defaults | box the shape is drawn into (line/arrow use it as bounding box) |
| `fill` | `#RRGGBB[AA]` or `"none"` | `#FFFFFFFF` for rect/ellipse; `none` for line/arrow | `none` = outline-only |
| `stroke` | `#RRGGBB[AA]` or `"none"` | `#0A0D12FF` | outline color |
| `strokeWidth` | px ≥ 0 | `0` for filled rect/ellipse; `6` for line/arrow (a line *is* its stroke) | 0 = no outline |
| `cornerRadius` | px ≥ 0 (rect only) | `0` | `>= min(w,h)/2` ⇒ pill/stadium; ignored by other shapes |
| `opacity` (via `transform`) | 0..1 | `1` | whole-shape alpha (composes with `fill`/`stroke` alpha) |
| `rotation` (via `transform`) | deg | `0` | clockwise, about center |
| `arrowHead` | `{ length, width, ends }` | see below | arrow only |
| `lineCap` | `butt \| round \| square` | `round` | line/arrow ends; round reads friendliest |

**Arrow head proportions (this is what makes an arrow *not* look toy):**
- Head **length** = `clamp(3.2 × strokeWidth, 8% of shaft length, 22% of shaft length)`. Tying it to stroke weight keeps a thin arrow's head from ballooning and a bold arrow's head from disappearing; the shaft-length clamp keeps a long arrow's head sane.
- Head **width** (full base) = `2.4 × headLength` (≈ 50° included tip angle — the widely-read "pointer" look; sharper than 50° reads flimsy, wider reads cartoonish).
- `ends`: `end` (default), `start`, or `both` (double-headed for "A ↔ B" comparisons).
- The shaft **stops at the base of the head** (don't draw the line full-length *under* the head — the overlap fattens the tip and looks amateur).

**Sensible default sizes** (scale by frame; numbers are for a 1920×1080 comp, scale linearly by `min(W,H)`):
- **rect backing bar** (lower-third): `w = 46% of W` (`≈ 883px`), `h = 4.2% of H` (`≈ 45px`) is thin/underline-style; a full lower-third block is `h = 13% of H` (`≈ 140px`). `cornerRadius = 8px`. `fill = #0A0D12CC` (80% black — matches the existing caption pill `#0a0d12cc`), `strokeWidth = 0`.
- **highlight box**: `w,h` default to `24% × 18% of frame`, `fill = none`, `stroke = #FFCF70` (the house amber used by `CalloutClip.color`), `strokeWidth = 4px`, `cornerRadius = 12px` — deliberately identical to `CalloutClip` defaults so the two read as one design language.
- **line**: length `20% of W`, `strokeWidth = 6px`, `stroke = #FFFFFF`, `lineCap = round`.
- **arrow**: same as line + the arrowHead defaults above; default `stroke = #FFCF70`.
- **progress bar**: it's just a rect. Author a track (bg rect, `fill #FFFFFF33`) and a fill rect on top whose `w` is **keyframed 0→full** with `linear` easing over the clip (`animate prop:x`/a width keyframe). Give the ship a `add_progress_bar` convenience op that lays both rects + the width keyframe.

### How it sits on the timeline
- Shapes are **overlays**: they live on their own free-position lane, `id: "shapes"`. **Add `"shapes"` to `OVERLAY_TRACK_IDS`** (edits.ts line 38) so a shape keeps its authored x/y and never gets gap-closed by the magnetic re-flow, never gets grabbed by `setSpeed`/`setZoom`/`setTransition` (all of which guard on `isMainVisualTrack`).
- **Z-order = array order.** A shape added after captions paints over them; before them, under them. For a backing bar behind a lower-third, the bar must be **beneath** the text — so the op should insert the "shapes" track *before* the "titles"/"captions" track, or better: back the text with the text clip's own `box` panel (schema `TextBackground`, lines 637-650) when the intent is literally "bar behind this caption", and reserve free shapes for standalone graphics.
- A shape has `start`/`duration` like any clip; default `duration = min(4s, remaining timeline)`, default `start = 0` (or `atSec` when the Director places it against a moment). Give it `transitionInSec/OutSec = 0.2s` by default so it pops on/off cleanly instead of hard-appearing.

### Rendering (parity)
- **Canvas** (`canvas-engine.ts`): a `drawShape(ctx, clip)` mirroring `drawText`'s transform block (translate to center, rotate, scale, `globalAlpha = opacity × transitionOpacity × keyframe opacity`). rect → `roundRect` + `fill()`/`stroke()`; ellipse → `ctx.ellipse` path; line → `moveTo/lineTo` with `lineWidth = strokeWidth`, `lineCap`; arrow → line + a filled triangle head polygon. This is the same toolkit already used for the callout border and caption pill.
- **Export** (`plan.ts`): axis-aligned, unrotated, un-feathered rects/lines can go straight to **`drawbox`** (already used by callouts, lines 487-523) — cheap and exact. But ellipses, rotation, rounded corners, and arrow heads have **no clean drawbox equivalent**. The robust, parity-correct path is the **same trick text already uses**: rasterize the shape to a transparent composition-sized PNG via the canvas engine and overlay it time-gated (see `overlayPng`, plan.ts lines 1482-1490, and `renderTextClipPng`, canvas-engine lines 879-887). I recommend **PNG-overlay for all shapes** for guaranteed canvas↔export identity; only fall back to `drawbox` as an optimization for the plain-rect case if profiling demands it. A keyframed/animated shape rasterizes per-state exactly like keyframed overlays do.

### Acceptance feel
A lower-third backing bar sits pixel-behind the name text; a highlight box is indistinguishable from a callout border; an arrow at 6px and at 24px both look intentional; a rounded rect at `cornerRadius = h/2` is a clean pill. If any of those look "drawn by a script", the head/stroke ratios are wrong.

---

## 2. LAYOUTS (PiP / split-screen presets)

### Principle
A layout is a **deterministic placement of N clips into named cells**, expressed purely as `transform {x, y, scale}` on each participating clip plus a background fill behind any gaps. Everything is a **fraction of frame W×H** so a layout authored in 16:9 still works after `reframe` to 9:16 or 1:1. This reuses the exact overlay math already in the export: **cover-fit each cell (`force_original_aspect_ratio=increase` + `crop`) and center-anchor (`overlay = center − half`)** (plan.ts 1416-1467). No new compositor needed.

**Terminology:** `scale` in `transform` is a uniform multiplier on the frame-cover size, so a cell that is 50% of frame width uses `scale = 0.5`. `x,y` is the cell **center** in comp px. Cells cover-fill (crop to fill, never letterbox inside a cell) — that's what split-screen should do; letterboxing individual cells looks broken.

### Global rules for every preset
- **Outer margin (gutter to frame edge):** `3%` of the shorter frame dimension.
- **Inner gap (between cells):** `1.5%` of the shorter frame dimension. Small and even — big gaps look like a photo collage, not an edit.
- **Background behind gaps/margins:** the doc's `meta.background` (default `#000000`). Offer a `layoutBackground` option; a very dark neutral (`#0A0D12`) reads more "designed" than pure black. This is a full-frame `SolidClip` painted first (bottom of z-order) so gaps are never the checkerboard/transparent.
- **Which clips go where:** in **timeline/track order** — first main clip → cell 1, second → cell 2, etc. When a layout is applied to a single long clip plus b-roll, main footage takes the largest cell. The op should accept an explicit `clipIds` array to override ordering.
- Cells are **cover-cropped**, so a portrait phone clip dropped into a landscape cell fills the cell (center crop). This matches `addBroll`'s existing behavior and users' expectations from CapCut.

### Exact geometry (fractions of frame; cell = {cx, cy, w, h} as fractions)
Let `m = 0.03` (outer margin), `g = 0.015` (inner gap), both as fractions of `min(W,H)` converted to the relevant axis. For readability the tables below give the common 16:9 case with margins folded in; implement from the parametric form so it holds at any aspect.

**2-up side-by-side** (two cells, split vertically down the middle):
- Cell A (left): `cx = 0.25`, `cy = 0.5`, `w ≈ 0.5 − m − g/2`, `h = 1 − 2m`.
- Cell B (right): `cx = 0.75`, `cy = 0.5`, same `w`, `h`.
- Each clip: `scale ≈ 0.485` (the cell width fraction), centered on its `cx,cy`.
- **Best default for interviews/reactions.** For vertical 9:16 output, offer a **2-up stacked** variant (top/bottom, each `h ≈ 0.485`) — side-by-side in 9:16 makes two slivers.

**3-up** (three equal columns):
- Cells at `cx = 1/6, 3/6, 5/6` (`≈ 0.167, 0.5, 0.833`), `cy = 0.5`.
- `w ≈ 1/3 − m − 2g/3 ≈ 0.30`, `h = 1 − 2m`. `scale ≈ 0.30`.
- In 9:16, use **3 stacked rows** instead (columns become unreadably thin).

**PiP corner** (one full-frame background clip + one small inset):
- Background clip: full frame, `scale = 1`, `cx = cy = 0.5` (fills, crop-cover).
- Inset: **`bottom-right`** by default (least likely to cover a speaker's face or on-screen lower-thirds; it's the streamer/webcam convention). Size **`30%` of frame width** (`scale = 0.30`), margin **`4%`** from both edges — matching `addBroll`'s `margin = 0.04` (edits.ts line 532) so PiP-corner and existing b-roll agree. Inset center: `cx = 1 − 0.15 − 0.04 = 0.81`, `cy = 1 − 0.15 − 0.04 = 0.81` (using half of 0.30 = 0.15).
- Offer the other three corners; keep bottom-right the default. A **1px–2px inset border / subtle shadow** on the PiP (a `shapes` rect behind it, or a stroke) makes it read as intentional rather than a floating rectangle — recommend a `#00000066` drop or a `2px #FFFFFF` stroke as an option.

**2×2 grid** (four equal cells):
- Cell centers at `cx ∈ {0.25, 0.75}`, `cy ∈ {0.25, 0.75}`.
- `w ≈ 0.5 − m − g/2 ≈ 0.485` (of W), `h ≈ 0.5 − m − g/2` (of H). `scale` picks the **min** of the width/height fractions so the clip fits its cell in both axes before cover-crop. Fill order: TL, TR, BL, BR.

### Fewer / more clips than the layout expects
This is where toy implementations fall over. Rules:
- **Fewer clips than cells:** don't stretch. Leave empty cells showing the background fill (a 2×2 with 3 clips shows one dark cell — acceptable and common), OR, better default, **degrade the layout**: 3 clips + "2×2 requested" → auto-switch to 3-up. Offer both; default to degrade for 2-up/3-up, keep-empty for 2×2.
- **More clips than cells:** place the first N into cells, and **leave the rest on the timeline untouched** (they play in sequence before/after, or on their own track). **Never** silently drop clips or auto-shrink to a 3×3. Surface it in the tool summary: *"Placed 4 of 6 clips in a 2×2 grid; the other 2 are unchanged on the timeline."*
- **Duration mismatch:** cells are laid for the **overlap window** where the participating clips are all active. Default the layout window to `[maxStart, minEnd]` of the participants, or accept `atSec`/`durationSec`. Where only one clip is active, it should fill its cell alone against the background (don't blank the whole frame).
- **Aspect within a cell:** always cover-crop (fill the cell, center). Provide a per-cell `fit: cover | contain` escape hatch; default `cover`.

### Data model / op
`apply_layout(doc, { preset, clipIds?, atSec?, durationSec?, background?, insetCorner?, insetSize? })` — a pure op that (1) ensures a bottom `SolidClip` background covering the window, (2) sets each participant clip's `transform.x/y/scale` to its cell, (3) moves participants onto a shared visual track if needed so z-order is deterministic. Re-parse through the schema. It writes **only transforms + a background** — fully faithful, and every cell clip keeps its own grade/audio/keyframes. Reversible by clearing the transforms (a `clear_layout`).

### Acceptance feel
Two webcam clips in 2-up have a clean 1.5% seam, equal sizes, no letterbox bars inside cells, faces not cropped off. A PiP corner sits in the bottom-right with breathing room, not jammed into the pixel edge. Reframing 16:9→9:16 re-lays the grid without anyone falling off the frame.

---

## 3. AUTO-COLOR (one-click white balance + levels)

### What "auto" must do (and must not)
An editor hits Auto-Color to fix a flat, slightly-off SOOC clip in one click — **neutralize a color cast, set a proper black and white point, add a touch of contrast/saturation** — and expects it to look *corrected*, not *graded*. It must be **faithful**: it is a primary correction, never a creative look (no teal-orange, no film emulation — that's what `apply_look` / LUTs are for). It writes to the existing `ColorGrade` fields (schema 61-90) so it previews and exports through the paths already in place (`eqFromLook`, `warmColorbalance`, `curvesFilter`).

### The four moves, in order
1. **White balance (neutralize cast).** Estimate the frame's average color; push it toward neutral gray. Implement as a gentle `curves` per-channel tweak or, simpler and already-wired, a `warmth` nudge + `hueShift` for green/magenta. Target: average chroma reduced by **~60–70%, not 100%** — killing the cast entirely often looks clinical and wrong for warm indoor/golden light. Cap the correction so no channel moves more than the equivalent of **±0.06 on a 0..1 curve** per click.
2. **Levels / white-and-black point.** Find the near-min and near-max luma (use the **1st and 99th percentile**, never the absolute min/max — outliers/specular highlights would blow it out) and stretch them toward 0 and 1 via a master `curves` `[[blackIn,0],[whiteIn,1]]`. This is the biggest visible win on flat footage. Leave **~2–3% headroom** (map to 0.02 and 0.98, not 0.0/1.0) so you don't hard-clip shadows/highlights.
3. **Gentle contrast.** After the level stretch, a small S-curve or `contrast ≈ 1.04–1.08` (multiplier). Keep it under the `punch` preset's `1.16` — auto should never be punchy.
4. **Gentle saturation.** `saturation ≈ 1.05–1.10`. Correcting exposure usually flattens color slightly; this restores it. Never above `~1.12` (the `vivid` preset is `1.35` — that's a look, not a correction).

### When to be conservative (or bail)
- **Already well-exposed / already graded:** if the histogram already spans ~0.03–0.97 and the cast is small, **do almost nothing** — a near-neutral result. Auto-color on good footage should be a no-op, not a "boost". Detect: if the level-stretch would move black/white points by <2%, skip levels.
- **Log / flat / LUT-expecting footage** (very low contrast, milky): auto-color's mild contrast will help but **warn** the user this looks like log footage that wants a proper transform/LUT — don't pretend a one-click fix replaces that.
- **Stylized footage** (heavy existing grade, intentional monochrome, night scenes): be conservative; over-correcting a moody night shot to "neutral" wrecks intent. If saturation is already very low (likely intentional B&W), **don't re-saturate**.
- **Skin tones:** the correction is global, so watch that WB neutralization doesn't push skin green/blue. Bias the WB estimate to protect the warm/skin band — err toward slightly warm rather than slightly cool.
- **Clip-by-clip vs. whole-timeline:** apply per main visual clip (like `applyLook` / `adjustColor`, which iterate main clips) so each clip is corrected to *its own* content — a single global correction across mixed lighting looks worse than per-clip.

### Data model / op
`auto_color(doc, { atSec?, strength? })` — analyzes each main visual clip's decoded frame(s) (needs a real frame sample; today's canvas draws placeholder tiles, so the **analysis pass must run on real media** — this is the one new dependency, a lightweight histogram probe, e.g. `ffmpeg -vf ... signalstats`/histogram or a decoded thumbnail). It then writes `brightness/contrast/saturation/warmth/hueShift/curves` onto each clip's `look`, **merging** (like `adjustColor`, edits.ts 195-215) so a later manual tweak still stacks. `strength` (0..1, default `0.8`) scales the whole correction so users can dial it back. Export is already faithful (`eq` + `colorbalance` + `curves`, all identity-preserving). **Preview caveat:** CSS/canvas has no `curves` primitive (schema notes this, lines 50-58), so the canvas approximates the level stretch via brightness/contrast — document it; export is exact.

### Acceptance feel
A flat, slightly-yellow indoor clip comes out neutral, with real blacks and a clean white, skin still looks like skin, and it reads "fixed" not "filtered". Hitting it twice doesn't keep pushing (it converges — clamp so a second click on corrected footage is ~a no-op). A clean, well-shot clip barely changes.

---

## 4. STABILIZE

### Expected behavior
Smooth out handheld shake / walking bounce so the shot looks locked-off or gently floating — the CapCut "Stabilize" / Premiere Warp Stabilizer job. This is **two-pass** by nature: analyze motion across the clip, then apply the smoothing transform. In ffmpeg that's **`vidstabdetect` (pass 1, writes a transforms file) → `vidstabtransform` (pass 2)**. It is **export-only** (the canvas preview can't run vidstab); the preview should show the un-stabilized clip with a "stabilized on export" badge, exactly like the `loudnorm`/`cleanAudio` export-only precedent (schema lines 1049-1067).

### Default aggressiveness
Default to a **medium, natural** smoothing — not locked-tripod (which looks eerie and amplifies rolling-shutter jello on the edges):
- `vidstabtransform` **`smoothing = 15`** frames (≈ 0.5s window at 30fps) — a good "floaty but natural" default. Locked-off is `smoothing = 30+`; that's an option, not the default.
- `optzoom = 1` (auto zoom just enough to hide the moving borders) with **`zoom` capped** so auto-crop never exceeds **~10%** magnification (see tradeoff below).
- `vidstabdetect` **`shakiness = 5`** (mid), `accuracy = 15` (high). Bump `shakiness` toward 8–10 only for genuinely rough footage.
- Expose one **strength** control (low / medium / high) that maps to `smoothing` = 8 / 15 / 30 and shakiness = 4 / 5 / 8. Don't expose raw vidstab params to the user.

### The core tradeoff: crop / zoom to hide borders
Stabilizing shifts each frame to cancel motion, which exposes empty edges. Two ways to hide them:
- **Zoom in (crop)** — the default. Costs resolution and framing. **This is the thing to warn about.** At medium smoothing on typical handheld, expect **5–10% zoom**; rough footage can need 15–25%, which visibly softens the image and tightens the frame.
- **Black borders** — never acceptable for delivery.
- We should default to **auto-zoom, capped at 10%**, and if the required zoom to fully hide borders exceeds the cap, **leave a tiny amount of residual edge motion rather than crop the shot to death** (or warn and let the user raise the cap). Editors overwhelmingly prefer a hair of residual wobble over a mushy 25%-cropped frame.

### When to warn the user
- **Heavy shake / high required zoom:** if pass-1 detection implies >15% zoom to fully stabilize, warn: *"This clip is very shaky — stabilizing it will crop in ~X% and soften the image. Consider medium strength."*
- **Rolling shutter / jello:** vidstab doesn't fix rolling-shutter skew and can *accentuate* it. Warn on obviously CMOS-wobbly footage.
- **Motion blur:** stabilization can't remove per-frame motion blur; the result is *steady but still blurry* frames. Set expectations.
- **Intentional camera motion** (whip pans, deliberate handheld energy, locked tripod already): stabilizing a tripod shot is a no-op that only costs a crop — detect near-zero motion in pass 1 and **skip** (don't crop a already-steady clip). Warn before flattening intentional motion.
- **Very short clips** (< ~0.75s): the smoothing window can't establish; results are marginal — warn or reduce smoothing.
- **`ffmpeg-static` availability:** libvidstab is **not guaranteed** in the bundled `ffmpeg-static` build. **This must be checked at implementation time** — if the bundled binary lacks `--enable-libvidstab`, stabilize needs a different binary or a fallback (`deshake`, a single-pass, weaker filter). This is a blocker to verify before promising the feature. `deshake` is the graceful fallback: worse, single-pass, but always present.

### Faithfulness
Stabilize warps/crops existing frames only — no synthesized content. It stays inside the faithful contract. Note it *does* change framing (the crop), so unlike auto-color it is not purely additive; keep it a deliberate, per-clip, clearly-labeled action with the crop amount surfaced.

### Data model / op
`stabilize(doc, { clipId? | atSec?, strength? })` sets a `stabilize` field on the video clip (e.g. `{ smoothing, shakiness, maxZoom }`), optional so existing docs are unchanged. The impure export driver runs pass 1 (detect) before building the plan, caches the transforms file per clip+source, and the plan inserts `vidstabtransform` into that clip's chain. Preview ignores it (badge only).

### Acceptance feel
Walking footage becomes a smooth glide with a barely-noticeable ~7% crop; a tripod shot is untouched; a violently shaky clip either comes out watchably-steady with an honest crop warning, or the user is told to lower expectations — never a silently destroyed, over-cropped mush.

---

## 5. TOP QA TEST SCENARIOS (prioritized)

Ordered by how likely a real editor is to hit the feature *and* how likely it is to break. Run with **real media** (the canvas placeholder tiles hide media-fit/crop bugs) and verify **both the canvas preview and the exported .mp4**, checking they match.

**P0 — must pass before ship**

1. **Lower-third with a backing bar** (shapes + text). Add a rounded rect bar (`#0A0D12CC`, `cornerRadius 8`, lower-third geometry) and put a name/title text clip on top. Verify the bar sits *behind* the text, both align, bar has clean rounded corners, and preview == export. This is *the* most common real use.
2. **Highlight box + arrow callout** (shapes). Draw a 4px amber highlight box around a screen element and an arrow pointing at it. Verify the arrow head proportions look right at both 6px and 20px stroke, the shaft stops at the head base, and the box matches the existing `CalloutClip` look.
3. **2-up interview** (layout). Two real clips (one landscape, one portrait phone) into 2-up side-by-side. Verify equal cell sizes, a clean 1.5% seam, cover-crop (no internal letterbox), no faces cropped off, background fills any residual gap.
4. **PiP corner webcam** (layout). Full-frame gameplay/screen + a 30% bottom-right webcam inset at 4% margin. Verify position matches `addBroll` convention, inset cover-crops, and (if enabled) the inset border renders.
5. **Auto-color on flat, cast footage** (auto-color). A real slightly-yellow, low-contrast indoor clip. Verify cast neutralized (~60-70%), black/white points set with headroom (no clipping), skin still natural, and a **second click barely changes it** (convergence). Export (exact curves) vs. preview (approximated) both look corrected.
6. **Stabilize handheld walk** (stabilize). Real shaky walking clip. Verify it exports smooth, the auto-zoom is ≤10%, the crop amount is reported, and the tripod control case (steady clip in → skip/near-no-op, no needless crop).

**P1 — core robustness**

7. **Layout clip-count mismatches.** 2×2 with 3 clips (empty cell shows background, or degrades to 3-up per config); 2-up with 4 clips (first 2 placed, rest untouched, summary says so). No dropped clips, no stretch.
8. **Reframe after layout.** Apply 2×2 in 16:9, then `reframe` to 9:16. Cells re-lay by fraction; nobody falls off frame; grid → stacked variant where specified.
9. **Shape transforms + keyframes.** Rotate a rect 15°, fade a shape in via `transitionInSec`, keyframe a progress-bar rect's width 0→full linearly. Verify canvas and export agree frame-for-frame (PNG-overlay path).
10. **Auto-color guardrails.** Run on (a) already-graded footage → near no-op; (b) intentional B&W → no re-saturation; (c) night/moody → conservative, not neutralized to daylight.
11. **Stabilize warnings.** Very shaky clip → high-zoom warning fires and crop caps rather than mushing; rolling-shutter clip → jello warning; short (<0.75s) clip → handled.
12. **Stabilize binary check.** Confirm bundled ffmpeg has libvidstab; verify the `deshake` fallback path when it doesn't. (Blocker verification.)

**P2 — polish / interaction with existing features**

13. **Shapes as overlays don't get grabbed by editorial ops.** After adding shapes, run `setSpeed`, `setZoom`, `setTransition`, filler-cut — shapes keep position, aren't retimed, aren't gap-closed (confirms `"shapes"` in `OVERLAY_TRACK_IDS`).
14. **Layout + per-cell grade/audio.** Give one cell in a 2-up a `warm` look and different volume; verify each cell keeps its own grade and audio mix through the layout.
15. **Stacked feature chain (real editor flow).** Import → filler-cut → 2-up layout → auto-color each cell → lower-third with backing bar → captions → stabilize the handheld cell → export. Verify nothing regresses and the final export matches the assembled preview (minus the export-only stabilize/curves, which the badges disclose).
16. **Aspect coverage.** Every layout preset in 16:9, 9:16, 1:1, and 4:5 — the four aspects real deliverables use — verifying the fraction-based geometry holds and the stacked/degrade variants kick in for vertical.

---

### One-line summary for the dev lead
Shapes = a new overlay `ShapeClip` (rect/ellipse/line/arrow) rendered via the existing PNG-overlay/canvas path, with stroke/fill/corner-radius/arrow-head proportions specified above. Layouts = pure transform placement into fraction-defined cells reusing the current cover-crop + center-anchor overlay math, with explicit fewer/more-clip rules. Auto-color = a faithful primary correction (WB neutralize + percentile level stretch + gentle contrast/sat) written into the existing `ColorGrade`, conservative on good/stylized footage. Stabilize = export-only two-pass vidstab at `smoothing 15`, auto-zoom capped ~10%, with honest crop/rolling-shutter/binary-availability warnings.
