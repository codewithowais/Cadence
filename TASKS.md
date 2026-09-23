# Cadence — TASKS

Working method: PLAN → smallest vertical slice → `typecheck` + `verify` (render one frame) → fix → commit → next. Never proceed while red.

## Status legend
✅ done & verified · 🚧 in progress · ⬜ todo · ⛔ blocked on money gate

## QA / end-to-end testing

- ✅ **QA1 Playwright E2E (real app + real media).** `apps/web/e2e/` + `@playwright/test`; `npm run test:e2e` (root or `@cadence/web`), `npm run test:e2e:install` for CI's Chromium. Generates a real `.webm` (canvas → `captureStream` → `MediaRecorder`) + 4 `.png` photos in-browser, uploads via `setInputFiles`, drives the video flow (highlight · vertical+captions · cinematic · fade · punch-in · 4K), rooms rail, Audio mute→`<video>.muted`, export-graceful (ffmpeg absent → message + JSON fallback), and the photo→slideshow flow. Screenshots → `test-artifacts/` (gitignored). — *verified: `npm run test:e2e` 2/2 headless Chromium; typecheck + verify 18/18 + next build all green.*
  - ✅ **Bug (MEDIUM) FIXED:** `setQuality` overshot on vertical "make it 4K" (anchored to width → ~3844×6836). Now anchors the LONG edge (`Math.max(baseW,baseH)`) so landscape→3840×2160 and vertical→2160×3840. Asserted in verify + e2e.

## Cycle I — specialist agent waves — ✅ COMPLETE

Five role agents (Senior Video Editor, Motion Designer, Audio Engineer, Product Manager, CTO) each built a feature group in an isolated worktree on a disjoint lane, gated green, then were merged into master and re-gated together (see CHANGELOG S6.1 and `docs/agents/*.md`). *verified: unit 162/162 · verify 70/70 · evals 6/6 · next build · e2e 41/41.*

- ⬜ **Known limitations carried forward:** shuttle ≠1× is silent; group drag with the mouse; graphics words edited in the Graphics panel (not the Text room); no color-emoji stickers in export; stereo pan not heard in preview; exporting before generated music finishes composing; autosave is scratch-editor only; progress stream untested behind Render's proxy; export z-order draws all text before shapes over footage (general fix belongs in render-ffmpeg/plan.ts).

## Cycle H — Text video (Canva parity) + mature text — ✅ COMPLETE

Goal: make a video from text alone (no upload), Canva-style, with preview == export for every animation. Root gaps found: (1) the editor gates prompt/play/export on uploaded media; (2) the Stage draws text as a plain DOM span (ignores font/outline/shadow/box/wrap/typewriter/keyframes) and never draws solid clips; (3) export renders animated text FROZEN at rest and ignores solid backgrounds; (4) no script→scenes tool; (5) no way to edit an existing text clip.

