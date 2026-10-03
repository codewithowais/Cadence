# Cadence — Competitive Gap Analysis, Cycle J

> **Author:** CTO / principal PM advisor. **Advisory only — no source code changed.**
> **Date:** 2026-10-03. **Baseline:** `master @ 7669591` (Cycle I merged: 75-feature catalog).
> **Method:** Cadence column is read from the code (`packages/core/src/schema.ts`, `packages/director/src/tools.ts`,
> `apps/web/src/components/*`, `apps/web/src/app/api/*`), not from marketing docs. Competitor column is from live web
> search (Oct 2026) plus stable product knowledge; where I rely on memory rather than a fetched page I say "(memory)".
> Competitor features move monthly; treat cells as "as of this date, verify before quoting externally".

## 0. Scope: what is deliberately NOT in this doc

Seven lanes are building right now, so these are excluded from the backlog even where they are real gaps:
timeline polish + drag-drop; scene-split of finished videos; on-canvas position/transform; custom aspect ratio;
full emoji library; prompt-to-video studio; export/engine debt (keyframe export for x/y/rotation/opacity, karaoke
captions on export, LUT, adjustment layers, speed-ramp UI, RTL fonts).

Already designed but not built (do not re-spec, just schedule): **AI background removal** — see
`docs/BACKGROUND-REMOVAL-AND-MORE.md` (matting provider seam). It appears here as backlog item #1 only because it
is the single highest-value unshipped item and nobody owns it.

## 1. Competitor snapshot (what moved in 2026)

Sources at the bottom. Highlights that change the calculus for Cadence:

- **CapCut** (desktop + web): Free/Pro restructure (Pro $19.99/mo); auto-captions in 20+ languages with auto-translate;
  generative effects from a text prompt on top of a 50k+ effect library; in-app video generation (Seedance); desktop
  has multi-track, keyframes, chroma key, stabilization. Web is "basic edits + templates".
- **Premiere Pro 26 / Premiere (mobile):** AI Object Mask (click a subject, auto-tracked mask), Generative Extend now
  up to 4K / any aspect, media-intelligence search across audio+visual. **Premiere Rush is retired 2026-09-30**
  (replaced by Premiere mobile / Pro) — the "simple Adobe editor" slot is vacant.
- **After Effects 26.x:** native 3D parametric meshes, SVG-to-shape-layer, variable-font animation, Unmult.
- **DaVinci Resolve 21:** new Photo page, IntelliSearch (content search), CineFocus (post-hoc focus), face refinement.
- **Descript (Underlord):** conversational multi-step editing, model picker (incl. Claude), filler removal and B-roll
  placement accuracy up sharply; Studio Sound; text-based editing (Cadence has the Words room equivalent).
- **Clipchamp:** free tier bundles auto-compose, background removal, auto-captions, voiceovers in 80+ languages,
  screen/camera recording. **VEED:** auto-subtitles + translation, AI avatars, voice dubbing, eye-contact correction.
- **Canva Video:** brand kits (shared, template-locked, approval flows on Business), 10k+ video templates, captions in
  many languages incl. Arabic. **InVideo AI:** prompt-to-video with stock library and templates.
- **Opus Clip:** one long video to N vertical shorts with virality scoring and auto-reframe.
- **Runway (Aleph):** in-context video-to-video editing (relight, swap objects, change camera) — the generative frontier;
  not something Cadence's "faithful, never redraw" rule (see `docs/BACKGROUND-REMOVAL-AND-MORE.md` A.1) should chase.

## 2. Feature matrix

Legend: ● full · ◐ partial/limited/paid-tier · ○ absent. "Cadence" cells cite code. Competitor columns are coarse
(product-level), so a ● means "a mainstream user finds this in the product", not "feature-for-feature equal".
Abbreviations: Cnv Canva, CC CapCut, PrP Premiere Pro (Rush retired), AE After Effects, Rsv Resolve, Dsc Descript,
Clp Clipchamp, VEED, Rwy Runway, InV InVideo AI, Opus.

