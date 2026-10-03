# Timeline upgrade + drag-and-drop — Cycle J

Owner: senior-video-editor (timeline lane) · Branch: `worktree-agent-aebce1662eae7ba0e` (base `master @ 7669591`)

Goal: make the timeline feel like a real NLE and make every drag a first-class,
previewable, undoable edit — with no timeline vocabulary required. Every drop and
move is a PURE doc-in/doc-out op routed through the editor's undoable `commit`
(edits-as-code); the UI only decides *where* and *how*.

## Audit (what existed at 7669591)

| Area | Before | Gap |
|---|---|---|
| Ruler | one tick per ~80px, `m:ss.d` labels | no minor ticks, no timecode, no frame accuracy when zoomed, rendered the whole timeline |
| Scrubbing | click = single seek | no drag-scrub, no playhead handle |
| Zoom | slider + ± + Fit, anchored to the playhead | no wheel / pinch zoom, jumpy playhead-follow |
| Clips | flat coloured boxes; one shared waveform under the lanes | no thumbnails, no per-clip waveform, fixed 36px lanes |
| Reorder | invisible drag, a thin insertion line | no ghost, no Esc, no preview of the result, vertical-only moves blocked |
| Drops | Media tile → lane, a single line indicator | only media; no preview of length/ripple; text styles, stickers, graphics not draggable; nothing on the preview |
| Collisions | cross-lane moves could stack media on top of media | no insert / overwrite choice |
| Groups | mouse drag moved ONE clip (carried-forward limitation) | — |

## What ships

### Timeline
- **Ruler** (`timeline-ruler.ts`): majors ≥ 84px apart on a frame-aware ladder (frames → 0.5s → 1s … → hours), minors where there's room, labels `m:ss` (or `m:ss:ff` below 1s). Only the visible window (± a screenful) renders.
- **Timecode readout** `MM:SS:FF / total` (project fps) and a `role=slider` playhead with `aria-valuetext`.
- **Scrubbing**: press the ruler, an empty lane area or the playhead head and drag; frame-quantized, edge auto-scroll while scrubbing; ←/→ on the head steps a frame (⇧ = 10).
- **Zoom** around the pointer with Ctrl/⌘+wheel (and trackpad pinch); smooth, eased playhead-follow (instant under `prefers-reduced-motion`).
- **Per-track height** S/M/L (36/56/84px) via a button on each header, remembered in `localStorage` (`cadence:trackH`).
- **Filmstrip** (`filmstrip.ts` + `TimelineClipMedia.tsx`): one hidden muted `<video>` per media, serial seeks, canvas → JPEG, cached per (media, quantized time); only tiles in the scroll viewport render; images repeat the still. **Waveform** per audio clip: just the slice of the media's peaks that clip plays (shared decode cache with the base waveform).
- Snap guide labels the timecode it stuck to; a dragged clip's **right** edge snaps too.

