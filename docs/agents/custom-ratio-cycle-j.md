# Custom ratio — "Canvas & size" (Cycle J, feature #3)

Owner: product-minded senior editor agent · Branch: `worktree-agent-aab9fe5aee99cb90f` (base `master @ 7669591`)

Goal: Canva "custom size" / CapCut "ratio" / Premiere "sequence settings" parity. Any
frame size or ratio, a clear choice of how footage adapts, platform presets, saved sizes,
Magic resize, safe-zone guides — all edits-as-code, preview == export, no paid service.

## Audit (at 7669591)

| Area | State before | Gap |
|---|---|---|
| Frame size | `meta.width/height` (the single source of truth); `reframeTo` takes any W×H; 8 named aspects | No UI to type a size or ratio; only 8 fixed ratios from the Director |
| Adaptation | Footage is always cover-scaled + cropped (ffmpeg `increase`+`crop`, Stage `object-cover`) | No "fit whole picture" with bars; no blurred background |
| Resize side effects | `reframeTo` re-centers media, moves text by fraction | Font sizes / shapes / callouts / cursors don't follow; a stale `quality.targetWidth/Height` from the old aspect would DISTORT the export |
| Presets | 6 Deliver-room pills (16:9, 9:16, 1:1, 4:5) | No per-platform catalogue (IG story/carousel, FB, X, LinkedIn, Pinterest, Snapchat, Twitch, print, scope…) |
| Multi-size | none | One project → many sizes meant redoing the edit |
| Guides | none | No platform UI safe areas |

## What ships

1. **Schema (backward compatible).** `meta.canvas` is OPTIONAL: `{ fit: "fill"|"fit", fill: "blur"|"solid", fillColor, blur, ratio, presetId, linked, magicTargets, customPresets[] }`. Absent ⇒ legacy cover behavior; the key is not emitted, so old docs round-trip byte-identically (migration test). `stretch` is deliberately not a fit mode — media is never distorted. Size stays `meta.width/height`.
2. **`@cadence/core/canvas`** — pure: bounds (even, 64–7680), `validateCanvasSize`, `parseRatio` (`21:9`, `1.91:1`, `7:5`, `16/9`, bare `2.39`), `parseSizeText`, `sizeForRatio`, `ratioLabel` (names 1.91:1 / 2.39:1 …), `linkedSize` (link-lock), `swapOrientation`, a 40-preset catalogue grouped by platform, `SOCIAL_MAGIC_SET`, `SAFE_ZONES` (title-safe, TikTok, Reels, Shorts — fractions of the frame), `mediaFitRect` (cover vs contain, never stretches), `blurRadiusFor`.
3. **Director ops + tools** (`canvas-ops.ts`, `canvas-parse.ts`):
   - `setCanvasSize(doc, {width,height | ratio | presetId, fit, fill, fillColor, blur, relayout})` → `reframeTo` for the base re-anchor, then re-lays text (font/maxWidth/outline), shapes, callouts, cursors **by fractions**, keeps `quality.target*` in the new aspect (scaled when the aspect is unchanged, cleared when it changed), and records `meta.canvas`.
   - `setCanvasFit`, `withCanvasSettings`, `magicTargets`, `magicResize(doc, targets, {fit, fill})` → one valid, retitled doc per size.
   - Tools **`set_canvas_size`** and **`magic_resize`** (the latter queues ids on `meta.canvas.magicTargets`; the web panel creates + exports the copies).
   - StubDirector phrases: "make it 21:9", "make it 3:2", "make it 1.91:1", "make it 1080 by 1350", "reframe to 1600x900", "fit the whole video with a blurred background", "use black bars", "fill the frame", "resize for all social platforms", "resize for tiktok, instagram and youtube". Named words ("vertical", "square") still go through the existing `reframe` tool; timestamps ("at 1:30") are never read as ratios.
4. **Export (ffmpeg plan).** One helper `coverFilters(doc, W, H)` replaces the 4 base-clip `scale…increase,crop` pairs: Fill = unchanged; Fit·solid = `scale=…decrease,pad=…:color=0x…,setsar=1`; Fit·blur = a marker that `pushVideoChain` expands to `split` → cover+`boxblur` background, contain foreground, `overlay=(W-w)/2:(H-h)/2`. PiP overlays are untouched. The output size is the doc size (custom sizes honored end to end; verified with a real encode).
5. **Preview.** Stage frame already sized by `meta` aspect; Fit swaps `object-cover` → `object-contain`, solid bars set the frame colour, blur adds a muted, self-syncing backdrop copy (`FitBackdrop`, blur scaled from the same `blurRadiusFor` as the export). Node canvas draws the contain rect with bars/tinted bg.
6. **Canvas panel** (`CanvasPanel.tsx`, non-modal side sheet; opens from the top-bar size chip, the Deliver room "Custom size…" / "Magic resize" pills, or the Director's `magic_resize`):
   - W×H inputs with link-lock + rotate + live validation ("1081 → 1082, even sizes only"), a ratio field ("21:9" → "Set 2560×1080"), Apply on Enter.
   - Fill / Fit·blur / Fit·color cards with mini diagrams, blur strength, bar colour, "re-layout text" toggle — applied live and remembered per change.
   - Presets grouped by platform with live ratio thumbnails + search; saved custom sizes (localStorage in try/catch **and** embedded in the doc so they travel with the project); recents.
   - Safe-zone guides (Off / Title / TikTok / Reels / Shorts) as a Stage overlay (preview only, never exported).
   - **Magic resize** tab: pick sizes (Social set / any preset) → "Create N copies" (sibling projects via `/api/projects` + `/doc`; with no database it downloads `.editdoc.json` files instead) → "Export all N" (sequential through the existing export path, with Stop).

## Files

New: `packages/core/src/canvas.ts`, `packages/director/src/canvas-ops.ts`, `canvas-parse.ts`, `apps/web/src/components/CanvasPanel.tsx`, `CanvasFit.tsx`, `apps/web/src/lib/canvas-prefs.ts`, `tests/canvas.test.ts`, `apps/web/e2e/custom-ratio.spec.ts`.
Shared files, additive/small hunks: `core/schema.ts` (+`meta.canvas`), `core/index.ts`, `director/{tools,stub-director,index}.ts`, `render-ffmpeg/plan.ts` (helper + marker in `pushVideoChain` + 4 one-line swaps), `render-node/canvas-engine.ts` (`drawMedia` fit), `web/{Stage,TopBar,Editor,RoomPanel}.tsx` (a size chip, a mount, two pills, fit classes + overlay), `scripts/{verify,evals}.ts`.

## Limitations

- Fit applies to the base (full-frame) footage and photos; picture-in-picture / b-roll overlays keep their own box.
- Blurred-bars preview duplicates the `<video>` (muted, resynced if it drifts > 0.3 s) — a heavier decode on very long 4K clips; the node canvas (thumbnails/verify) approximates the blur with a darkened tile.
- Safe-zone insets are conservative guides — platform UIs shift; they are not exported.
- `quality.target*` is cleared when the aspect changes; re-pick High/Ultra in Export to up-scale again.
- Magic resize copies re-lay text by fractions but are not subject-aware (no auto-reframe tracking — that remains money-gated).
- Keyframed x/y on media are preview-only on export (pre-existing).