| Capability | Cnv | CC | PrP | AE | Rsv | Dsc | Clp | VEED | Rwy | InV | Opus | **Cadence today (evidence)** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Multi-track timeline, trims, keyframes | ◐ | ● | ● | ● | ● | ◐ | ◐ | ◐ | ◐ | ○ | ○ | ● `CutsStrip.tsx`, `trims.ts`; keyframes preview-only for x/y/rot/opacity on export (lane) |
| Text-based (transcript) editing | ○ | ◐ | ● | ○ | ● | ● | ○ | ◐ | ○ | ○ | ◐ | ● `edit_by_transcript`, Words room (`TranscriptRoom.tsx`) |
| Auto-captions | ● | ● | ● | ○ | ● | ● | ● | ● | ○ | ● | ● | ● local Whisper, `add_captions`; stub fallback when Whisper absent |
| Caption translation / multilingual | ● | ● | ◐ | ○ | ◐ | ● | ◐ | ● | ○ | ● | ◐ | ○ none (`language` is read from Whisper only, `whisper-transcriber.ts:245`) |
| Speaker diarization / labels | ○ | ○ | ◐ | ○ | ◐ | ● | ○ | ◐ | ○ | ○ | ◐ | ○ no speaker field in `transcript.ts` |
| Background removal (any footage) | ● | ● | ● | ● | ● | ◐ | ● | ● | ● | ◐ | ○ | ◐ chroma key only (`chroma_key`); AI matting designed, not built |
| Green screen / chroma key | ◐ | ● | ● | ● | ● | ○ | ◐ | ● | ◐ | ○ | ○ | ● `ChromaKey` in schema + export; canvas preview approximates |
| Masks (shape / feathered) | ○ | ● | ● | ● | ● | ○ | ○ | ◐ | ● | ○ | ○ | ◐ `add_mask` engine exists; UI is a pill in Advanced FX, no bezier/freehand, no tracking |
| Motion tracking (text/sticker follows object) | ○ | ● | ● | ● | ● | ○ | ○ | ○ | ◐ | ○ | ○ | ○ none |
| AI object mask + tracking | ○ | ◐ | ● | ◐ | ● | ○ | ○ | ○ | ● | ○ | ○ | ○ none |
| Stabilization | ○ | ● | ● | ● | ● | ○ | ○ | ○ | ○ | ○ | ○ | ◐ `stabilize` flag, export-only vidstab (`RoomPanel.tsx:1903`); no preview, no strength control |
| Audio noise reduction / voice enhance | ◐ | ● | ● | ○ | ● | ● | ◐ | ● | ○ | ◐ | ◐ | ◐ `clean_audio`/`enhance_voice` export-only (`schema.ts:1512`); no live preview |
| Auto-duck / loudness normalize | ○ | ◐ | ● | ○ | ● | ◐ | ◐ | ◐ | ○ | ◐ | ○ | ● `auto_duck`, `normalize_loudness` |
| Beat detection / beat-synced cuts | ○ | ● | ◐ | ○ | ◐ | ○ | ○ | ○ | ○ | ◐ | ○ | ◐ detect + split-at-beats (`beats.ts`); no "auto-cut clips to music" |
| Text-to-speech voice-over | ◐ | ● | ◐ | ○ | ○ | ● | ● | ● | ◐ | ● | ○ | ◐ seam only: `tts.ts`, default `none` (gated); mic recorder works |
| Voice cloning / AI dubbing | ○ | ◐ | ○ | ○ | ○ | ● | ○ | ● | ◐ | ◐ | ○ | ○ none |
| Stock media library (video/photo/music/SFX) | ● | ● | ◐ | ○ | ○ | ◐ | ● | ● | ○ | ● | ○ | ○ none; SFX are synthesized (`sound-synth.ts`) |
| Brand kit (logo, fonts, colors, locked templates) | ● | ◐ | ◐ | ○ | ○ | ◐ | ◐ | ● | ○ | ◐ | ● | ○ none (fonts are a bundled set, `fonts.ts`) |
| Templates (video) | ● | ● | ◐ | ◐ | ○ | ◐ | ● | ● | ○ | ● | ◐ | ◐ ~handful of starter docs (`dashboard/templates.ts`); no save-as-template, no gallery, no sharing |
| Screen / webcam recorder | ◐ | ● | ○ | ○ | ○ | ● | ● | ● | ○ | ○ | ○ | ◐ mic voice-over only (`VoiceOverRecorder.tsx`); no `getDisplayMedia` |
| Teleprompter | ○ | ● | ○ | ○ | ○ | ○ | ○ | ● | ○ | ○ | ○ | ○ none |
| Auto-reframe with subject tracking | ● | ● | ● | ○ | ● | ○ | ○ | ◐ | ○ | ○ | ● | ◐ centered reframe only; tracking is "money-gated" in docs but free local face detection is feasible |
| Long video to many shorts (virality ranking) | ○ | ◐ | ○ | ○ | ○ | ◐ | ○ | ◐ | ○ | ◐ | ● | ◐ `create_highlight` (single cut); batch-N-clips owned by scene-split lane in part |
| Generative extend / object removal / gen-fill | ◐ | ◐ | ● | ◐ | ◐ | ○ | ○ | ◐ | ● | ◐ | ○ | ○ by design (faithfulness rule) |
| AI avatars / eye contact | ○ | ◐ | ○ | ○ | ◐ | ◐ | ○ | ● | ◐ | ● | ○ | ○ none (paid-only in market) |
| Content search over media library | ○ | ○ | ● | ○ | ● | ● | ○ | ○ | ○ | ○ | ○ | ○ none; Media room is a thumbnail grid |
| Auto color match / AI grade | ○ | ◐ | ● | ○ | ● | ○ | ○ | ○ | ◐ | ○ | ○ | ◐ manual grade, curves, HSL, scopes, LUTs; no match-to-reference |
| Slow motion / frame interpolation | ○ | ● | ● | ● | ● | ○ | ○ | ○ | ◐ | ○ | ○ | ◐ speed + ramps; no optical-flow interpolation (output is choppy under 0.5x) |
| Audiogram / waveform visualizer overlays | ● | ◐ | ○ | ● | ○ | ● | ○ | ● | ○ | ○ | ◐ | ○ waveforms shown on timeline only (`waveform.ts`) |
| Real-time collaboration | ● | ◐ | ◐ | ○ | ● | ● | ◐ | ● | ◐ | ○ | ○ | ○ none; single-user doc, no presence |
| Review links / frame-accurate comments | ◐ | ○ | ● | ○ | ● | ● | ○ | ● | ○ | ○ | ○ | ○ none |
| Version history UI / restore | ◐ | ○ | ◐ | ○ | ● | ● | ○ | ◐ | ○ | ○ | ○ | ◐ `edit_doc_versions` table is append-only (`packages/db`), no UI to list/restore/branch |
| Publish / schedule to socials | ◐ | ● | ○ | ○ | ○ | ◐ | ◐ | ◐ | ○ | ◐ | ● | ○ none; export presets only (`export-presets.ts`) |
| Mobile app / touch editing | ● | ● | ● | ○ | ◐ | ○ | ○ | ◐ | ◐ | ● | ◐ | ○ desktop web only; no manifest/service worker |
| Proxy media / 4K smooth editing | n/a | ● | ● | ● | ● | n/a | n/a | n/a | n/a | n/a | n/a | ○ preview seeks the original file in a `<video>` (`Stage.tsx`) |
| Prompt/Director-driven editing | ◐ | ◐ | ◐ | ○ | ◐ | ● | ◐ | ◐ | ● | ● | ◐ | ● ~80 typed tools, stub or Claude; every action also has a manual control — Cadence's real moat |

