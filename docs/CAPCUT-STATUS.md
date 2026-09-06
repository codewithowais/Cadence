# Cadence → CapCut Parity — Current Status (re-audit)

> **Author:** Senior video-editor QA auditor. **Advisory only — no code changed.**
> **Method:** Verified row-by-row against the real code, not the changelog:
> `packages/core/src/schema.ts`, `packages/director/src/{tools,edits,tracks,trims,demo,stub-director}.ts`,
> `packages/render-ffmpeg/src/plan.ts`, and `apps/web/src/{components,lib}/*`.
> **Baseline:** `docs/CAPCUT-PARITY.md` (the original audit). Since then Cadence shipped
> Cycle F waves A–E (S4.1–S4.8) plus the earlier S3.11–S3.12 AI-edge work.
> **Headline:** the original audit's five biggest gaps are now **closed** — including the
> keystone (export-side multi-track layers). What remains is a short, well-defined P1/P2 list.

---

## 0. The keystone — VERIFIED FIXED

The original audit's load-bearing finding was that **ffmpeg export flattened all visual
tracks** (`collectVisualBase` concatenated everything-but-broll), so any stacked layer was a
preview-only illusion. **This is genuinely fixed** in `packages/render-ffmpeg/src/plan.ts`:

- `collectVisualBase()` (plan.ts:698) now takes the **lowest non-hidden visual track** as the base.
- `collectUpperLayers()` (plan.ts:719) iterates the remaining non-hidden visual tracks **in array
  order (bottom→top)** and composites each over the base through the existing overlay/blend/chroma/
  mask path (plan.ts:1088–1097, "Multi-track layer compositing (z-order)").
- The **single-visual-track fast path is preserved** byte-for-byte (base + a `broll` lane = the
  historical overlay pass).
- `hidden` is honored in visual base, upper layers, and audio; `muted`/`solo` honored in
  `collectAudioClips()` (plan.ts:779) and `soloActive()` (plan.ts:742).

`Track` now carries additive metadata `name?/hidden/locked/muted/solo` (schema.ts:603–618), array
order = z-order (no `z` field — single source of truth, as recommended). Layers are real
end-to-end: data model → canvas → Stage → **export**.

---

## A. Updated parity table

Legend: ✅ done · 🟡 partial · ❌ missing. "AI" = a Director tool trigger exists; "Manual" = a UI
control exists. Both required to count as full parity per Cadence's product rule.

### Timeline & tracks

| Feature (CapCut) | CapCut | Was | **Now** | AI / Manual | Where | What changed |
|---|---|---|---|---|---|---|
| Multiple visual **layers** (overlapping tracks) | ✅ | 🟡 preview-only | **✅** | AI+Manual | `plan.ts` z-order composite; `activeClipsAt` | **Export now honors z-order** (keystone) |
| Add / remove track | ✅ | ❌ | **✅** | AI+Manual | `tracks.ts addTrack/removeTrack`; tools `add_track`/`remove_track`; `CutsStrip` `+ Video/+ Audio` | Built in Wave A |
| Track **headers** (name / kind badge) | ✅ | 🟡 read-only | **✅** | Manual | `CutsStrip` header gutter | Full header column on the lanes |
| Track **hide/show** | ✅ | ❌ | **✅** | AI+Manual | `setTrack`/`set_track`; header eye toggle | New `hidden` field, honored by all 3 renderers |
| Track **lock** | ✅ | ❌ | **✅** | AI+Manual | `set_track`; header toggle; pure ops refuse edits | New `locked` field |
| Track **mute / solo** | ✅ | 🟡 fake (vol=0) | **✅** | AI+Manual | `set_track`; header toggles; `soloActive` in export | Real `muted`/`solo` flags |
| Rename track | ✅ | ❌ | **✅** | AI+Manual | `set_track name`; double-click header | New `name` field |
| Reorder tracks (z-order) | ✅ | ❌ | **✅** | AI+Manual | `reorderTrack`/`reorder_track`; drag-handle | Array reorder = z-order |
| Magnetic main track | ✅ | ✅ | ✅ | — | `reflowTrack`/`reanchorOverlays` | unchanged |
| Drag clip **across** tracks | ✅ | ❌ | **✅** | AI+Manual | `moveClipToTrack`/`move_clip`; cross-lane drag | Built in Wave A |
| Snapping (edges/playhead/markers) | ✅ | ✅ | ✅ | Manual | `snap()`/`SNAP_PX` | now also snaps to beat markers |
| Ripple trim | ✅ | ✅ | ✅ | AI+Manual | `trimClip` | unchanged |
| **Roll** trim | ✅ | ❌ | **✅** | AI+Manual | `trims.ts rollEdit`/`roll_edit`; Roll mode + ±0.1s nudge | Wave E |
| **Slip** trim | ✅ | ❌ | **✅** | AI+Manual | `slipEdit`/`slip_edit`; Slip mode | Wave E |
| **Slide** trim | ✅ | ❌ | **✅** | AI+Manual | `slideEdit`/`slide_edit`; Slide mode | Wave E |
| Split / ripple-delete / duplicate | ✅ | ✅ | ✅ | AI+Manual | `splitClip`/`rippleDeleteClip`/`duplicateClip` | unchanged |
| Timeline **zoom** anchored + follow | ✅ | 🟡 | **✅** | Manual | `CutsStrip` playhead-anchored zoom, follow, **Fit**, dbl-click zoom-to-clip | Wave B |
| Multiple **sequences** (projects/comps) | ✅ | ❌ | **❌** | — | one `EditDoc` per editor | still missing (P2) |

