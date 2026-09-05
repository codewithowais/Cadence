# Cadence

A prompt-native, mass-market, enterprise-scale video editor. You describe what you
want in plain language; an AI **Director** edits the video and shows the result —
always editable. The project is stored as **edits-as-code**: a declarative
`EditDoc` that any renderer can turn into pixels.

See **[AGENTS.md](AGENTS.md)** for the full build brief and rules, and
**[ARCHITECTURE.md](ARCHITECTURE.md)** for how it fits together.

## Requirements
- **Node 20+** (Node **22 LTS recommended**; this repo is pinned/tested there).
- Optional, free, only for later slices: **Docker** (`docker compose up`) and **ffmpeg** (video export).

## Quick start (no cloud, no bill)
```bash
npm install
npm run typecheck   # tsc across all packages
npm run verify      # renders one real frame headlessly and asserts success
```
`npm run verify` writes a proof frame to `.cadence/verify-frame.png`.

## Layout
```
packages/core         engine-agnostic EditDoc schema (source of truth) + RenderEngine contract
packages/render-node  headless canvas RenderEngine (no browser/ffmpeg/Docker needed)
packages/director     (next) stub Director — deterministic, emits valid edit-docs
apps/                 (next) Next.js web + api
scripts/verify.ts     the render-verify gate
```

## The rules (short version)
1. **Edits-as-code** — the `EditDoc` is the single source of truth.
2. **Never code library APIs from memory** — verify from `.d.ts`/docs first.
3. **Agentic loop** — plan → smallest slice → typecheck + verify → fix → commit.
4. **Render-verify gate** — if it doesn't render one frame, it isn't done.
5. **Scale by construction** — client preview, splittable render, engine-agnostic ops.
6. **Money gate** — never enable a paid/metered service without asking; free fallback first.

## Status
Phase 0 in progress — see **[TASKS.md](TASKS.md)** and **[CHANGELOG.md](CHANGELOG.md)**.
The stub Director (free) is the default; the real Claude Director (Anthropic API,
metered) is behind a money gate and off by default.
