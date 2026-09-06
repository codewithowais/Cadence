# Cadence — Build Wave Plan

Synthesized from `EDITING-ROADMAP.md` (senior editor), `UX-ROADMAP.md` (UX), and
`EDITING-REVIEW.md` (head of editing). Each wave runs as a group of agents on
**disjoint** files so they never collide: one owns `packages/**` (+ `scripts/verify.ts`),
the other owns `apps/web/**`. Integrate → gate → commit between waves.

## Wave 2 — P0 fixes + make audio audible  ← running
- **Engine (packages):** P0-1 render video-cut **transitions on export** (xfade in the
  all-video branch; fix A/B crossfade so it dissolves between clips, not from black) +
  preview parity; P1 caption source-time honors `speed`; multi-video audio concat robust
  when a clip has no audio; clamp speed reads to EOF; `add_music` gains `startSec`/`durationSec`.
- **Web (apps/web):** P0-3 **music auto-attaches on upload** (media-aware copy) and is
  **audible in the browser preview** (hidden `<audio>` synced to the timeline, incl.
  slideshow); P0-2 **overlays ripple** with the main track on trim/split/reorder/delete
  (`edit-ops.ts`/`doc.ts`); UX quick wins — determinate progress on edits/export, undo
  toast, describe-first composer, single Export.

## Wave 3 — craft foundations
- Keyframe engine: `Keyframe {t,value,easing}` + one pure `valueAt()`; keyframable
  position/scale/rotation/opacity/crop/volume; canvas + Stage + ffmpeg parity.
- Multi-track video compositing (layers, blend order); reverse; freeze-frame; markers in schema.
- Deliver room: platform presets (YouTube/TikTok/Reels/Shorts), codec/bitrate/fps, SRT/VTT sidecar, thumbnail/poster.

## Wave 4 — VFX + color + audio depth
- Chroma-key (green screen) + spill/matte; mask primitive (draw+feather); blur/pixelate regions; blend modes; adjustment layers.
- Color: curves (RGB/HSL), HSL secondary, LUTs, scopes (waveform/vectorscope), auto-balance.
- Audio mixer: keyframable volume/pan, crossfades, ducking curves, LUFS normalize.

## Wave 5 — AI-native edge
- Text-based (transcript) editing; auto-reframe with subject tracking; silence removal; TTS voice-over (gated providers).

## Non-negotiable quality bars (all waves)
Frame-accurate trims (quantize to fps) · one shared pure helper for preview↔export parity ·
A/V sync via `sourceTimeAt` · real easing · gap-free ripple · a render/plan verify check per feature.
