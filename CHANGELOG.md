# Changelog

All notable changes, one line per verified slice.

## [Unreleased]

### S0.1 — Scaffold + verify gate
- Init npm-workspaces monorepo (`packages/*`, `apps/*`); pinned toolchain (typescript 5.9.3, zod 4.5.4, @napi-rs/canvas 1.0.8, tsx 4.23.13, @types/node 22.20.1).
- `@cadence/core`: engine-agnostic edit-doc schema (Zod) — the single source of truth — plus the `RenderEngine` interface and timeline math (`activeClipsAt`, `docDurationSec`).
- `@cadence/render-node`: headless canvas `RenderEngine` (Skia via @napi-rs/canvas) — renders a frame from any valid edit-doc with no browser/ffmpeg/Docker.
- Verify gate: `npm run typecheck` (tsc, exit 0) + `npm run verify` (renders one real 1280×720 PNG from a schema-validated doc, asserts PNG magic + size, fails loudly).
- Corrected the brief from ground truth: Omniclip is **ISC** (not MIT) and the headless **"omnitool" engine does not exist yet** — resolved by the engine-agnostic render contract (see ARCHITECTURE.md).