Honest read: Cadence is **ahead of most web editors on edit depth + AI/manual parity + edits-as-code**, and **behind on
everything that is "content you don't have to make yourself"** (stock, templates, brand, TTS voices, bg removal,
translation) and on **distribution/collab** (publish, review links, multiplayer, mobile). A mass-market creator judges
the product in the first 10 minutes on exactly those gaps, not on roll/slip/slide trims.

## 3. Ranked backlog — 25 gaps outside the seven active lanes

Ranking = (user value x frequency of need) / effort, tie-broken by strategic fit (free/local first per `AGENTS.md`
money gate). Effort: S ≤ 3 dev-days, M ≈ 1–2 weeks, L ≥ 3 weeks. Gate: **FREE** = fully local/OSS, no account;
**FREE-KEY** = free third-party tier but needs a signup/API key (ask first); **PAID** = metered/paid (money-gate
format applies, free fallback stays default). "Local-feasible" = can ship and demo with zero cloud bill.

| # | Gap | Value | Effort | Gate | Local-feasible | Owner |
|---|---|---|---|---|---|---|
| 1 | AI background removal | Very high | M | FREE (local) / PAID (api) | Yes | Engine + Motion |
| 2 | Caption translation + multilingual captions | Very high | M | FREE (local) / PAID (DeepL) | Yes | Understanding eng |
| 3 | Brand Kit (logo, colors, fonts, caption/lower-third style, watermark, intro/outro) | High | M | FREE | Yes | PM + Web |
| 4 | Screen + webcam recorder | High | M | FREE | Yes | Web |
| 5 | Stock library (video/photo/music/SFX) | High | M | FREE-KEY | Partial | Web + PM |
| 6 | Subject/face-aware auto-reframe | High | M | FREE (MediaPipe) | Yes | Engine |
| 7 | Templates: save-as-template, gallery, org sharing | High | M | FREE | Yes | PM + Web |
| 8 | Multi-platform batch export + post metadata (title/desc/hashtags) | High | M | FREE (stub) / PAID (Claude) | Yes | Web + Director |
| 9 | Review links + frame-accurate comments | High | M | FREE | Yes | Backend + Web |
| 10 | Free local TTS voices (Piper / browser speech) | High | S–M | FREE | Yes | Audio |
| 11 | Motion tracking (attach text/stickers/masks to an object) | High | L | FREE (OpenCV.js) | Yes | Motion |
| 12 | Mask tools UI (bezier/freehand, feather, invert, keyframed) | Med-high | M | FREE | Yes | Motion |
| 13 | Mobile PWA + touch editing | High | L | FREE | Yes | Web/UX |
| 14 | Proxy media + render cache | High (4K) | L | FREE | Yes | CTO / Engine |
| 15 | Version history UI + named snapshots + restore | Medium | S–M | FREE | Yes | Backend + Web |
| 16 | Media search (transcript + visual) | Medium | M | FREE | Yes | Understanding |
| 17 | Auto-cut to music (beat-driven montage) | Medium | M | FREE | Yes | Audio + Director |
| 18 | AI B-roll suggestions from transcript | Medium | M | FREE-KEY (needs #5) | Partial | Director |
| 19 | Auto color match / one-click AI grade | Medium | M | FREE | Yes | Colorist/Engine |
| 20 | Publish + schedule (YouTube/TikTok/IG) | High | L | FREE-KEY (OAuth apps) | No | Backend |
| 21 | Audiogram / waveform visualizer overlays | Medium | S–M | FREE | Yes | Motion |
| 22 | Frame interpolation slow-mo | Medium | S–M | FREE (ffmpeg minterpolate) | Yes | Engine |
| 23 | Teleprompter | Medium | S | FREE | Yes | Web |
| 24 | Speaker diarization + SRT import | Medium | M | FREE (pyannote, HF token) | Yes | Understanding |
| 25 | Voice cloning / AI dubbing | Medium (high delight) | L | PAID | No | Audio + Backend |

Parked (not ranked; revisit after Cycle K): real-time multiplayer co-editing (CRDT over `EditDoc`, L, FREE but huge),
multicam sync/switching (L), generative extend / object removal / eye contact / avatars (PAID; conflicts with the
faithfulness rule or needs GPU vendors), 3D text (low demand for the mass market).

### Specs

**1. AI background removal.** User value: the most-requested "magic" in every competitor's free tier (Clipchamp, Canva,
CapCut, VEED all bundle it); today a user without a green screen cannot isolate a subject, so overlays, PiP and
text-behind-subject are impossible. Implement exactly as `docs/BACKGROUND-REMOVAL-AND-MORE.md` section A: a
`@cadence/matting` provider seam mirroring `@cadence/enhance` (`none` default / `cli` / `api`), plus a **free in-browser
provider** using MediaPipe selfie segmentation (Apache-2.0, WASM, no server) for people, and a CLI path for rembg /
Robust Video Matting. Matte plugs into the existing alpha-overlay path in `plan.ts` via one `alphamerge`. Must run the
`assertLocalMediaPath` guard before any CLI sees a path. Free: browser + local CLI. Paid only if a hosted matting API
is chosen. Acceptance: a person-on-desk clip gets a clean cutout over a solid/blurred/own-image background in preview
and in the exported mp4; verify check renders frame and asserts non-uniform alpha.

