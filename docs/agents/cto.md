# CTO lane — Reliability, speed & trust

Owner: CTO agent (worktree branch). Goal: editors never lose work, always know what
export is doing, and the app stays fast. Everything is free/local (no new services,
no new dependencies).

## Audit (what was wrong on master @ e036a14)

| # | Risk (observed) | Severity |
|---|---|---|
| R1 | The scratch `/editor` keeps the doc in React state and media as in-memory `File`s. A refresh, tab crash, or accidental close loses **everything**. | Critical — data loss |
| R2 | Export is a single opaque POST: the UI says "Rendering .mp4 with ffmpeg…" with no progress, no ETA. Cancel aborts the fetch but the server keeps encoding (ffmpeg runs to completion, burning the free instance's CPU). | High — trust + wasted CPU |
| R3 | No error boundary anywhere in the editor. One throwing panel (a room, the Stage, the timeline) white-screens the whole app. | High — perceived data loss |
| R4 | Export only discovers problems server-side: a doc referencing media whose `File` isn't loaded (project opened from the DB / a JSON file) fails with a raw message; media in `doc.media` that no clip uses is still uploaded (and fails the export when its file is missing); huge resolutions / very long renders give no warning. | Medium |
| R5 | "Duplicate as new" downloads JSON, but there is no way to **open** a project file again, and no way to re-link media after opening one. The round-trip is one-way. | Medium |
| R6 | Playback calls `setTimeSec` every rAF → the whole ~1.7k-line Editor tree re-renders at 60 Hz (measured: 60 React commits/s; at 4× CPU throttle the dev build drops to ~19 fps with 2.6 s of long tasks per 3 s). Panels that don't depend on time (TopBar, DirectorRail, RoomsRail, AppliedStatus, QuickActions, CodeDrawer) re-render every frame. | Medium — perf |

## Plan (risk → feature → how verified)

1. **R1 → Autosave + crash recovery** (`lib/autosave.ts` pure, `lib/media-store.ts`
   IndexedDB, `lib/use-autosave.ts` hook, `RecoverDraftBanner.tsx`). The scratch
   editor debounces (800 ms) the doc + media registry + transcripts into IndexedDB
   and stores each media `File` once (Blobs are structured-cloneable). On load, a
   banner offers "Restore your last session" (title · media count · "saved 3 min
   ago") or Discard. Autosave pauses while the choice is pending so a fresh tab
   never overwrites the draft. Every IndexedDB call is try/catch'd — private mode
   / blocked storage / quota errors degrade to "autosave off" with a quiet note;
   media too large to keep is reported on restore ("re-add X").
   *Verified:* unit tests for draft (de)serialization, validation of corrupt drafts,
   media-prune selection, relative-time copy; e2e: load media + edit → reload →
   Restore → same title/clips/media preview.
2. **R2 → Real export progress + real Cancel.** `runExport` gains `onProgress(fraction,
   etaSec)`, `onPhase`, and `signal`. The driver adds `-progress pipe:1` and parses
   ffmpeg's key=value blocks (format verified against the bundled ffmpeg 6.0 output:
   `out_time_us` — negative sentinel before the first frame — `frame=`,
   `progress=continue|end`) with a pure parser (`render-ffmpeg/src/progress.ts`).
   Abort kills ffmpeg (SIGKILL) and the canvas frame feeder, and rejects with
   `ExportCancelledError`. The export route streams NDJSON events when the client
   opts in (`x-cadence-progress: 1`): `phase` / `progress` / `error` lines, then a
   `file` header line followed by the raw mp4 bytes on the same stream (no base64,
   one request — works on Docker/Render and serverless alike). Client disconnect
   (fetch abort) aborts `req.signal` / cancels the body stream → ffmpeg is killed.
   Legacy callers without the header get the unchanged binary response.
   UI: the Export button becomes a determinate progress pill (role=progressbar,
   % + "~12s left", phase label) with a Cancel button; a `beforeunload` guard
   warns while an export is running.
   *Verified:* unit tests for the progress parser + stream decoder; verify check
   (right before check 64) proves progress callbacks fire monotonically and reach 1
   during REAL encodes (footage path and raw-canvas path), and that an abort kills
   ffmpeg quickly; e2e: export shows the progress bar then downloads a real mp4;
   existing download/text-video specs re-run.
3. **R3 → Error boundaries.** `ErrorBoundary.tsx` (class boundary, `resetKey`
   auto-retries when the doc changes, e.g. after Undo) around the room panel,
   Stage, timeline, Director rail and code drawer: a friendly card ("This panel
   hit a snag — your edit is safe") with Try again / Undo last change. Plus an
   `app/editor/error.tsx` route boundary (Next 16 `retry` prop, per the bundled docs)
   pointing at autosave recovery.
   *Verified:* e2e forces a panel crash via a dev-only query flag and asserts the
   card renders while the rest of the editor keeps working.
4. **R4 → Export pre-flight.** Pure `preflightExport(doc, {hasFile, fileBytes})` in
   `lib/export-preflight.ts`: blocks on nothing-to-export / missing media (names
   them, suggests re-adding); warns on >4K output, >30 min, very large uploads;
   strips media no clip references before upload. Shown inside the export popover
   (errors disable the button with the reason).
   *Verified:* unit tests.
5. **R5 → Project file round-trip.** "Save project file (.cadence.json)" + "Open
   project file…" in the overflow menu. The file is a versioned envelope
   `{ format: "cadence.project", version: 1, doc, mediaList }` (plain edit-docs are
   accepted too). Opening validates with the schema, resets history, and lists
   media to re-link; adding a file whose name matches a missing media re-links it
   in place (no doc change) instead of starting a new project.
   *Verified:* unit tests for envelope round-trip + matching; e2e save → open.
6. **R6 → Playback performance.** `withStableHandlers` HOC (`lib/stable-memo.tsx`):
   memo + "latest ref" proxies for function props, so time-independent panels skip
   re-rendering during playback while handlers never go stale.
   *Verified:* Playwright render-count check (React commit hook): during playback
   the memoized panels don't re-render; fps measured before/after (numbers below).

## Results

(filled in as slices land)
