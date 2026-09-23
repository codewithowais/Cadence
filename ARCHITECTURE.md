# Cadence — Architecture

> The shape never changes across phases:
> **understanding → Director → edits-as-code doc → preview (client) / render (splittable).**
> New features are new Director tools operating on the same document.

## The one invariant: edits-as-code

The project/video is a **declarative TypeScript document** (`EditDoc`, defined in
`packages/core/src/schema.ts` with Zod). That document — not any renderer's
internal state — is the single source of truth. It is what the Director emits,
what the DB versions, and what every renderer consumes. Store the recipe, not
opaque state.

## Engine-agnostic render contract

Everything downstream of the document depends only on the `RenderEngine`
interface (`packages/core/src/engine.ts`):

```ts
interface RenderEngine { renderFrame(doc: EditDoc, timeSec: number): Promise<RenderedFrame> }
```

This lets us swap render backends without touching the Director or the document:

| Surface | Backend | Status |
|---|---|---|
| Verify gate + offline dev | **`@cadence/render-node`** — Skia canvas (`@napi-rs/canvas`), pure Node | ✅ built |
| Instant client preview | Omniclip / **WebCodecs** in the browser | planned (Phase 1) |
| Final export / cloud fan-out | ffmpeg worker (MLT/ffmpeg) | planned (Phase 1/3) |

### Ground-truth correction to the brief
The brief specified "Omniclip + omnitool (MIT, WebCodecs)" as the render engine.
Verified against the real packages (Sept 2026):

- `@omnimedia/omniclip@1.1.3` is licensed **ISC** (not MIT) — still permissive and
  commercial-friendly. It is built as an **app** (pixi.js + @ffmpeg/ffmpeg wasm +
  mp4box), **not** a headless library.
- **"omnitool" / Omni Tools does not exist yet** — the Omniclip README lists a
  programmatic "timelines from code" engine as a *future* ("Soon…").

Also, **WebCodecs is a browser API and does not run in Node**. Therefore the
headless verify + server render path *cannot* use Omniclip/WebCodecs today. The
engine-agnostic contract resolves this cleanly:
- **Browser** previews with Omniclip/WebCodecs (real, exists) when we build the app.
- **Node/worker** renders with the canvas engine now, ffmpeg later.
Neither choice leaks into the Director or the edit-doc.

## One drawing module for every synthetic layer (preview == export)

Text, solids/backgrounds, shapes, callouts, cursors, and the VFX finishing pass
are drawn by ONE module — `packages/core/src/draw.ts` — written against a minimal
structural 2D context (`Ctx2D`) that both the DOM `CanvasRenderingContext2D` and
Skia's `SKRSContext2D` satisfy. The frame time is passed explicitly (no globals).

| Surface | How it draws synthetic layers |
|---|---|
| Browser preview (`Stage` → `SyntheticLayer`) | `<canvas>` "under" + "over" the `<video>`/`<img>` layers (split by track z-order), `pxScale` keeps blurs/shadows proportional, web fonts awaited |
| Node renderer (`@cadence/render-node`) | the same functions on a Skia canvas (verify gate, thumbnails, rasterizing for export) |
| ffmpeg export | **media-less docs** (text videos): every frame painted by the node renderer and piped to ffmpeg as raw RGBA (`canvasBase` plan, ~1.5 ms/frame) — only audio is mixed in the graph. **Footage docs**: animated text/shapes become stills over static spans + PNG sequences over animated windows (`overlaySegmentSpecs` / `clipAnimatedWindows`), static text keeps the single-PNG path |

Text animation is resolved by one pure function family (`packages/core/src/text-anim.ts`,
`textUnitState`): 21 intro styles × whole/line/word/letter staggering, exits, and
loops, deterministic (integer-hash pseudo-randomness). Fonts come from one bundled
library (`FONT_LIBRARY`, 24 OFL Google Fonts vendored into `apps/web/public/fonts`
by `scripts/sync-fonts.ts`) loaded by the browser via `@font-face` and registered
with Skia, so the same faces render everywhere. Verify check 66 decodes exported
frames and matches them to the canvas render (mean |ΔRGB| ≈ 1).

**Text videos** (`packages/director/src/textvideo.ts`) are plain EditDoc data:
scene clips carry ids `tv-s{n}-{role}` and `doc.textVideo` stores the recipe
(theme/format/pace), so scenes read back from the clips for restyle, reframe
(re-lay, not stretch), retime, and reorder.

## Scale by construction
- Preview is **client-side and instant**; final render is a **separate, splittable**
  worker job so it can fan out to cloud later without changing the document or tools.
- Services are separable from day one (`web` · `api` · `worker` · `db`) even while
  running in one `docker compose`.

## Packages (current)
- `packages/core` — `EditDoc` schema (source of truth) + `RenderEngine` contract + timeline math.
- `packages/render-node` — headless canvas `RenderEngine`.
- `packages/director` — (next) stub Director emitting valid edit-docs via typed tools.
- `apps/*` — (next) Next.js web+api.

## Verify gate
`scripts/verify.ts`: builds a trivial edit-doc → validates via schema → renders
frame 0 → asserts a real PNG. Paired with `tsc --noEmit`. Anything that changes
the edit engine or composition must keep both green.
