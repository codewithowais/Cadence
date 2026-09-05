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