### Keyframes / motion / speed

| Feature | CapCut | Was | **Now** | AI / Manual | Where | Note |
|---|---|---|---|---|---|---|
| Keyframe **engine** | ✅ | ✅ | ✅ | AI | `Keyframe`/`valueAt` | unchanged |
| Keyframe **editor UI** (diamonds) | ✅ | ❌ | **✅** | AI+Manual | `CutsStrip` ⬦ Keyframes sub-lane; `setKeyframe`/`moveKeyframe`/`removeKeyframe`; tools `add/move/remove_keyframe` | Wave C. **Export caveat:** only **scale** (zoompan) and **volume** keyframes render on export; x/y/rotation/opacity keyframes are **preview-only on export** (plan.ts:554) — a 🟡 within a ✅ UI |
| Speed (constant) | ✅ | ✅ | ✅ | AI+Manual | `VideoClip.speed`, `set_speed` | unchanged |
| **Speed ramp** (curve) | ✅ | ❌ | **❌** | — | `speed` is still a scalar; no `speedRamp` field | **still missing (P1)** |
| Reverse / Freeze | ✅ | ✅ | ✅ | AI | `reversed`/`freezeAtSec` | unchanged |
| Ken Burns / photo motion | ✅ | ✅ | ✅ | AI+Manual | `ImageClip.motion` | unchanged |

### Text / stickers / overlays

| Feature | CapCut | Was | **Now** | AI / Manual | Where | Note |
|---|---|---|---|---|---|---|
| Titles / lower-thirds | ✅ | ✅ | ✅ | AI+Manual | `TextClip`/`add_title` | unchanged |
| Animated text in/out | ✅ | 🟡 in only | 🟡 | AI | `TextAnim` (kinetic/pop/bounce/typewriter) | **still in-anim only; no out-anim/loop** |
| **Text presets** (styled templates) | ✅ | 🟡 | **✅** | Manual | `text-presets.ts TEXT_PRESETS`; VFX-room picker | Wave D — one-click Bold Title/Subtitle/Handwritten/Meme. **Manual only, no AI tool** |
| Auto captions | ✅ | ✅ | ✅ | AI | `add_captions` | unchanged |
| Caption **karaoke / word highlight** | ✅ | ❌ | **❌** | — | captions are per-segment text clips | still missing (P2) |
| **Stickers / emoji** | ✅ | ❌ | **✅** (emoji) | Manual | `EMOJI_STICKERS`/`insertSticker`; VFX picker | Wave D — ~20 emoji. **No vector shapes; manual only, no AI tool.** Export emoji fidelity depends on host fonts (noted honestly) |
| Image/video overlay (PiP) | ✅ | ✅ | ✅ | AI | `add_broll` | now also a real upper layer on export |

### Filters / color

| Feature | CapCut | Was | **Now** | AI / Manual | Where | Note |
|---|---|---|---|---|---|---|
| Filter / look presets | ✅ | ✅ | ✅ | AI+Manual | `apply_look` (14 looks); `LOOKS` pills | unchanged |
| Manual grade | ✅ | ✅ | ✅ | AI+Manual | `ColorGrade`; Color-room sliders | unchanged |
| Tone curves (master + RGB) | ✅ | ✅ | ✅ | AI+Manual | `Curves`; `CurveEditor` | unchanged |
| **LUT import (.cube)** | ✅ | ❌ | **❌** | — | no `lut` field, no `lut3d` in plan.ts, no `apply_lut` | **still missing (P1)** |
| HSL **secondary** (per-hue) | ✅ | 🟡 global | 🟡 | AI+Manual | `adjust_hsl` (global `hueShift` only) | unchanged |
| Scopes (histogram/parade) | ✅ | ✅ | ✅ | Manual | `Scopes` in Color room | unchanged |
| **Adjustment layer** | ✅ | ❌ | **❌** | — | no `AdjustmentClip` kind; grade is per-clip | **still missing (P1)** |

### Audio

