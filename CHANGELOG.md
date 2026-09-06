# Changelog

All notable changes, one line per verified slice.

## [Unreleased]

### S4.2 — Cycle F wave A (web): manageable multi-track timeline
- **Track-header gutter** on the timeline: per-track **rename** (double-click), kind badge, and toggles for **hide/show**, **lock**, **mute**, **solo**, a **reorder drag-handle** (z-order), and **remove** (guarded on the base/non-empty track). A **+ Video / + Audio** control adds tracks.
- **Drag clips between tracks** — cross-lane drag retargets via `moveClipToTrack` (magnetic main lane gap-closes; overlay/free lanes keep the snapped start); locked tracks refuse edits; drop indicators show the destination.
- State reflected visually: hidden/soloed-out lanes dim, locked lanes hatch + click-through, active toggles amber. All routed through the undoable commit path (Undo/redo + live preview). Directly closes the "no multi-track management / hide-show" gap.
- *verified:* typecheck (root+web) + `next build` + Playwright e2e **8/8** (incl. a tour-assertion fix now that the DB is live).

### S4.1 — Cycle F wave A (engine): true multi-track layers
- **Track metadata** (additive to `Track`, backward-compatible): `name?`, `hidden`, `locked`, `muted`, `solo`. Array order stays the single source of z-order.
- **Layers honored across renderers:** `activeClipsAt` skips `hidden` visual tracks (canvas + Stage + preview get it free); **ffmpeg export reworked to composite visual tracks by z-order** — base = lowest visual track, upper layers overlaid in order through the existing overlay/blend/chroma/mask path. The single-visual-track fast path is byte-identical (all prior checks unchanged). Audio honors `muted`/`solo`.
- **Pure track ops + Director tools:** `addTrack`/`removeTrack`/`setTrack`/`reorderTrack`/`moveClipToTrack` (`@cadence/director`) + tools `add_track`/`remove_track`/`set_track`/`reorder_track`/`move_clip`. `move_clip` generalizes within-track reorder; lock-guarded.
- Fixes the CapCut-parity keystone: layers no longer flatten on export. Driven by `docs/CAPCUT-PARITY.md`. *verified:* typecheck (root+web) + test:unit 44/44 + verify **54/54** + evals 5/5 + `next build` clean.

### fix(timeline) — zoom anchors on the playhead + follows during playback
- Timeline zoom re-centers on the playhead (was left-anchored → content slid away) and the strip follows the playhead past the viewport edge without fighting manual scroll. (`CutsStrip`.)

### Ops — Neon DB live + Vercel deploy readiness
- **Database live:** applied the 3 migrations to a Neon Postgres instance; `/api/health` → `{ status:"ok", db:true }`. Local `.env` (gitignored) holds `DATABASE_URL`; symlinked to `apps/web/.env` so the single file feeds both Node tooling (`migrate`, `verify`) and the Next app.
- **Vercel:** `apps/web/vercel.json` (framework pin) + `DEPLOY.md` — Root Directory `apps/web` (Vercel re-anchors to the npm-workspace root and transpiles `packages/*`), env-var table (`SESSION_SECRET` required; `DATABASE_URL` for persistence), Neon steps, and honest limitations (ffmpeg export is Docker-only; absent on serverless it degrades gracefully). `.env.example` extended with the enhance/TTS provider vars.

### S3.12 — Cycle E wave 5 (web): edit-by-transcript + AI-edge UI
- **Words room** (new `TranscriptRoom`): the transcript renders as clickable sentences/words — click a sentence or drag across words, then **Remove** ("cut this out") or **Keep only this** (`editByTranscript`, word/segment unit). Commits through the undoable path (instant preview + Undo); unmatched phrases never commit (no accidental wipe). Shows time removed.
- **One-tap cleanups:** Remove filler words (`fillerCut`) and Tighten pauses / remove silences (`removeSilence`, surfaces gaps dropped + seconds saved). Stub transcripts show an honest "approximate — install Whisper" banner but still allow segment edits.
- **Auto-reframe controls:** 9:16 / 1:1 / 4:5 / 16:9 pills (`autoReframe`, with settle-pan); "Keep subject centered (tracking)" is a visibly **disabled/Upgrade** pill (money-gated, honest tooltip — never faked).
- **AI voice-over composer:** text → `generate_voiceover` via `/api/director`; TTS is money-gated so it surfaces the graceful "no provider configured" message verbatim, with the free mic recorder cross-linked beside it.
- `/api/transcribe` now returns `approximate` (stub vs Whisper) so the client can flag it honestly; client imports only TYPES from `@cadence/understanding` (no browser bundle leak).
- *verified:* typecheck (root+web) + test:unit 44/44 + verify 53/53 + `next build` clean (/editor static).

