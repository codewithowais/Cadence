# Cadence → CapCut Parity Spec

> **Author:** Senior video editor (CapCut / Premiere Pro / DaVinci Resolve / Final Cut).
> **Status:** Advisory only. No code changed. This is the plan for turning Cadence
> into an **AI + full-manual** editor where *every AI capability also has a manual control*.
> **Scope of truth:** grounded in the actual code — `packages/core/src/schema.ts`,
> `packages/director/src/{tools,edits,demo,slideshow}.ts`, `packages/render-node`,
> `packages/render-ffmpeg`, and `apps/web/src/{components,lib}`.

---

## 0. The one thing to understand first (architecture reality check)

Cadence is **edits-as-code**: a Zod `EditDoc` is the single source of truth, Director
tools + client `edit-ops` are *pure functions* `(doc, …) => EditDoc`, and three
renderers are pure functions of the doc:

| Renderer | File | Layer model today |
|---|---|---|
| Browser preview (Stage) | `apps/web/src/components/Stage.tsx` | reads `activeClipsAt` (track order) |
| Canvas raster (thumbnails / node) | `packages/render-node/src/canvas-engine.ts` | **composites all active clips in track order, bottom→top** (real layers) |
| Export (.mp4) | `packages/render-ffmpeg/src/plan.ts` | **flattens** — see below |

**The load-bearing finding for this whole document:** the schema already models
`tracks: Track[]` with `kind: "visual" | "audio"` and the canvas engine already
composites them as **true stacked layers** (`packages/core/src/engine.ts` →
`activeClipsAt` returns clips "in paint order (earlier tracks first, i.e. bottom of
the stack)"). But the **ffmpeg export does not honor arbitrary track z-order.**
`collectVisualBase()` in `plan.ts` merges *every* visual track except the hardcoded
`"broll"` id into **one concatenated base sorted by `start`**, then overlays only the
`"broll"` track + text/callout/cursor. Chroma/blend/mask composite "over the layer
beneath," but on export "beneath" effectively means "the broll overlay track," not
"track N-1."

So: **multi-track layers are ~80% built in the data model and preview, and missing in
(a) the timeline UI and (b) the export planner.** Any "add a second video layer"
feature that ships UI-only will preview correctly and then **flatten on export** —
a parity break that violates Cadence's core contract. This is the single most
important thing to get right, and it drives the roadmap in §D.

A second structural fact that shapes everything: **track identity is by
convention, not schema.** `edit-ops.ts` and `doc.ts` hardcode
`OVERLAY_TRACK_IDS = {titles, captions, broll, fades, music, voiceover}` and treat
everything else as a "main sequential" (magnetic, gap-closing) track. There is **no
per-track metadata** (name, hidden, locked, muted, solo, z-order) on the `Track`
schema at all. That is complaint #1's root cause.

---

## A. Parity audit

CapCut is the benchmark the user named. Columns: does CapCut have it → Cadence
status (✅ have / 🟡 partial / ❌ missing) → priority.

### Timeline & tracks

