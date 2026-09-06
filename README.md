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

Run the editor:
```bash
npm run dev --workspace @cadence/web   # http://localhost:3000  (open /editor)
```
Real `.mp4` export + Postgres persistence: `docker compose up` (ffmpeg baked in). Deploy to Vercel: see **[DEPLOY.md](DEPLOY.md)**.

## Layout
```
packages/core          engine-agnostic EditDoc schema (source of truth) + RenderEngine contract + pure helpers
packages/render-node   headless canvas RenderEngine (no browser/ffmpeg/Docker needed)
packages/render-ffmpeg pure EditDoc -> ffmpeg filtergraph plan + runExport (real .mp4)
packages/director      Director tools + pure edit ops (highlight, tracks, trims, keyframes, transitions, demo, transcript, ...)
packages/understanding transcripts (Whisper CLI or offline stub) + pluggable TTS seam
packages/enhance       pluggable faithful upscale providers (free / local / api / cli)
packages/db            multi-tenant Postgres (migrations, pooled client, tenant-scoped repos)
apps/web               Next.js editor + API (the app)
scripts/verify.ts      the render-verify gate ; scripts/evals.ts  capability evals
```

## The rules (short version)
1. **Edits-as-code** — the `EditDoc` is the single source of truth.
2. **Never code library APIs from memory** — verify from `.d.ts`/docs first.
3. **Agentic loop** — plan → smallest slice → typecheck + verify → fix → commit.
4. **Render-verify gate** — if it doesn't render one frame, it isn't done.
5. **Scale by construction** — client preview, splittable render, engine-agnostic ops.
6. **Money gate** — never enable a paid/metered service without asking; free fallback first.

## What you can do
A **prompt-native + full manual** editor (CapCut-style), all edits-as-code so preview,
canvas, and export stay in sync:
- **AI:** describe an edit in chat; highlight cuts, reframe, captions from speech,
  **edit-by-transcript**, silence removal, auto-reframe, looks, slideshows, and an
  **interaction/walkthrough builder** from screenshots.
- **Manual timeline:** multi-track layers with **track headers** (hide/show, lock,
  mute/solo, rename, reorder, add/remove), **drag clips between tracks**, trim/split/
  ripple, **roll/slip/slide**, an **on-timeline keyframe editor**, **per-cut transitions**,
  **audio fade handles**, **beat-sync**, **stickers/emoji + text presets**, and a
  playhead-anchored zoom.
- **Rooms:** Media · Edit · Words · Color · VFX · Audio · Deliver · Demo.

Full feature list: **[FEATURES.md](FEATURES.md)**. CapCut parity status:
**[docs/CAPCUT-STATUS.md](docs/CAPCUT-STATUS.md)**.

## Status
Social MVP + the manual/AI editor (CapCut-parity waves A–E) are built and verified;
Neon Postgres is wired and Vercel deploy is ready. See **[TASKS.md](TASKS.md)** and
**[CHANGELOG.md](CHANGELOG.md)** for the slice-by-slice history.
The stub Director (free) is the default; the real Claude Director (Anthropic API,
metered) is behind a money gate and off by default — as are AI upscale and TTS.