| Feature | CapCut | Was | **Now** | AI / Manual | Where | Note |
|---|---|---|---|---|---|---|
| Volume / mute per clip & track | ✅ | ✅ | ✅ | AI+Manual | `setClipVolume`/`setTrackVolume` | unchanged |
| Fade in/out **handles** | ✅ | 🟡 sliders | **✅** | AI+Manual | `setClipFade`; `CutsStrip` corner drag handles + ramp triangle; `audio_fade` | Wave C |
| Pan | ✅ | ✅ | ✅ | AI+Manual | `pan`; `set_pan` | unchanged |
| Ducking | ✅ | ✅ | ✅ | AI | `auto_mix` | unchanged |
| LUFS normalize | ✅ | ✅ | ✅ | AI+Manual | `loudnorm`/`normalize_loudness` | unchanged |
| **Beat detection** (snap cuts to music) | ✅ | ❌ | **✅** | Manual only | `lib/beats.ts detectBeats`; "Detect beats"/"Split at beats" (Audio room); beats → `doc.markers`, cuts snap | Wave D. **No Director/AI tool** (`detect_beats` absent) — manual only. Dependency-free energy/onset estimate (honest "estimate" copy) |
| Denoise / voice isolation | ✅ | 🟡 | 🟡 | AI | `Quality.denoise` (video only) | no audio denoise — unchanged |
| Waveform on timeline | ✅ | 🟡 | 🟡 | Manual | `CutsStrip` base-media waveform | unchanged |

### Compositing / VFX

| Feature | CapCut | Was | **Now** | AI / Manual | Where | Note |
|---|---|---|---|---|---|---|
| Green screen (chroma key) | ✅ | ✅ | ✅ | AI+Manual | `ChromaKey`; VFX room | now composites over any lower layer, not just broll |
| Mask (shape+feather+invert) | ✅ | ✅ | ✅ | AI+Manual | `Mask`; VFX room | as above |
| Blur / pixelate region | ✅ | ✅ | ✅ | AI+Manual | `RegionFx`; VFX room | unchanged |
| Blend modes | ✅ | 🟡 broll-only | **✅** | AI+Manual | `BlendMode`; VFX room | **now blends over true z-order layers** (keystone unlocked this) |
| Transitions library | ✅ | 🟡 global | **✅ (per-cut)** | AI+Manual | 7 `TransitionType`; `set_transition({clipId})`/`clear_transition`; **per-cut ◇ chip + gallery** in `CutsStrip` | Wave C. Library is 7 types (CapCut has 100s) — depth gap, not a wiring gap |
| **Motion tracking** | ✅ | 🟡 gated | 🟡 gated | AI (gated) | `auto_reframe` centers; `subjectTracking` money-gated, not performed | unchanged (intentionally gated) |
| Whole-frame VFX (vignette/grain/leak) | ✅ | ✅ | ✅ | AI+Manual | `Vfx`; VFX room | unchanged |

### Product-specific (Cadence edge) & delivery

| Feature | CapCut | Was | **Now** | AI / Manual | Where | Note |
|---|---|---|---|---|---|---|
| **Walkthrough / Demo builder** | ❌ (Cadence edge) | 🟡 engine-only | **✅** | AI+Manual | `demo.ts buildDemo`; `DemoRoom.tsx` (8th room, Screens + build + on-preview placement of cursor/typewriter/callout) | Wave B — the "can't find it" gap is closed |
| Templates | ✅ | ❌ | 🟡 | — | slideshow/demo only | unchanged |
| Stock library / effects store | ✅ | ❌ | ❌ | — | out of scope | unchanged |
| Aspect presets | ✅ | ✅ | ✅ | AI+Manual | `reframe` + Deliver pills | unchanged |
| Export presets (platform/codec/fps) | ✅ | ✅ | ✅ | AI+Manual | `set_platform`; Deliver room | unchanged |
| Text-based editing (edit transcript) | 🟡 | ✅ | ✅ | AI+Manual | `edit_by_transcript`; Words room | unchanged |
| Markers persistence | — | 🟡 local-state | **✅** | AI+Manual | `doc.markers`; `add_marker`; `edit-ops addMarkerAt` | Wave D fix — markers now survive save/load + undo |

---

## B. Done ✅ / Remaining ❌ at a glance

### NOW present in Cadence (new since the original audit)

- **True multi-track layers, real on export** — z-order compositing in ffmpeg (the keystone).
- **Full track management** — add/remove/rename/reorder + hide/lock/mute/solo, both AI and manual.
- **Cross-track clip drag.**
- **On-timeline keyframe editor** (draggable diamonds) — *scale/volume export; x/y/rot/opacity preview-only on export.*
- **Per-cut transition chips** with a 7-type gallery + duration.
- **Audio fade handles** on the clip corners.
- **Roll / slip / slide** trim modes (+ inspector nudges).
- **Beat detection + beat-snap cutting** (manual only).
- **Emoji stickers + one-click text presets** (manual only).
- **Walkthrough / Demo room** with visual on-preview placement.
- **Playhead-anchored zoom + Fit + zoom-to-selection.**
- **Marker persistence** on the doc.
- (Earlier) edit-by-transcript, silence removal, auto-reframe, voice-over.

