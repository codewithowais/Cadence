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

### S1.6 — Real .mp4 export via ffmpeg (free/local path)
- `@cadence/render-ffmpeg`: new package (type module; deps `@cadence/core` + `@cadence/enhance`; **no npm ffmpeg deps** — shells out to system ffmpeg via `node:child_process`).
  - `plan.ts` — PURE `buildExportPlan(doc, resolveMediaPath, outFile)` turns an EditDoc into an ffmpeg argv + filtergraph: video cut+concat (per-clip `-ss/-t` source trim → `setpts` → `scale`/`crop` to meta W×H), looks via `eq` (brightness/contrast/saturation) + warm `colorbalance`, burn-in captions/titles via `drawtext` (special-char escaping + `enable='between(t,start,end)'` + `box=1` pill), slideshow (images `-loop`ed, Ken Burns `zoompan`, `xfade` crossfades), fade in/out via the `fade` filter, solid/text-only docs via a `lavfi` color base, audio concat + music `amix`, and quality (`scale=…:flags=lanczos` + `unsharp` + `hqdn3d`). All filters identity-preserving.
  - `detect.ts` — async `detectFfmpeg()` (`ffmpeg -version`), never throws; `FFMPEG_MISSING_MESSAGE`.
  - `export.ts` — `runExport(doc, {resolveMediaPath, outFile})`: builds the plan, spawns ffmpeg, resolves to the file; throws `FfmpegNotFoundError` (“ffmpeg not found — run: brew install ffmpeg”) when absent. When `quality.aiUpscale` is on it selects a faithful provider via `@cadence/enhance` (`configFromEnv`/`selectProvider`); otherwise the free Lanczos+unsharp path. **Money gate honored** — no paid service enabled; AI off by default.
- Web API (runtime nodejs): `/api/upload` (multipart → saves to `<os.tmpdir()>/cadence-uploads/<uuid><ext>`, returns `{ id, path }`) and `/api/export` (`{ doc }` with server-path media → renders → streams the mp4 with `content-disposition`; **HTTP 501 + install-hint JSON** when ffmpeg is missing). `@cadence/render-ffmpeg` added to `transpilePackages` (it ships TS source + only spawns system ffmpeg, so it is NOT a serverExternalPackage — Turbopack forbids a package in both lists).
- Web UI: the Export button now uploads each media File, rewrites `media.src` to the returned server paths, POSTs to `/api/export`, and downloads the `.mp4`. On 501 it shows the install hint in the Director chat and falls back to the JSON edit-doc export. Editor keeps raw `File` objects by media id (`files` state + `filesRef`); `uploadMedia`/`exportVideo` helpers in `lib/api.ts`, `downloadBlob` in `lib/format.ts`.
- Verify gate: check 7 asserts `buildExportPlan` yields sane args for a 2-cut highlight (trim+concat), captions (drawtext + escaping), quality ultra (lanczos scale + unsharp + hqdn3d), and a slideshow (xfade + zoompan) — all WITHOUT ffmpeg; check 8 asserts the missing-binary path throws the clear install error.
- *verified:* root `typecheck` green; `npm run verify` 8/8 (real .mp4 needs `brew install ffmpeg` to produce output — absent here, handled gracefully); `apps/web` `next build` clean.

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

