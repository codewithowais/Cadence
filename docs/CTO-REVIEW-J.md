# Cadence — CTO Review, Cycle J

> **Author:** CTO advisor. **Read-only review; no code changed.** Baseline `master @ 7669591`, 2026-10-03.
> Every claim cites a file/line read in this worktree. Performance numbers marked *(estimate)* are reasoned from the
> code and browser/codec behavior, **not measured** — the first 30-day task is to measure them.
> Companion: `docs/COMPETITIVE-GAP-J.md`. Prior reliability work (autosave, export progress, error boundary) in
> `docs/agents/cto.md` is credited, not repeated.

## Executive summary (candid)

The engine side is genuinely good: a Zod-validated declarative `EditDoc`, pure Director ops, a shared canvas draw module
so preview == export, a verify gate that renders real frames. That is the hard part and it is working. The risks are
elsewhere:

1. **Security is not production-shaped, and `render.yaml` deploys it publicly.** Sign-in accepts any email with no
   credential (`apps/web/src/app/api/auth/login/route.ts:20`); five compute-heavy API routes have no session check, no
   rate limit and no size caps. Anyone on the internet can take over any workspace by email, or fill the disk / burn CPU.
2. **The UI layer is a three-file monolith** whose bulk makes every future lane a merge-conflict. Seven agents in
   parallel is already the stress test: `Editor.tsx` is one 1,930-line function, `CutsStrip` one 1,310-line function.
3. **Playback re-renders the whole editor tree 60x/s** (`Editor.tsx:205,393`); the `withStableHandlers` band-aid does not
   cover the two heaviest consumers (`RoomPanel`, `CutsStrip`).
4. **Export is a single in-process slot** (`lib/export-slots.ts`): no persisted jobs, no worker, no limits on
   resolution/duration, tab-close kills the render. Fine for a demo, not for a launch.
5. **Observability and CI do not exist** (no `.github/`, no structured logging, `/api/health` is a DB ping) despite
   `AGENTS.md` section 7 requiring them.

Tests are the strong point (unit 162, verify 70, evals 6, e2e 41 per CHANGELOG S6.1), but nothing gates merges, so they
only protect the work if a human runs them.

---

## 1. The three god components and a safe refactor plan

### 1.1 What is actually in them

| File | Lines | Shape (verified) |
|---|---|---|
| `apps/web/src/components/CutsStrip.tsx` | 3,422 | `export function CutsStrip` spans **543–1854** (~1,310 lines) with 28 `useState`, 20 `useRef`, 16 `useCallback`, 10 `useMemo`. Below it, already-top-level components: `TransitionPopover` 1854, `TrackHeader` 2129, `ClipInspector` 2327, `SpeedRampEditor` 2655, `KeyframeEditor` 2974, `SelectionBar` 3246. Above it: a `DragState` state machine (375) and ~250 lines of pure helpers (`trimEligibility` 249, `clipFitsTrack` 225, `animatableProps` 506). |
| `apps/web/src/components/RoomPanel.tsx` | 2,702 | `RoomPanel` itself is only 215–403 (a router). The bulk is already separate functions in the same file: `DesignRoom` 858, `LooksGallery` 1059, `GradeControls` 1173, `LutControls` 1290, `DeliverRoom` 1552, `AdvancedFx` 1810, `TextStylesGallery` 2048, `AudioRoom` 2163, `MediaGrid` 2509, `TrackPanel` 2618, plus `CurveEditor`/`Scopes` 587–836. Props interface is ~35 handlers (77–140); **0** `useCallback`/`useMemo`. |
| `apps/web/src/components/Editor.tsx` | 2,118 | `export function Editor` spans **185–2118** (~1,930 lines): 33 `useState`, 18 `useEffect`, 11 `useRef`, 15 `useMemo` in one closure. It owns doc history, media `files`/`urls`, transcripts, playback clock, the Director chat, export, autosave wiring, undo toast, rooms, keyboard shortcuts, and passes ~35 props down. Only 2 `useCallback`; handlers are inline closures, which is why `withStableHandlers` (`lib/stable-memo.tsx`) exists. |

Also over 1k lines: `packages/director/src/edits.ts` 2,734; `tools.ts` 2,095; `packages/render-ffmpeg/src/plan.ts`
1,960 (one filtergraph builder); `packages/core/src/draw.ts` 1,634; `stub-director.ts` 1,603; `TextRoom.tsx` 1,109.
Those are cohesive-ish "registry" files and lower priority; the three UI files are the merge-conflict magnets.

### 1.2 Why it matters now

- Parallel agents/devs touching the same file is the dominant cost: this cycle alone has the timeline lane, the
  on-canvas-transform lane and the export lane all wanting `CutsStrip`/`Editor`.
- Perf: because `RoomPanel` is unmemoized and receives `timeSec` (`RoomPanel.tsx:100`, passed at `Editor.tsx:1922`), a
  2.7k-line module re-evaluates at display rate during playback even when the visible room (say Audio) ignores time.
  `CutsStrip` (`Editor.tsx:2000`) and `Stage` (`:1969`) legitimately need time, but the 3.4k-line `CutsStrip` body
  re-running 60x/s with 28 state hooks is far heavier than it needs to be.
- Review/AI-agent effectiveness: a 3.4k-line file exceeds what a reviewer or agent can hold, so regressions slip through.

### 1.3 Safe refactor plan (behavior-preserving; each step ships alone behind the existing gates)