### Still MISSING / partial

- ❌ **Speed ramps** (time-remap curve) — `speed` is still scalar.
- ❌ **LUT import (.cube)** — no LUT primitive anywhere.
- ❌ **Adjustment layers** — grade is per-clip only.
- ❌ **Karaoke / word-highlight captions** — captions are per-segment.
- ❌ **Multiple sequences** (Premiere-style comps) — one `EditDoc` per editor.
- 🟡 **Keyframe export fidelity** — x/y/rotation/opacity keyframes don't render on export (scale/volume do).
- 🟡 **Text out-animation / looping** — in-animation only.
- 🟡 **Vector shapes** — only emoji stickers, no shape primitives.
- 🟡 **HSL secondary** — global hue shift only, no per-hue-range.
- 🟡 **Audio denoise / voice isolation** — video denoise only.
- 🟡 **Transition library depth** — 7 types vs CapCut's hundreds.
- 🟡 **Motion tracking** — intentionally money-gated (centered reframe is the free path).
- **AI-trigger gaps on shipped manual features:** beat detection, stickers, and text presets have
  **manual controls but no Director tool** — a parity inversion vs Cadence's "every capability
  reachable by prompt AND by hand" rule (previously the gaps ran the other way).

---

## C. Remaining gaps ranked

### P1 (craft depth users will notice)

| Gap | Effort | One-line |
|---|---|---|
| **Keyframe export fidelity** (x/y/rotation/opacity) | **S–M** | Extend `plan.ts` keyframe approximation beyond scale/volume (overlay-x/y expr, rotate, opacity via `format=…,geq`/`fade`) so the diamond editor is truthful on export — highest-value because the UI already ships and silently drops these on export. |
| **Speed ramp** (time-remap curve) | **M** | Add `speedRamp: [progress, mult][]` to `VideoClip`; integrate in `sourceTimeAt` (one shared helper); segmented `setpts` on export; curve editor + `set_speed_ramp` tool. |
| **LUT import (.cube)** | **S–M** | `lut?: assetId` on `ColorGrade`; ffmpeg `lut3d`; canvas approximates; `apply_lut` tool + Color-room "Import LUT". |
| **Adjustment layer** | **M** | New lightweight `AdjustmentClip` (grade/VFX spanning a range) that the renderers apply to everything beneath its span — leverages the now-real z-order; `add_adjustment` + Color-room button. |
| **AI triggers for shipped manual features** | **S** | Add `detect_beats`, `add_sticker`, `apply_text_preset` Director tools calling the same pure fns the UI buttons already call — restores full AI↔manual parity. |
| **Text out-animation** | **S** | Add out-anim to `TextAnim` mirroring the in-anim path. |

### P2 (larger or nicher)

| Gap | Effort | One-line |
|---|---|---|
| **Karaoke captions** | **M** | Word-timed highlight within a caption clip (word data already exists in the transcript). |
| **Multiple sequences** | **L** | Architectural — the editor assumes one `EditDoc`; needs a project holding N docs + a switcher. Do everything else first. |
| **HSL secondary** (per-hue) | **M** | Per-hue-range qualifier on top of the global hue shift. |
| **Audio denoise / voice isolation** | **M** | ffmpeg `afftdn`/`arnndn` pass + Audio-room control (model gating for RNNoise). |
| **Vector shapes** | **S–M** | A `shape` clip kind (rect/ellipse/line/arrow) beyond emoji stickers. |
| **Transition library depth** | **S each** | Add more `xfade` types to the existing per-cut gallery. |
| **Motion tracking** | **L / gated** | Keep money-gated until a vision provider is wired; free centered reframe stays the default. |

---

## Verdict

**Done vs remaining:** Of the original audit's 8 headline gaps, **6 are fully closed**
(export-side layers, track management UI, timeline keyframe UI, per-cut transitions, walkthrough
room, cross-track drag) and **2 remain** (speed ramps, LUTs/adjustment layers). Beat sync and
stickers shipped too, but **manual-only** — the AI-trigger side is the new small gap. The single
most important remaining correctness item is the **keyframe export fidelity caveat**: the diamond
editor lets users animate x/y/rotation/opacity, but only scale/volume survive to the exported
`.mp4` — worth fixing first because it's a live preview↔export parity break on a shipped feature.

No code was changed. Doc written to `docs/CAPCUT-STATUS.md`.