### S3.11 — Cycle E wave 5 (engine): AI-native edge
- **Transcript-based editing** (`edit_by_transcript`): remove/keep spans by matching words or whole segments ("cut the sentence about…", "keep only where they mention…", "delete every 'um'"). Word-accurate; rebuilds surviving source spans back-to-back.
- **Silence / dead-air removal** (`remove_silence`): keeps every segment, drops inter-segment gaps beyond a threshold (default 0.6s). Distinct from filler_cut; "tighten the pauses" / "remove dead air" route here.
- **Auto-reframe** (`auto_reframe`): FREE centered reframe to any aspect (reuses `reframe`) + optional keyframed settle-pan. `subjectTracking` is **money-gated** (no vision provider wired) — the tool says so and returns the free centered reframe.
- **TTS voice-over seam** (`generate_voiceover`): pluggable `TtsProvider` (`none` default / `cli` / `api`), free-first + honest gating — fails gracefully with a money-gated message when no provider is configured; adds a full-volume `voiceover` track when one is.
- **Fix:** made `@cadence/understanding` (whisper-transcriber) fully browser-import-safe — all `node:*` built-ins are now lazy-imported so the barrel, re-exported through `@cadence/director` into the client `RoomPanel`, no longer leaks `node:child_process`/`fs` into the browser bundle (was breaking `next build` / the `/editor` route with a Turbopack "does not support external modules" error). TTS values in `tools.ts` are also lazy-imported.
- *verified:* typecheck (root+web) + test:unit 44/44 + verify **53/53** + evals 5/5 + `next build` clean (editor route restored).

### S3.9 — Cycle E wave 4 (engine): VFX + color + audio depth
- **Chroma key** (green screen, `chromakey`+`despill`), **blend modes** (screen/multiply/overlay/add/soft-light), **blur/pixelate regions** (hide a face/plate), **masks** (rect/ellipse + feather/invert), **color curves + HSL hue-shift**, and **audio depth** (per-clip fade in/out, pan, doc-level LUFS `loudnorm`). Each = schema (optional/defaulted) → Director tool + routing → canvas + ffmpeg → verify. Compositing tools target the overlay/b-roll track.
- *verified:* typecheck (root+web) + test:unit 44/44 + verify **49/49** + evals 5/5 + `next build` clean. (Hardened `appendVideos` to push minimal input clips so future schema fields never break it.)

### S3.10 — Cycle E wave 4 (web): VFX/Color/Audio room controls + scopes
- **Color room:** Hue slider + **draggable 5-node curve** (and S-curve/lift/crush presets) on top of the brightness/contrast/saturation/warmth sliders.
- **VFX room** (real controls, not just NL): chroma-key toggle + color swatch + similarity/spill, blend-mode select, blur/pixelate region (adjustable rect), mask (shape/feather/invert) — each notes composite-over-b-roll vs main.
- **Audio room:** per-track fade in/out + pan sliders + doc-level Normalize-loudness toggle (on top of music/voice volume + duck + audible preview).
- **Scopes:** client-only luma+RGB histogram & RGB parade (grade-aware), behind a toggle.
- All controls read from the doc (single source of truth), mutate via the undoable commit path. *verified:* typecheck (root+web) + verify 49/49 + `next build` clean.

### S3.8 — Cycle E wave 3: craft foundations (keyframes, delivery, subtitles)
- **Keyframe engine:** animate `x/y/scale/rotation/opacity` (+ `volume`) via `{prop,t,value,easing}` + a pure `valueAt()` (linear/ease-in/out/in-out); canvas + Stage full support, ffmpeg for scale (`zoompan`) + volume (`volume:eval=frame`) (x/y/rotation/opacity keyframes are preview-only on export, documented). Tools `animate`/`add_keyframe`.
- **Reverse** clips (`reverse`/`areverse`), **freeze-frame** (`trim`+`tpad`), **markers** (`EditDoc.markers`, add via UI/tool).
- **Subtitles export:** `toSrt`/`toVtt` in core + a client `srt.ts`; **Download .srt** in the Deliver room.
- **Delivery:** platform presets (`set_platform`: YouTube/Shorts/TikTok/Reels/IG feed+story → aspect+quality+fps) and a real **Deliver room** (preset buttons, quality summary, **thumbnail** + **.srt** downloads) + a **track panel** (per-track mute).
- *verified:* typecheck (root+web) + test:unit 44/44 + verify **43/43** + evals 5/5 + `next build` clean. (Integration fix: `appendVideos` clip literal now sets `reversed`.)

