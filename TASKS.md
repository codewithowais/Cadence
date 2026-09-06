# Cadence — TASKS

Working method: PLAN → smallest vertical slice → `typecheck` + `verify` (render one frame) → fix → commit → next. Never proceed while red.

## Status legend
✅ done & verified · 🚧 in progress · ⬜ todo · ⛔ blocked on money gate

## Phase 0 — Spike (prove the loop) — ✅ COMPLETE

- ✅ **S0.1 Scaffold + verify gate.** npm workspaces monorepo; `@cadence/core` (engine-agnostic edit-doc schema + render interface); `@cadence/render-node` (headless canvas RenderEngine); `npm run typecheck` + `npm run verify` (renders one real frame, fails loudly). Pinned versions. — *verified: typecheck exit 0, verify renders 1280×720 PNG.*
- ✅ **S0.2 Stub Director + `set_timeline` tool.** `@cadence/director`: `ProjectState`, typed `set_timeline` tool (validates edit-doc via schema before it lands), `StubDirector` with plain-language intent routing. — *verified: Director calls set_timeline, doc renders.*
- ✅ **S0.3 Ingest + transcript (stub).** `@cadence/understanding`: `Transcript` types + `Transcriber` interface + deterministic `StubTranscriber` (offline, free). — *verified: 3-min media → 39 segments.* **Next:** `FasterWhisperTranscriber` drop-in (real local Whisper).
- ✅ **S0.4 "Cut a 60s highlight" end-to-end.** media → transcript → StubDirector → 61s edit-doc (15 cuts, word-accurate source offsets) → rendered full-frame preview. **Phase-0 done gate met.**

## Phase 2 — Color + Audio / creative capabilities

- ✅ **S2.1 Music · b-roll · kinetic titles · punch-in.** Four creative capabilities, each edits-as-code across every surface (EditDoc data → typed Director tool → StubDirector routing → Node canvas renderer → web Stage preview → ffmpeg export plan → verify check that renders a frame).
  - **Background music + ducking** (`add_music`): a `music` audio track referencing an audio `MediaAsset`, ducked (0.28) and re-ducked by `auto_mix`. Silent in the canvas/Stage preview; honored on export via `amix`/`adelay`. Audio upload wired into the web app. *Manifests fully at export only.*
  - **B-roll / PiP overlay** (`add_broll`): scaled (≈0.35), corner-anchored image/video on a top `broll` track for a range. Canvas + Stage render the PiP; export composites with `overlay=…:enable=…` (kept out of the base concat).
  - **Kinetic titles** (`add_kinetic_title`): title slides up + scales in, via pure core helper `textKinetic`. Canvas + Stage honor it; export slides it with a time-dependent `drawtext` x/y expression.
  - **Punch-in emphasis** (`add_emphasis`): scale pulse on a video clip over `[atSec, atSec+dur]`, via pure core helper `emphasisScale`. Canvas + Stage + export (`zoompan` sine pulse) honor it.
  - QuickActions added: Punch-in, B-roll, Kinetic title, Music. — *verified: typecheck + verify **checks 11–14** (each renders a real frame + asserts the export filter) + `apps/web` next build, all green.*

## Phase 1 — Social MVP (see AGENTS.md §11 for done)

- ✅ **S1.1 Next.js editor app.** web + 3 api routes; north-star dark/amber conversation-first UI with rooms rail, live preview (seeks real uploaded footage), cuts timeline, nudge, code drawer, JSON export. — *verified: `next build` clean, UI renders, HTTP pipeline returns valid PNG.*
- ✅ **S1.2 Director edit tools + photo→video + quality.** Tools: create_highlight, filler_cut, reframe (9:16/1:1/4:5/16:9), add_captions, apply_look (warm/cool/vivid/bw/cinematic), auto_mix, make_slideshow, set_quality. Multi-intent chaining for custom scenarios. — *verified: 4 rendered scenarios + chained-tool + 4K asserts.*
- ✅ **S1.3 Features wired into the UI.** Video-or-photos upload, generic live preview (Ken Burns/crossfade/looks/captions), one-tap QuickActions bar. — *verified: next build clean, in-browser layout.*
- ✅ **S1.4 Real media export (ffmpeg).** `@cadence/render-ffmpeg`: PURE `buildExportPlan` (edit-doc → ffmpeg filtergraph: cut+concat, looks, burn-in captions, slideshow xfade/Ken Burns, fades, lanczos upscale + unsharp + denoise) · `detectFfmpeg` · `runExport` (free/local path; faithful `@cadence/enhance` pass when `aiUpscale` on, off by default). Web `/api/upload` + `/api/export` (streams mp4; 501 + install hint when ffmpeg absent); Export button wired with JSON fallback. — *verified: typecheck + verify (checks 7–8, no ffmpeg needed) + next build all green.* **Note: producing an actual .mp4 requires `brew install ffmpeg` (not installed here).**
- ⬜ **S1.5 Real local Whisper** transcriber (drop-in for StubTranscriber).
- ✅ **S1.6 Enterprise bones:** multi-tenant Postgres + dev auth + docker-compose. `@cadence/db` (pg 8.23.0 pinned): migrations (orgs→users→memberships→projects→media→edit_docs + append-only edit_doc_versions; org_id tenant column everywhere, FKs, indexes, timestamps), idempotent `migrate.ts` (`_migrations` table), pooled client, and typed **tenant-scoped, parameterized** repositories (docs validated by `parseEditDoc` before write). `apps/web/src/lib/auth.ts`: `AuthProvider` interface + signed-cookie `DevAuthProvider` (SESSION_SECRET; SSO-swappable). Root `docker-compose.yml` (db + web, commented api/worker) + multi-stage `apps/web/Dockerfile`. `/api/health` → `{ status, db }`. — *verified: typecheck + verify 10/10 (pure DB builder + migration checks) + next build all green. Docker not installed here → not run live.*
- ✅ docker-compose: web · db(Postgres); api + worker as commented split-later placeholders. *(Docker not installed locally yet — free install; run `docker compose up`.)*
- ✅ Multi-tenant data model (orgs → users → projects → media → edit-docs, versioned, row-scoped by org_id).
- ✅ Local dev auth behind an auth interface (`DevAuthProvider`, signed HTTP-only cookie). *(Real SSO left as a documented swap; Auth.js/OIDC not wired.)*
- ⬜ Director tools: filler cut · reframe 9:16 · burn-in captions · one warm look · basic auto-mix.
- ✅ Export renders a real file (ffmpeg; free, needs ffmpeg installed — see S1.4).
- ⬜ Agentic loop hardening (plan→act→verify→correct) + 5 eval prompts.

## Open money gates
- _None yet._ Real Claude Director (Anthropic API, metered) will be raised at S-Director-real. Free stub is the default until then.

## Environment notes
- Node 25.1.0 present (odd/current). **Recommend Node 22 LTS** — vitest 5 flags Node 25 as unsupported.
- Docker: **not installed** (free). Needed for `docker compose up` (Postgres + web) and running migrations live; core dev + verify gate do NOT require it. Live bring-up: `cp .env.example .env` (set SESSION_SECRET) → `docker compose up` → `npm -w @cadence/db run migrate`. Health at `GET /api/health`.
- ffmpeg: **not installed** (free). Needed only for video export, not for the canvas verify/preview path.