**2. Caption translation + multilingual captions.** User value: global reach is the number-one reason creators pay for
CapCut/VEED/Canva; Cadence has transcription but no translation, and Whisper's own `language` field is read but never
surfaced. Add `translate_captions(lang)` Director tool and a Words-room control. Free path: Whisper's built-in
"translate to English" task plus local MT (Argos Translate / NLLB-200 via CLI, behind a `TranslationProvider` seam
copying `tts.ts`: `none|cli|api`). Paid option: DeepL/Google behind the money gate. Captions become
`TextClip`s per language; keep one `EditDoc` per language variant (cheap, since docs are tiny) and add "export all
languages". Depends on the RTL-font export work in the export lane for Arabic/Urdu rendering; do not start Arabic
output before that lands. Acceptance: Urdu/Spanish caption track generated offline, timings preserved.

**3. Brand Kit.** User value: Canva's stickiest feature, and the thing that turns a one-off user into a team. Add an
org-level `BrandKit` row (logo asset, 3–6 colors, 2 fonts from the bundled set, default caption style, lower-third
style, watermark position/opacity, optional intro/outro clips) in `@cadence/db` (org_id scoped) and a Settings panel.
"Apply brand" is a Director tool (`apply_brand`) that restyles captions/titles/background and adds the watermark;
new projects inherit it. Free, local. The doc stays source of truth: applying a kit writes plain values into the
`EditDoc`, never references the kit at render time, so exports never depend on live org state.