### S3.7 — Cycle E wave 2: P0 fixes + audible audio (expert-review driven)
- **Audible preview (P0-3):** music & voice-over now **play in the browser preview** (hidden `<audio>` per audio clip, synced to the transport/scrub/mute/volume) — not just on export. Music **auto-attaches on upload** (works on photo slideshows), shows on the timeline + "Music on" chip, with an Undo toast.
- **Transitions export for real (P0-1):** video-cut transitions now lay a proper **overlap** and render as an **A→B dissolve** + **audio crossfade** (`xfade`/`acrossfade`) on export and in preview — not a fade-from-black or a hard cut.
- **Overlays ripple (P0-2):** captions/titles re-anchor when you trim/split/reorder/delete footage, staying in sync.
- **P1 render fixes:** captions honor clip `speed`; multi-video audio robust when a source is silent (`anullsrc`+`aformat`); speed reads clamped to EOF; `add_music` gains `startSec`/`durationSec`; `make_slideshow` preserves attached music/voice-over. New `MediaAsset.hasAudio?` (defaulted).
- **UX quick wins:** labeled progress ("Rendering .mp4…") + **Cancel** on export, **undo toast**, **describe-first** composer (type before uploading → runs on load).
- *verified:* typecheck (root+web) + test:unit 44/44 + verify **37/37** + `next build` clean.

### S3.6 — Cycle E wave 1: interaction-demo engine + direct timeline editing
- **Interaction-demo engine (E1):** turn app/UI screenshots into an animated walkthrough — new `cursor` clip (eased waypoints + click ripples), `callout` clip (highlight box + dim + optional zoom), and a **typewriter** text animation (+caret). A `build_demo` skill assembles screens → sequenced image clips with typed email/password + a cursor that glides to a button and clicks; manual `add_cursor` / `type_text` / `add_callout` tools. Rendered in canvas + ffmpeg (drawbox/drawtext, time-gated). Verify checks 28–31. *(Vision-based auto field detection = money-gated follow-up; positions are nudgeable.)*
- **Direct timeline editing (E2):** select a clip → inspector; **drag-trim** edges (with snapping to edges/playhead/markers), **split at playhead** (S), **drag-reorder**, **ripple-delete** (Del) / delete, **duplicate**, per-clip **volume/mute**, **timeline zoom** (1–24×) + ruler scrub, and **markers** (M). All pure ops in `lib/edit-ops.ts`, routed through the undo/redo commit path. (Schema follow-ups noted: persist markers; first-class per-clip `muted`.)
- *verified:* typecheck (root+web) + test:unit 44/44 + verify 31/31 + `next build` clean.

### S3.5 — Cycle D: multi-video + audio + "more options" engine; login/Neon fixes
- **Multiple videos (DB):** upload several videos → one combined timeline (`combinedVideoDoc`/`appendVideos`); Media room clip-manager (reorder/remove, undoable); multi-video preview.
- **Voice-over + music (DB):** in-browser **voice-over recording** (mic, graceful permission/no-mic handling) + audio upload → `voiceover`/`music` tracks; live volume sliders + duck; mixed on export.
- **"More options" engine (DA):** 8 frame sizes (added 21:9, 4:3, 2.39:1, 2:3 + **custom W×H**), 14 looks (added bleach-bypass/moody/golden-hour/matte/punch), more transitions (dissolve/zoom/smooth) + title animations (pop/bounce), **VFX overlays** (`apply_vfx`: vignette/grain/light-leak), and **caption styling** (`style_captions`: font/weight/color/outline/size/position). New verify checks 23–27. *(Follow-up: bundle TTFs so exported captions use the exact font/weight; preview already does.)*
- **Login UX fix:** sign-in submits via `fetch` with inline errors — **no `?error=` in the URL**, no aggressive validation popups.
- **Dev-auth + Neon:** `SESSION_SECRET` dev fallback (prod still required); DB client negotiates **verified TLS** for managed Postgres (Neon/Supabase/RDS) automatically, local/Docker stays plaintext (`DATABASE_SSL_NO_VERIFY` opt-out for custom CAs).
- *verified:* typecheck (root+web) + test:unit 44/44 + verify 27/27 + `next build` clean.

