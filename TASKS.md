# Cadence — TASKS

Working method: PLAN → smallest vertical slice → `typecheck` + `verify` (render one frame) → fix → commit → next. Never proceed while red.

## Status legend
✅ done & verified · 🚧 in progress · ⬜ todo · ⛔ blocked on money gate

## Phase 0 — Spike (prove the loop) — ✅ COMPLETE

- ✅ **S0.1 Scaffold + verify gate.** npm workspaces monorepo; `@cadence/core` (engine-agnostic edit-doc schema + render interface); `@cadence/render-node` (headless canvas RenderEngine); `npm run typecheck` + `npm run verify` (renders one real frame, fails loudly). Pinned versions. — *verified: typecheck exit 0, verify renders 1280×720 PNG.*
- ✅ **S0.2 Stub Director + `set_timeline` tool.** `@cadence/director`: `ProjectState`, typed `set_timeline` tool (validates edit-doc via schema before it lands), `StubDirector` with plain-language intent routing. — *verified: Director calls set_timeline, doc renders.*
- ✅ **S0.3 Ingest + transcript (stub).** `@cadence/understanding`: `Transcript` types + `Transcriber` interface + deterministic `StubTranscriber` (offline, free). — *verified: 3-min media → 39 segments.* **Next:** `FasterWhisperTranscriber` drop-in (real local Whisper).
- ✅ **S0.4 "Cut a 60s highlight" end-to-end.** media → transcript → StubDirector → 61s edit-doc (15 cuts, word-accurate source offsets) → rendered full-frame preview. **Phase-0 done gate met.**

## Phase 1 — Social MVP (see AGENTS.md §11 for done)

- ✅ **S1.1 Next.js editor app.** web + 3 api routes; north-star dark/amber conversation-first UI with rooms rail, live preview (seeks real uploaded footage), cuts timeline, nudge, code drawer, JSON export. — *verified: `next build` clean, UI renders, HTTP pipeline returns valid PNG.*
- ✅ **S1.2 Director edit tools + photo→video + quality.** Tools: create_highlight, filler_cut, reframe (9:16/1:1/4:5/16:9), add_captions, apply_look (warm/cool/vivid/bw/cinematic), auto_mix, make_slideshow, set_quality. Multi-intent chaining for custom scenarios. — *verified: 4 rendered scenarios + chained-tool + 4K asserts.*
- ✅ **S1.3 Features wired into the UI.** Video-or-photos upload, generic live preview (Ken Burns/crossfade/looks/captions), one-tap QuickActions bar. — *verified: next build clean, in-browser layout.*
- ⬜ **S1.4 Real media export.** ffmpeg worker: edit-doc → real .mp4 (cuts, looks, captions, reframe, quality/sharpen/denoise). Free; needs ffmpeg installed.
- ⬜ **S1.5 Real local Whisper** transcriber (drop-in for StubTranscriber).
- ⬜ **S1.6 Enterprise bones:** multi-tenant Postgres (orgs→users→projects→media→edit-docs, versioned) + dev auth + docker-compose.
- ⬜ docker-compose: web · api · worker · db(Postgres). *(Docker not installed locally yet — free install; see README.)*
- ⬜ Multi-tenant data model (orgs → users → projects → media → edit-docs, versioned).
- ⬜ Local dev auth (Auth.js credentials) behind an auth interface.
- ⬜ Director tools: filler cut · reframe 9:16 · burn-in captions · one warm look · basic auto-mix.
- ⬜ Export renders a real file (ffmpeg worker; free, needs ffmpeg installed).
- ⬜ Agentic loop hardening (plan→act→verify→correct) + 5 eval prompts.

## Open money gates
- _None yet._ Real Claude Director (Anthropic API, metered) will be raised at S-Director-real. Free stub is the default until then.

## Environment notes
- Node 25.1.0 present (odd/current). **Recommend Node 22 LTS** — vitest 5 flags Node 25 as unsupported.
- Docker: **not installed** (free). Needed for `docker compose up`; core dev + verify gate do NOT require it.
- ffmpeg: **not installed** (free). Needed only for video export, not for the canvas verify/preview path.
