# Motion designer — Graphics, overlays & social elements

Owner: senior motion-graphics designer lane (Cycle I). Branch: `worktree-agent-a020cd1bfacbf3e3c`.

## Audit (base = master @ e036a14)

- `ShapeClip` (rect / ellipse / line / arrow) has fill/stroke/radius + keyframes +
  transition ramps, but **no intro/exit/loop motion** and only four geometries.
- `draw.ts#drawShape` is the single drawing path (Stage `SyntheticLayer`, Skia node
  renderer, export) — no `pxScale`, so shape glows/shadows could not stay proportional.
- `clipAnimatedWindows` treats a shape as static unless it has keyframes/ramps.
- **Export z-order bug:** over footage, `buildExportPlan` overlays ALL text first,
  then ALL shapes — so a shape on a track *below* a text (a CTA pill under its label,
  a lower-third bar under a name) covers the text on export while the preview draws
  it correctly. Anything "shape + text" was impossible to ship at parity.
- No counters (timers / countdowns / count-ups), no social CTAs, no stickers, no
  progress bars, no hand-drawn annotations. Design → "Shapes · Layout" only offers
  four plain shapes.

## What ships (6 features)

| # | Feature | Data (EditDoc) | Director tool |
|---|---|---|---|
| 1 | **Shape motion** — 13 intros (fade, pop, grow, grow-x/y, slide ×4, draw-on, wipe, spin, drop), 10 exits, 9 loops (pulse, bounce, wiggle, float, spin, blink, heartbeat, swing, shimmer) + **12 new vector shapes** (star, heart, burst, triangle, check, play, bell, chevron, scribble, curved arrow, sparkle, speech bubble) | `ShapeClip.anim` (optional, mirrors `TextAnim`), appended `SHAPE_KINDS` | `animate_shape` |
| 2 | **Progress bars** — top line, bottom pill, knob, ring, story segments; fill over the whole video or a range | `ShapeClip.progress` {from,to,startSec,durationSec,easing,direction,style: wipe/draw,repeat,knob} | `add_progress_bar` |
| 3 | **Social CTAs** — Subscribe (+bell), Like, Follow, Link in bio, Swipe up, Comment | shape + text groups (`gfx-{uid}-{preset}-{role}`) with pop + loop + exit | `add_graphic` |
| 4 | **Countdowns & timers** — 3-2-1 Go (per-number pop + sweeping ring), mm:ss timer, count-up ("10,000 followers"), percent + bar | `TextClip.counter` {from,to,format,mode,prefix,suffix,endText,decimals} — resolved per frame by the pure `counterText` | `add_countdown` |
| 5 | **Lower-third pack** — bar slide, underline draw, boxed, split color, gradient pill, accent line | shape + text groups with choreographed delays | `add_lower_third` |
| 6 | **Stickers & annotations** — heart / star / burst badge (“NEW”, “WOW”, “SALE”) / sparkle / check with pop + wiggle/float/heartbeat loops; hand-drawn circle, curved arrow, scribble underline, box outline — all drawn on | shapes (+ label text) with `anim.style: "draw"` | `add_graphic` |

Plus `edit_graphic` (move to a 9-point position, scale, recolor, retime, re-animate,
remove — all layers of a group at once) so every graphic is editable after insert.

## Architecture decisions

- **Pure resolvers** in NEW `packages/core/src/shape-anim.ts`: `shapeAnimState`
  (intro → loop → exit, same easing family as text-anim), `shapeProgressFrac`,
  `counterValue` / `counterText`, `shapeOutline` (polyline geometry for draw-on),
  `graphicShapeWindows`. Deterministic, no globals.
- **Drawing**: `drawShape(ctx, clip, t, opts?)` keeps the exact legacy path when a
  clip has no `anim`/`progress` and is one of the original four kinds (legacy frames
  byte-identical); animated/new shapes go through `drawShapeAnimated` (appended at the
  end of draw.ts). `drawText` gains ONE line: a counter clip draws `counterText`.
- **Export**: `clipAnimatedWindows` marks animated shapes (intro/exit windows,
  whole span for loops/progress) and tick counters (one-frame windows at each tick,
  stills in between — a 60 s timer costs 60 stills, not 1800 frames), so
  `overlaySegmentSpecs` → `renderAnimatedOverlays` sequences them. Media-less docs
  already render every frame through the canvas.
- **Z-order fix** (plan.ts, small): when a doc has BOTH text and shape overlays,
  they are overlaid in track/array order (the preview's order). Text-only and
  shape-only docs keep their exact previous graph.
- **Groups** are plain clips on one "Graphics" track (array order = z-order), ids
  `gfx-{uid}-{preset}-{role}` so the group, its preset, and each layer's role read
  back from the doc with no extra state. Text layers stay editable in the Text room.
- **UI**: NEW `GraphicsGallery.tsx` (Design → "Graphics" category + a section in the
  Text room's Text pane): six tabs, tiles are live canvas previews drawn by the same
  `drawShape`/`drawText` (animate on hover/focus), one click inserts at the playhead,
  then a "Selected graphic" inspector (words, colors, position, size, timing, motion,
  remove) and a shape-motion inspector for ANY selected shape.

## Tests

- `tests/graphics.test.ts` — resolvers (intro/exit/loop, progress, counter formats,
  tick windows), ops (insert/edit/remove groups, ids, legacy docs untouched).
- verify check 67 (graphics) — frames change over the intro, settle, loops move,
  progress fills, counters tick; windows drive export; real encode over footage +
  media-less with decoded-frame parity (and the z-order fix: a label over its pill).
- `apps/web/e2e/graphics.spec.ts` — gallery → insert → preview animates → edit →
  export.

## Status / notes

**Shipped** (branch `worktree-agent-a020cd1bfacbf3e3c`):
- Slice 1 — core motion engine + 34 presets + 6 Director tools + StubDirector routing, tests, verify check 67.
- Slice 2 — Design → Graphics gallery (live hover previews), Selected-graphic inspector (words, amount,
  colors, 9-point position, size, start/duration, in/loop/out), motion panel for any plain shape,
  a Graphics section in the Text room, one named timeline lane per graphic, e2e spec.

**Design decisions that changed during the build**
- Text and icons live INSIDE shapes (`ShapeClip.parts`) instead of separate text clips: a label
  always moves with its pill (pop / bounce / wiggle), and the export's overlay order (all text,
  then all shapes) can never put a pill over its own label. So no plan.ts change was needed.
- Pill / bar widths come from measured per-font glyph averages (`estimateTextWidth`, ±5%) so the
  ops stay pure and identical in the browser, Node, and tests.

**Known limitations / follow-ups**
- Export overlays text clips before shape clips over footage, so a user-built shape on a track
  *below* a separate text clip covers it on export (pre-existing; graphics avoid it via parts).
  Fix belongs in render-ffmpeg/plan.ts (z-ordered interleave).
- Graphic text parts are edited in the Graphics inspector, not the Text room text inspector.
- Group edits rebuild from the preset: per-layer tweaks made elsewhere (e.g. a shape's color in
  Design → Shapes) are reset by the next group edit; motion overrides are preserved.
- No emoji stickers (a color-emoji font is not guaranteed in the Skia export) — vector only.
- No on-canvas drag for graphics yet (the Stage has no move handles); position via the 9-point grid.