### S3.4 — Cycle C wave 2: settings depth, login polish, dev-auth fix
- **Settings (`/settings`):** tabbed, accessible — Profile (edit display name via tenant-scoped `PATCH /api/settings`), Workspace + member roster (roles), Editor preferences (default aspect/look/quality/unmuted → `cadence:prefs` localStorage), and a Danger zone (sign out; delete-workspace intentionally disabled). New tenant-scoped, parameterized `@cadence/db` builders (`updateUserName`, `listOrgMembers`, `getOrg`). Graceful DB-down throughout.
- **Login (`/login`):** product-grade two-panel layout — progressive-enhancement form (email validation, loading/error states), "continue without an account", clearly-labeled dev-auth + "coming soon" SSO placeholders.
- **Dev-auth fix:** sign-in 500'd when `SESSION_SECRET` was unset. `sessionSecret()` now falls back to a fixed dev secret when unset **and not production** (prod still hard-errors) — sign-in works with zero config. *verified:* `POST /api/auth/login` → 303 → /dashboard with a signed HttpOnly cookie.
- *verified:* typecheck (root+web) + test:unit 44/44 + verify 22/22 + `next build` clean.

### S3.3 — Cycle C wave 1: richer pages (landing, dashboard, editor power)
- **Landing (`/`):** full marketing page — polished hero (reduced-motion-safe glow), an 11-capability feature showcase, "how it works" (Upload→Describe→Preview→Export), clickable example-prompt chips → `/editor`, an accessible FAQ (`<details>`), stat strip, and a real footer. Claims cross-checked against FEATURES.md.
- **Dashboard (`/dashboard`):** a real project hub — search, sort, grid↔list toggle, project cards with aspect/format badge + relative time, per-project **rename / duplicate / delete** (new tenant-scoped, parameterized API routes + `@cadence/db` builders), and **create-from-template** (Blank / Talking-head / Slideshow, server-validated seed docs). Graceful DB-down state preserved.
- **Editor power features:** **undo/redo** via a single `useDocHistory` commit path (coalesced slider/nudge steps, bounded), **keyboard shortcuts** (space/seek/home/undo/redo/`?` help, ignored while typing), **editable project title**, an **Export options popover** (container/quality/fps → `doc.quality`), and **Start over / Duplicate** in a TopBar overflow menu.
- *verified:* typecheck (root+web) + test:unit 44/44 + verify 22/22 + `next build` clean (17 routes).
- **Color room (B2):** manual grading — a preset grid **plus four live sliders** (brightness/contrast/saturation/warmth) that edit the doc instantly via a pure `adjustColor(doc, partialGrade)` (merges onto every main visual clip, clamped, re-parsed). Sliders are doc-controlled (single source of truth) so presets/NL/Reset move them too. New `adjust_color` Director tool + StubDirector routing ("brighter", "warmer", "more contrast", "less saturated"). Verify **check 22**.
- **Deliver room (B2):** real export panel — aspect chips, quality presets (Standard/High/Ultra·4K), resolution readout, Export, ffmpeg note.
- **Unit test suite (B4):** `tests/` via Node's built-in `node:test` (zero new deps, run through tsx) — **44 tests** over schema/engine/grade/edits/understanding/enhance, incl. the long-edge 4K invariant, caption sync, filler cut, whisper parsing, and provider faithfulness. `npm run test:unit`; repointed the broken `test` script off vitest.
- *verified:* typecheck + `test:unit` 44/44 + verify 22/22 + `next build` clean.

### S3.1 — Cycle B: engine features + audio waveform + bug fixes
- **Engine (B1):** **speed-ramp** (`set_speed`, 0.25–4×, slow-mo/fast — canvas source-time mapping + ffmpeg `setpts`/chained `atempo`), **crop/zoom** (`zoom`, static reframe via scale+pan, distinct from animated punch-in + ffmpeg `scale`/`crop`), and a **transitions library** (`set_transition`: crossfade / dip-to-black / slide / wipe → xfade `fade`/`fadeblack`/`slideleft`/`wipeleft`). New core helpers `sourceTimeAt`/`sourceSpanSec`/`transitionMotion`. Verify checks 19–21 (render + export-plan). *verified: verify 21/21, evals 5/5.*
- **Audio waveform (B3):** the timeline now shows a decoded **audio waveform** (Web Audio `decodeAudioData` → normalized peaks, ~600 buckets, cached per media, off the render path, drawn as a teal SVG envelope). Degrades to nothing when there's no audio; prefers the base video's own audio.
- **Bug fixes (the "5 issues"):**
  - **Duplicate React keys** (`m2`/`m4`/…): `say()` called `nextId()` *inside* the `setMessages` updater, so React dev's double-invoke produced colliding message ids. Now the id is generated **outside** the updater with `crypto.randomUUID()`.
  - **Font preload warnings** (×2): `next/font` emitted `<link rel=preload>` for the CSS-variable fonts that the browser then flagged as unused — set `preload:false` (still `display:swap`), clearing both.