| Feature (CapCut name) | CapCut | Cadence status | Where it lives / why | Priority |
|---|---|---|---|---|
| Multiple visual **layers** (overlapping tracks) | ✅ | 🟡 **data+preview yes, export no, UI no** | `activeClipsAt` composites layers; `plan.ts` flattens all-but-broll | **P0** |
| Add / remove track | ✅ | ❌ | no tool, no UI, no schema affordance | **P0** |
| Track **headers** (name / kind badge) | ✅ | 🟡 read-only chips in `TrackPanel` (RoomPanel.tsx); not on the timeline lanes | timeline lanes in `CutsStrip` have **no header column** | **P0** |
| Track **hide/show** (eye) | ✅ | ❌ | no field, no control | **P0** |
| Track **lock** | ✅ | ❌ | no field, no control | **P1** |
| Track **mute / solo** | ✅ | 🟡 mute-per-track exists (`TrackPanel`, `setTrackVolume→0`); no real "muted" flag; **no solo** | mute is faked via volume=0 | **P1** |
| Rename track | ✅ | ❌ | no `name` field | **P1** |
| Reorder tracks (change z-order) | ✅ | ❌ | track array order = z-order, but nothing reorders it | **P0** |
| **Magnetic** main track (auto gap-close) | ✅ (CapCut main track) | ✅ | `reflowTrack` / `reanchorOverlays` in `edit-ops.ts` | — |
| Drag clip **across** tracks | ✅ | ❌ | `CutsStrip` move drag only reorders **within** a track | **P0** |
| Snapping (edges / playhead / markers) | ✅ | ✅ | `snap()` + `SNAP_PX` in `CutsStrip` | — |
| Ripple trim (main track) | ✅ | ✅ | `trimClip` re-flows the track | — |
| **Roll** trim (adjust cut point, total length fixed) | ✅ | ❌ | not implemented | P1 |
| **Slip** (shift source in/out, position fixed) | ✅ | ❌ | not implemented | P1 |
| **Slide** (move clip, neighbors absorb) | ✅ | ❌ | not implemented | P2 |
| Split at playhead | ✅ | ✅ | `splitClip` + `S` key | — |
| Ripple delete / delete | ✅ | ✅ | `rippleDeleteClip` / `deleteClip` | — |
| Duplicate | ✅ | ✅ | `duplicateClip` | — |
| Timeline **zoom** anchored to playhead + follow | ✅ | 🟡 zoom exists but not anchored/following (user complaint #3) | `CutsStrip` zoom is a raw multiplier; scroll not re-centered | **P0** (fix in flight) |
| Multiple **sequences** (projects/comps) | ✅ (CapCut: separate projects; Premiere: sequences) | ❌ | one `EditDoc` per editor | P2 (see §2) |

### Keyframes / motion / speed

| Feature | CapCut | Cadence | Notes | Priority |
|---|---|---|---|---|
| Keyframe **engine** (pos/scale/rot/opacity/volume) | ✅ | ✅ | `Keyframe` schema + `valueAt`, all three renderers | — |
| Keyframe **editor UI** (diamonds on the timeline, drag) | ✅ | ❌ | only the Director `animate`/`add_keyframe` tools + a Color curve editor; **no timeline keyframe UI** | **P0** |
| Speed (constant) | ✅ | ✅ | `VideoClip.speed`, `set_speed` tool | — |
| **Speed ramp** (curve / keyframed speed) | ✅ (CapCut "Curve") | ❌ | `speed` is a scalar; no time-remap curve | **P1** |
| Reverse | ✅ | ✅ | `VideoClip.reversed` | — |
| Freeze frame | ✅ | ✅ | `VideoClip.freezeAtSec` | — |
| Ken Burns / photo motion | ✅ | ✅ | `ImageClip.motion` | — |

### Text / stickers / overlays

| Feature | CapCut | Cadence | Notes | Priority |
|---|---|---|---|---|
| Titles / lower-thirds | ✅ | ✅ | `TextClip`, `add_title` | — |
| Animated text (in/out) | ✅ | 🟡 in-anim only (`TextAnim`: kinetic/pop/bounce/typewriter); **no out-anim, no loop** | schema `anim` is intro-only | P1 |
| **Text presets** (styled templates) | ✅ (huge library) | 🟡 fonts + outline + bg pill; no one-click styled presets | `styleCaptions`, `CAPTION_FONTS` | P1 |
| Auto **captions** from speech | ✅ | ✅ | `add_captions` from transcript | — |
| Caption **karaoke / word highlight** | ✅ | ❌ | captions are per-segment text clips | P2 |
| **Stickers / emoji / shapes** | ✅ | ❌ | no sticker/shape clip kind (callout is the closest) | P1 |
| Image/video overlay (PiP) | ✅ | ✅ | `add_broll` (corner/size) | — |

### Filters / color

| Feature | CapCut | Cadence | Notes | Priority |
|---|---|---|---|---|
| Filter / look presets | ✅ | ✅ | 14 looks in `apply_look`; `LOOKS` pills | — |
| Manual grade (bright/contrast/sat/warmth/hue) | ✅ | ✅ | `ColorGrade`, Color room sliders | — |
| Tone curves (master + RGB) | ✅ | ✅ | `Curves`, draggable `CurveEditor` | — |
| **LUT import (.cube)** | ✅ | ❌ | no LUT primitive | P1 |
| HSL **secondary** (per-hue-range) | ✅ | 🟡 global hue/sat only (`adjust_hsl` says so) | P2 |
| Scopes (histogram / parade) | ✅ (Resolve-grade) | ✅ | client-only `Scopes` in Color room | — |
| **Adjustment layer** (grade a range across clips) | ✅ | ❌ | grade is per-clip only | P1 |

### Audio

| Feature | CapCut | Cadence | Notes | Priority |
|---|---|---|---|---|
| Volume / mute per clip & track | ✅ | ✅ | `setClipVolume`, `setTrackVolume` | — |
| Fade in/out handles | ✅ | 🟡 fades exist (`fadeInSec/OutSec`, Audio room sliders); **no on-clip drag handles** | P1 |
| Pan | ✅ | ✅ | `pan` field, Audio room | — |
| Ducking (auto lower music under speech) | ✅ | ✅ | `auto_mix` | — |
| LUFS normalize | ✅ | ✅ | `loudnorm` / `normalize_loudness` | — |
| **Beat detection** (snap cuts to music) | ✅ | ❌ | no beat analysis; markers are manual | P1 |
| **Denoise / voice isolation** | ✅ | 🟡 `Quality.denoise` (whole-frame video denoise at export) but **no audio denoise** | P2 |
| Waveform on timeline | ✅ | 🟡 one waveform strip for the base media only (`CutsStrip`) | P2 |

### Compositing / VFX

| Feature | CapCut | Cadence | Notes | Priority |
|---|---|---|---|---|
| Green screen (chroma key) | ✅ | ✅ | `ChromaKey`, VFX room (verified — real ffmpeg `chromakey`+`despill`) | — |
| Mask (shape + feather + invert) | ✅ | ✅ | `Mask` (rect/ellipse), VFX room (verified) | — |
| Blur / pixelate region | ✅ | ✅ | `RegionFx`, VFX room | — |
| Blend modes | ✅ | ✅ | `BlendMode` (6), VFX room — **but only composites over broll on export** (see §0) | 🟡 P0-dependent |
| Transitions library | ✅ (100s) | 🟡 7 types (`TransitionType`); no picker gallery, applied globally by `set_transition` | **P1** |
| **Motion tracking** | ✅ | 🟡 gated stub — `auto_reframe` centers; `subjectTracking` documented as money-gated, not performed | keep gated | P2 |
| Whole-frame VFX (vignette/grain/leak) | ✅ | ✅ | `Vfx`, VFX room | — |

### Product-specific (Cadence's edge) & delivery

| Feature | CapCut | Cadence | Notes | Priority |
|---|---|---|---|---|
| **Walkthrough / interaction demo** builder | ❌ (Cadence differentiator) | 🟡 **engine only** — `build_demo`, cursor, typewriter, callout all exist; **no UI room** (user complaint #4) | **P0** |
| Templates | ✅ | ❌ | slideshow/demo are the only "templates" | P2 |
| Stock library / effects store | ✅ | ❌ | out of scope for now | P2 |
| Aspect presets | ✅ | ✅ | `reframe` + Deliver platform pills | — |
| Export presets (platform/codec/fps) | ✅ | ✅ | `set_platform`, Deliver room | — |
| Text-based editing (edit transcript) | 🟡 (CapCut has it) | ✅ | `edit_by_transcript`, Words room | — |

---

## B. Top P0/P1 specs (edits-as-code, backward compatible)

Every spec below is **schema-additive** (new fields are `.optional()` or
`.default()`-ed so all existing docs stay valid), provides **both** a Director tool
(AI) and a **manual UI control**, and must render identically across
preview↔canvas↔ffmpeg (the non-negotiable Cadence bar).

### P0-1 — Track metadata + true multi-track layers

**The keystone.** Everything else in track management hangs off this.

**Schema (`packages/core/src/schema.ts`), additive to `Track`:**
```ts
export const Track = z.object({
  id: z.string().min(1),
  kind: TrackKind,
  clips: z.array(Clip).default([]),
  name: z.string().optional(),            // header label; falls back to id
  hidden: z.boolean().default(false),     // exclude from render (visual) 
  locked: z.boolean().default(false),     // UI-only: block edits/selection
  muted: z.boolean().default(false),      // audio track: drop from mix
  solo: z.boolean().default(false),       // audio: if any track solos, only solos play
  // z-order stays implicit = array index (documented), OR add:
  // z: z.number().optional()  // NOT recommended — keep array order as truth
});
```
Keep **array order = z-order** (already true in `activeClipsAt`); reordering tracks
= reordering the array. Do not add a `z` field — it would create two sources of truth.

**Renderers (the real work):**
- Canvas (`render-node`): honor `hidden` (skip), `muted`/`solo` (audio) — a few
  guard lines; layer order already correct.
- **ffmpeg (`render-ffmpeg/src/plan.ts`): rework `collectVisualBase` → composite by
  track z-order.** Instead of "concat everything except broll," build the base from
  the **lowest visual track**, then `overlay` each higher visual track's clips in
  order (they already carry `transform`, `blendMode`, `chroma`, `mask`). This is the
  parity fix that makes UI layers real. Preserve the fast path: when there is exactly
  one visual track (the common case), emit today's concat graph unchanged.
- Honor `hidden`/`muted`/`solo` in `collectVisualBase`/`collectAudioClips`.

**Director tools:**
```
add_track({ kind, name?, afterTrackId? }) → inserts a track
remove_track({ trackId })                  → drops it (and its clips)
set_track({ trackId, name?, hidden?, locked?, muted?, solo? })
reorder_track({ trackId, toIndex })        → change z-order
```
All are thin pure fns in `edit-ops.ts` / a new `packages/director/src/tracks.ts`.

**Manual UI (`CutsStrip.tsx`): add a left-hand track-header column.** Each lane gets
a ~140px sticky header: name (double-click to rename), kind badge, and icon toggles
for 👁 hide, 🔒 lock, 🔇 mute, S solo, plus a drag-handle to reorder the lane and a
`×` to remove. A `+ Track` button at the bottom of the header column. This is the
direct fix for complaint #1. Route every toggle through the existing
`commit`/undo path in `Editor.tsx` (same pattern as `onSetTrackVolume`).

> **Sequencing caution:** ship the *header UI + hide/lock/mute/solo/rename/reorder*
> (which work on data the preview already respects) and the *export z-order rework*
> **in the same wave**, or gate the "add a real second video layer" UI action behind
> the export fix. Never let a user stack layers that silently flatten on export.

### P0-2 — Cross-track clip drag (with snapping)

**No schema change.** Extend `CutsStrip`'s move drag: when the pointer's Y crosses
into another lane, retarget the clip to that track. New pure op in `edit-ops.ts`:
```ts
moveClipToTrack(doc, clipId, toTrackId, toStartSec): EditDoc
```
- Dropping onto a **magnetic/main** track → insert + `reflowTrack` (snap to sequence).
- Dropping onto an **overlay/free** track → keep the dropped `start` (snapped to
  edges/playhead/markers via the existing `snap()`), free-positioned.
- Respect `locked` (no drop). Reuse `SNAP_PX`.

**Director:** fold into a `move_clip({ clipId, trackId?, atSec? })` tool (generalizes
today's within-track reorder).

### P0-3 — Walkthrough / Demo room (make `build_demo` discoverable)

The engine is **done** (`build_demo`, `add_cursor`, `type_text`, `add_callout`,
cursor/typewriter/callout schema + all three renderers). It has **zero UI**. Add an
**8th room**.

**`RoomsRail.tsx`:** add `{ key: "demo", label: "Demo", hint: "Walkthroughs" }`
(a cursor-arrow glyph). Extend `RoomKey`.

**`RoomPanel.tsx` → new `DemoRoom`:**
- **"Build walkthrough"** button → fires `build_demo` on the project's ordered
  screenshots; `per-screen seconds` stepper; `transition` picker; **"seed login
  interaction"** toggle (the `login` option).
- **Manual primitives** (each = an existing tool, now a button + inspector):
  - **+ Cursor path** — click points on a preview overlay to add `waypoints`; a
    "click here" toggle adds a ripple time. (→ `add_cursor`)
  - **+ Typewriter** — text + click-to-place on the preview → `type_text`.
  - **+ Callout** — drag a rect on the preview → `add_callout` (label / dim / zoom).
- Because `build_demo`'s field/button positions are documented as *fractional
  defaults with no vision*, the room's headline value is **letting the user nudge
  them visually** — a draggable cursor/callout overlay on the Stage.

**Schema:** none — all primitives already exist.

### P0-4 — Timeline zoom that anchors + follows (complaint #3)

A fix is reportedly in flight; here is the **CapCut-correct behavior** to match:
- **Anchor zoom to the playhead** (or the pointer under the cursor for wheel-zoom):
  keep `timeSec`'s pixel position fixed while `pxPerSec` changes — after setting
  zoom, set `scrollLeft += (newX - oldX)` for the anchor time.
- **Ctrl/⌘ + wheel** = zoom at cursor; plain wheel = horizontal scroll; pinch on
  trackpad = zoom.
- **Playhead-follow during playback:** when the playhead leaves the viewport, page
  the scroll so it re-enters (CapCut scrolls by a viewport when the head hits ~90%).
- **Fit / zoom-to-selection:** a "Fit" button sets zoom so `total` fills the lane;
  double-tap zooms to the selected clip.
- Keep snapping in **pixel** space (already correct via `pxToSec(SNAP_PX)`).

### P1-1 — Transitions gallery (per-cut)

`TransitionType` already has 7 faithful, export-verified types. Today `set_transition`
applies **one type globally**. CapCut applies transitions **per cut** from a gallery.

- **Schema:** already per-clip (`transitionType` on each visual clip). No change.
- **Director:** `set_transition({ type, clipId?, atSec? })` — target one boundary.
- **UI:** a transition **chip on each cut** in `CutsStrip` (a small ◇ between
  adjacent clips); clicking opens a mini-gallery (the 7 types) + a duration slider
  (`transitionInSec`). This is a timeline affordance, not a room.

### P1-2 — On-timeline keyframe editor

The keyframe **engine** is complete (`Keyframe`, `valueAt`, parity). There is **no
manual keyframe UI** — only Director `animate`/`add_keyframe`. CapCut edits keyframes
as diamonds on an expandable clip row.

- **Schema:** none (`keyframes?: Keyframe[]` exists on video/image/text/solid/audio).
- **UI:** when a clip is selected and "Keyframes" is expanded, render a sub-lane per
  animatable `prop` with draggable diamonds (t along the clip, value on Y); a
  ⬦ "add keyframe at playhead" button; right-click to change easing. Each drag →
  a pure `setKeyframe`/`moveKeyframe` op → `commit`.
- **Director parity:** the existing `add_keyframe` already covers the AI side.

### P1-3 — Speed ramp (time remap curve)

CapCut "Speed → Curve" (e.g. "Bullet time," "Hero"). Today `speed` is scalar.

- **Schema (additive to `VideoClip`):**
  ```ts
  speedRamp: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0.1).max(10)])).optional()
  // [clipProgress, speedMultiplier] control points; absent ⇒ use scalar `speed`
  ```
- **Engine:** `sourceTimeAt` integrates the ramp (piecewise) instead of a constant
  multiplier — one pure change shared by canvas/Stage/export (matches the existing
  "one pure helper" rule). ffmpeg export approximates via segmented `setpts` (same
  strategy already used for keyframes → linear time expr).
- **Director:** `set_speed_ramp({ points | preset })`. **UI:** a speed-curve editor
  in the Edit inspector (reuse the `CurveEditor` component pattern).

### P1-4 — LUT import + adjustment layer

- **LUT:** add `lut: z.string().optional()` (asset id of a `.cube`) to `ColorGrade`;
  ffmpeg `lut3d`; canvas approximates (documented, like curves). Tool `apply_lut`,
  Color room "Import LUT."
- **Adjustment layer:** a new lightweight `AdjustmentClip` kind (a `ColorGrade`/`Vfx`
  spanning a timeline range on its own track) that the renderers apply to everything
  beneath within its span. Manual: "+ Adjustment layer" in the Color room; AI:
  `add_adjustment({ atSec, durationSec, look? })`. **This depends on P0-1's export
  z-order rework** (it *is* a layer).

### P1-5 — Audio fade handles + beat markers

- **Fade handles:** no schema change (`fadeInSec/OutSec` exist) — add the two corner
  drag handles CapCut shows on an audio clip; drag → `audioFade` coalesced.
- **Beat detection:** analyze an audio asset (client Web Audio, like `computeWaveform`)
  → push beat times as `markers`. Manual: "Detect beats" in Audio room; AI:
  `detect_beats()`. Cuts can then snap to these markers (snapping already includes
  markers).

---

## C. AI ↔ manual mapping (nothing is AI-only)

The product rule: every capability reachable by prompt is also reachable by hand,
and vice-versa. Current + proposed:

| Capability | AI trigger (Director tool) | Manual control | Gap |
|---|---|---|---|
| Trim / split / ripple / reorder | `set_timeline` | `CutsStrip` drag + inspector | ok |
| Add / remove / rename track | **`add_track`/`remove_track`/`set_track`** (new) | **track headers** (new) | build both (P0-1) |
| Hide / lock / mute / solo track | **`set_track`** (new) | header toggles (new) | build both (P0-1) |
| Reorder track (z-order) | **`reorder_track`** (new) | drag lane handle (new) | build both (P0-1) |
| Move clip across tracks | **`move_clip`** (new) | cross-lane drag (new) | build both (P0-2) |
| Color grade | `apply_look`, `adjust_color`, `adjust_hsl`, `adjust_curves` | Color room sliders + curve editor | ok |
| LUT | **`apply_lut`** (new) | Color room import (new) | P1-4 |
| Chroma / mask / blend / region | `chroma_key`, `add_mask`, `set_blend`, `blur_region` | VFX room | ok |
| Transitions | `set_transition` (global) | **per-cut chip** (new) | UI gap (P1-1) |
| Keyframes | `animate`, `add_keyframe` | **timeline diamonds** (new) | UI gap (P1-2) |
| Speed | `set_speed` | Edit inspector | ok (scalar) |
| Speed ramp | **`set_speed_ramp`** (new) | speed-curve editor (new) | P1-3 |
| Captions / text | `add_captions`, `add_title`, `add_kinetic_title`, `style_captions` | Words room, title pills | ok |
| Stickers / shapes | **`add_sticker`** (new) | sticker picker (new) | P1 |
| Audio mix / fade / pan / duck / LUFS | `auto_mix`, `audio_fade`, `set_pan`, `normalize_loudness` | Audio room | ok (add fade handles) |
| Beat sync | **`detect_beats`** (new) | "Detect beats" (new) | P1-5 |
| **Walkthrough / demo** | `build_demo`, `add_cursor`, `type_text`, `add_callout` | **Demo room** (new) | UI gap (P0-3) |
| Reframe / platform / quality / export | `reframe`, `set_platform`, `set_quality` | Deliver room | ok |
| Motion tracking | `auto_reframe` (subjectTracking gated) | Deliver/VFX pill | keep gated |

**Principle to enforce going forward:** a new Director tool without a matching manual
control (and vice-versa) should not merge. The pure-fn layer (`edits.ts` /
`edit-ops.ts`) is the shared spine — both the tool and the UI button call the same
pure function, so parity is structural, not duplicated.

---

## D. Sequenced roadmap (waves on disjoint files)

Same convention the repo already uses (`docs/WAVE-PLAN.md`): each wave = agents on
**disjoint** trees — **`packages/**`** (engine + schema + renderers) vs
**`apps/web/**`** (UI) — so they never collide. Integrate → verify → commit between
waves. Each wave is independently shippable and has a verify hook (`scripts/verify.ts`
+ a render/plan parity check).

### Wave A — Track model + real layers (the keystone) — **P0**
- **`packages/**`:** add `Track` metadata (`name/hidden/locked/muted/solo`); pure
  ops `addTrack/removeTrack/setTrack/reorderTrack/moveClipToTrack`; Director tools
  `add_track/remove_track/set_track/reorder_track/move_clip`; **rework
  `render-ffmpeg/plan.ts` to composite visual tracks by z-order** (keep single-track
  fast path); honor `hidden/muted/solo` in canvas + ffmpeg; verify: a 2-video-layer
  doc renders identically in canvas snapshot and ffmpeg plan.
- **`apps/web/**`:** track-header column in `CutsStrip` (name/rename, kind badge,
  hide/lock/mute/solo, reorder handle, remove, `+ Track`); cross-track clip drag;
  wire all through `Editor.tsx` commit/undo.
- **Ships:** complaint #1 fully solved; layers real end-to-end.

### Wave B — Discoverability + zoom feel — **P0** (can run parallel to A; disjoint files)
- **`apps/web/**` only:** Demo room (#4) + draggable cursor/callout/typewriter
  overlays on the Stage; timeline zoom anchor-to-playhead + follow + fit (#3);
  per-cut transition chip UI (uses existing per-clip field — no engine change).
- **`packages/**`:** none required (Demo/transition engines already exist). Optional:
  `set_transition({ clipId })` targeting.
- **Ships:** walkthrough builder is findable; zoom behaves.

### Wave C — Manual craft depth — **P1**
- **`packages/**`:** speed-ramp (`speedRamp` field + `sourceTimeAt` integration +
  export segmentation); `set_speed_ramp`; keyframe move/set pure ops; LUT primitive.
- **`apps/web/**`:** on-timeline keyframe diamond editor; speed-curve editor; audio
  fade drag-handles; LUT import in Color room.
- **Ships:** keyframes + speed ramps + LUTs editable by hand.

### Wave D — Layer-native effects + audio intelligence — **P1**
- **`packages/**`:** adjustment-layer clip kind (depends on Wave A z-order); beat
  detection helper; `add_adjustment`, `detect_beats`.
- **`apps/web/**`:** adjustment-layer control (Color room); "Detect beats" +
  beat-snapped cutting; sticker/shape clip + picker.
- **Ships:** adjustment layers, beat-sync, stickers.

### Wave E — Trims + sequences — **P1/P2**
- **`packages/**`:** roll / slip / slide pure ops (+ tools).
- **`apps/web/**`:** modifier-key trim modes on the timeline; **multiple sequences**
  (see §2 — a bigger lift: a project holds `sequences: EditDoc[]` or the editor
  manages N docs). Sequences are P2 — do layers first.

**Non-negotiable bars (every wave):** one shared pure helper for preview↔export
parity · frame-accurate quantize · gap-free ripple · a render/plan verify per feature
· additive/defaulted schema so old docs still parse.

---

## Appendix — Complaints, answered directly

**#1 "No multi-track management."** Root cause: `Track` has no metadata and the
timeline lanes have no header column. Fix = **Wave A** (schema + header UI +
add/remove/reorder/hide/lock/mute/solo/rename). Note the deeper issue: even the data
model's layers **flatten on ffmpeg export today** — Wave A fixes that too, or the
feature would be a preview-only illusion.

**#2 "Multiple timelines."** Two different things:
- **Multi-track LAYERS** (stacked video/audio on *one* timeline) — this is what
  CapCut users mean 95% of the time, it's what your compositing (chroma/blend/mask)
  needs to be useful, and it's **mostly built already** (schema + canvas). **Build
  this first (Wave A).**
- **Multiple SEQUENCES** (separate timelines you cut between, à la Premiere
  sequences / CapCut separate projects) — a genuinely bigger architectural change
  (the editor assumes one `EditDoc`). **Defer to Wave E (P2).**
  My recommendation: layers now, sequences later. Layers unlock 10× more value per
  unit of work and are the actual blocker for your VFX room.

**#3 "Zoom feels wrong."** Correct CapCut behavior spec'd in **P0-4** (anchor to
playhead/cursor, follow during playback, fit/zoom-to-selection, ⌘+wheel).

**#4 "Can't find the walkthrough builder."** `build_demo` + cursor/typewriter/callout
are fully implemented in the engine and renderers but have **no room** — reachable
only by prompt. Fix = **Wave B** Demo room, with visual nudging of the
fraction-defaulted cursor/field/button positions.

**#5 "So many features missed."** The audit (§A) is the honest inventory. The biggest
real gaps, in order: **true export-side layers**, **track management UI**,
**timeline keyframe UI**, **per-cut transitions gallery**, **speed ramps**, **LUTs /
adjustment layers**, **beat sync**, **stickers**. Much of the "missing" surface is
actually **built-but-unexposed** (layers, keyframes, demo, per-clip transitions) —
so a lot of parity is UI-wiring, not new engine work.
