# Cadence — Agent & Wave Log

A running record of the multi-agent build. Each wave = a group of expert agents
run in parallel on disjoint files (packages/* vs apps/web/*), integrated + gated
(`typecheck` · `test:unit` · `verify` · `next build`) + committed.

## Cycles A–E (done, committed)
- **A/B (S0–S1.x):** monorepo + edits-as-code core + verify gate; Next.js editor; edit tools (highlight, filler, reframe, captions, looks, auto-mix, slideshow, quality); real ffmpeg export path; enterprise DB/auth; pluggable faithful enhance.
- **C:** richer landing, dashboard hub, editor power (undo/redo, shortcuts), settings, login; dev-auth fix.
- **D:** multiple videos, voice-over/music, "more options" engine (8 aspects, 14 looks, transitions/anims, VFX overlays, caption styles); Neon-ready DB client.
- **E wave 1:** interaction-demo engine (cursor/typewriter/callout, `build_demo`) + direct timeline editing (trim/split/reorder/ripple/markers/zoom). Committed `099af52`.
- **Tester:** Playwright suite + video recording; page tour + feature flows (7/7). `890d203`.

## Expert advisory (docs/)
- `docs/EDITING-ROADMAP.md` — senior editor: pro feature set + priorities (keyframes, multi-track, audible mixer, delivery presets, chroma-key).
- `docs/UX-ROADMAP.md` — UX: progress feedback, undo toasts, describe-first, filmstrip thumbs, mobile room bar, click-to-place demo.
- `docs/EDITING-REVIEW.md` — head of editing: P0 punch-list (export transitions, overlay-ripple desync, music-on-slideshow, caption-font-on-export) + wave plan.

## Build waves (from the review) — see docs/WAVE-PLAN.md
- **Wave 2 (P0 fixes + audible audio):** engine = export transitions on video cuts + P1 render fixes; web = music auto-attach + **audible preview** + overlay-ripple sync + UX quick wins.
- **Wave 3 (foundations):** keyframe engine (`valueAt`), multi-track compositing, reverse/freeze, delivery presets + SRT/thumbnail.
- **Wave 4 (VFX/color/audio depth):** chroma-key, masks, blur/pixelate, blend modes; curves/HSL/LUTs/scopes; audible multi-track mixer + fades/EQ/LUFS.
- **Wave 5 (AI edge):** transcript-based editing, auto-reframe w/ subject tracking, silence removal, TTS voice-over.

## Wave 5 delivered (engine) — S3.11
- Single expert engine agent (economical, disjoint `packages/**`+`scripts/verify.ts`, no-commit): `edit_by_transcript`, `remove_silence`, `auto_reframe` (free centered + gated subject tracking), `generate_voiceover` (pluggable `TtsProvider` none/cli/api, money-gated + graceful). All pure-fn → Director tool → routing → verify; verify 49→**53**.
- Orchestrator integration fix: `@cadence/understanding` (whisper-transcriber) made fully browser-import-safe — lazy `node:*` imports so the barrel re-exported through `@cadence/director` into the client `RoomPanel` no longer leaks `node:child_process`/`fs` into the browser bundle (was breaking `next build` + `/editor`). Gated + committed.
