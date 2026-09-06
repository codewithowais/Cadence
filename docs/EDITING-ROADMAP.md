# Cadence — Professional Editing Roadmap

*A senior editor's map of where Cadence stands against a real NLE (Premiere, Resolve, Final Cut, CapCut, After Effects), and what to build next for the biggest jump in genuine editing power.*

**Written against the code as of S3.6.** Everything below is mapped to Cadence's edits-as-code model: every feature = **data on the `EditDoc`** (`packages/core/src/schema.ts`) **+ a typed Director tool** (`packages/director/src/tools.ts`) **+ a renderer path** (canvas preview, browser Stage, `@cadence/render-ffmpeg` export). A feature isn't "done" until all three agree.

---

## 1. What Cadence already has (honest inventory from the code)

Maturity legend: **Solid** = data + tool + all three renderers + verify check · **Preview-only / Export-only** = manifests in one place, not both · **Thin** = exists but shallow (one preset, no keyframes, hardcoded defaults).

| Area | Capability | Where it lives | Maturity |
|---|---|---|---|
| **Cuts** | Highlight cut (`create_highlight`), filler/pause removal (`filler_cut`) | `highlight.ts`, `filler.ts` | **Solid** — transcript-driven, word-accurate, verified |
| **Looks / color** | 14 presets (`apply_look`) + 4 live sliders (`adjust_color`: brightness/contrast/saturation/warmth) | `edits.ts`, `grade.ts`, `ColorGrade` | **Solid** but **thin** — global multipliers only, no wheels/curves/scopes |
| **Captions** | Burn-in from transcript (`add_captions`), synced through cuts, auto-fit, pill bg; restyle (`style_captions`: font/weight/color/outline/size/position) | `edits.ts`, `TextClip` | **Solid** (preview); export font-fidelity is a known follow-up (no TTF bundling) |
| **Titles / fades** | Title card + lower-third (`add_title`), kinetic titles (`add_kinetic_title`: kinetic/pop/bounce), typewriter (`type_text`), fades to/from black (`add_fades`), solid/color clips | `TextClip.anim` (`TextAnim`), `SolidClip` | **Solid** for what's there; animation set is fixed-recipe, not keyframed |
| **B-roll / PiP** | Corner-anchored overlay (`add_broll`) on a `broll` track, image or video | `edits.ts` | **Solid** but **thin** — static position/size, no keyframes, no mask |
| **Speed** | Constant speed ramp (`set_speed`, 0.25–4×), `setpts`/`atempo` | `VideoClip.speed`, `engine.ts` `sourceTimeAt` | **Solid** but constant-only — **no speed ramps / time-remap curves** |
| **Zoom / reframe** | Static punch-in (`zoom`: scale+pan), animated emphasis pulse (`add_emphasis`) | `Emphasis`, `Transform` | **Solid** but fixed-recipe (sine pulse), no arbitrary keyframes |
| **Transitions** | 7 types (`set_transition`: crossfade/dip-to-black/slide/wipe/dissolve/zoom/smooth) → ffmpeg `xfade` | `TransitionType` | **Solid** — clip-to-clip only, one global type applied to all |
| **VFX overlays** | Whole-frame vignette / grain / light-leak (`apply_vfx`) | `Vfx` on `EditDoc` | **Solid** but whole-frame only, not per-region |
| **Reframe** | 8 aspects + custom W×H (`reframe`) re-anchors all clips | `Meta`, `reframeTo` | **Solid** — but re-anchoring is centered, **no subject-aware auto-reframe** |
| **Photo → video** | Slideshow (`make_slideshow`): Ken Burns + crossfades + look | `slideshow.ts`, `KenBurns` | **Solid** |
| **Multi-video** | Append several videos into one combined timeline; Media-room clip manager | `combinedVideoDoc`/`appendVideos` | **Solid** but **sequential concat only** — no true multi-track layering/compositing |
| **Audio / voice-over** | VO recording (mic), music upload, per-clip volume/mute, `add_music` (ducked), `auto_mix` | `AudioClip`, tracks | **Export-only** for the mix (preview has no audio graph); **thin** — static duck, no keyframed volume, no EQ/comp/NR/LUFS |
| **Transforms** | Per-clip `Transform` (x/y/scale/rotation/opacity/anchor=center) | `Transform` | **Solid data, static values** — **no keyframes / easing on any of them** |
| **Timeline editing** | Select→inspector, drag-trim (snapping), split at playhead, drag-reorder, ripple-delete, duplicate, per-clip volume, zoom 1–24×, markers | `lib/edit-ops.ts` | **Solid** for a single main sequence; markers not yet persisted in schema |
| **Interaction demo** | Screenshots→walkthrough (`build_demo`): animated `cursor` clip, `callout` clip, typewriter, typed login | `CursorClip`, `CalloutClip`, `demo.ts` | **Solid** — genuinely differentiated |
| **Quality / delivery** | `set_quality` (standard/high/ultra→4K), faithful Lanczos+unsharp+hqdn3d upscale, pluggable AI super-res (gated), real `.mp4` export | `Quality`, `@cadence/render-ffmpeg`, `@cadence/enhance` | **Solid** (export); **no platform presets, no thumbnail/poster, no SRT sidecar, no chapters** |
| **AI-native** | Transcription (Whisper/Stub), transcript-driven highlight + filler + captions, self-correcting Director loop | `@cadence/understanding`, `agentic.ts` | **Solid foundation**; higher-order AI edits (auto-reframe tracking, silence removal as its own tool, text-based editing UI, TTS VO) still missing |