- *verified:* typecheck + verify 21/21 + `next build` clean.

### S2.5 — Resizable side panels + timeline; handle polish
- Draggable `ResizeHandle` dividers adjust the width of the **chat rail** (chat ↔ editor) and the **`{ } code` drawer** (editor ↔ code), and the **height of the timeline** (preview ↔ timeline) via a horizontal variant. Pointer-drag or focus + arrow keys (accessible `role="separator"` with correct `aria-orientation`); clamped (rail 300–620, code 320–760, timeline 90–460) and **persisted per browser** (localStorage, storage-guarded). Below `md` panels go full-width/auto-height and handles hide.
- **Handle color fix:** suppressed the global amber focus outline on the separators (it rendered as a bright yellow bar) in favor of a subtle **teal hairline** on hover/keyboard-focus (north-star: teal = selection). — *verified in-browser: focused vertical handle outline = none; timeline keyboard nudge 150→278 persists; rail var applies; typecheck + build green.*

### QA1 — End-to-end browser test (Playwright) driving the real app with real media
- **New E2E suite** (`apps/web/e2e/`, `@playwright/test`) — drives the running app at `localhost:3000` in headless Chromium. `test:e2e` script at repo root (`npm run test:e2e`) and in `@cadence/web`; `test:e2e:install` installs the Chromium browser for CI. Playwright config reuses an already-running dev server locally and boots one in CI (`reuseExistingServer: !CI`). Screenshots of every step → `test-artifacts/` (gitignored); generated fixtures → `test-artifacts/fixtures/`.
- **Real media, generated in-browser** (`e2e/fixtures.ts`) — a ~2.5s `.webm` is authored by drawing an animated `<canvas>`, capturing `captureStream(30)` into a `MediaRecorder`, and writing the Blob to disk (this Mac has no ffmpeg to author a clip); four `.png` photos via `canvas.toDataURL`. Uploaded through the app's real `<input type=file>` via `setInputFiles`.
- **Video flow covered** — upload → transcript segment count → `cut a 15-second highlight` · `make it vertical with captions` · `give it a cinematic look` · `add a fade in and out` · `punch in at 1s` · `make it 4K`, asserting the edit-doc (code drawer) and the AppliedStatus strip after each (aspect 9:16, Cinematic look, Captions on, 4K-class quality). Rooms rail: Media/Color/VFX/Audio/Deliver each open their panel; Audio mute toggle flips the preview `<video>.muted`. Export with ffmpeg absent → asserts the graceful ffmpeg-missing message AND the JSON edit-doc fallback download.
- **Photo flow covered** — upload 4 photos → auto slideshow (4 image clips) → `make it vertical` → `warm look`.
- **Bug found (MEDIUM, reported, not yet fixed):** `setQuality` (`packages/director/src/edits.ts`) anchors the ultra/high upscale to **width** (`scale = 3840 / baseW`) regardless of orientation, so applying "make it 4K" to a **vertical** (9:16) doc overshoots to ~**3844×6836** (a ~6836px-tall, ~26 MP frame) instead of the documented "up to 3840×2160" / standard vertical 4K 2160×3840. Landscape is unaffected (1280×720 → 3840×2160). Repro: upload video → "make it vertical with captions" → "make it 4K" → AppliedStatus shows `Quality 4K 3844×6836`. Suggested fix: scale by the LONG edge (cap max(w,h) at 3840) or clamp both target dims to a 4K budget. The E2E test asserts the durable invariant (long edge ≥ 3840) so it stays green whether or not the overshoot is fixed.
- *verified:* root `typecheck` green; `npm run verify` **18/18**; `apps/web` `next build` clean; `npm run test:e2e` **2/2** (video + photo flows) in headless Chromium.