### Drag & drop
- **Ghost + drop preview** while moving a clip: the source dims, a ghost follows the pointer, and the target lane shows a dashed block of the clip's real length — an amber bar for a ripple insert, the nearest free slot on non-main lanes, a red window over the footage an overwrite will replace. Invalid lanes (locked / wrong media family) show red.
- **Insert vs Overwrite** (toolbar group "Drop mode", remembered). Insert: on the main lane the clip lands at the nearest cut and later clips ripple (captions follow); on any other lane media never collide — the clip slides to the nearest free slot and nothing is destroyed. Overwrite: the clip lands exactly where dropped and replaces what's under it (clips straddling an edge are split with the engine's `splitClipAtTime`, so keyframes / fades / speed ramps stay correct).
- **Esc cancels** a move / palette drag with no change (captured before the editor's own Esc). Pointer-cancel aborts too. Trims still commit live (and are undoable).
- **Group drag**: grab any clip of a multi-selection; the group travels together. Main-lane clips move as one block to a slot among the unselected footage; free clips shift by the same delta (clamped at 0) and, when the pointer is on another lane, move that many lanes (all-or-nothing). One undo step.
- **Edge auto-scroll** while dragging (horizontal in the lanes, vertical in the timeline panel); the delta accounts for scroll so a held pointer keeps moving the clip.
- **Palette drops** (`dnd-payload.ts`): Media tiles, classic + animated **text styles**, **stickers** and **graphics** are drag sources. While in flight the timeline knows what's being dragged (module-scoped payload), so the preview is sized correctly before you let go. Drop on a lane at a time, or on the **preview** to add as an overlay at the drop point (media becomes a 0.4× picture-in-picture on a free lane; text/stickers/graphics are placed at the point).
- **Keyboard / a11y**: ⌥⇧↑ / ⌥⇧↓ on a focused clip moves it to the lane above / below at the same time (collision-aware); a polite live region announces drops, moves and cancels; clips, trim handles, ruler and the playhead head use `touch-action: none` so pointer drags work with a finger or pen. Click-to-add on the Media / text / sticker tiles is unchanged.

## Files

- NEW `apps/web/src/lib/timeline-dnd.ts` — pure ops: `placeClip`, `moveClipsGroup`, `reorderBlock`, `insertMediaAt`, `addMediaAsOverlay`, `dropItemIntoDoc`, `previewDrop`, `carveRange`, `nearestFreeStart`, lane helpers, payload types.
- NEW `apps/web/src/lib/timeline-ruler.ts` — ticks, timecode, edge-scroll speed, follow target, zoom clamp, track heights.
- NEW `apps/web/src/lib/dnd-payload.ts` — palette drag payload plumbing (`dragSource`, `readDropPayload`).
- NEW `apps/web/src/lib/use-timeline-dnd.ts` — editor-side hook: drop mode, drop/move callbacks via `commit`, Stage drop handlers.
- NEW `apps/web/src/lib/filmstrip.ts`, `apps/web/src/components/TimelineClipMedia.tsx` — thumbnails + clip waveforms.
- `apps/web/src/components/CutsStrip.tsx` — ruler, scrub, readout, heights, thumbs, ghost, preview, Esc, group drag, auto-scroll, keyboard move (timeline lane — owned).
- Shared files, additive only: `Editor.tsx` (+hook call, `dnd` in the `edit` prop, a `contents` wrapper around the Stage that carries the drop handlers), `RoomPanel.tsx` / `TextRoom.tsx` / `GraphicsGallery.tsx` (drag-source props on the Media tile, text-style, sticker, pro-text and graphic tiles), `edit-ops.ts` (`reflowTrack` now exported).
- Tests: NEW `tests/timeline-dnd.test.ts` (24), NEW `apps/web/e2e/timeline-dnd.spec.ts` (2).

## Design decisions / limitations

- Only MEDIA clips (video / image / audio) collide. Text, stickers, graphics and shapes are overlays and may stack (that is how titles over titles work today).
- The main (magnetic) lane is the first visual sequence track; every other lane is free-positioned. This matches `moveClipToTrack`.
- Overwrite past the end of the main lane extends the timeline; a 2.5s asset overwritten at 0.7s replaces everything it covers.
- Palette drags use HTML5 DnD (mouse / pen); touch devices keep tap-to-add. Esc cancels moves and drops; trims, fades and roll/slip/slide commit live (one undo step each).
- Filmstrip decoding needs same-origin / blob media (a cross-origin source without CORS simply shows no thumbnails). Thumbnails use the clip's constant speed; ramps and reverse show the source frames in source order.
- The timeline panel's default height (150px) still hides the lanes under the toolbar on short screens — drag the divider (or ↑ on the "Resize the timeline" separator). `cadence:tlH` restoration is overwritten by the Editor's persist effect on mount (pre-existing; not touched).

## Results (gates)

See the final report / CHANGELOG S7.1 for the numbers.