### S1.6 — Enterprise bones: multi-tenant data + auth + compose
- `@cadence/db`: new package (type module; deps `@cadence/core` + `pg` **8.23.0** pinned; devDep `@types/pg` **8.23.1**; lockfile committed). Verified `pg`'s real API against `node_modules/@types/pg/index.d.ts` before use — nothing coded from memory.
  - Migrations `packages/db/migrations/00N_*.sql` (orgs, users, memberships → projects, media → edit_docs + append-only edit_doc_versions): FKs with `ON DELETE` rules, indexes, `timestamptz` timestamps, `gen_random_uuid()` PKs, CHECK constraints. **Tenant column (`org_id`) on every tenant-data table**; `users` are global identities that reach a tenant only via `memberships` (documented in 001).
  - `migrate.ts`: applies migrations in numeric order, tracked in a `_migrations` table, idempotent (skips applied), each file in its own transaction. PURE `orderMigrations()`/`listMigrations()` for testing. CLI: `npm -w @cadence/db run migrate`.
  - `queries.ts`: PURE parameterized builders returning `{ text, values }` — user/tenant data is ALWAYS a `$N` bind, never string-interpolated. Every tenant builder pins `org_id` (+ `project_id`).
  - `repositories.ts`: typed, tenant-scoped functions (`createOrg`, `createUser`, `addMembership`, `createProject`, `listProjects(orgId)`, `addMedia`, `saveEditDocVersion(scope, doc, userId)` — validates via `@cadence/core` `parseEditDoc` before write, then bumps the version pointer + appends the immutable version row in one transaction — `getLatestEditDoc`, `getEditDocVersion`). Pooled client from `DATABASE_URL` (`client.ts`) + `pingDb()` (never throws).
- Auth behind an interface: `apps/web/src/lib/auth.ts` — `AuthProvider` (`getSession`/`getUser`/`signIn`/`signOut`) + `DevAuthProvider` (HMAC-SHA256-signed, HttpOnly, SameSite=Lax cookie over `SESSION_SECRET`; constant-time verify; Secure in prod). Documented how to swap in enterprise SSO (Okta/Auth0/Entra/Auth.js) without touching call sites. No real SSO implemented (free local default).
- Compose + Docker: root `docker-compose.yml` (`db` postgres:16-alpine with named volume + healthcheck, `web` built from the new multi-stage `apps/web/Dockerfile` on node:22-alpine, `DATABASE_URL` pointed at the `db` service; commented `api` + `worker` placeholders to split later). `.dockerignore` added.
- Health: `apps/web/src/app/api/health/route.ts` (runtime nodejs, force-dynamic) returns `{ status, db }` from a real `SELECT 1`; degrades gracefully (`db:false`) when the DB is down.
- Config: `.env.example` gains `POSTGRES_PORT` + `SESSION_SECRET` (with a generate hint); real `.env` stays gitignored. `@cadence/db` added to both tsconfig paths, `apps/web` deps (+`pg`), and `next.config.ts` `transpilePackages`; **`pg` added to `serverExternalPackages`** (verified: it does conditional requires of optional `pg-native`/`pg-cloudflare`, so it must not be bundled — `@cadence/db` ships TS source so it stays transpiled; different packages, no Turbopack both-lists conflict).
- Verify gate: check 9 asserts builders are tenant-scoped + fully parameterized (placeholder/value parity + a `DROP TABLE` injection guard that stays in `values`); check 10 asserts migrations parse, are contiguously ordered, and that duplicate indices are rejected. All pure — no live DB.
- *verified:* root `typecheck` green; `npm run verify` 10/10; `apps/web` `next build` clean. **Docker not installed here** (free) — Postgres/migrations not run live; run `docker compose up` + `npm -w @cadence/db run migrate` once installed.

### S1.5 — Pluggable, faithful enhance/upscale system
- `@cadence/enhance`: `EnhanceProvider` contract with a hard **faithfulness** rule (detail-preserving only — never alters faces/identity/content). Providers: **free** (Lanczos+unsharp+denoise, no AI, default), **local** (Real-ESRGAN), **api** (hosted, metered), **cli** (bring-any-CLI). Selected by `ENHANCE_PROVIDER` env; `buildCliArgs` templating for custom tools.
- Schema `quality`: added `faithful` (always true) + `enhanceProvider`.
- **Honesty fix:** `set_quality` no longer implies the preview changed — it says the upscale renders on **export** (preview stays at source res), and that enhancement is faithful (no face/content changes). Addresses "it says 4K but doesn't look 4K."
- *verified:* verify gate check 6 asserts CLI templating, provider selection, and that all providers are identity-preserving with both AI and non-AI options.
