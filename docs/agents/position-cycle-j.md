# Senior video editor / motion designer — Position (Cycle J, feature #2)

Owner: POSITION lane. Branch: `worktree-agent-ad8787d49045224ea`.

Goal: Canva / CapCut / After-Effects-grade control over where a layer sits and how it is
transformed — by hand (on the preview + numbers) **and** by sentence — all as edit-doc ops
(edits-as-code, undoable, keyframe-aware).

## Audit (base = master @ 7669591)

- The Stage preview was read-only: no selection on the canvas, no handles, no guides.
- `Transform` = `{ x, y, scale, rotation, opacity }` (anchor = centre; text anchors by `align`).
  No flip. Text/shape/solid already honor keyframed `x y scale rotation opacity` through
  `keyframeTransformState` (shared by Stage canvas, Skia renderer and export).
- b-roll PiP overlays were drawn with static CSS (keyframes/rotation ignored in the preview).
- `setKeyframe` supports video/image/text/solid but not shapes.
- Z-order is track order (no per-clip z).

## What ships

| Piece | Where |
|---|---|
| Pure math: rotated boxes, hit-test, 8-handle resize (aspect / from-centre, rotated frames), rotate-from-pointer (15° snap), smart-guide snapping (canvas edges+centre, 5% safe margins, other layers' edges/centres), align / distribute / fit | `packages/core/src/transform.ts` |
| Clip → on-canvas box (`layerBoxesAt`): text measured with a canvas ctx (estimator without one), left/right-aligned text rotates about its anchor, shapes, b-roll overlays, base media (selectable, not movable); `boxToPatch` converts an edited box back into `x/y/scale/rotation` / shape `w,h` | same |
| Edit-doc ops: `setTransform(s)` (keyframe-aware), `moveClipsBy`, `alignClips`, `distributeClips`, `fitClip`, `resetTransform`, `arrangeClip` | `packages/director/src/transform-ops.ts` |
| Director tools `set_transform`, `align_clip`, `arrange_clip` + `parseTransformRequest` (StubDirector) | `packages/director/src/transform-tools.ts` |
| `Transform.flipX/flipY` (optional) honored by `drawText` / `drawShape` / `drawShapeAnimated` | `packages/core/src/{schema,draw}.ts` |
| On-canvas selection box | `apps/web/src/components/TransformLayer.tsx` |
| Transform inspector | `apps/web/src/components/TransformInspector.tsx` |
| Stage wiring (draft doc, inspector column, b-roll keyframe/rotation/flip preview) | `apps/web/src/components/Stage.tsx` |

## Interaction model

- **Select**: click a layer (top-most hit; Shift/⌘-click toggles); click empty canvas or Esc clears. Selection is
  the editor's `selectedClipId` / multi-select, so canvas and timeline stay in sync.
- **Move**: drag the body. Shift = axis lock, Alt = no snapping. Group drag moves every selected layer.
- **Resize**: shapes get 8 handles (free), text and overlays get the 4 corners (always uniform — their
  transform model is a single scale), lines/arrows get the 2 end handles (length). Shift keeps aspect (shapes),
  Alt resizes from the centre. Works on rotated layers (pointer is un-rotated into the box frame).
- **Rotate**: the round handle above the box; Shift snaps to 15°. Text with a left/right alignment rotates
  about its anchor, and the box is the visual footprint (`LayerBox.anchor`).
- **Nudge**: arrow keys while the preview has focus (1px, Shift = 10px); the editor's arrow-seek is
  suppressed only there.
- **Edit text**: double-click a text layer → in-place textarea (Enter applies, Esc cancels, Shift+Enter newline).
- **Snapping + guides**: magenta guide lines (dashed for the safe margins); 6 screen-px threshold.
- **One undo step per gesture**: a drag previews a *draft doc* in the Stage (built from the committed doc at
  pointer-down, so there is no drift) and lands a single `commit` on pointer-up. Arrow nudges and inspector
  fields use `coalesce` keys.
- **Keyframe-aware**: if a prop (x / y / scale / rotation / opacity) already has keyframes, the edit upserts a
  keyframe at the playhead's clip-progress instead of the static value (◆ in the inspector marks such props).
  Shape `w/h` and flip are static.

## Inspector

X · Y · W · H · rotation · scale · opacity, a 3×3 **reference point** (which point of the box X/Y/W/H refer
to; resizing keeps it fixed), px / % units, lock aspect (forced on for uniform layers), flip H/V, 9-point and
edge align (canvas or selection), distribute (3+), Fit / Fill / Reset, arrange (front / forward / backward / back).
Fields commit on Enter / blur; ↑/↓ step (Shift ×10).

## Director

| Tool | Examples (StubDirector) |
|---|---|
| `align_clip` | "move the title to the top left", "put the logo in the bottom right corner", "center it", "align the title to the left" |
| `set_transform` | "make the logo smaller / bigger", "rotate 15 degrees", "flip the logo", "make the badge 50% transparent", "move it up a bit", "fit the logo to the screen", "reset the logo position" |
| `arrange_clip` | "send the logo to the back", "bring the title to the front" |

Nouns (`title · caption · logo · shape · overlay · it`) resolve to layers by kind; "it" = the top-most layer.
`set_transform.x/y` address the layer **centre**. Text size words ("make the title bigger") stay with `style_text`.
Tools are registered *before* the graphics tools (`graphics.test.ts` pins those last).

## Gates (real numbers)

See CHANGELOG S7.1: unit 177/177 (15 new in `tests/position.test.ts`), verify green, 73 check lines (check 71 renders moved /
rotated / resized / flipped / faded layers; opacity 0 ≡ layer absent; flip on→off byte-identical; a keyframe edit
at the playhead renders like the static position; align + Director → render + export plan), evals 8/8 (g, h),
`next build`, Playwright e2e 45/45 (new `position.spec.ts`: select / drag / one-undo / guides / resize / rotate /
nudge / numeric entry / align / reset / flip / arrange / in-place text edit / Director / multi-select).

## Limitations

- **Export**: preview/draw is the source of truth. ffmpeg export (another lane) does not mirror `flipX/flipY` on
  overlays yet, and base-track footage ignores x/y (existing documented limit). The inspector disables flip for
  video/photo overlays for that reason.
- The **reference point** is a UI aid (not stored in the doc); rotation is always about the visual centre
  (anchor-point animation à la After Effects would need a schema anchor field + exporter support).
- Base (full-frame) footage is selectable but not draggable — use an Overlay or reframe. Callouts/cursors stay in the Demo room.
- Text and overlay resize is uniform (corner handles); a text wrap-width handle is not built.
- Group resize / rotate is not supported (group move + align/distribute are).
- `arrangeClip` lifts overlapping clips into a new "Layer N" track; footage clips on a shared lane can't be split out.
- The inspector sits beside the preview (hidden below `md`); on very short windows the preview gets small.
- Dev environment note: `next dev` needs Node ≥ 22 with a *real* (not symlinked) `node_modules` (Turbopack refuses
  files outside the root); local Playwright can use system Chrome (`channel: "chrome"`) when the bundled browser isn't installed.
