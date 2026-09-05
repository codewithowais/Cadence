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

- ⬜ Next.js app (web + api routes); dark graded UI per `/design/north-star.html`; conversation-first rooms.
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