**4. Screen + webcam recorder.** User value: tutorials, product demos and talking-head content are the biggest
creator segments; Clipchamp, Descript, VEED and CapCut all record in-app. Cadence has a cursor/callout engine for
screenshots (`build_demo`) but no capture. Use `getDisplayMedia` + `getUserMedia` + `MediaRecorder` in the browser,
write the Blob into the same media path as an upload (and the IndexedDB draft store), and offer layouts (screen only,
webcam bubble, side by side) via `apply_layout`. Record system audio where the browser allows it. Free. Edge case:
`MediaRecorder` webm has no seek index; remux via ffmpeg on first export or fix duration at ingest.

**5. Stock library.** User value: users without footage cannot make anything; this is what makes prompt-to-video
and templates feel complete. Integrate Pexels + Pixabay (video/photo) and Openverse/Freesound (CC audio) behind a
`StockProvider` seam; searched from the Media room, dragged like any media. **Money gate:** both APIs are free but need
an account/key — ask before signing up; ship the seam with a bundled tiny CC0 sample pack as the free fallback.
Attribution metadata is stored on the `MediaAsset` and shown on export when licence requires it. Server proxies the
search so keys never reach the client; add an allowlist + size limit on downloads (SSRF risk, see CTO review).

**6. Subject/face-aware auto-reframe.** User value: reframing 16:9 to 9:16 with the speaker kept in frame is the
core of Opus/CapCut/Canva shorts workflows; Cadence's centered reframe cuts off off-center speakers, and the docs mark
tracking as money-gated, which is unnecessarily pessimistic. MediaPipe face/pose detection runs free in the browser or
Node on sampled frames (2–4 fps), then smooth with a Kalman/EMA filter into a crop-path of keyframes on the existing
`x/y/scale` keyframe system. Because x/y keyframe export fidelity is being fixed by the export lane, build the
detector + path generation now and gate "applies on export" on that lane. Keep the "centered" result as the
fallback. Free.