- ✅ **H1 Shared draw module** — move canvas drawing (text/solid/shape/callout/cursor/vfx) into `@cadence/core/draw` typed against a structural 2D context, so the browser Stage, node canvas, and export all run the SAME code. No behavior change (verify frames identical).
- ✅ **H2 Text animation engine** — ~15 new intro styles (fade/rise/drop/slide/zoom/stomp/blur/wipe/baseline/tumble/neon/glitch/scramble…) with per-line/word/letter staggering, delay, exit animations, and loop emphasis (breathe/float/wiggle/flicker/pulse). One pure resolver.
- ✅ **H3 Text effects** — Canva-style effects (lift, hollow, splice, echo, glitch, neon, highlight) + gradient text fill.
- ✅ **H4 Backgrounds** — gradient (linear/radial), animated (drift/pulse/aurora), pattern overlays (dots/grid/lines) on `SolidClip`.
- ✅ **H5 Font library** — ~24 bundled OFL Google fonts (preview + export identical), registered in Skia and loaded in the browser.
- ✅ **H6 Export parity** — media-less docs render every frame through the shared canvas (raw RGBA → ffmpeg); media docs overlay animated text/shapes as PNG sequences for their animated windows; background solids + gradients export in text-only docs.
- ✅ **H7 Stage parity** — the preview draws synthetic layers on a `<canvas>` via the shared module (z-order aware); play/scrub/export work with no media.
- ✅ **H8 Director** — `make_text_video` (script → timed scenes, themes, formats: story/quote/list/announcement), `restyle_text_video`, `animate_text`, `style_text`, `set_background`; StubDirector routing + evals.
- ✅ **H9 Editor unlock + Text room** — "Start with text" empty state, a Text room (script composer, scene list: edit/reorder/duration/add/delete, theme switcher).
- ✅ **H10 Text inspector** — edit any selected text clip: content, font, size/weight/italic/color/align/spacing, box/outline/shadow/effect/gradient, animation in/loop/out, 9-point position, apply-to-all.
- ✅ **H11 Templates + presets** — text-video templates in New project; ~30 text presets; gradient/animated background gallery.
- ✅ **H12 QA** — unit + verify + real encode + Playwright e2e for the text-video flow; CHANGELOG/FEATURES/ARCHITECTURE. *verified: unit 78/78 · verify 66/66 · evals 6/6 · next build · e2e 25/25.*
- ⬜ **Follow-ups (optional):** per-scene theme overrides; beat-synced scene cuts from music; Urdu/Arabic font pack (Noto) for non-Latin scripts; stroke-reveal ("handwriting") animation; verify blur-in/blur-out on Safari (canvas `filter` support varies by browser version; blur styles would render sharp where it's missing); export background solids placed BEFORE/BETWEEN footage clips (text-only docs export them; footage docs still export only fade solids).

## Cycle E — craft depth (waves 2–5) + go-live — ✅ COMPLETE

Run as expert-agent waves on disjoint files (packages/** vs apps/web/**), each integrated → gated (`typecheck` root+web · `test:unit` · `verify` · `next build` · `test:e2e`) → committed. Full history in `CHANGELOG.md` (S3.7–S3.12), advisory docs in `docs/`, agent runs in `AGENTS-LOG.md`.

- ✅ **Wave 1 — interaction demos + timeline editing.** `build_demo` (cursor/typewriter/callout — ERP-style walkthroughs from screenshots); direct trim/split/reorder/ripple/markers/zoom.
- ✅ **Wave 2 — P0 fixes + audible audio.** Export transitions on cuts; music auto-attaches on upload and is **audible in preview**; overlays ripple in sync; UX quick wins (determinate progress, undo toast, describe-first).
- ✅ **Wave 3 — craft foundations.** Keyframe engine (`valueAt`), multi-track compositing, reverse/freeze, markers; delivery presets (YouTube/TikTok/Reels/Shorts) + SRT/VTT + thumbnail.
- ✅ **Wave 4 — VFX + color + audio depth.** Chroma-key, masks, blur/pixelate, blend modes; curves/HSL/scopes; audio mixer (fades/pan/LUFS).
- ✅ **Wave 5 — AI-native edge.** Edit-by-transcript (click words to cut), silence removal, auto-reframe (subject-tracking money-gated), TTS voice-over seam (money-gated, graceful). New "Words" room. Fixed a client/server boundary leak that broke `/editor` (whisper transcriber made browser-import-safe).
- ✅ **QA — full tester pass.** Playwright **8/8** green incl. a Wave-5 spec; refreshed artifacts (screenshots + `.webm`) in `test-artifacts/`.
- ✅ **DB live (Neon Postgres).** Migrations applied to the user's Neon instance; `/api/health` → `{ status:"ok", db:true }`. Local `.env` (gitignored) feeds both tooling and the app (symlinked into `apps/web/.env`).
- ✅ **Vercel deploy readiness.** `apps/web/vercel.json` (framework pin) + `DEPLOY.md` (Root Directory `apps/web`, env-var table, Neon + limitations). ffmpeg export documented as Docker-only (absent on serverless; degrades gracefully).

## Cycle F — CapCut parity: manual + AI editor (waves A–E) — ✅ COMPLETE

Driven by two expert advisory docs — `docs/CAPCUT-PARITY.md` (senior editor) + `docs/MANUAL-EDITING-PLAN.md` (head of editing/UX). Every capability is AI **and** manual. Waves ran engine (`packages/**`) then UI (`apps/web/**`), each gated + committed. Full history in `CHANGELOG.md` (S4.1–S4.8).

- ✅ **Zoom fix:** timeline zoom anchors on the playhead + follows during playback (was left-anchored → content slid away — the reported bug).
- ✅ **Wave A — true multi-track:** `Track` metadata (name/hidden/locked/muted/solo); track-header gutter (rename/hide/lock/mute/solo/reorder/remove + Video/+Audio); drag clips between tracks; **ffmpeg export reworked to composite by z-order** so layers no longer flatten. Closes the multi-track + hide/show gap.
- ✅ **Wave B — Walkthrough/Demo room:** exposes the built-but-hidden interaction-demo engine; visual on-preview placement (click/drag → composition fractions) for typed fields, cursor+click, callouts; Build walkthrough from screenshots. + zoom Fit / zoom-to-selection.
- ✅ **Wave C — manual craft:** on-timeline keyframe editor (draggable diamonds), per-cut transition chips (7-type gallery), audio fade drag-handles; engine per-cut `setTransition`/`clearTransition` + `setKeyframe`/`moveKeyframe`/`removeKeyframe`.
- ✅ **Wave D — beat-sync + stickers:** "Detect beats" (Web-Audio energy/onset) → beat markers + "Split at beats"; stickers/emoji + text-preset picker; **markers now persist** in `doc.markers` (was local-state only — correctness fix).
- ✅ **Wave E — trims:** `rollEdit`/`slipEdit`/`slideEdit` ops + tools; timeline Normal·Roll·Slip·Slide mode selector + inspector nudges.
- ✅ **Tester:** Playwright **11/11** green (added wave-a/wave-b/wave-c artifact specs). verify **57** · unit 44 · evals 5.
- ⬜ **Deferred (P1/P2, optional):** LUT import, adjustment layers, keyframe export fidelity (x/y/rot/opacity are preview-only on export), speed-ramp UI (engine done), karaoke captions, multiple **sequences** (P2), motion-tracking auto-reframe (money-gated).

## Cycle G — transitions fix + 55 library + full UX overhaul — ✅ COMPLETE

Driven by the transition bug report + `docs/UX-OVERHAUL.md` (senior UX/UI) and `docs/CAPCUT-STATUS.md` (parity re-audit). History in `CHANGELOG.md` (S4.9–S4.15). Every AI capability still has a manual control.

- ✅ **Transitions fixed** (S4.10): the preview ignored `transitionType` — now renders each type; single/first/last clips get fade-in/out chips. Deep e2e (`transitions.spec.ts`).
- ✅ **55 transitions** (S4.12/S4.15): full ffmpeg `xfade` set across schema/export/preview + a grouped, searchable timeline gallery.
- ✅ **Speed ramps** engine (S4.9, CapCut "Curve") — UI pending.
- ✅ **UX overhaul** (S4.11/S4.13/S4.14): collapsible rails · media thumbnail grid · drag-drop to timeline · dedupe brand mark · unified **Design** room (thumbnail preview gallery, 24 looks/palettes/text presets, instant-apply) · **new coral-on-charcoal theme** (no yellow) · **preview-visibility fix** (room-panel scroll + adjustable preview) · prominence polish.
- ✅ **Tester:** Playwright **17/17**; verify **60**; unit **49**; evals 5. Neon DB live; Vercel-ready.

## Phase 0 — Spike (prove the loop) — ✅ COMPLETE

- ✅ **S0.1 Scaffold + verify gate.** npm workspaces monorepo; `@cadence/core` (engine-agnostic edit-doc schema + render interface); `@cadence/render-node` (headless canvas RenderEngine); `npm run typecheck` + `npm run verify` (renders one real frame, fails loudly). Pinned versions. — *verified: typecheck exit 0, verify renders 1280×720 PNG.*
- ✅ **S0.2 Stub Director + `set_timeline` tool.** `@cadence/director`: `ProjectState`, typed `set_timeline` tool (validates edit-doc via schema before it lands), `StubDirector` with plain-language intent routing. — *verified: Director calls set_timeline, doc renders.*
- ✅ **S0.3 Ingest + transcript (stub).** `@cadence/understanding`: `Transcript` types + `Transcriber` interface + deterministic `StubTranscriber` (offline, free). — *verified: 3-min media → 39 segments.* **Done in S1.5:** `WhisperTranscriber` drop-in (real local Whisper).
- ✅ **S0.4 "Cut a 60s highlight" end-to-end.** media → transcript → StubDirector → 61s edit-doc (15 cuts, word-accurate source offsets) → rendered full-frame preview. **Phase-0 done gate met.**

## Phase 2 — Color + Audio / creative capabilities

- ✅ **S2.1 Music · b-roll · kinetic titles · punch-in.** Four creative capabilities, each edits-as-code across every surface (EditDoc data → typed Director tool → StubDirector routing → Node canvas renderer → web Stage preview → ffmpeg export plan → verify check that renders a frame).
  - **Background music + ducking** (`add_music`): a `music` audio track referencing an audio `MediaAsset`, ducked (0.28) and re-ducked by `auto_mix`. Silent in the canvas/Stage preview; honored on export via `amix`/`adelay`. Audio upload wired into the web app. *Manifests fully at export only.*
  - **B-roll / PiP overlay** (`add_broll`): scaled (≈0.35), corner-anchored image/video on a top `broll` track for a range. Canvas + Stage render the PiP; export composites with `overlay=…:enable=…` (kept out of the base concat).
  - **Kinetic titles** (`add_kinetic_title`): title slides up + scales in, via pure core helper `textKinetic`. Canvas + Stage honor it; export slides it with a time-dependent `drawtext` x/y expression.
  - **Punch-in emphasis** (`add_emphasis`): scale pulse on a video clip over `[atSec, atSec+dur]`, via pure core helper `emphasisScale`. Canvas + Stage + export (`zoompan` sine pulse) honor it.
  - QuickActions added: Punch-in, B-roll, Kinetic title, Music. — *verified: typecheck + verify **checks 11–14** (each renders a real frame + asserts the export filter) + `apps/web` next build, all green.*

## Phase 1 — Social MVP (see AGENTS.md §11 for done)

- ✅ **S1.8 Agentic loop hardening (Ask 4) — plan→act→verify→correct + evals.** `@cadence/director/agentic.ts`: `runDirectorLoop(request, project, { engine, probeTimes?, maxAttempts?, director? })` — calls the Director's `interpret` (PLAN/ACT), `parseEditDoc`s + renders probe frames through an injected `RenderEngine` (VERIFY), and on any schema/render throw captures the error, feeds it forward (`DirectorFeedback`), and falls back to the last-good / a minimal valid doc (CORRECT). Returns `{ result, verified, attempts, corrections }`. **Engine-agnostic** (imports only the `@cadence/core` interface — never `@cadence/render-node`; caller injects `CanvasRenderEngine`). `scripts/evals.ts` (`npm run evals`): 5 capability prompts (highlight · vertical+captions+cinematic · kinetic title+punch-in+fades · slideshow · filler+4K), each asserts `verified===true` + expected tools + a rendered proof frame in `.cadence/`. Verify gate **check 17** covers the loop (clean run + broken-Director recovery). Also fixed two StubDirector parse gaps the evals exposed (hyphenated "45-second"; "make it 4K" no longer means highlight). — *verified: typecheck + verify 17/17 + evals 5/5 + `apps/web` next build all green.*

- ✅ **S1.1 Next.js editor app.** web + 3 api routes; north-star dark/amber conversation-first UI with rooms rail, live preview (seeks real uploaded footage), cuts timeline, nudge, code drawer, JSON export. — *verified: `next build` clean, UI renders, HTTP pipeline returns valid PNG.*
- ✅ **S1.2 Director edit tools + photo→video + quality.** Tools: create_highlight, filler_cut, reframe (9:16/1:1/4:5/16:9), add_captions, apply_look (warm/cool/vivid/bw/cinematic), auto_mix, make_slideshow, set_quality. Multi-intent chaining for custom scenarios. — *verified: 4 rendered scenarios + chained-tool + 4K asserts.*
- ✅ **S1.3 Features wired into the UI.** Video-or-photos upload, generic live preview (Ken Burns/crossfade/looks/captions), one-tap QuickActions bar. — *verified: next build clean, in-browser layout.*
- ✅ **S1.4 Real media export (ffmpeg).** `@cadence/render-ffmpeg`: PURE `buildExportPlan` (edit-doc → ffmpeg filtergraph: cut+concat, looks, burn-in captions, slideshow xfade/Ken Burns, fades, lanczos upscale + unsharp + denoise) · `detectFfmpeg` · `runExport` (free/local path; faithful `@cadence/enhance` pass when `aiUpscale` on, off by default). Web `/api/upload` + `/api/export` (streams mp4; 501 + install hint when ffmpeg absent); Export button wired with JSON fallback. — *verified: typecheck + verify (checks 7–8, no ffmpeg needed) + next build all green.* **Note: producing an actual .mp4 requires `brew install ffmpeg` (not installed here).**
- ✅ **S1.5 Real local Whisper** transcriber (drop-in for StubTranscriber). `@cadence/understanding`: `WhisperTranscriber` (shells out to a local `whisper` / `whisper-cpp` / `faster-whisper` CLI, or a `WHISPER_CMD` template; `WHISPER_MODEL` default `base`; **no heavy npm dep** — `node:child_process`), extracting audio to a temp wav via ffmpeg (`FFMPEG_PATH` convention). PURE `parseWhisperJson(json, mediaId)` maps both the OpenAI/faster-whisper shape (seconds + word probs) and the whisper.cpp shape (ms offsets, special-token filtered) into `Transcript`. `detectWhisper()` (never throws) + `isAvailable()` (Whisper **and** ffmpeg). `createTranscriber()`/`pickTranscriber()` factory returns Whisper when available, else the Stub. `/api/transcribe` uses the factory (same response shape). — *verified: typecheck + verify **checks 15–16** (pure parse of a realistic sample + factory-fallback) + `apps/web` next build, all green.* **Whisper not installed here → live transcription not exercised; graceful fallback to Stub confirmed. Enable: install whisper.cpp/faster-whisper (or OpenAI whisper) + ffmpeg, or set `WHISPER_CMD`. ffmpeg is baked into the Docker image.**
- ✅ **S1.6 Enterprise bones:** multi-tenant Postgres + dev auth + docker-compose. `@cadence/db` (pg 8.23.0 pinned): migrations (orgs→users→memberships→projects→media→edit_docs + append-only edit_doc_versions; org_id tenant column everywhere, FKs, indexes, timestamps), idempotent `migrate.ts` (`_migrations` table), pooled client, and typed **tenant-scoped, parameterized** repositories (docs validated by `parseEditDoc` before write). `apps/web/src/lib/auth.ts`: `AuthProvider` interface + signed-cookie `DevAuthProvider` (SESSION_SECRET; SSO-swappable). Root `docker-compose.yml` (db + web, commented api/worker) + multi-stage `apps/web/Dockerfile`. `/api/health` → `{ status, db }`. — *verified: typecheck + verify 10/10 (pure DB builder + migration checks) + next build all green. Docker not installed here → not run live.*
- ✅ **S1.7 Multi-page app (App Router).** Landing `/` · dev sign-in `/login` · auth-gated `/dashboard` (projects list, New project) · scratch `/editor` · project-bound `/project/[id]` (loads latest edit-doc, Save appends a new version) · `/settings` (account/org, sign out). Shared `TopNav`. New API routes (nodejs, session-scoped, DB-graceful): `/api/auth/login`, `/api/auth/logout`, `/api/projects`, `/api/projects/[id]/doc`. `<Editor/>` made reusable via optional props (`initialDoc`/`projectName`/`onSave`/`backHref`/`notice`) — `/editor` unchanged. `@cadence/db`: `provisionAccount` + `upsertUser`/`firstOrgForUser` builders. Every DB page degrades gracefully when Postgres is down. — *verified: typecheck (root + web) + verify 14/14 + next build clean (17 routes).* **Postgres not running here → persistence paths exercise graceful fallbacks; full save/load needs `docker compose up db` + migrate.**
- ✅ docker-compose: web · db(Postgres); api + worker as commented split-later placeholders. *(Docker not installed locally yet — free install; run `docker compose up`.)*
- ✅ Multi-tenant data model (orgs → users → projects → media → edit-docs, versioned, row-scoped by org_id).
- ✅ Local dev auth behind an auth interface (`DevAuthProvider`, signed HTTP-only cookie). *(Real SSO left as a documented swap; Auth.js/OIDC not wired.)*
- ⬜ Director tools: filler cut · reframe 9:16 · burn-in captions · one warm look · basic auto-mix.
- ✅ Export renders a real file (ffmpeg; free, needs ffmpeg installed — see S1.4).
- ✅ Agentic loop hardening (plan→act→verify→correct) + 5 eval prompts. **See S1.8.**

## Open money gates (all OFF by default; never auto-enabled)
- ⛔ Real Claude Director (`DIRECTOR_MODE=claude` + `ANTHROPIC_API_KEY`) — metered. Free stub is the default.
- ⛔ AI faithful upscale (`ENHANCE_PROVIDER=local|api|cli`) — free no-AI upscale is the default.
- ⛔ TTS voice-over (`TTS_PROVIDER=cli|api`) — free mic recorder is the default; gated tool fails gracefully.
- ⛔ Auto-reframe subject tracking (needs a vision provider) — free centered reframe ships now.

## Environment notes
- Node 25.1.0 present (odd/current). **Recommend Node 22 LTS.** Vercel uses a supported LTS automatically (engines `>=20`).
- **DB: LIVE on Neon Postgres.** `DATABASE_URL` set in local `.env`; migrations applied; `/api/health` → `db:true`. For Vercel, set `DATABASE_URL` + `SESSION_SECRET` in the dashboard — see `DEPLOY.md`.
- Docker: optional (free). Needed only for real `.mp4` export (ffmpeg baked into the image) and as an alt to Neon. `docker compose up` + `npm -w @cadence/db run migrate`.
- ffmpeg: **not installed** (free). Needed for video export and for real Whisper transcription (audio extraction), not for the canvas verify/preview path.
- Whisper: **not installed** (free). Real transcription uses a local `whisper` / `whisper-cpp` / `faster-whisper` CLI (or `WHISPER_CMD`) + ffmpeg; absent here, so `/api/transcribe` uses the offline `StubTranscriber`. Enable by installing one of those CLIs (e.g. `pip install faster-whisper` / build whisper.cpp) + ffmpeg; both are available in the Docker image.
