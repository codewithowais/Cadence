# Cadence — Features

A prompt-native, mass-market, enterprise-shaped video editor. You describe the
edit in plain language; the **Director** turns it into an **edit-doc** (the single
source of truth) that previews live and renders to real video.

Legend: ✅ works now (verified) · 🎬 fully manifests on **export** (needs ffmpeg — bundled in Docker) · 🔒 needs a free install to run live · ⛔ money-gated (off by default)

---

## 1. The core idea
- ✅ **Edits-as-code** — every project is a declarative `EditDoc` (Zod-validated). Store the recipe, not opaque state; version it in the DB.
- ✅ **Conversation-first** — describe what you want; the Director plans + calls typed tools. No timeline knowledge required.
- ✅ **Custom multi-step scenarios** — one request chains multiple tools, e.g. *"cut a 40s highlight, make it vertical with captions and a cinematic look."*
- ✅ **Live preview on your real media** — the browser seeks your actual footage/photos and applies looks/motion/captions in real time (no upload round-trip, no ffmpeg).
- ✅ **Engine-agnostic rendering** — one `RenderEngine` contract: Node canvas (now), browser preview, ffmpeg export. Swappable without touching the Director.

## 2. Ingest & understanding
- ✅ Upload a **video**, or a **group of photos**, or an **audio** track (music).
- ✅ In-browser probing of duration/dimensions.
- ✅ **Transcription** via a `Transcriber` interface — deterministic **StubTranscriber** (offline, free, default fallback). ✅ 🔒 **Local Whisper** drop-in (`WhisperTranscriber`) — real speech-to-text from a local `whisper` / `whisper-cpp` / `faster-whisper` CLI (or `WHISPER_CMD` template; `WHISPER_MODEL`, default `base`), audio extracted via ffmpeg. A `createTranscriber()` factory picks Whisper when both it and ffmpeg are present, else the Stub — never crashes when absent. (Needs a free Whisper install + ffmpeg to run live.)

## 3. Editing tools (Director tools on the edit-doc)
- ✅ **Highlight cut** (`create_highlight`) — pick the best segments up to a target length.
- ✅ **Filler-word / pause removal** (`filler_cut`) — tighten a talking-head video.
- ✅ **Reframe** (`reframe`) — 9:16, 1:1, 4:5, 16:9 (re-anchors all clips).
- ✅ **Burn-in captions** (`add_captions`) — from the transcript, synced through the cuts, auto-fit to the frame, pill background.
- ✅ **Color looks** (`apply_look`) — warm, cool, vivid, b&w, cinematic, vintage, noir, vibrant, none.
- ✅ **Title cards & lower-thirds** (`add_title`) with fade in/out.
- ✅ **Kinetic / animated titles** (`add_kinetic_title`) — slide + scale in.
- ✅ **Fade from/to black** (`add_fades`) + **solid/color clips** (backgrounds, letterbox).
- ✅ **Ken Burns motion** on photos (zoom + pan) and **crossfade transitions**.
- ✅ **B-roll / picture-in-picture** (`add_broll`) — overlay an image/clip, corner-anchored.
- ✅ **Punch-in emphasis** (`add_emphasis`) — a scale pulse for emphasis.
- 🎬 **Auto-mix audio** (`auto_mix`) — level speech, duck music.
- 🎬 **Background music** (`add_music`) — music track, ducked under speech (audible on export).
- ✅ **Manual nudge** — trim the ending by ±0.1s from the UI.
- ✅ **`set_timeline`** — the keystone tool; commits a full, schema-validated edit-doc.
- ✅ **Transcript-based editing** (`edit_by_transcript`) — remove or keep spans by matching words/segments ("cut the sentence about…", "delete every 'um'").
- ✅ **Silence / dead-air removal** (`remove_silence`) — drop pauses beyond a threshold while keeping every segment ("tighten the pauses").
- ✅ **Auto-reframe** (`auto_reframe`) — free centered reframe to any aspect + optional settle-pan; subject tracking is a money-gated upgrade (honest note).
- 🎬 **AI voice-over** (`generate_voiceover`) — pluggable TTS (`none`/`cli`/`api`); money-gated, fails gracefully when no provider is configured.

