# Changelog

All notable changes, one line per verified slice.

## [Unreleased]

### S0.1 — Scaffold + verify gate
- Init npm-workspaces monorepo (`packages/*`, `apps/*`); pinned toolchain (typescript 5.9.3, zod 4.5.4, @napi-rs/canvas 1.0.8, tsx 4.23.13, @types/node 22.20.1).
- `@cadence/core`: engine-agnostic edit-doc schema (Zod) — the single source of truth — plus the `RenderEngine` interface and timeline math (`activeClipsAt`, `docDurationSec`).
- `@cadence/render-node`: headless canvas `RenderEngine` (Skia via @napi-rs/canvas) — renders a frame from any valid edit-doc with no browser/ffmpeg/Docker.
- Verify gate: `npm run typecheck` (tsc, exit 0) + `npm run verify` (renders one real 1280×720 PNG from a schema-validated doc, asserts PNG magic + size, fails loudly).
- Corrected the brief from ground truth: Omniclip is **ISC** (not MIT) and the headless **"omnitool" engine does not exist yet** — resolved by the engine-agnostic render contract (see ARCHITECTURE.md).

### S0.2–S0.4 — Phase 0 spike complete: the core loop
- `@cadence/understanding`: `Transcript`/`Word`/`Transcriber` types + deterministic offline `StubTranscriber` (drop-in for local Whisper).
- `@cadence/director`: `ProjectState` (working set), typed `set_timeline` tool (schema-validates the doc before it lands), `StubDirector` (plain-language routing), and a real deterministic `buildHighlightDoc` skill (ranks transcript segments, lays word-accurate cuts back-to-back).
- Fixed clip transform semantics: a visual clip's anchor is its **center**; media placeholders are frame-covering. Highlight cuts are centered full-frame.
- Verify gate extended to run the full loop: media → transcript → Director → edit-doc → frame. — *verified: "cut a 60-second highlight" → 61s doc of 15 cuts, renders 1920×1080.*

## Phase 1

### S1.1 — Next.js editor app (conversation-first UI)
- `apps/web`: Next.js 16 (App Router, Turbopack) + React 19 + Tailwind v4, pinned. North-star design system: graded dark palette, amber action / teal selection, Space Grotesk chrome + Fraunces italic for the user's words.
- API services (stateless): `/api/transcribe` (StubTranscriber), `/api/director` (StubDirector + set_timeline), `/api/render` (canvas engine → PNG). Native `@napi-rs/canvas` kept server-only via `serverExternalPackages`.
- Editor UI: rooms rail (Media/Edit/Color/VFX/Audio/Deliver), Director conversation spine with plain-language composer + suggestions, live preview **that seeks the user's actual uploaded footage** (client-side via pure @cadence/core — no ffmpeg), scrubber + playback clock, cuts timeline (click-to-seek), manual **nudge** for the ending, `{}` code escape-hatch drawer, and edit-doc JSON export.
- Converted intra-package imports to extensionless so tsx, tsc, and Next's bundler all resolve the workspace source.
- *verified:* `next build` clean (TS passes); UI renders at desktop; HTTP pipeline transcribe→director→render returns a valid PNG.

### S1.2 — Edit tools, photo→video, and quality
- Schema: color grade (looks), crossfade transitions, Ken Burns motion for stills, caption pill background, and output `quality` settings — all edits-as-data. Shared `grade.ts` helpers (cssFilter/transitionOpacity/imageMotion) so browser CSS, server canvas, and export compute looks identically.
- Renderer: applies looks (ctx.filter + warmth overlay), crossfade opacity ramps, and Ken Burns scale/pan.
- New Director tools: `create_highlight`, `filler_cut`, `reframe` (9:16/1:1/4:5/16:9), `add_captions` (transcript synced through cuts), `apply_look` (warm/cool/vivid/bw/cinematic), `auto_mix`, `make_slideshow` (photos→video), `set_quality` (standard/high/ultra + AI-upscale flag, gated).
- StubDirector now detects multiple intents and chains tools in order (builders→transforms), enabling custom scenarios: "cut a 40s highlight, make it vertical with captions and a cinematic look."
- Captions size to the frame (fit in portrait).
- *verified:* typecheck green; verify gate renders 4 scenarios (highlight, filler, vertical+captions+cinematic, slideshow) + asserts chained tool calls and 4K quality.

### Money gate note
- ⛔ **AI super-resolution (Real-ESRGAN local model or a paid upscaling API)** is the first likely gate. The free path — higher-res export + sharpen/denoise via the (coming) ffmpeg worker — is wired now via `set_quality`; `aiUpscale` is a flag that stays off until approved.

### S1.3 — Features wired into the UI
- Upload accepts **video or a group of photos** (multiple); dropping photos auto-builds a slideshow.
- Preview Stage rewritten to render active clips generically — video, layered photos (real `<img>` with Ken Burns + crossfade), and captions — applying looks live via CSS `filter` (same math as the server).
- **One-tap QuickActions** bar (context-aware for video vs photos): Highlight, Remove filler, 9:16, Captions, Cinematic, Auto-mix, Make 4K / Slideshow, Warm look.
- Editor manages multiple media + a URL map; nudge, export, code drawer intact.
- *verified:* `next build` clean; empty state + layout confirmed in-browser.

### S1.4 — Titles, fades, backgrounds, more looks
- Schema: `solid` clip kind (color fill → backgrounds, letterbox, fades) + `transitionOutSec` on visual clips; `transitionOpacity` now ramps in and out.
- New tools: `add_title` (title card / lower-third with fade), `add_fades` (fade from/to black). More looks: vintage, noir, vibrant.
- StubDirector routes titles (extracts quoted text), fades, and the new looks; all chainable.
- QuickActions: added Fade in/out (+ Vintage for photos).
- *verified:* verify gate check 5 renders a chained highlight+title+vintage+fades frame; `next build` clean.