**7. Templates: save, gallery, share.** User value: templates are how Canva/CapCut/InVideo win the mass market; Cadence
has starter docs but users cannot save their own or reuse a finished video's structure. Add "Save as template" which
strips media refs into typed slots (video slot, text slot, logo slot), a gallery in the dashboard, and org sharing.
Applying a template runs the Director's replace-media over slots. Because the doc is declarative this is cheap:
a template is an `EditDoc` plus a slot map. Free. A public marketplace is explicitly out of scope until moderation
and licensing exist (security/legal, not engineering).

**8. Multi-platform batch export + post metadata.** User value: "make it once, ship to TikTok, Reels, Shorts, YouTube"
is the real job; today the user re-runs reframe + export per platform. Compose the existing `set_platform` +
`reframe` + export presets into a batch job producing N files with one click, using the export queue (see CTO review
section 6 — do not ship before the queue exists or one batch OOMs a 512 MB instance). Add generated title,
description and hashtags per platform (stub Director produces rule-based text; Claude when the key gate is open).
Output a zip + a metadata sheet. Free with stub.

**9. Review links + frame-accurate comments.** User value: agencies/teams need approvals; Descript/Frame.io/Resolve
lead here and Cadence has orgs but no sharing. Add a signed, expiring, view-only review URL (`/review/[token]`) that
renders from a proxy mp4 (export at 540p), with time-coded comments stored in Postgres (org-scoped, plus token-scoped
anonymous commenter name). A comment can carry a Director request ("fix this") that the owner applies with one click.
Free. This is the cheapest credible "collaboration" step before CRDT multiplayer and does not need websockets.

**10. Free local TTS voices.** User value: voice-over from text is table stakes for faceless/text videos (and the
prompt-to-video lane needs it); `tts.ts` is a seam with a default of `none`, so the feature is effectively absent.
Ship two free providers: (a) browser `speechSynthesis` for instant preview/draft, and (b) **Piper** (MIT, ONNX, CPU) via
the existing `cli` provider for rendered, exportable audio with 20+ languages. Record to a WAV the same way
`generate_voiceover` already expects. Keep paid (ElevenLabs etc.) as gated `api`. Note: browser speech cannot be
captured into the export, so only Piper output is "real".

**11. Motion tracking.** User value: tracked titles, stickers, blur-on-face and "arrow follows the car" are the big
CapCut/AE/Premiere pro-feel features; the Motion Designer lane has text and shape animation but no tracking. Use
OpenCV.js (BSD, WASM; CSRT/KCF tracker) in a Web Worker on a user-drawn box; output is a keyframe track on x/y/scale
(and optionally rotation) on the target clip, so tracking is just a generator of the existing keyframes (edits-as-code
preserved). Hard dependency: export keyframe fidelity (export lane). Effort L because of UX (draw box, scrub, retry,
drift correction) more than the algorithm. Free.

**12. Mask tools UI.** User value: masks power reveals, spotlight, blur-region, vignette; `add_mask` exists in the engine
(`mask?: Mask` on clips, `maskGeqFilter` in `plan.ts`) but the manual UI is a single pill. Add on-canvas
shape/bezier/freehand masks, feather, invert, mask keyframes, and an "apply to adjustment layer" shortcut. Depends on
the on-canvas transform lane for handle infrastructure — coordinate, do not duplicate gizmos. Free.