**The honest headline:** Cadence is a strong *assembly + finishing* engine with a real edits-as-code spine and a genuinely novel AI/demo layer. What it is **not yet** is a *craft* editor: there are **no keyframes on anything**, **no true multi-track compositing**, **no audio mixing graph**, and **no color tools beyond global multipliers**. Those four gaps are what separate it from "a pro could actually cut on this."

---

## 2. The professional editing feature set (by discipline)

Effort: **S** = ≤ a few days (data + tool + one renderer path) · **M** = ~1–2 weeks (all three renderers + verify) · **L** = multi-week (new subsystem: a keyframe engine, an audio graph, a scope pipeline, a tracker).
Status: ✅ have · ◻ partial · ✗ missing.

### 2.1 Timeline / craft

| Feature | What it is / why editors need it | Effort | Status |
|---|---|---|---|
| **J & L cuts** | Audio leads (J) or trails (L) the video across a cut — the backbone of dialogue/interview pacing | M | ✗ (needs audio on its own track offset from video; today audio is welded to the clip) |
| **Roll / slip / slide edits** | Adjust cut points without moving downstream (roll), change source in/out without moving the clip (slip), move a clip re-rippling neighbors (slide) | M | ◻ trim/reorder exist (`edit-ops.ts`); slip (sourceIn without duration change) and roll are missing |
| **Insert / overwrite** | The two fundamental drop modes when adding a clip | S | ◻ append/reorder only; no true insert(ripple) vs overwrite semantics |
| **Multi-track video layering / compositing** | Stack video with opacity/blend/transform to build a frame — the difference between a *sequence* and a *composite* | L | ◻ tracks exist in schema; render composites, but authoring is single-main-sequence + one broll track |
| **Snapping / magnetic timeline** | Clips snap to edges/playhead/markers; ripple keeps the sequence gapless | S | ✅ snapping in `edit-ops`; magnetic ripple partial |
| **Nested sequences / compound clips** | Group clips into one you can treat as a unit (reusable lower-third packages, graded sub-edits) | L | ✗ (no clip-of-clips; would need a `sequenceRef` clip kind) |
| **Adjustment layers** | A clip whose grade/VFX apply to everything beneath it — non-destructive global looks | M | ✗ (today `look` is per-clip; `Vfx` is whole-doc — an adjustment *layer over a range* is the missing middle) |
| **Freeze frame** | Hold one source frame for N seconds — emphasis, titles-over-freeze | S | ✗ (would be `speed→0` at a `sourceIn`, or a `hold` flag) |
| **Reverse** | Play a clip backwards | S | ✗ (ffmpeg `reverse`; needs a `reversed` flag on `VideoClip`) |
| **Time-remap curves** | Keyframed speed over time (a curve, not a constant) | L | ✗ (today `speed` is a single scalar) |
| **Speed ramps** | Ease from 100%→slow-mo→100% (the signature action/sports move) | M | ✗ (depends on the keyframe engine + time-remap) |

### 2.2 Motion / transform

| Feature | What it is / why | Effort | Status |
|---|---|---|---|
| **Keyframes: position/scale/rotation/opacity/anchor + easing** | The single most important missing subsystem — animate any transform over time with bezier easing | L | ✗ **table-stakes gap.** Data model has static `Transform` only |
| **Motion paths** | A spatial bezier path a clip follows (vs per-axis keyframes) | M | ✗ (builds on keyframes) |
| **Crop / pan / zoom keyframed** | Animated reframe (the "manual Ken Burns" on video, not just stills) | M | ◻ static `zoom` + still-only `KenBurns`; keyframed version missing |
| **Stabilization** | Smooth shaky handheld (ffmpeg `vidstab`, 2-pass) | M | ✗ (export-side filter + a `stabilize` flag) |
| **Transform pinning / anchor control** | Move the anchor so scale/rotate pivot correctly | S | ◻ anchor is fixed to center; expose it |