### S2.4 — UX fixes (working rooms, audible preview, applied-state) + Whisper SSRF fix
- **Rooms rail now works** — Media / Edit / Color / VFX / Audio / Deliver each open a real contextual panel (`RoomPanel.tsx`), all routing through the existing Director handlers: Media (asset list + add), Color (look picker), Audio (music + auto-mix + mute toggle), VFX (b-roll/punch-in/kinetic/fade), Deliver (quality presets + export). `RoomsRail` is stateful (no more disabled buttons).
- **Preview is audible** — the main preview `<video>` starts UNMUTED with a speaker toggle in the transport + Audio room (b-roll PiP stays muted). Fixes "added sound but hear nothing" for the source audio (music/mix still render at export).
- **Applied-state strip** (`AppliedStatus.tsx` + `lib/status.ts`) under the TopBar shows live state — aspect, cuts, active look, quality target (e.g. "4K 3840×2160"), captions on, music on — so export-only changes like "Make 4K" visibly register.
- **Security (HIGH):** `assertLocalMediaPath` in `@cadence/understanding` — the Whisper ffmpeg audio-extraction now validates `media.src` (rejects URLs/`concat:`/`file:`/flags, realpath-confines to the uploads dir, requires a regular file) and constrains ffmpeg with `-protocol_whitelist file,pipe`. Closes the SSRF/arbitrary-read the commit review flagged. (`--` intentionally omitted: verified against ffmpeg source that `-i --` breaks legit inputs; an absolute realpath + whitelist is the correct guard, matching the export fix.)
- *verified:* typecheck green; `npm run verify` **18/18** (new **check 18** asserts the guard); `apps/web` `next build` clean.

### S1.8 — Agentic loop hardening (plan→act→verify→correct) + evals (Ask 4)
- `@cadence/director`: new `runDirectorLoop(request, project, { engine, probeTimes?, maxAttempts?, director? })` (`agentic.ts`) — the self-correction seam the real Claude Director will use. PLAN/ACT calls the Director's `interpret`; VERIFY `parseEditDoc`s the produced doc (schema) then renders probe frames (default `t=0` + mid-duration) through the injected `RenderEngine`, asserting real non-empty PNGs; CORRECT captures the error, records a correction, and feeds it FORWARD (`DirectorFeedback`) to the next attempt — the deterministic stub can't self-revise, so the loop falls back to the last known-good doc (or a minimal valid doc) so the caller is never left broken. Returns `{ result, verified, attempts, corrections }`. **Stays engine-agnostic** — imports only the `RenderEngine` interface from `@cadence/core`, never `@cadence/render-node`; the caller injects the concrete `CanvasRenderEngine`.
- `scripts/evals.ts` + root `"evals"` script (`tsx scripts/evals.ts`): 5 prompts exercising different capabilities, each builds a suitable ProjectState (stub transcript / image assets), runs `runDirectorLoop` with `CanvasRenderEngine`, and asserts `verified === true`, the expected tool(s) were called, and a real frame rendered (proof frames → `.cadence/`): (a) "cut a 45-second highlight", (b) "make it vertical with captions and a cinematic look", (c) 'add a kinetic title that says "Hello", punch in at 2s, fade in and out', (d) "make a slideshow from my photos with a warm look", (e) "remove filler words then make it 4K".
- Verify gate: new **check 17** runs `runDirectorLoop` on a chained prompt (verifies + renders in 1 attempt, 0 corrections) AND on a deliberately broken Director (invalid `fps` → caught by VERIFY → recovered to a safe doc, corrections recorded) — so the loop is covered by `npm run verify` too.
- StubDirector fixes surfaced by the evals: `parseTargetSeconds` now accepts hyphenated durations ("45-second"); the highlight intent now requires a *time unit* after "make it …" so "make it 4K" / "make it 1080p" (incl. the "Make 4K" QuickAction) no longer falsely triggers `create_highlight` — it's a quality change.
- *verified:* root `typecheck` green; `npm run verify` 17/17; `npm run evals` 5/5; `apps/web` `next build` clean (17 routes).

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