**13. Mobile PWA + touch editing.** User value: creators are on phones; CapCut, Canva, InVideo all lead with mobile.
No manifest, no service worker, and the timeline (`CutsStrip.tsx`) is mouse-pointer-centric. Phase 1: installable PWA
(manifest, offline shell, share-target for "send video to Cadence"), a phone layout that collapses to Preview + Director
+ a simplified single-track strip. Phase 2: pinch zoom, long-press drag, bottom-sheet rooms. Free. Do after the
timeline lane lands to avoid touching the same file; this is the main reason to do the CutsStrip split first
(CTO review section 1).

**14. Proxy media + render cache.** User value: 4K and long clips stutter or crash tabs; the preview seeks the original
file in `<video>` elements (`Stage.tsx:283`). Generate a 540p/720p all-intra (or high-keyint) H.264 proxy on ingest in a
worker (ffmpeg.wasm client-side, or the server queue), play proxies in preview, use originals on export; cache rendered
overlay frames (text/shape) keyed by content hash so scrubbing is cheap. Free. See CTO review section 3 for budgets.

**15. Version history UI.** User value: trust and undo-beyond-session; the DB already stores every save append-only
(`edit_doc_versions`), but users cannot see or restore them. Add a History drawer (list, diff summary by tool-call
summary, preview a version, restore as new head, name a snapshot) and "branch from here" (copy to a new project).
Edits-as-code makes the diff readable (JSON patch summarized in words). Free. Quick win that exposes an already-paid-for
architecture advantage.

**16. Media search.** User value: Premiere/Resolve/Descript all now search footage by content (Resolve IntelliSearch,
Premiere media intelligence); Cadence's Media room is a grid. Index Whisper transcripts (full-text, trivial) and add
visual search with a small local CLIP/SigLIP ONNX model on sampled frames (embeddings in Postgres pgvector or IndexedDB
for scratch mode). Search box in Media room + Director ("find where I talk about pricing and put it first"). Free;
visual part adds ~100 MB model download, make it opt-in.

**17. Auto-cut to music.** User value: beat-synced montages are CapCut's viral template format; Cadence has beat
detection and split-at-beats (`beats.ts`) but the user must supply cuts. Add `montage_to_music`: given N clips and a
track, choose cut points on strong beats / downbeats, fit each clip's best segment (reuse highlight scoring), apply
transitions on beats, and emit a normal editable `EditDoc`. Free; pure engine + Director.

