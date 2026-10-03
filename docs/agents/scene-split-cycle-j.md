# Senior Video Editor (understanding / ingest) — "Already-built video → divided into clips" (Cycle J, feature #7)

Goal: when a user uploads a FINISHED/rendered video (one file, one long clip), Cadence finds its
scenes and splits it into separate, labelled, editable clips so each part can be rearranged,
trimmed, deleted or restyled. Free, in the browser, nothing to install; ffmpeg is an upgrade, not a
requirement.

## Architecture (edits-as-code stays the source of truth)

```
 video file ──► browser scan (hidden <video> + 64×36 canvas)      ┐
 transcript ──► sentences / silence                               ├─► cut points (SOURCE seconds)
 audio      ──► beats (lib/beats.ts)                              │        │
 N seconds  ──► interval                                          ┘        ▼
 ffmpeg (optional) select='gt(scene,X)' ──────────────────────────► planSourceSplit()  (pure, shared)
                                                                           │ cuts + labelled shots
                                                                           ▼
                                                      splitIntoScenes(doc, …)  (pure, undoable, ripple-safe)
                                                                           ▼
                                                      EditDoc: N clips, each with `label`, exact sourceIn
```

| Piece | File | Notes |
|---|---|---|
| Pure scoring + strategies | `packages/understanding/src/scenes.ts` (subpath `@cadence/understanding/scenes`) | `frameSignature` (3×16-bin RGB histogram + 6×6 luma grid) → `signatureDistance` (max of half-L1 hist, 1.5× grid Δ) → `detectCutsFromScores` (local median + k·MAD, absolute floor, strongest-first NMS by `minShotSec`, clear of both ends) · `refineCut` · `sentenceCuts` · `silenceCuts` · `beatCuts` · `intervalCuts` · `planSourceSplit` · `samplePlan` |
| ffmpeg upgrade | `packages/understanding/src/scenes-ffmpeg.ts` | `detectSceneFfmpeg` (never throws on absence → `{available:false}`), `parseShowinfoCuts`, `sceneScanArgs`; path guarded by the same SSRF check as transcription; Node builtins lazy-imported |
| Core op | `packages/director/src/scenes.ts` | `splitIntoScenes`, `timelineTimeAtSource` |
| Director tool + routing | `tools.ts` (`split_into_scenes`), `scene-intent.ts` (`parseSceneSplit`, `wantsSceneDetection`), `stub-director.ts` (3 added lines) | |
| Schema | `packages/core/src/schema.ts` | optional `label` on every clip (additive; old docs identical) |
| Browser detector | `apps/web/src/lib/scene-detect.ts` | scan once per media (cached), cheap re-threshold on slider moves, boundary refinement, thumbnails, server probe |
| Chat bridge | `apps/web/src/lib/scene-director.ts` | scans in the browser and ships `sceneCuts` to `/api/director` |
| UI | `apps/web/src/components/SceneSplit.tsx` (`SceneOfferBanner`, `SceneSplit`) | |
| API | `apps/web/src/app/api/scenes/route.ts` | `GET` → `{ffmpeg}`, `POST {src,sensitivity}` → `{cuts}` or 501 + hint |

## The op's guarantees (`splitIntoScenes`)
- Cut points are SOURCE seconds (or timeline seconds / `everySec`) and are mapped to timeline time by
  bisection over core's `sourceTimeAt`, so **speed, speed ramps and reversed clips** cut at the right frame.
- Each cut goes through the engine's own `splitClipAtTime` (keyframes/fades/ramps re-normalised per half).
- **Ripple-safe**: pieces tile the original exactly, so captions/titles/b-roll/music/markers never move
  (verified: frames byte-identical across the cut, total length unchanged).
- **Audio link**: a video clip carries its own audio, so picture and sound are cut together; a separate,
  sync-aligned audio clip of the same media is split at the same instants (out-of-sync ones are left alone).
- Cuts closer than `minShotSec` to an edge or each other are dropped; locked tracks and freeze-frame clips
  are skipped; a no-op returns the SAME doc reference (callers skip an empty undo step).
- Pure `(doc, opts) → EditDoc`, one `commit` = one undo step.

## UI
1. **Offer** — after a single video ≥ 10 s loads: teal strip "Looks like a finished video. Divide it into scenes…?"
   [Divide into scenes] [Not now]. It hides itself once the doc is no longer one undivided clip.
2. **Media room → Divide into clips** — method pills (Scene changes · Sentences · Silences · Beats · Every N
   seconds), sensitivity + shortest-clip sliders, Detect (progress bar `Scanning frames 120/480` + Cancel),
   live preview: cut markers on the real timeline strip, a mini strip (click to jump), a thumbnail per shot with
   its label and range; **Divide into N clips** → "Done — N clips" + **Undo**. Optional "Use server ffmpeg" appears
   only when `/api/scenes` reports ffmpeg.
3. **Chat** — "split this video into scenes", "divide into clips", "cut at every scene change", "chop every 5
   seconds", "split into 10 second clips", "split by sentence", "split at the pauses", "chop to the beat";
   modifiers "more sensitive", "only the major ones", "at least 2 seconds long".

Never freezes the UI: every sample awaits a `seeked` event (a macrotask), the scan is abortable, progress per
sample; long videos are sampled at most 900 times (rate drops instead) and boundaries are then refined locally.

## Gates (real numbers)
- Root + web `tsc`: clean. `npm run test:unit`: **186/186** (24 new in `tests/scene-split.test.ts`).
- `npm run verify`: **71/71** — check 71 splits a doc (frames byte-identical across cuts, export plan builds),
  scores synthetic colour changes, and (bundled ffmpeg 6.0) runs the REAL `select='gt(scene,X)'` scan on a
  synthesized 3-shot mp4 and splits a doc at the cuts it finds.
- `npm run evals`: **9/9** (g: scenes with client cuts · h: "chop every 30 seconds" · i: "split by sentence").
- `next build`: clean (only the pre-existing `uploads.ts` tracing warning remains).
- Playwright `scene-split.spec.ts`: a 12 s 4-shot `.webm` is generated in the browser, uploaded; banner → dismiss →
  Media room scan → 3 cut markers within 0.6 s of 3/6/9 s, 3 timeline markers → sensitivity slider → Apply → 4 clips
  labelled Scene 1–4 with `sourceIn` ≈ 0/3/6/9 → Undo → 1 clip → chat "chop every 4 seconds" → chat "split this video
  into scenes" → 4 clips.

## Limitations / follow-ups
- **Hard cuts and fast changes only.** Slow dissolves/fades and scenes that differ only by motion are
  under-detected (the 4 fps coarse scan compares neighbours). Raise sensitivity, or use sentences/interval.
- PySceneDetect is **not wired** (no CLI here to verify its output format against — AGENTS.md rule 2); the ffmpeg path is.
- The timeline strip still labels video clips with their duration (`CutsStrip.clipLabel`, another lane's file);
  `clip.label` shows in the Media room list and the code drawer. One-line follow-up: `clip.label ?? fmtTime(...)`.
- Beats/interval in the UI cut in SOURCE time; for a clip already retimed they may not land on whole timeline seconds
  (the Director's interval/beats use TIMELINE time).
- A clip trimmed before dividing gets numbered labels (transcript-label alignment needs the whole source).
- Browser decoding limits apply (a codec the browser can't play can't be scanned; the section shows the error and the
  ffmpeg path, if installed, is the fallback).
- The scan caches per media id for the session only (not persisted).