### 2.3 Titles / graphics / motion graphics

| Feature | What it is / why | Effort | Status |
|---|---|---|---|
| **Styled / animated titles** | Rich type with animated in/out | S | ✅ (`add_title`, `add_kinetic_title`, typewriter) — good coverage |
| **Lower-thirds** | Name/role bug | S | ✅ (`add_title` style: lower-third) |
| **Shapes** | Rectangles/lines/circles as clips (backers, dividers, progress bars) | S | ◻ only `solid` (full-frame) + callout box; no free shape clip |
| **Masks (draw + feather + track)** | Reveal/hide part of a layer; the core of compositing & selective color | L | ✗ (no mask primitive anywhere) |
| **Text on path** | Type following a curve | M | ✗ |
| **Kinetic templates** | Parameterized MOGRT-style animated title packages | M | ◻ three built-in styles; not a template system |
| **Callouts / annotations** | Highlight boxes, arrows, dims | S | ✅ (`CalloutClip`) — strong, from the demo engine |

### 2.4 Color

| Feature | What it is / why | Effort | Status |
|---|---|---|---|
| **Primary wheels (lift/gamma/gain)** | Shadow/mid/highlight color balance — the grammar of grading | M | ✗ (only brightness/contrast/sat/warmth multipliers) |
| **Curves (RGB / per-channel / HSL)** | Precise tonal & hue control | L | ✗ |
| **HSL qualifier / secondary** | Isolate a color (skin, sky) and grade only it | L | ✗ (needs a key/mask) |
| **LUTs (.cube)** | Apply a look/creative LUT, match camera profiles | M | ✗ (ffmpeg `lut3d`; add a `lut` ref to `ColorGrade`) |
| **Scopes (waveform / vectorscope / histogram)** | Objective exposure/color reading — pros will not grade without them | M | ✗ (a canvas analysis pass over the preview frame; no new render path) |
| **Auto-balance / white balance** | One-click neutralize | S | ◻ `warmth` slider only |
| **Match shot** | Match one clip's grade to another | L | ✗ |

### 2.5 Audio

| Feature | What it is / why | Effort | Status |
|---|---|---|---|
| **Multi-track mixer** | Independent tracks with levels — dialogue/music/SFX | M | ◻ tracks exist; no mixer UI, mix is export-only |
| **Keyframable volume / pan** | Ride levels over time; place in stereo field | M | ✗ (volume is one scalar/clip) — **depends on keyframe engine** |
| **Fades / crossfades (audio)** | Prevent clicks; smooth music transitions | S | ◻ visual fades exist; dedicated audio fade/xfade missing |
| **Ducking curves** | Music dips *under* speech dynamically (sidechain) | M | ◻ static duck (0.28) only — no dynamic/keyframed duck |
| **EQ / compressor / noise reduction** | Make voice sit right; kill hiss/hum | M | ✗ (ffmpeg `equalizer`/`acompressor`/`afftdn` + flags on `AudioClip`) |
| **Loudness normalization (LUFS)** | Hit platform targets (-14 YT, -16 podcast) — a delivery must | S | ✗ (ffmpeg `loudnorm`; a delivery setting) |
| **Trim / loop music to length** | Fit a bed to the edit | S | ◻ music added whole; no trim/loop-to-fit |
| **Beat markers / beat-synced cuts** | Cut on the beat | M | ✗ (beat detect → markers; pairs with markers-in-schema) |
| **Preview audio graph** | *Hear* the mix while editing, not just on export | L | ✗ — today preview is silent for music/mix (big UX gap) |

### 2.6 VFX / compositing

| Feature | What it is / why | Effort | Status |
|---|---|---|---|
| **Chroma key (green screen) + spill/matte** | Composite a subject over new bg — a top-3 requested effect | M | ✗ (ffmpeg `chromakey`/`colorkey` + despill; a `key` block on the clip) |
| **Blend modes** | screen/multiply/overlay/add for layers | S | ◻ light-leak uses screen internally; not exposed per-clip |
| **Blur / pixelate / mosaic regions** | Hide faces/plates/logos — a compliance staple | M | ✗ (needs a region + `boxblur`/`pixelize` masked to it) |
| **Masks + tracking** | Follow a moving subject with a mask/effect | L | ✗ (shares the mask + tracker subsystem) |
| **Picture-in-picture** | Inset a second source | S | ✅ (`add_broll`) — though static |
| **Backgrounds** | Solid/gradient fills behind keyed/letterboxed content | S | ◻ `solid` only; no gradient |