**18. AI B-roll suggestions.** User value: Descript's flagship; turns a talking head into a produced video. Match
transcript noun phrases/topics to stock search (#5) or the user's own media (#16), propose inserts as ghost clips the
user accepts/rejects (the "visible, editable result with nudge" rule). Stub Director uses keyword extraction (free);
Claude improves topic extraction (PAID gate, stub stays default). Depends on #5/#16.

**19. Auto color match / AI grade.** User value: matching shots and one-click "fix my footage" is where Resolve/Premiere
lean on AI; Cadence has curves/HSL/scopes/LUTs but no automatic step. Implement histogram + mean/variance matching in
Lab space against a reference frame (classic Reinhard transfer) and an auto white-balance/exposure normalize, emitted as
ordinary `adjust_color` / curves values (editable, faithful). Free; pure TS using the scopes sampling already in
`RoomPanel.tsx` (Scopes, line ~684).

**20. Publish + schedule.** User value: closes the loop (CapCut, Opus, Clipchamp). OAuth integrations to YouTube Data
API (resumable upload), TikTok Content Posting API, Instagram Graph API; scheduling via a job queue. **Money/compliance
gate:** API access is free but TikTok/Meta require app review and verified business accounts; YouTube unverified apps
upload as private. Build YouTube first (lowest friction). Needs real auth (the current dev auth must be replaced first,
see CTO review section 7) and token storage encrypted per org. L, backend-heavy.

**21. Audiogram / waveform visualizers.** User value: podcasters and musicians post audio as video; Canva/Descript/VEED
all offer it. Add a synthetic layer kind drawn by the shared `@cadence/core/draw` module (bars/line/circle reacting to
audio energy), computed from the same peaks `waveform.ts` already extracts, rendered identically in preview and export
via the existing raw-RGBA-to-ffmpeg path. Free.

**22. Frame-interpolation slow motion.** User value: slow-mo looks choppy below 0.5x without it; CapCut/Premiere/Resolve
interpolate. Export: ffmpeg `minterpolate` (mci) per clip with `speed < 0.5` behind a quality toggle (slow, CPU heavy;
queue-only). Preview keeps the simple stretch with an honest badge. Free.

**23. Teleprompter.** User value: pairs with the recorder (#4); creators reading scripts is a main use of VEED/CapCut.
A scrolling script overlay with speed/mirror/size, hidden from the recording; the script can come from the Director
(stub-written script from a prompt) and later feeds captions as a known-text alignment. Free, S.

**24. Speaker diarization + SRT import.** User value: podcasts/interviews need "Speaker 1/2" labels, per-speaker caption
colors and "cut Speaker 2"; Descript/Opus have it. Add `speaker?` to words/segments in `transcript.ts`, populate with
pyannote (needs a free Hugging Face token and model-licence acceptance, so flag as FREE-KEY) or a lightweight
energy/embedding clustering fallback; import `.srt/.vtt` (export exists in `lib/srt.ts`) so users can bring their own
captions. Free.

**25. Voice cloning / AI dubbing.** User value: high delight (VEED, Descript) and the logical end of #2 + #10, but
consent, misuse and cost make it a gated, late item. Provider seam like TTS; require an explicit consent attestation
recorded per voice, watermark/metadata on output, no cloning of voices not uploaded by the same org. PAID
(ElevenLabs/HeyGen-class API). Do not start until auth, rate limiting and abuse controls from the CTO review exist.

## 4. Suggested cycle sequencing

- **Cycle J (now, parallel to the 7 lanes):** #1 matting (browser provider first), #10 Piper TTS, #15 version history,
  #3 brand kit, #4 recorder. All independent of the in-flight lanes and mostly in new files.
- **Cycle K:** #2 translation (after RTL fonts land), #7 templates, #8 batch export (after the queue exists), #6
  reframe tracking (after keyframe export), #9 review links.
- **Cycle L:** #14 proxies, #13 mobile PWA (after CutsStrip split), #11 tracking, #12 mask UI, #5 stock (needs key decision).
- **Later / gated:** #20 publishing (after real auth), #25 dubbing, parked items.

## Sources

- CapCut: https://www.capcut.com/tools/desktop-ai-power · https://bigvu.tv/blog/capcut-desktop-review-2026-features-pricing-smart-alternatives/ · https://marcandrews.com/capcut-ai-features-review-2026-which-ones-are-worth-it/
- Descript / Opus / Resolve / Premiere roundups: https://www.letscompareai.com/post/descript-underlord-update-faster-ai-video-editing-for-creators-in-2026 · https://davinciresolve21.com/blog/whats-new-21 · https://www.blackmagicdesign.com/products/davinciresolve/whatsnew
- Adobe: https://helpx.adobe.com/premiere-rush/kb/end-of-life.html · https://helpx.adobe.com/premiere/desktop/whats-new/whats-new.html · https://digitalproduction.com/2026/01/23/adobe-after-effects-2026-lands-with-3d-text-and-performance-boosts/
- Canva / Clipchamp / VEED / InVideo: https://www.canva.com/features/auto-caption/ · https://www.ngram.com/blog/canva-video-vs-veed · https://blog.lunabloomai.com/easy-video-maker/
- Runway Aleph: https://runwayaleph.com/