Rule: **move code, don't rewrite it.** Each step is a pure extract with identical JSX/logic, gated by
`typecheck` (root+web), `test:unit`, `verify`, `next build`, and the 41-spec Playwright suite (the real safety net,
because there are no component-level tests). One PR per step, merged only when no other lane has the file open
(announce a freeze window per file; this is the practical constraint with parallel agents).

**Step 0 (S, do first, zero risk): file moves of already-separate functions.**
- `CutsStrip.tsx` -> `components/timeline/{TransitionPopover,TrackHeader,ClipInspector,SpeedRampEditor,KeyframeEditor,SelectionBar,AttributeClipboard,CraftStatusRow,WaveformStrip}.tsx` and `timeline/helpers.ts` (the pure functions: `trimEligibility`, `clipFitsTrack`, `isSequentialOn`, `animatableProps`, `baseValue`, `describeRamp`, `fmtKfValue`, `TRANSITIONS`). Shared types (`TimelineEdit`, `DragState`, `TrackFlag`, `TrimMode`) go to `timeline/types.ts`. `CutsStrip.tsx` shrinks to ~1.4k lines with unchanged exports (re-export from the old path so importers don't change).
- `RoomPanel.tsx` -> `components/rooms/{Design,Deliver,Audio,Media,Tracks}Room.tsx` + `rooms/design/{Looks,Grade,Lut,Adjustment,Backgrounds,Shapes,AdvancedFx,TextStyles}.tsx` + `rooms/controls/{Row,Pill,FxSlider,GradeSlider,CurveEditor,Scopes}.tsx`. `RoomPanel` remains the ~190-line router. This is a pure move: all of these are already top-level functions taking explicit props.
- Add a lint rule (`max-lines: 600` warn) so it cannot regrow.

**Step 1 (M): isolate the playback clock (also the biggest perf win — see section 3).**
Replace `const [timeSec, setTimeSec] = useState(0)` (`Editor.tsx:205`) with a tiny external store
(`lib/playhead.ts`: `getTime()`, `setTime()`, `subscribe()`), consumed by `useSyncExternalStore` only in the
components that must paint it (`Stage`, the `CutsStrip` playhead element, the transport time label). Everything else
reads `getTime()` lazily on click (e.g. the Deliver thumbnail grab). The Editor no longer re-renders on frames.

**Step 2 (M): extract Editor concerns into hooks, not components.** Candidates in order of independence:
`useMediaLibrary` (files/urls/probing/transcripts: `probeVideo/Image/Audio` 140–168, `filesRef/urlsRef` 258), `useExport`
(export state, preflight, progress, the `beforeunload` guard), `usePlayback` (rAF loop 386–400, mute, shuttle),
`useDirector` (messages, busy, undo toast), `useEditorShortcuts`. Each hook takes/returns plain values; `Editor` becomes
orchestration + layout (target < 600 lines). Verify by e2e only; do not change behavior.

**Step 3 (M-L): split the `CutsStrip` function.** Extract in this order, each with an explicit prop surface:
(a) `useTimelineViewport` (zoom, scroll, follow, fit), (b) `useTimelineDrag` (the `DragState` machine, 375–403, with pointer
handlers), (c) `<TrackLane>` + `<ClipBlock>` (the per-clip render, memoized by `clip` identity + selected + zoom),
(d) `<Ruler>`/`<Playhead>`/`<MarkerLayer>`. `useReducer` for the drag/trim machine makes it unit-testable (see section 9).
**Coordinate with the timeline+drag-drop lane: do this step *after* that lane merges, or let that lane's owner do it.**

**Step 4 (S): context for the 35 handlers.** Replace the RoomPanel prop-drilling with an `EditorActions` context
(`useEditorActions()`), so rooms stop requiring a 35-prop interface and `withStableHandlers` can be retired.

Do **not**: introduce a state library mid-refactor, convert to a different component model, or "clean up" markup while
moving. The one acceptable behavior change is Step 1, which is guarded by the existing playback e2e tests.

---

## 2. State management and undo model

**Today:** `useDocHistory` (`lib/history.ts`) is a snapshot stack: `past[]`, `present`, `future[]`, `LIMIT = 100`,
`COALESCE_MS = 600`, with a no-op guard that deep-compares via `JSON.stringify` (`history.ts:~38`). Every mutation must
go through `commit`. `reset` clears history when new media loads. It is well written (pure updaters, StrictMode-safe).

**What is good:** because the `EditDoc` is the whole truth, snapshot undo is correct by construction; markers now live
in `doc.markers`; the Director and manual controls share the one commit path.

**Problems, in priority order:**
1. **Undo is cleared when you add media** (`reset` — `history.ts` header comment, used on new-media load). A user who
   adds one clip loses all undo for the session. Cheap fix: keep history and treat media registration as an undoable
   doc change (the doc references `MediaAsset` by id; leave unreferenced assets in `doc.media`, prune at export, which the
   preflight already does).
2. **Cost of `JSON.stringify` equality on every commit**, including slider drags at 60 Hz. Fine for 20 KB docs; text-videos
   with many scenes + keyframes + captions can reach hundreds of KB *(estimate)*, i.e. several ms per event. Replace with
   structural-sharing ops (ops already return new objects only where changed — verify in `edits.ts`) and `===` per
   top-level slice, or hash after coalescing; measure with a 500-clip doc first.
3. **Memory:** 100 snapshots x doc size. If ops deep-clone (check `structuredClone`/spread-all patterns in
   `packages/director/src/edits.ts`), 100 x 300 KB = 30 MB, acceptable. If they share structure it is far less. Add a
   byte budget (evict oldest past ~20 MB) rather than a count.
4. **Not undoable / not in the doc:** selection, timeline zoom, track UI state, transcripts, `files` map. That is the
   right call for UI state, but transcripts edits (Words room) go through doc commits only when they change clips — confirm
   a "restore transcript" path isn't needed.
5. **Autosave and undo interplay:** autosave debounces at 800 ms (`use-autosave.ts`) the *present* doc; after a crash the
   restored draft has an empty undo stack. Acceptable; document it.
6. **Multi-user future:** snapshots do not merge. When multiplayer is on the roadmap, move to an operation log
   (each Director tool call / manual op is already a typed op with parameters, `tools.ts` — an excellent seed). Do not
   build CRDT now; do keep every mutation an explicit named op so the log is derivable. Server side, DB versions are
   append-only per save, so "save" is already a coarse oplog.

Recommendation: keep the model; fix #1 this month, measure #2/#3, and avoid adding any state outside `commit`.

---

## 3. Preview performance budget (memory, frames/s, many tracks, 4K)

### 3.1 How preview works (verified)
`Stage.tsx` renders the primary clip in a single `<video>` that is seeked via `currentTime` (`Stage.tsx:201–224`),
b-roll/PiP in extra `<video>` elements (`:51–76`), each audio clip in a hidden always-mounted `<audio>` (`:80–134`,
"always-present hidden `<audio>` elements", `:172`), and synthetic layers (text/solid/shapes) on a `<canvas>` via
`@cadence/core/draw`. The playhead is React state ticked in a rAF loop (`Editor.tsx:386–400`).

### 3.2 Proposed budgets (targets to measure against; owner: CTO + Senior Video Editor)

| Metric | Budget | Why / current risk |
|---|---|---|
| Sustained playback | **>= 30 fps** at 1080p with <= 4 simultaneous visual layers; scrub response < 100 ms | One main `<video>` + b-roll `<video>`s; the risk is React, not decode |
| Main-thread work per frame during playback | **<= 6 ms JS** (leaves headroom for 16.6 ms) | Today the full Editor tree re-renders per frame: CTO doc measured 60 commits/s and ~19 fps at 4x CPU throttle in dev (`docs/agents/cto.md` R6). `withStableHandlers` fixed the small panels; `RoomPanel`/`CutsStrip`/`Stage` still re-render |
| Playhead update path | **0 React renders/frame outside Stage + playhead element** | Section 1.3 Step 1 |
| Concurrent hardware video decoders | **<= 3 at 4K, <= 6 at 1080p** | Browsers cap HW decoders (platform-dependent, often 8–16 total across tabs); each decoder pins several frames (a 4K RGBA frame is ~33 MB, 3840x2160x4) *(estimate: ~250–400 MB resident per 4K decoder)* |
| Tab heap during a 10-min 1080p project | **< 1 GB**; 4K < 2 GB | Media are in-memory `File` objects in `files` state (`Editor.tsx:193`) plus object URLs; IndexedDB duplicates them (below) |
| Audio elements | **<= 8 live `<audio>`; otherwise pool by active window** | One element per audio clip is O(clips); `auto_sfx` / `add_sfx` can create dozens |
| Time to first frame after open | **< 2 s** for a 100 MB source | Needs poster/proxy |
| Autosave write | **< 50 ms main-thread** | Media are written once (`mediaToPersist`), doc debounced 800 ms — fine |

### 3.3 Known gaps vs the budget
- **No proxy media.** Preview plays the original file. 4K H.264/HEVC with long-GOP seeks slowly and thrashes memory;
  CapCut/Premiere/Resolve all use proxies. Gap J #14 in the competitive doc. Until it exists, show a "large file —
  Optimize for editing" prompt above ~1080p / > 200 MB and, on Safari/Firefox, check HEVC.
- **Many tracks:** the compositing in preview is DOM `<video>` layering plus one canvas. 6+ simultaneous visual video
  layers means 6 decoders: the budget above will be exceeded. Either cap simultaneous video layers in preview (freeze
  hidden/low-opacity ones to a poster frame) or move to WebCodecs decode into one canvas (the original Omniclip plan).
  Document the cap; the export path has no such limit.
- **Waveform extraction** (`lib/waveform.ts`, `beats.ts`) decodes whole files with Web Audio on the main thread; a 1-hour
  file allocates hundreds of MB of PCM. Move to a worker, process in chunks, cache peaks in IndexedDB.
- **Canvas size:** `Meta.width/height/fps` are only `.positive().int()` (`schema.ts:313,1431–1432`) with no maximum.
  A doc or a typo can request an 8K+ canvas in preview or `/api/render` (see security). Add schema maxima
  (e.g. 7680x4320, fps <= 120, duration <= configurable).

Measurement plan (30-day): a Playwright perf spec using `page.tracing` + `PerformanceObserver` long-task entries,
running 1080p/4K/6-layer fixtures at 1x and 4x CPU throttle, and a heap snapshot at t=0 and after 5 minutes. Fail CI on
regressions > 20%.

---

## 4. IndexedDB media lifecycle

Verified in `lib/media-store.ts`, `lib/autosave.ts`, `lib/use-autosave.ts`: database `cadence-autosave` v1, stores
`drafts` (doc + registry + transcripts) and `media` (the `File` itself, once, indexed by `draftKey`); all calls
fail-soft; `mediaToPersist`/`mediaToPrune` diff writes and deletes.

Strengths: fail-soft design, write-once media, corrupt-draft handling, tested pure planners (`tests/reliability.test.ts`).

Gaps and recommendations:
1. **Quota is unmanaged.** No `navigator.storage.estimate()` check before storing a 2 GB video, no
   `navigator.storage.persist()` request, so Safari (7-day ITP eviction for script-writable storage) and low-disk devices
   can silently drop a draft. Add: estimate before write, request persistence after first successful autosave,
   surface "X MB / Y MB used" and a clear "too big to keep, re-add on restore" state (partially exists on restore).
2. **Whole files in memory and IDB.** Each media exists as a `File` in React state, an object URL, and an IDB copy. Prefer
   storing `FileSystemFileHandle` where available (Chromium) for zero-copy references, with the IDB copy as fallback.
3. **Single draft key / no per-project namespace?** Scratch editor uses one draft key; the DB-bound project editor
   (`/project/[id]`) saves to Postgres but its media are not persisted server-side at all (scratch media stay in the
   browser; `/api/upload` is only for export). So a project reopened on another device has a doc with no media — the
   "relink" flow exists (`project-file.ts`) but this is the biggest product hole in the project model. **Decision needed:**
   projects need server (object-storage) media with content-addressed keys, otherwise "projects" are just documents.
4. **No GC for abandoned drafts.** `deleteDraft` exists, but nothing expires drafts of closed sessions. Add a TTL sweep on
   app start (e.g. 30 days) and show usage in Settings.
5. **Schema migration:** `DB_VERSION = 1` with `onupgradeneeded` creating stores only; plan the v2 path now (proxy blobs,
   thumbnails, peaks cache) so an upgrade doesn't drop media.
6. **Cross-tab:** `onversionchange` closes the DB (good); two tabs editing the same draft key will clobber each other.
   Use a `BroadcastChannel` + per-tab draft key or a lock (`navigator.locks`).

---

## 5. Server export scalability (queue/worker split for Render / Vercel / Docker)

### 5.1 Current architecture (verified)
`/api/export` (`app/api/export/route.ts`): parse doc -> resolve every media path (local confined path or allow-listed
Blob download) -> `acquireExportSlot` (in-process counter, default 1, `lib/export-slots.ts`) -> `runExport` (ffmpeg child
process, `-progress pipe:1`, SIGKILL on abort) -> streams NDJSON progress then raw mp4 on the same HTTP response, or
legacy `readFile` whole-file response. Client re-uploads every media file on every export (comment in the route's
cleanup). `maxDuration = 300`. Output goes to `os.tmpdir()/cadence-exports`.

### 5.2 What breaks, in order of likelihood
1. **Disconnect = cancel**, by design: closing the tab at 90% loses the export. Acceptable for ≤ 1 min renders, hostile
   for 10-minute 1080p renders and unusable on mobile (backgrounding the tab drops the fetch).
2. **No job identity or persistence.** A container restart (Render free sleeps after 15 min; deploys) kills in-flight
   work; there is nothing to resume, list or retry. Temp mp4s and downloaded Blob scratch files are leaked on crash
   (cleanup only runs in `finally`); no startup sweep.
3. **Per-process limiter only** (`export-slots.ts` says so). Two web instances = two concurrent encodes on 512 MB boxes;
   serverless = no limiting at all. Queue depth is invisible (`queued` phase only for the caller).
4. **No server-side limits**: no max duration, resolution, number of clips, source size, or fps. Combined with
   `Meta.width/height` having no maximum (section 3.3), one request can demand a 100k x 100k canvas. The client preflight
   (`lib/export-preflight.ts`) is advisory only — it runs in the attacker's browser.
5. **Single filtergraph for the whole timeline** (`plan.ts`, 1,960 lines): long edits produce huge graphs, memory grows
   with graph size and a failure at minute 9 restarts from zero. Not splittable today (AGENTS principle 5 "keep the render
   path splittable" is aspirational).
6. **Re-upload per export** wastes bandwidth and, on Vercel, the 4.5 MB body limit makes server upload unusable for video
   (documented in `DEPLOY.md`). Large video on Vercel is effectively unsupported.

### 5.3 Target design (keeps the free local path)
- **Job model** (new `export_jobs` table in `@cadence/db`): `id, org_id, project_id, doc_version_id, preset, status
  (queued|running|done|failed|cancelled), progress, eta, error_code, output_key, created_at, started_at, finished_at`.
  The doc is stored by version (immutable), so retries are deterministic.
- **API:** `POST /api/exports` (auth, validate, enforce limits, insert, return id), `GET /api/exports/:id` (poll or SSE for
  progress), `DELETE /api/exports/:id` (sets `cancelled`), `GET /api/exports/:id/file` (signed, expiring URL). Reuse the
  existing `progress.ts` parser and NDJSON format for SSE.
- **Worker:** a separate process (`worker` service — already a commented placeholder in `docker-compose.yml`) that polls with
  `SELECT … FOR UPDATE SKIP LOCKED`, runs `runExport`, writes output to storage, updates progress rows, and watches the
  row for `cancelled` to SIGKILL ffmpeg. Concurrency = `CADENCE_EXPORT_CONCURRENCY` per worker; scale by adding workers.
  Heartbeat + reaper marks jobs `failed(retryable)` if a worker dies.
- **Storage abstraction:** `MediaStore` interface with `fs` (local/Docker volume), `blob` (Vercel Blob — exists in
  `lib/uploads.ts`), and `s3` (R2/S3) implementations; content-addressed keys (`sha256`), which also removes the
  re-upload-every-export waste and gives dedupe. Presigned direct-to-storage uploads for large videos (the follow-up
  already noted in `upload/route.ts`).
- **Deployment mapping:**
  - *Docker/compose (free):* `web` + `worker` + `db` + volume; same image, different command. No cloud bill.
  - *Render:* web service + Background Worker (paid) or keep single-container free mode with the in-process worker and
    the same job table (worker runs inside web, `CADENCE_WORKER=inline`). Persistent disk or R2 for outputs.
  - *Vercel:* web only; enqueue to the DB; worker on Render/Fly/Cloud Run Jobs. Vercel functions must not run ffmpeg for
    real work (60 s, no disk sharing). Update `DEPLOY.md` to say so plainly.
- **Limits (server-enforced, per plan):** max duration (e.g. 10 min free), max pixels (1080p free, 4K paid), max sources
  size, max concurrent jobs per org (1 free), max queued, TTL for outputs (24 h). Return typed error codes the existing
  client already understands (`describeError`).
- **Splittable render (later):** build per-segment plans (cut at keyframes/transition-free boundaries), render segments in
  parallel across workers with `-c copy` concat for the video, single audio mix pass. `plan.ts` needs an
  "exportRange(startSec, endSec)" entry; boundary transitions are the hard part. Do this only after the queue exists.
- **Cancel semantics:** keep abort-on-disconnect for the legacy sync path (tiny jobs); jobs survive tab close.
- **Cost guardrails:** structured per-job metrics (render seconds, pixels, output bytes) from day one, so pricing and abuse
  detection are possible.

Effort: job table + API + inline worker + limits = ~2 weeks; separate worker + storage abstraction = ~2 more; splittable
render = a quarter.

---

## 6. Security

Severity is for a **public deployment** (which `render.yaml` and `DEPLOY.md` set up). For a purely local dev tool most of
this is acceptable; none of it is acceptable behind a public URL.

| # | Finding | Evidence | Sev | Fix |
|---|---|---|---|---|
| S1 | **Authentication bypass by design.** Sign-in takes an email, optionally a name, finds-or-creates the user and org, and issues a signed session — no password, no OTP. Anyone can sign in as any email and read/modify that user's projects. | `app/api/auth/login/route.ts:20–34`; `lib/auth.ts:21` ("a *dev* auth (the caller asserts identity…)"); `render.yaml` deploys it publicly | **Critical** | Refuse to boot in production unless `CADENCE_AUTH=dev` is explicitly set; implement real auth behind the existing `AuthProvider` interface (Auth.js: email magic link + Google/GitHub OAuth). Until then, remove the public deploy or put it behind Render/Vercel password protection. |
| S2 | **Unauthenticated compute endpoints**: `/api/upload`, `/api/export`, `/api/render`, `/api/transcribe`, `/api/director` have no session check and no rate limiting (only `/api/projects*`, `/api/settings` call `requireSession`). `/api/transcribe` runs Whisper; `/api/export` runs ffmpeg; `/api/render` runs Skia. | `app/api/*/route.ts` (no `requireSession` in these five) | **High** | Scratch editor is intentionally anonymous, so add: per-IP and per-session token-bucket rate limits (Upstash/Redis, or in-memory for single node), per-request body caps, a daily compute quota, and Cloudflare/WAF in front. Authenticated users get higher quotas. |
| S3 | **Unbounded uploads.** No size limit, no MIME sniffing (extension regex only), whole body buffered into memory (`Buffer.from(await file.arrayBuffer())`), written to disk with no quota or sweeper. A single large POST, or a loop, fills the disk or OOMs a 512 MB instance. | `app/api/upload/route.ts` (formData -> arrayBuffer -> writeFile); no unlink/TTL in `lib/uploads.ts` for `UPLOAD_DIR` | **High** | Stream to disk with a hard cap (`Content-Length` + counted stream), `file-type` magic-byte sniff against an allow-list (mp4/mov/webm/mp3/wav/png/jpg/…), `ffprobe` validation, per-IP quota, hourly sweeper for files older than N hours, never return the server filesystem path to clients (return an opaque id and resolve server-side). |
| S4 | **No resource ceilings on the doc.** `Meta.width/height/fps` have no maximum; `/api/render` and `/api/export` accept any valid doc, `timeSec` unchecked. A 100000x100000 canvas or 10k clips is a trivial DoS. | `packages/core/src/schema.ts:313–314,1431–1432`; `app/api/render/route.ts` | **High** | Add schema maxima and a `validateExportLimits(doc, plan)` used by both routes (max pixels, max duration, max clips/tracks, max keyframes), plus request body size limit. |
| S5 | **Tenant isolation is application-level only.** All queries take `org_id` from the session and are parameterized (good, and tested), but Postgres has no row-level security, so one forgotten `WHERE org_id` is a cross-tenant leak. | `packages/db/src/queries.ts`, `repositories.ts` (no `ROW LEVEL SECURITY`/`POLICY` anywhere); `AGENTS.md` section 7 asks for "row-level tenant isolation" | **Medium-High** | Enable RLS on every tenant table with `USING (org_id = current_setting('app.org_id')::uuid)`, set via `SET LOCAL` in a per-request transaction wrapper, run the app as a non-owner role, and add a cross-tenant negative test per route. |
| S6 | **Local media addressed by raw server paths**, ownership-free in local/Docker mode (owner tag exists only for Blob mode). The realpath containment in `uploads.ts:73` and `assertLocalMediaPath` is good and prevents traversal/SSRF; but anyone who learns another user's upload UUID path can export it. UUIDs are unguessable, so this is Low until media become shared/served. | `lib/uploads.ts`, `whisper-transcriber.ts` | Low-Med | Opaque media ids + owner binding (session or owner cookie) in both modes. |
| S7 | **Vercel Blob uploads are `access: "public"`.** URLs are unguessable but anyone with one can read the user's media; deletion is correctly owner-tagged. | `app/api/upload/route.ts` (`access: "public"`) | Medium | Private blobs + signed URLs, or the S3 abstraction in section 5. |
| S8 | **No security headers or CSP** (`next.config.ts` defines no `headers()`); no Origin/Referer check on mutating routes (SameSite=Lax mitigates cross-site POST). | `apps/web/next.config.ts` | Medium | Add CSP (self + blob: for media, fonts), `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`; origin check helper for all POST routes. |
| S9 | **ffmpeg filtergraph injection surface.** User text goes into `drawtext`/expressions and paths into `lut3d`; the code escapes (`escapeFilterPath`, `escExpr` in `plan.ts`) and a verify check covers hostile strings per the changelog, but a fuzz test is the right permanent control. | `packages/render-ffmpeg/src/plan.ts:187,262` | Medium | Property-based fuzz test: random unicode/quotes/backslashes/`:`/`,`/`;`/`[`/`]` in every text field must never change the graph structure; run ffmpeg with `-protocol_whitelist file,pipe` (already) and `-nostdin`. |
| S10 | **Session cookie / secrets:** HMAC + httpOnly + secure-in-prod + constant-time compare (good). The dev fallback secret is well-known; production correctly throws without `SESSION_SECRET`. No session rotation/revocation list, no logout-everywhere. | `lib/auth.ts:67–83,151` | Low | Move to Auth.js sessions in DB when S1 is fixed. |
| S11 | No audit log, no abuse reporting, no dependency/secret scanning in CI (no CI). | repo root | Medium | `npm audit` + gitleaks + CodeQL in GitHub Actions (section 9). |
| S12 | Whisper/ffmpeg child processes run with the web process's full privileges and no resource limits. | `whisper-transcriber.ts`, `export.ts` | Medium | In production run workers in a separate container/user with `ulimit`/cgroup memory + CPU caps and read-only filesystem except scratch. |

The good news: path confinement, Blob SSRF allow-listing (`uploads.ts:~185–215` incl. redirect rejection and size cap),
owner-tagged blob deletion (IDOR guard), SQL parameterization and server-derived `orgId` are all done correctly. The
problems are missing perimeter controls, not sloppy core logic.

---

## 7. Observability

Current state (verified): essentially none. `console.*` appears only in `packages/db/src/migrate.ts` and the two error
boundaries (`app/editor/error.tsx`, `components/ErrorBoundary.tsx`). `/api/health` pings the DB. `AGENTS.md` section 7 lists
"structured logging, health checks" as Phase-1 bones; logging was not delivered.

Minimum viable observability (S/M, 1 week):
- **Structured logging** (`pino`) with a request id middleware: `route, orgId, userId, durationMs, status`, plus ffmpeg
  exit code and last stderr lines for failures. Never log doc contents or media paths with PII.
- **Error tracking:** Sentry (free tier; **FREE-KEY, ask first**) for both browser (the error boundaries already catch) and server.
- **Metrics that matter for this product:** export queue depth, export duration vs output seconds (render ratio), failure
  rate by error code, ffmpeg peak RSS, upload bytes, Director latency per tool, time-to-first-frame, playback long-task
  count (RUM via `PerformanceObserver`), autosave failure rate, IndexedDB quota errors. Expose `/metrics` (Prometheus) from
  the worker; Grafana Cloud free tier optional.
- **Health:** split `/api/health` into liveness (process) and readiness (DB + ffmpeg detect + writable media dir + free
  disk); the container healthcheck should use readiness. Render's `healthCheckPath` currently only proves the DB.
- **Product analytics (opt-in, privacy-first):** funnel from upload -> first Director prompt -> first export. Without it
  the PM cannot rank the 25 gaps with data.
- **Client logging of agentic loop failures:** `runDirectorLoop` already captures verify errors; emit them as events so the
  eval suite can be fed real failing prompts.

---

## 8. Testing pyramid and gaps

Current (per `CHANGELOG.md` S6.1): unit 162 (`tests/*.test.ts`, 13 files, pure packages + a few `lib/` modules), verify 70
(real frame renders + real ffmpeg encodes via `scripts/verify.ts`), evals 6 (Director loop on prompts), Playwright e2e 41
(23 spec files in `apps/web/e2e`, ~2.5k lines, real browser + real media).

Shape: a good base of engine/pure tests and a heavy top of e2e; **the middle is missing**.

| Gap | Risk | Recommendation |
|---|---|---|
| **No component tests** (no jsdom/RTL, no Vitest/Testing Library). Everything UI is only covered by e2e, which is slow and coarse; the 3 god components can only be refactored on e2e faith. | Refactors regress silently; e2e flake blocks merges | Add Vitest + Testing Library for hooks and pure UI logic first: `useDocHistory`, the drag/trim reducer once extracted (section 1), `lib/edit-ops.ts` (585 lines, partially tested in `editor-craft.test.ts`), `placement.ts`, `export-preflight.ts`. Target 60+ fast tests. |
| **No API route tests** (auth, limits, tenant isolation, error codes). | The S1–S5 class of bugs goes unnoticed | Route-handler tests that invoke `POST(new Request(...))` directly with a test DB; one cross-tenant negative test per route. |
| **No CI.** There is no `.github/`; the gates (typecheck, unit, verify, build, e2e) run only when an agent or human remembers. | Seven parallel lanes merging without a gate | GitHub Actions: `typecheck` + `test:unit` + `verify` + `next build` on every PR; e2e sharded (Playwright `--shard`), with `ffmpeg` installed; required checks on `master`. Cache `~/.npm`, Playwright browsers. |
| **No performance tests** | Playback regressions invisible | Section 3.3 measurement spec. |
| **No fuzz/property tests** for `EditDoc` ops and ffmpeg plan | Random sequences of ops can produce invalid docs or invalid graphs | `fast-check`: random op sequences must keep `parseEditDoc` valid and `buildExportPlan` must not throw; random text must not alter graph structure. |
| **No visual regression** for preview == export other than check 66 (decoded frame vs canvas, mean ΔRGB≈1) | Drift between Stage and export as lanes add features | Extend check 66 into a golden-frame corpus across features (each new feature adds one frame). |
| **Accessibility tests absent** | See section 10 | `@axe-core/playwright` on key screens in e2e. |
| Evals only 6 prompts, stub Director only | Real Claude Director will behave differently | Grow to 40 prompts with an oracle (doc invariants + render probe); run the same set against Claude when the key gate opens. |
| e2e flakiness controls | 41 real-browser specs, long runtime | Tag `@smoke` (8–10 specs) for PRs, full suite nightly. |

---

## 9. Accessibility audit highlights

Sampled, not exhaustive (no axe run was possible read-only). Verified: `aria-*` density is reasonable (CutsStrip 107,
RoomPanel 48, TextRoom 28), `prefers-reduced-motion` handled globally (`app/globals.css:131`), live regions on the command
palette result count (`CommandPalette.tsx:164`), director status (`DirectorRail.tsx:286`), export progress
(`ExportMenu.tsx:109`) and timeline status (`CutsStrip.tsx:3238`); sliders have `role="slider"` + `tabIndex`
(`CutsStrip.tsx:1652,1672`); keyboard shortcuts help exists.

Concerns to verify/fix:
1. **The timeline is pointer-first.** Clip drag, trim handles and keyframe diamonds are mouse interactions; keyboard
   equivalents exist for JKL/step/in-out but I found no keyboard path for moving a clip between tracks, trimming an edge,
   or moving a keyframe (the sliders at 1652/1672 are the exception). Provide `Alt+Arrow` nudges and a "Move to track..." menu;
   announce results via the existing `aria-live`.
2. **Roving focus:** clips use `tabIndex` per element (`CutsStrip.tsx:1512`); with 200 clips that is 200 tab stops. Use
   roving tabindex (one stop, arrows to move) on tracks.
3. **Color contrast:** the coral-on-charcoal theme (S4.13) and faint text (`text-faint`) should be checked against WCAG AA
   (4.5:1 body, 3:1 UI). Run axe + manual contrast on `--faint`/`--muted` tokens.
4. **Preview media:** `<video>` has no captions track for the user's own project preview (acceptable) but the *app's*
   demo/landing videos need captions. Canvas-drawn text is not accessible to AT (inherent); expose a text alternative of
   the current captions in an `aria-live` region optional mode.
5. **Drag-and-drop-only operations** (media to timeline, transitions to cuts): the "Add to timeline" button parity exists
   for media (`onAddMediaToTimeline`); confirm the same for transitions (the chip opens a popover — good) and track reordering.
6. **Color-only state** (teal selection, amber action) must have a second cue (outline/shape) for color-blind users.
7. **Focus management** in modal/popovers (`TransitionPopover`, `Overlay.tsx`, `CommandPalette`): verify focus trap + return.
8. **Touch target size** (WCAG 2.2 AA 24x24 px): track-header toggles and keyframe diamonds are small; matters for the PWA plan.
9. **RTL/i18n:** UI strings are hard-coded English; RTL fonts are being added for export, but the app chrome has no
   `dir`/i18n layer. Plan `next-intl` before translation features ship.

Recommendation: add `@axe-core/playwright` to three e2e specs (landing, editor, dashboard) as a CI gate for "serious/critical"
violations, and run a manual keyboard-only pass of the "upload -> edit -> export" flow each cycle.

---

## 10. Other architectural notes worth acting on

- **Project media model (largest product-architecture gap).** See IDB item 3: projects stored in Postgres reference media
  that live only in a browser. Decide the media-in-storage model before adding templates, review links, publishing or mobile —
  all of them need server-addressable media.
- **Director API is stateless and trusts the posted project** (`app/api/director/route.ts`): posts the whole
  `media`/`transcripts`/`doc` each call. Fine for the stub; with Claude (metered) add auth, per-org rate/cost limits, prompt
  size caps, and token accounting *before* flipping the money gate — otherwise the unauthenticated endpoint is a direct
  billing hole.
- **Engine-agnostic contract is real, but `plan.ts` (1,960 lines) is the next monolith.** Split by stage
  (`inputs`, `visual-base`, `upper-layers`, `audio`, `text-overlays`, `finalize`) with golden-plan snapshot tests; this also
  prepares range-based splittable render.
- **Dependencies:** versions are pinned and the lockfile committed (good); `next` 16 + React 19 + `@napi-rs/canvas` native
  addon raise upgrade risk — add Renovate with grouped weekly PRs gated by CI.
- **Docs drift:** `docs/CAPCUT-STATUS.md` still lists LUT, adjustment layers, speed ramps and 55 transitions inconsistently
  with later docs (`docs/COMPETITIVE-FEATURES.md` notes this). Add a rule: the catalog (`landing/catalog.ts`) is the
  single source for "what exists", generated into FEATURES.md.

---

## 11. Prioritized 30/60/90-day plan

Effort in dev-weeks (dw). Owners are roles. Items marked **(gate)** require a user decision under the money gate.

### Days 0–30: stop the bleeding, make the system safe to scale

| # | Item | Owner | Effort | Outcome |
|---|---|---|---|---|
| 1 | **Disable public dev-auth** (S1): env switch + banner; protect the current deploy; decide real auth | Backend | S | No account takeover |
| 2 | **Perimeter on the 5 open routes** (S2–S4): rate limit, body/size caps, schema maxima, magic-byte sniff, upload sweeper, opaque media ids | Backend | M (1.5 dw) | Cheap-DoS closed |
| 3 | **CI** (GitHub Actions: typecheck, unit, verify, build, sharded e2e, audit, gitleaks) + required checks | DevOps | S–M | Every PR gated |
| 4 | **Structured logging + readiness health + Sentry (gate: free key)** | DevOps/Backend | S | Failures visible |
| 5 | **Refactor Step 0** (pure file moves of CutsStrip/RoomPanel) in a coordinated freeze | Frontend | S (3 d) | Files < 1.5k lines; conflicts drop |
| 6 | **Playhead external store** (Step 1) + memoize `RoomPanel`; measure before/after | Frontend | M | Render-per-frame ≈ 0 outside Stage/playhead |
| 7 | **Perf harness** (Playwright long-task + heap, throttled) with the section 3 budgets | QA/Frontend | S–M | Baseline numbers, regression gate |
| 8 | Undo survives media add (history section #1) | Frontend | S | UX bug removed |
| 9 | Quick wins from backlog: Version history UI (#15), Piper TTS (#10) | Frontend / Audio | S–M each | Visible product progress |

### Days 31–60: scalable export, real accounts, product breadth

| # | Item | Owner | Effort |
|---|---|---|---|
| 10 | **Export job model + API + inline worker + limits** (section 5.3) | Backend | M (2 dw) |
| 11 | **Real auth** via Auth.js behind `AuthProvider` (magic link + OAuth) **(gate if hosted IdP)** | Backend | M |
| 12 | **Postgres RLS** + route tests with cross-tenant negatives | Backend | M |
| 13 | **Storage abstraction + content-addressed media + presigned uploads**; server-side project media | Backend | M–L (3 dw) |
| 14 | Refactor Steps 2–3 (Editor hooks; CutsStrip split) after timeline lane merges | Frontend | M–L |
| 15 | Component/API test layer (Vitest + RTL; route tests); `fast-check` on ops/plan | QA | M |
| 16 | Backlog: AI background removal (#1), Brand Kit (#3), screen/webcam recorder (#4) | Engine/PM/Web | M each |
| 17 | IDB lifecycle: quota estimate, persist(), TTL sweep, `navigator.locks` | Frontend | S–M |
| 18 | a11y: axe in CI, keyboard parity for clip move/trim, roving tabindex | Frontend/UX | M |

### Days 61–90: scale features and distribution

| # | Item | Owner | Effort |
|---|---|---|---|
| 19 | Separate `worker` container + queue depth/autoscale signals; Render/Fly/Docker recipes; update DEPLOY.md | DevOps | M |
| 20 | **Proxy media + preview layer cap** (backlog #14), hitting the 4K budgets | Engine/Frontend | L |
| 21 | Caption translation (#2) after RTL lane; batch multi-platform export (#8) on the queue | Understanding / Web | M each |
| 22 | Templates (#7), review links (#9) — both need server media (item 13) | PM/Backend | M each |
| 23 | Director cost controls (per-org quotas, token accounting, caching) **then** open the Claude key gate | Backend | S–M **(gate)** |
| 24 | Splittable render prototype (`exportRange`) on a 10-minute fixture; decide go/no-go on parallel segments | Engine | M |
| 25 | Mobile PWA phase 1 (installable, phone layout) | Frontend/UX | M–L |
| 26 | Evals to 40 prompts; run vs stub and Claude; nightly | Director | M |

### Explicit non-goals for the next 90 days
Real-time multiplayer (CRDT), generative video (Runway-style), a public template marketplace, native desktop (Tauri), and a
state-management rewrite. Each is attractive and each would consume the cycle without moving launch-readiness.

### Decisions needed from the owner
1. Is the public Render deployment meant to be a demo? If yes, put it behind a password now (S1) — a 5-minute fix.
2. Media-in-storage model (browser-only vs server object storage) — blocks templates, review links, publishing, mobile.
3. Auth provider choice (Auth.js with magic link is free; Okta/Auth0/Entra are the paid enterprise options).
4. Sentry (free tier) and stock-media API keys — both need signups, so both are money-gate questions.