### 2.7 Delivery

| Feature | What it is / why | Effort | Status |
|---|---|---|---|
| **Platform presets** | One click → correct size/fps/bitrate/loudness for YouTube/TikTok/Reels/Shorts | S | ✗ **table-stakes gap** — aspects exist but not full presets |
| **Codec / bitrate / fps control** | H.264/H.265/ProRes, target bitrate, fps | S | ◻ quality presets + fps field; no codec/bitrate choice |
| **Poster / thumbnail** | Export a still (or pick a frame) for the thumbnail | S | ✗ (single ffmpeg frame grab) |
| **Captions: burn-in vs sidecar SRT** | Deliver open captions *or* a `.srt`/`.vtt` for platforms | S | ◻ burn-in only; SRT/VTT export missing (transcript is right there) |
| **Chapters** | YouTube chapter markers from titles/markers | S | ✗ (markers → chapter metadata) |

### 2.8 AI-native (Cadence's edge)

| Feature | What it is / why | Effort | Status |
|---|---|---|---|
| **Auto-captions** | Speech→styled captions | S | ✅ (`add_captions` + Whisper) |
| **Filler removal** | Cut "um"/"uh"/pauses | S | ✅ (`filler_cut`) |
| **Silence removal** | Tighten dead air (as a first-class control, separate from filler) | S | ◻ folded into `filler_cut`; not its own tunable tool |
| **Auto-highlight** | Best-moments cut | M | ◻ `create_highlight` ranks segments heuristically; no engagement/scene scoring |
| **Auto-reframe w/ subject tracking** | Keep the speaker centered when going 9:16 | L | ✗ — reframe re-anchors to center only. **Biggest AI differentiator missing** |
| **Text-based editing (edit by transcript)** | Delete words in a doc → cuts the video | M | ✗ — the transcript↔cut mapping already exists internally; this is mostly UI |
| **B-roll suggestions** | Suggest/insert b-roll at relevant moments | M | ◻ manual `add_broll` only |
| **Voice-over generation (TTS)** | Generate a VO track from a script | M | ✗ (money-gated provider, mirrors `@cadence/enhance` pattern) |

---

## 3. Prioritized build plan (top ~20, in waves)

Ranked for the biggest jump in *real* editing power per unit effort, respecting the edits-as-code model. Each wave lands a coherent capability.

### ⭐ The 5 table-stakes gaps a pro will immediately miss
These are the ones that make an experienced editor say "I can't actually cut on this yet." Prioritize them.

1. **Keyframes + easing on transforms** (position/scale/rotation/opacity) — **L**. Nothing animates over time today. This is *the* foundation; motion graphics, speed ramps, animated crop, keyframed audio and ducking all depend on it.
2. **True multi-track video layering / compositing** — **L**. Real overlays, stacked graphics, split-screen — beyond one welded main track + one broll track.
3. **Audible preview audio graph + a real mixer** — **L**. Editing audio you can't hear is a non-starter; the mix being export-only is the single most jarring gap in the current UX.
4. **Platform delivery presets + SRT/VTT sidecar + thumbnail** — **S each**. Cheap, and expected of anything that exports for social.
5. **Chroma key (green screen)** — **M**. The most-requested VFX that Cadence entirely lacks.

### Wave 1 — Foundations (unlock everything downstream)
- **Keyframe engine** (`Keyframe[] { t, value, easing }` on any animatable field; PURE `valueAt(track, t)` helper shared by canvas/Stage/export, mirroring the existing `textKinetic`/`emphasisScale` pattern) — **L** ⭐
- **Multi-track compositing** (author on N visual tracks; blend mode + transform per clip) — **L** ⭐
- **Reverse** clip + **Freeze frame** (`speed=0` / `hold`) — **S**, **S**
- **Insert vs overwrite** drop modes + **slip/roll** edits in `edit-ops.ts` — **M**
- **Markers persisted in schema** (they exist in the UI but not the doc) → unblocks chapters & beat cuts — **S**