### Manual timeline (CapCut-style) — every capability is AI **and** manual
- ✅ **Multi-track layers** with a **track-header gutter**: rename, **hide/show**, lock, mute/solo, reorder (z-order), add/remove (+ Video/+ Audio); **drag clips between tracks**. Layers composite by z-order in preview **and** export.
- ✅ **On-timeline keyframe editor** — draggable diamonds per prop (x/y/scale/rotation/opacity, volume); add/retime/value/easing/remove.
- ✅ **Per-cut transitions** — a ◇ chip on each cut → **55-transition** grouped, searchable gallery + duration, or hard cut (preview renders every type).
- ✅ **Roll / Slip / Slide** trim modes (+ inspector nudges) and **audio fade** drag-handles.
- ✅ **Zoom** anchored to the playhead + follow, Fit, and double-click zoom-to-selection.
- ✅ **Beat-sync** — Detect beats → beat markers → Split at beats; **Stickers/emoji + text presets** picker.
- ✅ **Walkthrough/Demo room** — build interaction videos from screenshots with visual on-preview placement (typed fields, cursor+click, callouts).

### UI/UX
- ✅ **Rooms:** Media (thumbnail grid, drag onto timeline) · Edit · Words · **Design** (Looks/Color/Backgrounds/Text/Overlays/Advanced — thumbnail preview gallery, 24 looks + palettes + text presets) · Demo · Audio · Deliver.
- ✅ **Collapsible chat & code rails** (`[` `]` `\`), **adjustable preview height**, room panels scroll so the video stays visible.
- ✅ **Drag-and-drop** media onto timeline tracks + OS file drop.
- ✅ **Theme:** coral/vermilion on warm charcoal (AA contrast), teal secondary.

## 3b. Text videos & typography (Canva-style — no footage needed)
- ✅ **Text video from words** (`make_text_video`) — paste a script, a quote ("…" — Author), a numbered/bulleted list, an announcement, or lyrics; it becomes timed, animated scenes (reading-speed pacing) with backgrounds and scene transitions. 16:9 · 9:16 · 1:1 · 4:5. No upload needed.
- ✅ **10 themes** — Bold, Minimal, Neon, Elegant, Playful, Corporate, Retro, Aurora, Cinematic, Handwritten — each a font pairing, palette, animated background, motion set, effect, and transition. **Restyle** keeps words + timing (`restyle_text_video`).
- ✅ **Scenes editor** (Text room) — edit lines in place, add a second line, retime, reorder, add, delete; reframe re-lays scenes instead of stretching.
- ✅ **21 text animations** (`animate_text`) — fade, rise, drop, slide left/right, zoom in, stomp, blur in, wipe, baseline, tumble, spin, flip, neon, glitch, scramble, typewriter, pop, bounce, kinetic — each **whole / line-by-line / word-by-word / letter-by-letter**, with speed + delay; **10 exits** and **7 loops** (breathe, float, wiggle, flicker, pulse, shake, wave). Live hover previews.
- ✅ **Text effects** (`style_text`) — lift, hollow, splice, echo, glitch, neon, highlight; **gradient text fill**; outline; pill/box panel.
- ✅ **24 bundled fonts** (OFL Google Fonts: Inter, Montserrat, Poppins, Bebas Neue, Anton, Playfair Display, Pacifico, Permanent Marker, Press Start 2P, …) — identical in preview and export.
- ✅ **Backgrounds** (`set_background`) — solid, linear/radial gradients, animated (drift, spin, pulse, **aurora**), patterns (dots, grid, lines, diagonal).
- ✅ **20 animated text-style presets** + Canva-style "Add a heading / subheading / body".
- ✅ **Caption animations** — fade, pop words, rise words, typewriter, slide up, blur in (Words room).
- ✅ **Exports exactly as previewed** — media-less docs render every frame through the shared canvas; animated titles over footage export as frame sequences (no more frozen text).
- ✅ **Text-video templates** in New project (Announcement, Quote, Tips list, Neon promo) + landing prompt chips.

## 3c. Cycle I — specialist agent waves (details in `docs/agents/*.md`)
**Editing speed & timeline craft** (Senior Video Editor)
- ✅ J/K/L shuttle (2×/4×, reverse), frame step `,` `.` (⇧ = 10), ↑/↓ cut-to-cut, I/O in/out range → **Remove range** / **Keep only range**, snapping toggle `N` with a snap guide, visible + closable **gaps**, multi-select (⇧/⌘-click, marquee, ⌘A) with group delete/duplicate/nudge, **copy/paste attributes** (⌘⇧C/⌘⇧V), **Split all tracks** (⇧S), speed presets 0.5–2×, **Freeze frame** (`F`). Tools: `split_all_tracks`, `close_gaps`, `cut_range`, `hold_frame`, `retime_clip`. Preview now honors speed/freeze/reverse.

**Graphics, overlays & social elements** (Motion Designer)
- ✅ Design → Graphics: 34 animated presets — social CTAs (Subscribe with bell, Like, Follow, Link in bio, Swipe up, Comment), countdowns/timers/count-ups, progress bars/story segments/percent ring, 6 lower-third styles, stickers & hand-drawn annotations. Shape motion engine (13 intros, 10 exits, 9 loops) for any shape. Tools: `add_graphic`, `add_lower_third`, `add_progress_bar`, `add_countdown`, `edit_graphic`, `animate_shape`. Preview == export (verify check 68).

**Sound made easy** (Audio Engineer)
- ✅ Royalty-free **music generator** (5 moods, bar-fitted to the video, rendered locally), procedural **SFX** + **auto-SFX**, **smart ducking** under speech, 🎬 **voice enhance** (export), **beat sync** for slideshows/text videos, **level meters**. Tools: `generate_music`, `add_sfx`, `auto_sfx`, `auto_duck`, `enhance_voice`, `beat_sync` (verify check 67).

**First-run ease & discoverability** (Product Manager)
- ✅ **⌘K command palette**, self-ticking **Getting started checklist**, **next-step chips** after each edit, **"What can I say?" prompt library** (66 ideas), ↑/↓ **recent prompts**, friendlier "didn't understand" with closest-match chips.

**Reliability, speed & trust** (CTO)
- ✅ Live **export progress** (% + ETA + phase) with real server-side **cancel**, export **pre-flight** checks, **autosave + crash recovery** (doc + media in IndexedDB) for the scratch editor, panel **error boundaries**, **.cadence.json project files** with media re-link, playback perf (idle panels skip frames). Verify check 69.

## 4. Photo → video (creation, not just editing)
- ✅ **Slideshow** (`make_slideshow`) — turn a group of photos into a video with Ken Burns moves + crossfades; add a look, go vertical, add captions/titles.

## 5. Quality / enhancement
- ✅ **Quality presets** (`set_quality`) — standard / high / ultra (up to 3840×2160 targets).
- 🎬 **Faithful upscale on export** — Lanczos scale + unsharp + hqdn3d denoise. **Never alters faces/identity/content** (contract-enforced; verified).
- ⛔ **AI super-resolution** — pluggable, off by default. Providers: **free** (no AI), **local Real-ESRGAN**, **hosted API** (metered), or **any CLI** you point it at (`ENHANCE_CLI_COMMAND`). All identity-preserving by contract.
- Honesty: the preview stays at source resolution; the real upscale happens at export.

## 6. Export
- 🎬 **Real `.mp4` export** (`@cadence/render-ffmpeg`) — edit-doc → ffmpeg filtergraph (cut+concat, looks, captions, titles, fades, slideshow xfade/Ken Burns, b-roll overlay, punch-in, music mix, quality). Streams a downloadable file.
- ✅ **Edit-doc JSON export** — the "open the code" escape hatch (always available).
- ✅ **Security** — export confines media paths to the uploads dir (realpath containment) and restricts ffmpeg to the `file` protocol (no arbitrary-file-read / SSRF).
- ffmpeg is **baked into the Docker image**, so export works in the container even where the host can't install it. On the host, set `FFMPEG_PATH` to any ffmpeg binary.

## 7. The app / UI (north-star design)
- ✅ **Multi-page app (App Router):** a polished **landing page** (`/`), **dev sign-in** (`/login`), an auth-gated **projects dashboard** (`/dashboard`, "New project"), the **scratch editor** (`/editor`, no account/persistence), the **project-bound editor** (`/project/[id]` — loads the latest edit-doc; **Save** appends a new version), and **account/org settings** (`/settings`, sign out). A shared top nav / account menu spans the authed pages.
- ✅ **Reusable `<Editor/>`** — one component powers both the scratch editor and the project-bound editor (optional `initialDoc`/`onSave`/`notice` props); no duplication.
- ✅ **Graceful without a database** — every DB-backed page/route degrades to a friendly "connect a database" / scratch-mode state (never a crash) when Postgres is down; `next build` and page loads stay green.
- ✅ Graded dark palette, **amber** action / **teal** selection, **Fraunces** italic for your words, **Space Grotesk** chrome.
- ✅ **Director conversation spine** + composer with suggestions.
- ✅ **One-tap QuickActions** (context-aware for video vs photos): Highlight, Remove filler, 9:16, Captions, Cinematic, Punch-in, B-roll, Kinetic title, Music, Fade, Auto-mix, Make 4K…
- ✅ **Preview stage** — play/scrub, live looks/motion/crossfades/captions, nudge.
- ✅ **Cuts timeline** — click a cut to jump; playhead.
- ✅ **`{ } code` drawer** — read the live edit-doc.
- ✅ **Rooms rail** — Media / Edit / Color / VFX / Audio / Deliver (Edit active; others are the Phase 2–3 roadmap).
- ✅ Accessible: keyboard-navigable, focus rings, reduced-motion aware, responsive.

## 8. Enterprise bones
- ✅ **Multi-tenant Postgres** (`@cadence/db`) — orgs → users → memberships → projects → media → edit-docs, with an **append-only version history**.
- ✅ **Tenant isolation + injection-safe** — every query is parameterized and scoped by `org_id`/`project_id` (verified).
- ✅ **Dev auth** (`DevAuthProvider`) — HMAC-signed, httpOnly/sameSite/secure cookies, constant-time compare; swappable for enterprise SSO. Sign-in **provisions a tenant** (`provisionAccount`: idempotent find-or-create user by email + a personal workspace org + `owner` membership). Auth-gated pages/routes derive tenant scope (`orgId`) from the session only — never from the client.
- 🔒 **`docker compose up`** — web + Postgres (api/worker as split-later placeholders); `/api/health` DB ping. (Needs Docker installed.)
- ✅ Config via env; `.env.example` committed, secrets gitignored.

## 9. The Director (AI brain)
- ✅ **Stub Director** — deterministic, offline, free (default). Detects intents from plain language and chains tools.
- ✅ **Self-correcting agentic loop** (`runDirectorLoop`) — PLAN→ACT (interpret) → VERIFY (schema-parse the doc + render probe frames through the injected `RenderEngine`) → CORRECT (capture the error, feed it forward, fall back to the last known-good / a minimal valid doc). Returns `{ result, verified, attempts, corrections }`. Engine-agnostic: it never imports a renderer, so it's the exact seam the real Claude Director self-corrects through. Covered by the verify gate (check 17) and a 5-prompt eval suite (`npm run evals`).
- ⛔ **Real Claude Director** (Anthropic API, metered) — planned drop-in behind the money gate; stub stays as fallback.

## 10. Engineering / quality gates
- ✅ **Verify gate** — `npm run typecheck` + `npm run verify` renders real frames and asserts (currently **17 checks**: trivial, highlight, edit tools, slideshow, titles/fades/looks, enhance providers, export plan, ffmpeg-graceful, DB builders, migrations, music, b-roll, kinetic, punch-in, whisper-parse, transcriber-factory, agentic-loop).
- ✅ **Eval suite** — `npm run evals` runs the agentic loop over 5 capability prompts, asserting each verifies, calls the right tools, and renders a proof frame (`.cadence/`).
- ✅ **End-to-end browser test** — `npm run test:e2e` (Playwright, headless Chromium) drives the REAL running app: it authors a real `.webm` in-browser (canvas → `MediaRecorder`) plus PNG photos, uploads them through the actual file input, runs the full video flow (highlight · vertical+captions · cinematic · fade · punch-in · 4K), the rooms rail, the Audio mute toggle, the photo→slideshow flow, and the graceful ffmpeg-missing export (message + JSON fallback) — asserting the edit-doc and AppliedStatus after each step, with a screenshot per step to `test-artifacts/`. CI: `npm run test:e2e:install` (Chromium) then `npm run test:e2e` (boots its own dev server when none is running).
- ✅ Pinned dependencies + committed lockfile; small verified commits; `TASKS.md` + `CHANGELOG.md` trail.

---

### How to run
```bash
npm install
npm run typecheck   # types across all packages
npm run verify      # renders real frames + asserts (writes to .cadence/)
npm run dev --workspace @cadence/web   # the editor at http://localhost:3000
```
Real `.mp4` export + Postgres: `docker compose up` (ffmpeg is in the image). See `README.md` / `ARCHITECTURE.md`.

### Deploy
- **Vercel:** set Root Directory to `apps/web`, add `SESSION_SECRET` (+ `DATABASE_URL` for persistence). Full steps + env-var table in `DEPLOY.md`. (ffmpeg export is Docker-only; it degrades gracefully on serverless.)
- **Database:** Neon Postgres — paste the URL into `.env`, run `npm -w @cadence/db run migrate`, confirm `GET /api/health` → `db:true`.
