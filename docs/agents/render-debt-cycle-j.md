# Render / engine debt — Cycle J (S7.x)

Lane: `packages/render-ffmpeg` and engine-side TODO debt. Every item = schema (additive) → Director tool + StubDirector routing → preview → export → verify check. Gate checks live in `scripts/verify-render-debt.ts` (checks 71–78); they encode REAL files with the bundled ffmpeg and compare pixels to the pure resolvers (`valueAt`, `sampleLut`, `sourceTimeAt`).

## Audit finding
The TASKS "Deferred" list was stale: keyframe export (PiP), LUT import, adjustment layers, karaoke and the speed-ramp curve editor already existed (S4.16–S4.19, S4.31, S4.17). This cycle closed the *real* gaps in each.

| # | Item | Status | What changed |
|---|------|--------|--------------|
| 1 | Keyframe export fidelity | done | Base-clip x/y/rotation/opacity (`baseTransformKeyframeFilters`), PiP scale (`scale eval=frame`). Real encode matches `valueAt` (x centre 543 vs 545, opacity luma 157 vs 159, PiP width 370 vs 371). Blend/chroma/mask layers keep static transforms. |
| 2 | Export z-order | done | `zOrderedOverlayItems`; layers/text/shapes/mid-stack adjustments in track order; hidden text track skipped. |
| 3 | Speed-ramp UI | done (adjusted) | The draggable curve editor already lives in CutsStrip (off-limits). Added `SpeedRamp.tsx` preset strip (new presets montage / hero-time / flash-in) hooked into the Edit room; export segmentation rewritten (`rampSegmentBounds`). |
| 4 | Karaoke + 6 caption presets | done | pop/underline/glow, `CAPTION_PRESETS`, `set_caption_preset`. |
| 5 | LUT import | done | parse/serialize, 6 bundled looks, exact canvas, fitted SVG preview (approximate, says so), export via `lut3d`. |
| 6 | Adjustment layers | done (refined) | Already built; now z-aware (grade only what is beneath) and previewed in the browser. |
| 7 | Urdu/Arabic/Hindi | done | Noto fonts, shaping + RTL + fallbacks in shared draw; real export frame verified. |
| 8 | Handwriting | done | `handwrite` anim style. |
| 9 | Per-scene theme | done | `sceneThemes` recipe + tool + UI. |
| 10 | Shuttle audio ≠1× | **skipped** | Forward 2×/4× audio needs the Stage media elements to *play* at `playbackRate` while the shuttle rAF loop keeps writing `timeSec`; today Stage re-seeks on every `timeSec` change while not `playing`, which kills audio, and reverse audio is impossible with `<video>`. Doing it safely means changing the Stage/Editor transport contract (owned by the editing-craft lane). Suggested design: pass `shuttleRate` to Stage; for rate>1 set `playbackRate=rate`, `preservesPitch=false`, play, and let the video clock lead (drop the per-tick seek, re-sync every ~0.5 s). |

## Limitations
- LUT preview in the browser is a fitted matrix + curve (mean error < 0.01 on the bundled looks; arbitrary imported LUTs may deviate). Export is exact. Imported-LUT preview params persist in localStorage; the canvas engine applies only `bundled:` LUTs exactly.
- Speed-ramp export is piecewise-constant (≥ 3 source frames per segment); very short clips with extreme slow-mo remain coarse. Emphasis / keyframe-zoom still do not combine with a ramped clip.
- Base-clip keyframes: scale still uses zoompan (≥ 1×); a ramped base clip ignores x/y/rotation/opacity keyframes.
- Karaoke `pop` exports the settled (full-scale) frame per word, not the 0.12 s ease.
- Handwrite traces contour *length*, not true pen order; every contour of a glyph draws simultaneously.
- RTL: word/karaoke layout is reversed for RTL lines; typewriter/scramble on Arabic are not reshaped mid-reveal.
- Mid-stack adjustment ordering uses track position; an adjustment with callouts/cursors above it still grades them only when it is topmost.