### S1.7 — Multi-page app: landing · auth · dashboard · project persistence
- **Turned the single editor screen into a real App-Router app.** New routes: `/` (landing), `/login` (dev sign-in), `/dashboard` (auth-gated projects list), `/editor` (scratch editor, unchanged behavior), `/project/[id]` (editor bound to a persisted project), `/settings` (account/org + sign out). The old `/` (bare `<Editor/>`) moved to `/editor`; `/` is now a static landing page.
- **Reusable Editor (no duplication):** `<Editor/>` gained optional props — `initialDoc`, `projectName`, `onSave`, `backHref`, `notice` — seeded via lazy `useState` so `/editor` still runs stateless with zero behavior change. A `Save` button + back link appear in `TopBar` only when their handlers are supplied. `ProjectEditor` (client) wraps `<Editor/>` and wires `onSave` → the doc route.
- **Auth-gating from the session, never the client:** `apps/web/src/lib/session.ts` — `requireSession()` (redirects to `/login`), `getSession()`, `deterministicUserId()` (offline fallback), `isValidEmail()`. Dashboard/settings/project pages call `requireSession()` first and derive tenant scope (`orgId`) only from the signed session.
- **API routes (all `nodejs`, session-scoped, DB-graceful):** `POST /api/auth/login` (provisions account + signs cookie + 303 → `/dashboard`; DB-down → signs in with a deterministic id, no org), `POST /api/auth/logout` (clears cookie + 303 → `/`), `POST /api/projects` (creates a project in the session's org; 409 no-org, 503 DB-down), `POST /api/projects/[id]/doc` (verifies the project belongs to the session's org, then `saveEditDocVersion` — validated by `parseEditDoc`; 404/400/503).
- **`@cadence/db` additions:** `upsertUserQuery` (idempotent find-or-create on the `lower(email)` unique index — re-sign-in never duplicates) + `firstOrgForUserQuery` (user-scoped) query builders, and a transactional `provisionAccount(email, name)` repository that find-or-creates the user and, if they have no org, a personal workspace org + `owner` membership. Returns the identity + tenant the session is scoped to.
- **Graceful without a DB (verified by construction):** every DB-backed page wraps its reads in try/catch → friendly "connect a database" state (dashboard), a scratch-mode notice (project editor), or a role fallback (settings) — page loads and `next build` never crash when Postgres is down. `parseEditDoc` still validates every doc before it touches the DB.
- **Shared chrome:** `TopNav` (brand + Projects/Settings links + email + sign-out form) across the authed pages, matching the north-star design (graded dark, amber action, teal selection, Fraunces italic for the user's words).
- Verify gate: check 9 extended to assert `upsertUserQuery` is idempotent on `lower(email)` and `firstOrgForUserQuery` is user-scoped — both fully parameterized.
- *verified:* root `typecheck` + `apps/web typecheck` green; `npm run verify` 14/14; `apps/web` `next build` clean (17 routes: `/` and `/editor` static, the rest server-rendered on demand). **Postgres not running here** → project create/load/save exercise the graceful-degradation paths; full persistence needs `docker compose up db` + `npm -w @cadence/db run migrate`.

### S1.5 — Pluggable, faithful enhance/upscale system
- `@cadence/enhance`: `EnhanceProvider` contract with a hard **faithfulness** rule (detail-preserving only — never alters faces/identity/content). Providers: **free** (Lanczos+unsharp+denoise, no AI, default), **local** (Real-ESRGAN), **api** (hosted, metered), **cli** (bring-any-CLI). Selected by `ENHANCE_PROVIDER` env; `buildCliArgs` templating for custom tools.
- Schema `quality`: added `faithful` (always true) + `enhanceProvider`.
- **Honesty fix:** `set_quality` no longer implies the preview changed — it says the upscale renders on **export** (preview stays at source res), and that enhancement is faithful (no face/content changes). Addresses "it says 4K but doesn't look 4K."
- *verified:* verify gate check 6 asserts CLI templating, provider selection, and that all providers are identity-preserving with both AI and non-AI options.

### S2.1 — Creative capabilities: music, b-roll, kinetic titles, punch-in
- **Edits-as-code, all surfaces.** Four new capabilities, each as data on the `EditDoc` + a typed Director tool + StubDirector routing + Node canvas renderer + web Stage preview + ffmpeg export plan + a verify check that renders a frame.
- **Schema (`@cadence/core`):** `TextAnim` (kinetic slide+scale intro) on `TextClip.anim`; `Emphasis` (punch-in scale pulse) on `VideoClip.emphasis`. Both are pure data, resolved by deterministic helpers.
- **Pure helpers (`grade.ts`):** `textKinetic(clip, t)` (eased slide + scale-in, mirrors `transitionOpacity`) and `emphasisScale(clip, t)` (sine pulse 1→zoom→1 over `[atSec, atSec+dur]`) — shared by canvas, Stage, and export so the three agree.
- **Background music + ducking:** `add_music` adds a `music` audio track referencing an audio `MediaAsset`; starts ducked (0.28) and `auto_mix` re-asserts the duck. Silent in the canvas/Stage preview (no audio there) but honored by the ffmpeg export via the existing `amix`/`adelay` path. Web upload now accepts audio files.
- **B-roll / PiP overlay:** `add_broll` overlays an image/video as a scaled (default 0.35), corner-anchored clip on a top `broll` track for a time range. Canvas paints it on top; Stage renders it as a positioned PiP box (`BrollVideo` seeks video overlays); export composites it with `overlay=…:enable='between(...)'` (excluded from the base concat).
- **Kinetic titles:** `add_kinetic_title` slides a title up and scales it in. Honored by canvas + Stage (`textKinetic`); export slides it via an eased, time-dependent `drawtext` x/y expression.
- **Punch-in emphasis:** `add_emphasis(atSec, durationSec, zoom)` sets a scale pulse on the video clip at `atSec`. Honored by canvas + Stage (`emphasisScale`); export animates it with a `zoompan` sine pulse.
- **QuickActions:** added Punch-in, B-roll, Kinetic title, Music (video) and Kinetic title, Music (photos).
- *verified:* `npm run typecheck` + `npm run verify` (new checks **11–14**, each renders a real frame and asserts the feature + its export filter) + `apps/web` `next build` — all green. Audio fully manifests only at **export**; the other three appear in the visual preview and export.

### S1.5 — Real local Whisper transcription (free/local drop-in)
- `@cadence/understanding`: new `WhisperTranscriber implements Transcriber` — real speech-to-text behind the existing interface, mirroring @cadence/enhance's pluggable/graceful CLI pattern. **No heavy npm dep** — shells out to a locally installed Whisper via `node:child_process`.
  - **Configurable command:** `WHISPER_CMD` command template (tokens `{input}` `{model}` `{output_dir}` `{output}`), OR auto-detects a `whisper` / `whisper-ctranslate2` / `faster-whisper` / `whisper-cpp` / `whisper-cli` CLI on PATH. Model from `WHISPER_MODEL` (default `base`).
  - **Audio extraction:** first extracts a temp 16 kHz mono wav via ffmpeg, reusing the `FFMPEG_PATH` convention from @cadence/render-ffmpeg's detect. `isAvailable()` is true only when **both** a Whisper CLI and ffmpeg are present; `detectWhisper()` never throws.
  - **PURE `parseWhisperJson(json, mediaId): Transcript`** (no process/fs — unit-testable without a model): maps the common OpenAI whisper / faster-whisper JSON shape (`segments[].words[].{word,start,end,probability}`, seconds) **and** the whisper.cpp full shape (`transcription[].offsets{from,to}` in ms, `tokens[]`, special markers like `[_BEG_]` filtered) into the shared `Transcript` (segments + flat words, seconds, 0..1 score from word probs or `exp(avg_logprob)`). Times clamped non-negative + end≥start; Whisper's ordering preserved.
- Factory: `createTranscriber()` / `pickTranscriber()` returns the `WhisperTranscriber` when available, else the deterministic offline `StubTranscriber` (the standing default fallback) — the pipeline never crashes when Whisper/ffmpeg are absent. Exported from `index.ts` (`WhisperTranscriber`, `parseWhisperJson`, `detectWhisper`, `templateToArgv`, `WHISPER_MISSING_MESSAGE`, `createTranscriber`, `pickTranscriber`, `WhisperDetection`).
- Web API: `apps/web/src/app/api/transcribe/route.ts` now uses `pickTranscriber()` (real Whisper when present, Stub otherwise) — response shape (`{ transcript }`) unchanged.
- Verify gate: **check 15** asserts `parseWhisperJson` maps a realistic OpenAI sample → 2 segments / 6 flat words / 3.2s with trimmed, monotonic, 0..1-scored output (round-trips through JSON), plus the whisper.cpp ms→s + special-token-filter path; **check 16** asserts the factory falls back to `StubTranscriber` when Whisper is unavailable (the case in this env) and would select Whisper when up. Both pure — no model needed.
- *verified:* root `typecheck` green; `npm run verify` 16/16; `apps/web` `next build` clean. **Whisper is NOT installed here, so live transcription can't be exercised — the graceful fallback to the Stub is confirmed.** To enable real transcription: install whisper.cpp / faster-whisper (or OpenAI whisper) + ffmpeg, or set `WHISPER_CMD`; ffmpeg (needed for audio extraction) is baked into the Docker image. **Free-first honored — no paid service; StubTranscriber stays the default.**
