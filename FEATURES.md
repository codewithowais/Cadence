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
- ✅ **Transcription** via a `Transcriber` interface — deterministic **StubTranscriber** now (offline, free). 🔒 **Local Whisper** drop-in planned.

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
- ⛔ **Real Claude Director** (Anthropic API, metered) — planned drop-in behind the money gate; stub stays as fallback.

## 10. Engineering / quality gates
- ✅ **Verify gate** — `npm run typecheck` + `npm run verify` renders real frames and asserts (currently **14 checks**: trivial, highlight, edit tools, slideshow, titles/fades/looks, enhance providers, export plan, ffmpeg-graceful, DB builders, migrations, music, b-roll, kinetic, punch-in).
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