### Wave 2 — Motion, audio-you-can-hear, delivery (fastest visible payoff)
- **Preview audio graph** (Web Audio mixing of speech+music+VO with the duck applied live) — **L** ⭐
- **Keyframed volume + pan + audio fades/crossfades** (on top of Wave 1's keyframes) — **M**
- **Dynamic ducking curve** (sidechain-style, keyframed under detected speech) — **M**
- **Keyframed crop/pan/zoom on video** (manual Ken Burns for footage) — **M**
- **LUF loudness normalization** + **platform presets** + **codec/bitrate** + **SRT/VTT export** + **thumbnail/poster** + **chapters from markers** — **S** each ⭐ (batch them; one Deliver-room pass)
- **Speed ramps / time-remap curve** — **L** (needs Wave 1)

### Wave 3 — VFX & compositing depth
- **Chroma key** with spill + matte controls — **M** ⭐
- **Masks** (rect/ellipse/polygon, feather) as a reusable primitive — **L**
- **Blur / pixelate / mosaic region** (mask + filter) — **M**
- **Blend modes exposed per clip** + **gradient backgrounds** — **S**
- **Adjustment layer** (a range-scoped grade/VFX layer) — **M**
- **Stabilization** (`vidstab`) — **M**

### Wave 4 — Color craft & AI edge
- **Scopes** (waveform/vectorscope/histogram from the preview frame — analysis only, no new render path) — **M** ⭐ (pros grade by scopes)
- **Primary wheels (lift/gamma/gain)** + **LUT support** (`lut3d`) — **M**, **M**
- **HSL secondary / qualifier** (depends on masks) — **L**
- **Auto-reframe with subject tracking** (keep speaker in frame on 9:16) — **L** ⭐ *the* AI differentiator
- **Text-based editing UI** (delete transcript words → ripple cuts; mapping already exists) — **M**
- **Silence removal as its own tunable tool** + **beat-synced cuts** (beat detect → markers) — **S**, **M**
- **TTS voice-over** (gated provider, mirrors `@cadence/enhance`) — **M**

---

## 4. Gotchas & quality bars a pro will insist on

These are the invisible things that make an editor trust the tool. Get them wrong and no feature list matters.

1. **Frame-accurate everything.** Trims, splits, cuts, keyframes must land on exact frame boundaries, computed from `meta.fps` — never on floating seconds that drift. Round to `frame = round(t * fps)` at the edit boundary, not at render time. The existing seconds-based model needs a frame-quantization pass before keyframes land.
2. **Non-destructive by construction.** The edits-as-code spine already guarantees this (the doc is a recipe, source is never mutated) — *keep it that way*. Every new feature must be reversible data on the doc, never a baked pixel. Undo/redo (already present via `useDocHistory`) must cover every new tool.
3. **Preview ↔ export parity.** The project's best discipline is the PURE shared helpers (`grade.ts`: `textKinetic`, `emphasisScale`, `transitionMotion`, `cursorPositionAt`…) that make canvas, Stage, and ffmpeg agree. **Every keyframe/mask/key value must resolve through one shared PURE function.** Never let the preview and the export compute a value two different ways — that's how "it looked right in preview" bugs are born. The already-known caption-font export drift (no TTF bundling) is exactly this class of bug; close it.
4. **Audio stays in sync — always.** Speed changes, J/L cuts, and time-remaps must keep audio locked to video sample-accurately. `atempo` chaining and `setpts` must be derived from the *same* source-time mapping (`sourceTimeAt`) the video uses. Drift here is unforgivable to an editor.
5. **Keyframe easing must be real bezier, shared across renderers.** A linear-only keyframe system feels robotic. Ship cubic-bezier easing (with the standard ease-in/out/hold presets) from day one, resolved by one PURE `valueAt()`.
6. **Snapping that can be defeated.** Snapping (already present) must be toggle-able (hold a modifier) — pros need to place a cut *between* frames' worth of snap targets.
7. **Deterministic, gap-free timelines.** Ripple operations must never leave 1-frame gaps or overlaps; assert gaplessness in the verify gate the way render frames are asserted today.
8. **Honest quality messaging (already a Cadence value — keep it).** The "preview stays at source res; upscale happens on export" honesty and the "faithful, no face/content change" contract are a real trust asset. Apply the same honesty to any AI edit (auto-reframe, TTS): say what's generated vs. preserved.
9. **The vertical-4K overshoot bug (`setQuality` scales by width).** Documented in the changelog QA1 — scaling by width sends a 9:16 doc to ~3844×6836. Fix to scale by the **long edge**. Small, but a pro will spot a 26 MP "4K" export instantly.
10. **Every feature = data + tool + three renderers + a verify check.** The 31-check verify gate and 5-prompt eval suite are the reason this codebase is trustworthy. Hold the line: no capability merges without a frame-rendering assertion. This is Cadence's actual moat — the discipline, not any single feature.

---

*File: `/Users/codewithowais/Downloads/video-editing-tool/docs/EDITING-ROADMAP.md`*
