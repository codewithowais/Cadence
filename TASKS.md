# Cadence — TASKS

Working method: PLAN → smallest vertical slice → `typecheck` + `verify` (render one frame) → fix → commit → next. Never proceed while red.

## Status legend
✅ done & verified · 🚧 in progress · ⬜ todo · ⛔ blocked on money gate

## Phase 0 — Spike (prove the loop)

- ✅ **S0.1 Scaffold + verify gate.** npm workspaces monorepo; `@cadence/core` (engine-agnostic edit-doc schema + render interface); `@cadence/render-node` (headless canvas RenderEngine); `npm run typecheck` + `npm run verify` (renders one real frame, fails loudly). Pinned versions. — *verified: typecheck exit 0, verify renders 1280×720 PNG.*
- ⬜ **S0.2 Stub Director + `set_timeline` tool.** Deterministic Director that emits a valid edit-doc from a request; exposed as a typed tool. Verify: a request → valid doc → renders.
- ⬜ **S0.3 Ingest one video + local transcript.** faster-whisper/whisper.cpp wrapper (free). Verify: transcript JSON produced for a sample.
- ⬜ **S0.4 "Cut a 60s highlight" end-to-end.** transcript → stub Director → edit-doc → preview frame. (Phase 0 done gate.)

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
