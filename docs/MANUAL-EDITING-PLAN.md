# Cadence — Manual Editing Plan (Timeline, Multi-track, Walkthrough, AI↔Manual)

Advisory doc. Head of product + senior UX lead. Scope: make Cadence a mass-market
**AI + manual** editor — as easy as CapCut, where every AI action has an obvious
manual control. Written against the real code, not assumptions.

Sibling docs: `EDITING-ROADMAP.md` (pro feature set), `UX-ROADMAP.md` (heuristics),
`WAVE-PLAN.md` (build waves). This doc is the concrete **interaction model** for the
four asks below and is meant to slot in as new waves on disjoint files.

---

## 0. Honest inventory — what the code actually does today

Read from `CutsStrip.tsx`, `Editor.tsx`, `schema.ts`, `edit-ops.ts`, `edits.ts`,
`demo.ts`, `RoomsRail.tsx`, `RoomPanel.tsx`, `TranscriptRoom.tsx`.

**Timeline (`CutsStrip.tsx`)** renders `doc.tracks` as bare horizontal lanes
(`h-9` rows). What exists:
- Zoom 1–24× (buttons + slider only — no keyboard), horizontal scroll, a ruler with
  "nice" tick intervals, a single amber playhead line, an audio waveform strip.
- Per-clip: drag-trim (left/right handles), **reorder within one track** (main
  sequential tracks only), split at playhead, duplicate, ripple-delete, delete, clip
  volume/mute — all via the `ClipInspector` below the lanes.
- Snapping (`SNAP_PX = 8`) to clip edges + playhead + markers + 0/end — but **only
  applied during trim**; reorder is index-based, not snapped.
- All mutations are pure `edit-ops.ts` fns routed through the editor's undoable
  `commit` (with `coalesceKey` so a drag collapses to one undo step). This is a
  genuinely good foundation.

**What's missing for real manual editing (the gap list):**
1. **No track headers at all.** Tracks are anonymous lanes. The track id only appears
   as text inside `ClipInspector` ("on `titles`"). No rename, hide, lock, mute, solo.
2. **No add / remove / reorder tracks** in the UI.
3. **No cross-track drag.** The `move` drag only reorders within the same main
   sequential track; overlay clips (titles/captions/broll/cursor/callouts) can't be
   dragged at all (`canReorder` is false → they're click-to-select only).
4. **Single selection only** (`selectedClipId`). No marquee / shift-click multi-select,
   no group operations.
5. **No follow / auto-scroll**; the playhead can run off-screen while playing. Playhead
   is not draggable (you seek by clicking the ruler/empty lane).
6. **Zoom has no keyboard**, no "zoom to fit", no "zoom to selection".
7. **Markers are editor-only local state** (`Editor.tsx` `const [markers, setMarkers]`)
   — the schema already has a persisted `doc.markers` field that the timeline **ignores**.
   Markers vanish on reload and never reach export/chapters.
8. **No walkthrough/demo room.** `build_demo`, `add_cursor`, `type_text`, `add_callout`
   exist **only as Director (chat) tools** in `packages/director/src/tools.ts`. There is
   no manual surface — this is precisely "the walkthrough feature the user can't find."

**Schema (`schema.ts`)** — `Track = { id, kind: "visual"|"audio", clips[] }`. No
`name`, `hidden`, `locked`, `muted`, `solo`. Those must be **added as optional,
defaulted fields** (§D flags this). Clip kinds already include `cursor` + `callout`,
and `TextClip.anim.style` already has `"typewriter"` — **all walkthrough primitives
already render** in canvas/Stage/ffmpeg. There is exactly one `tracks[]` array (no
"sequences" concept).

**AI↔manual pattern (already working for color/vfx/audio/words):**
`@cadence/director` exports **pure `doc → doc` functions**. Chat calls them through
`tools.ts` → `askDirector` → `/api/director`. Manual UI calls the **same** pure
functions directly via `onApplyDoc(fn(doc), coalesceKey)` → `commit`. This is the
whole game — §C generalizes it.

---

## A. Timeline interaction model

Design target: a first-timer recognizes it as "the CapCut/iMovie timeline" within
five seconds, and never has to open chat to do a basic edit.

### A.1 Layout change: a fixed track-header gutter

Split the timeline into two columns that scroll together vertically:

```
┌───────────────┬───────────────────────────────────────────────┐
│  TRACK HEADER │  RULER (ticks · markers · playhead handle)     │
│  (gutter,     ├───────────────────────────────────────────────┤
│   ~160px,     │  lane clips … (scrolls horizontally)           │
│   sticky-left)│                                                 │
└───────────────┴───────────────────────────────────────────────┘
```

- **Gutter is `position: sticky; left: 0`** so headers stay visible while the lanes
  scroll horizontally. Width ~160px desktop; collapses to a 44px icon rail < 768px.
- Lanes render **top-to-bottom in paint order = top layer first** (matches CapCut/
  Premiere mental model: "higher = on top"). Today `doc.tracks` paints bottom-to-top
  for compositing; the timeline should render `[...doc.tracks].reverse()` for display
  so the visual order matches the composite order the user sees. Keep audio tracks
  grouped at the bottom.

### A.2 Track header controls — exact behavior

Each header row shows, left→right: **drag-handle · name · [S] solo · [M] mute · [👁
visibility] · [🔒 lock] · [⋯ menu]**. Behaviors:

| Control | Click behavior | Persistence | Renderer effect |
|---|---|---|---|
| **Rename** | Double-click name → inline text input; Enter commits, Esc cancels. `⋯ → Rename` also. | `track.name` (new optional field; falls back to a humanized `track.id`). | None (label only). |
| **Visibility (hide/show)** | Toggle. Hidden = lane dims to ~35% + "hidden" badge; clips uneditable. | `track.hidden` (new, default `false`). | Renderers **skip** clips on hidden tracks in preview **and** export. Pure: an engine filter `visibleTracks(doc)`. |
| **Lock** | Toggle. Locked lane shows a hatch pattern; clips are click-through for seek but not drag/trim/delete/select. | `track.locked` (new, default `false`). | None — pure UI/edit-guard. |
| **Mute (audio)** | Toggle. Silences this track's audio. | `track.muted` (new, default `false`). Distinct from a clip's `volume`. | Export/preview mix treats muted track as volume 0. |
| **Solo (audio)** | Toggle. When ≥1 track is soloed, only soloed audio tracks are audible. | `track.solo` (new, default `false`). **Solo is a monitoring state** — persist it, but it's an override, not a mix value. | Mix: if any `solo`, non-soloed audio tracks are silenced. |
| **⋯ menu** | Add track above/below · Delete track (confirm if non-empty) · Move up/down · Duplicate track · Clear track. | structural doc edits. | via pure `track-ops.ts` fns. |

Rules that keep it "obvious":
- **Mute/solo show only on audio tracks; visibility/lock on visual tracks.** Don't
  render controls that do nothing for that track kind.
- **Every toggle is undoable** (routes through `commit`) and reflects instantly.
- Hidden ≠ muted: hiding a visual track also drops any audio on its video clips
  (it's not rendered at all); muting only touches audio. State this in a tooltip.

### A.3 Add / remove / reorder tracks

- **Add:** a `+ Track` button at the bottom of the gutter → choose "Video/Overlay" or
  "Audio". New track gets a default name ("Video 2", "Audio 2") and an empty `clips[]`.
  New tracks are **overlay-style** (freely positioned clips), never a second "main
  sequential" track — see §B/§A.6 for why the main track is special.
- **Remove:** `⋯ → Delete track`. Confirm when it has clips. Removing the last
  main-visual track is disallowed (there must always be a base).
- **Reorder:** drag the header drag-handle up/down, or `⋯ → Move up/down`. Reordering
  changes composite order (which layer is on top) — show a live insertion line.
- All of these are pure fns in a new `packages/director/src/track-ops.ts`
  (`addTrack`, `removeTrack`, `reorderTrack`, `renameTrack`, `setTrackFlag`) so chat
  and UI share them (§C).

### A.4 Cross-track drag + snap rules

This is the biggest single upgrade. Extend the existing pointer-drag in `CutsStrip.tsx`:

- **Vertical drag moves a clip between tracks.** During a `move` drag, compute the
  target track from pointer `y` (which lane it's over) and the target start time from
  pointer `x` (snapped). Show a ghost of the clip in the target lane + an insertion
  marker.
- **Kind compatibility:** a clip may only drop on a track whose `kind` matches its
  media family (video/image/text/solid/cursor/callout → visual tracks; audio → audio
  tracks). Incompatible lanes show a "no-drop" cursor and don't accept.
- **Main-track exception:** the main sequential track stays **gapless/reflowed**. If
  you drag a clip *out* of it, the remaining clips ripple closed (existing
  `reflowTrack`). If you drop a clip *into* it, it snaps to a sequence slot (existing
  reorder logic) rather than to a free x. Dropping onto an **overlay** track keeps the
  free x position. This preserves the "the main story is always continuous" guarantee
  while overlays float.
- **Snap targets** (reuse & extend today's `snapTargets`): other clips' edges (in any
  track), the playhead, markers, 0, and total end. Add **cross-track edge alignment**
  (a title snaps to the cut beneath it). Keep `SNAP_PX = 8`; make snapping toggle with
  a **held `Alt`/`⌥`** (industry-standard "disable snap") and a persistent snap
  on/off button in the toolbar.
- Snap must apply to **both trim and move** (today it's trim-only).

### A.5 Playhead, zoom, scroll, follow

- **Draggable playhead:** the ruler grows a grab handle (the amber triangle) you can
  scrub. Clicking anywhere on the ruler/lane still seeks (keep current behavior).
- **Follow / auto-scroll:** while playing, keep the playhead in view. Model:
  *page-scroll* when the playhead reaches ~85% of the viewport (jump forward one page),
  which is calmer than continuous centering for beginners. A toolbar toggle "Follow
  playhead" (default **on**), persisted to `localStorage` like the panel widths.
- **Zoom:** keep the slider; add keyboard `+` / `-` (and `⌘/Ctrl` + scroll-wheel over
  the lanes to zoom around the cursor). Add **"Fit"** (zoom so the whole project fits
  the lane width — i.e. reset to zoom 1) and **"Zoom to selection"**. Show the current
  scale (already present).
- **Vertical scroll** appears once tracks exceed the timeline height (the timeline is
  already height-resizable via `ResizeHandle`).

### A.6 Selection + multi-select

- **Single select:** click a clip (today). Show the inspector for it (today).
- **Multi-select:** `Shift`/`⌘`-click adds/removes clips; **marquee** (drag on empty
  lane area) selects everything intersected. Selected set is highlighted with the amber
  ring.
- **Group operations** on the selection: move together (preserving relative offsets),
  delete/ripple-delete, nudge, set volume, change look. The inspector switches to a
  compact "N clips selected" mode with the ops that apply to all.
- **Select-all-on-track** (click header body), **select-all** (`⌘A`).

### A.7 Keyboard shortcuts (mass-market-friendly, CapCut/Premiere-aligned)

Extend the single `keyHandlerRef` in `Editor.tsx` (already the right place — it's
ignored while typing). Additions in **bold**:

| Key | Action | Status |
|---|---|---|
| `Space` | Play/pause | exists |
| `←` / `→` | Nudge 1s (`Shift` = 5s) | exists |
| **`,` / `.`** | **Step one frame (1/fps)** | new |
| `Home` / **`End`** | Start / **end** | Home exists |
| `S` or **`B`** | Split (blade) at playhead | exists (`S`) |
| `Del` / `Backspace` | Ripple-delete selection | exists |
| **`Shift+Del`** | **Delete leaving a gap** | new |
| **`⌘/Ctrl+D`** | **Duplicate selection** | new |
| **`⌘/Ctrl+A`** | **Select all** | new |
| **`+` / `-`** | **Zoom in / out** | new |
| **`Shift+Z`** | **Zoom to fit** | new |
| `M` | Add marker | exists (persist it — §D) |
| **`[` / `]`** | **Trim clip start/end to playhead** | new |
| **`⌥/Alt` (hold)** | **Disable snapping while dragging** | new |
| **`V` / `T` / `A`** | **Visibility / lock / mute the focused track** | new (a11y for headers) |
| `⌘/Ctrl+Z`, `Shift`, `Y` | Undo/redo | exists |
| `?` | Shortcuts help | exists (add all new rows to `ShortcutsHelp`) |

Every shortcut must have a discoverable equivalent (button/menu) — beginners never
memorize keys; pros expect them. Show shortcut hints in tooltips.

---

## B. "Multiple timelines" — read + recommendation

**They almost certainly mean multi-track layers, not multiple sequences.** Evidence:
the ask sits inside "manageable multi-track timeline"; today there are no track headers,
so a beginner literally cannot tell tracks apart — that reads as "I can't manage my
multiple timelines (=layers)." The mental model a CapCut user has is *one timeline with
stacked layers*, and they call each layer a "track" or loosely a "timeline."

**Recommendation: deliver A (multi-track layers with headers) first and fully. Do NOT
build multiple sequences now.** Justification:
- The whole architecture is **one `doc.tracks[]` = one composition**; renderers,
  export, `docDurationSec`, waveform source, and history all assume a single doc.
  Multiple sequences means a `sequences[]` array, a "current sequence" pointer, nested
  sequence-as-clip references, and per-sequence undo — a large, breaking schema change
  with little payoff for a mass-market user who edits one video at a time.
- Real user value from "multiple sequences" (A/B versions, chapters, reusable intros)
  is **better served cheaply another way:**
  - **A/B versions / drafts** → already exists as project versions (`onSave` writes a
    new version) + "Duplicate project" (`duplicateProject`). Surface these better.
  - **Chapters / sections** → **markers with labels** (schema field already there;
    §D wires it). One timeline, labeled regions.
  - **Reusable intro/outro** → a future "save selection as a preset/template" that
    inserts clips, not a nested sequence.

If, later, power users genuinely ask for nested sequences, add it as an **optional,
additive** `doc.sequences?` behind a "Pro" flag — but it is explicitly **out of scope**
for the ease-of-use milestone. Keep the honest, single-doc model.

---

## C. AI ↔ manual dual model

### C.1 The principle (make it a rule, not a hope)

> **Every capability is one pure `doc → doc` function in `@cadence/director`. Chat and
> the manual UI are two thin callers of the same function. Neither may contain edit
> logic the other can't reach.**

This is already true for color/vfx/audio/words and is why those rooms feel instant and
undoable. The two gaps — **timeline track management** and **the walkthrough
primitives** — are gaps precisely because they skipped this rule (track ops don't exist
as pure fns yet; cursor/type/callout exist as fns but were only wired to chat).

Concretely, for any new capability you add:
1. Write/confirm the pure fn in `packages/director` (`edits.ts` / new `track-ops.ts`).
2. Register a Director **tool** wrapping it in `tools.ts` (chat path).
3. Add a **manual control** that calls it via `onApplyDoc(fn(doc, args), coalesceKey)`
   (UI path). Use a `coalesceKey` for continuous controls (drags/sliders) so the whole
   gesture is one undo step; omit it for discrete toggles.
4. Both paths land on the same `commit` → identical undo, identical render.

### C.2 Capability → chat phrasing → manual control (map)

| Capability | Chat phrasing (Director tool) | Manual control location | Status |
|---|---|---|---|
| Trim / split / reorder / ripple / duplicate / delete clip | "cut the first 3 seconds", "split here" | Timeline drag-handles + `ClipInspector` buttons | **manual ✅ / chat partial** |
| Clip volume / mute | "mute this clip" | `ClipInspector` volume slider | ✅ both |
| **Track rename** | "rename this track to B-roll" (`rename_track`) | Header double-click | **chat ✗ / manual ✗ → add** |
| **Track hide / lock** | "hide the captions track" (`set_track_flag`) | Header 👁 / 🔒 | **add both** |
| **Track mute / solo** | "solo the music", "mute voice-over" | Header M / S | manual exists for *volume* only (`setTrackVolume`); **add mute/solo** |
| **Add / remove / reorder track** | "add an audio track", "delete the b-roll track" | Gutter `+ Track`, header ⋯ menu, drag handle | **add both** |
| **Move clip between tracks** | "move this title onto its own track" | Cross-track drag (§A.4) | **add both** |
| Color grade / look | "make it warmer", "cinematic look" | Color room sliders (`adjustColor`) | ✅ both |
| Chroma / blend / mask / blur region | "green screen", "blur his face" | VFX room (`chromaKey`/`setBlend`/`addMask`/`regionBlur`) | ✅ both |
| Transcript edit / filler / silence / reframe | "remove the ums" | Words room | ✅ both |
| Captions + styling | "add captions", "make captions bigger" | Words room / (style is chat-only today) | chat ✅ / manual partial |
| **Cursor overlay** | "add a cursor that clicks the button" (`add_cursor`) | **Walkthrough room** (§D-wave) — drag on preview | **chat ✅ / manual ✗ → add** |
| **Typed text (typewriter)** | "type an email into the field" (`type_text`) | **Walkthrough room** — click field on preview | **chat ✅ / manual ✗ → add** |
| **Callout / highlight box** | "highlight the menu" (`add_callout`) | **Walkthrough room** — draw a box on preview | **chat ✅ / manual ✗ → add** |
| **Build walkthrough from screenshots** | "make a walkthrough from these screenshots" (`build_demo`) | **Walkthrough room** — "Build" button | **chat ✅ / manual ✗ → add** |
| Export / platform presets | "export for TikTok" | Deliver room | ✅ both |

The pattern to close every "✗": add the pure fn if missing → add the tool → add the
control. Nothing here needs new render code.

### C.3 Discoverability glue

- After a **chat** edit, the affected room/timeline should visibly reflect it (it
  already does — same doc). Add: the undo toast (`showUndoToast`) names the tool and
  offers "Open in [room]" for the surface that owns it.
- After a **manual** edit, optionally echo a one-line "did X" into the Director log so
  the transcript stays a complete history (low priority, nice for trust).

---

## D. Walkthrough / Demo room UX (the feature they can't find)

**Root cause:** `build_demo` + `add_cursor` + `type_text` + `add_callout` are only
reachable by typing to the Director. Make them a first-class **room** — the only new
*surface*; the engine already renders cursor/callout/typewriter and the tracks
(`cursor`, `callouts`, `demo-text`) already exist.

### D.1 Add a "Walkthrough" room to the rail

Add to `RoomsRail.tsx` `RoomKey`: `"walkthrough"` (icon: a cursor arrow). Place it
after "Edit". It's the home for turning screenshots into an interaction video.

### D.2 The flow (step by step, on-preview placement)

The `Stage` preview is a WYSIWYG canvas at composition resolution. **All placement
happens by direct manipulation on that preview** — never by typing pixel numbers. The
key insight from `demo.ts` (the VISION CAVEAT) is: screenshots carry no field pixels,
so the **user's drag *is* the field detector.**

**Step 1 — Add screens.** "Upload screenshots" (reuses `onFiles`, images become media
in order). A filmstrip shows the screens; drag to reorder (this is just `reorderMedia`).
Each screen = one full-frame `image` clip (exactly what `buildDemo` builds).

**Step 2 — Build the base.** One button "Build walkthrough" calls `buildDemo(screens,
{ perScreenSec, transition, transitionSec })` via `onApplyDoc` (a pure fn, undoable).
This gives the sequenced screens with transitions — instantly. Per-screen duration and
transition are set by two controls in the room (defaults: 3.5s, crossfade 0.5s).

**Step 3 — Annotate a screen (the core UX).** Select a screen in the filmstrip; the
preview shows that screen. A floating **"Add" palette** offers three tools; each is a
place-on-preview gesture that ends in an `onApplyDoc(fn(doc, …))`:

- **Type text** (`type_text`): click where the field is on the preview → a text caret
  appears there → type the string in an inline field → drag the caret to fine-tune
  x/y. On commit, `typeText(doc, { text, x, y, atSec, typeSec, holdSec, background })`
  with `x/y` = **the pixel you clicked** (preview→composition scale is known). Options:
  mask as password (•••), font size, "start after previous" (auto-sequences `atSec`).
- **Cursor path** (`add_cursor`): click to drop waypoints on the preview (each click =
  a `{x, y, atSec}`), and mark which waypoints are **clicks** (a checkbox per point or
  a double-click). A live dotted path previews the motion. On commit,
  `addCursor(doc, { waypoints, clicks, start, duration })`. Provide a one-click "cursor
  to this button then click" shortcut that drops a 2-point path ending in a click.
- **Callout** (`add_callout`): **drag a rectangle** directly on the preview over the UI
  element → `addCallout(doc, { x, y, w, h, label?, zoom?, dim? })` with the dragged
  rect. Toggle "dim background" and "zoom to this" (already in the schema), and type an
  optional label. This is the easiest and most satisfying — dragging a box is universal.

**Step 4 — Per-screen timing & transition.** For the selected screen: a duration
stepper and a transition picker (the schema's `TransitionType` enum:
crossfade/slide/wipe/dissolve/zoom/dip-to-black/smooth). Changing duration reflows the
screens (they're on a main sequential track — existing reflow handles it).

**Step 5 — Preview & refine.** Everything is on real overlay tracks (`cursor`,
`callouts`, `demo-text`), so it plays in `Stage` and shows up in the **timeline** — the
user can trim/move the cursor/text/callout clips there too (this is where §A's
cross-track drag pays off: nudge a callout's timing by dragging it). Full round-trip:
place visually → tweak on the timeline → export.

### D.3 Why on-preview placement (not the timeline) for authoring

A callout over "the Save button" is a *spatial* choice; the timeline is *temporal*.
Author position on the preview (spatial), author timing on the timeline (temporal).
The preview is already rendered at composition px, so a pointer position maps directly
to the `x/y/w/h` the schema wants — no guessing, no vision model, no pixel typing. This
directly answers the `demo.ts` caveat.

### D.4 Controls summary (maps to existing primitives)

| Room control | Gesture | Pure fn called |
|---|---|---|
| Upload screenshots | file picker | `onFiles` → images |
| Reorder screens | filmstrip drag | `moveMediaInDoc` |
| Build walkthrough | button | `buildDemo` |
| Per-screen duration / transition | stepper / picker | `buildDemo` opts / clip edit |
| Type text | click field + type | `typeText` |
| Cursor path + clicks | click waypoints | `addCursor` |
| Callout box | drag rectangle | `addCallout` |
| Login preset | button | `buildDemo({ login: true })` |
| Fine-tune timing | drag clip on timeline | `edit-ops` (existing) |

No schema changes for the walkthrough room — every primitive already exists.

---

## E. Phased delivery — WAVES on disjoint files

Same rule as `WAVE-PLAN.md`: two agents per wave on **disjoint** trees so they never
collide — **Engine** owns `packages/**` (+ `scripts/verify.ts`); **Web** owns
`apps/web/**`. Integrate → gate → commit between waves. Each wave is independently
shippable and verifiable via `npm run typecheck` · `npm run verify` · `next build`
(`apps/web`) · `npm run test:e2e`.

### Wave M1 — Track headers + track-ops (foundation)  ⭐ do first
- **Engine (`packages/**`):**
  - **SCHEMA CHANGE (additive, backward-compatible):** add to `Track`:
    `name?: string`, `hidden: boolean = false`, `locked: boolean = false`,
    `muted: boolean = false`, `solo: boolean = false`. All optional/defaulted so every
    existing doc parses unchanged. Bump nothing else; `version` stays `1`.
  - New `track-ops.ts`: pure `addTrack`, `removeTrack`, `reorderTrack`, `renameTrack`,
    `setTrackFlag(doc, id, flag, value)`. Add a pure `visibleTracks(doc)` /
    `audibleTracks(doc)` helper used by renderers so `hidden`/`muted`/`solo` are honored
    in canvas **and** ffmpeg (parity!). Register matching Director tools in `tools.ts`
    (`rename_track`, `set_track_flag`, `add_track`, `remove_track`, `reorder_track`).
    Add a `verify.ts` case: hidden track absent from render plan; soloed audio wins.
- **Web (`apps/web/**`):**
  - `CutsStrip.tsx`: add the sticky-left header gutter with rename/hide/lock/mute/solo
    per §A.2, `+ Track` and the ⋯ menu; render tracks top = top layer.
  - Wire header actions through `commit` (mirror existing `edit` callback plumbing in
    `Editor.tsx`).
  - Respect `locked` (block drag/trim/select) and dim `hidden` lanes.
- **Verifiable:** typecheck; verify (render-plan honors flags); build; e2e "rename +
  hide a track, export excludes it".
- **Flag:** the only schema change in the whole plan lives here and is additive.

### Wave M2 — Cross-track drag + snapping + playhead/zoom polish
- **Engine (`packages/**`):** ensure `edit-ops` move-between-tracks logic is pure and
  covered (a `moveClipToTrack(doc, clipId, toTrackId, atSec)` in `edit-ops.ts` —
  note this file is under `apps/web/src/lib`, so it's a **Web** file; keep pure-fn
  parity there). Engine's job here is minimal: verify reflow/anchor still hold. (If you
  prefer, promote `edit-ops.ts` into `packages/director` for shared reuse — a separate,
  optional refactor; don't do it mid-wave.)
- **Web (`apps/web/**`):**
  - `CutsStrip.tsx`: vertical-aware `move` drag with target-track detection, kind
    compatibility, ghost + insertion line; snapping on move (not just trim); hold-`⌥`
    to disable; snap on/off toolbar toggle.
  - Draggable playhead; **Follow playhead** toggle + page-scroll; keyboard zoom
    (`+`/`-`, `⌘`+wheel), Fit, Zoom-to-selection.
  - New keyboard rows in `Editor.tsx` + `ShortcutsHelp`.
- **Verifiable:** typecheck; build; e2e "drag a title onto a new track; it renders on
  top; snaps to the cut beneath."

### Wave M3 — Multi-select + persisted markers
- **Engine (`packages/**`):** confirm `doc.markers` round-trips; add a Director
  `add_marker`/`remove_marker` (add_marker exists) parity + a `verify` case that
  markers survive parse.
- **Web (`apps/web/**`):**
  - Multi-select (shift/⌘-click, marquee), group move/delete/nudge/volume, "N selected"
    inspector.
  - **Migrate markers from local state to `doc.markers`** (they're currently
    editor-only in `Editor.tsx`). Add optional labels; show them on the ruler; feed
    them to chapters/export later. This closes a real correctness bug (markers vanish
    on reload).
- **Verifiable:** typecheck; build; e2e "select 3 clips, delete; add a labeled marker,
  reload, it persists."

### Wave M4 — Walkthrough / Demo room
- **Engine (`packages/**`):** none required — `buildDemo`, `addCursor`, `typeText`,
  `addCallout` and their tools already exist. Optional: a `verify` case that a built
  demo doc is valid and that a callout rect maps to the drawn region.
- **Web (`apps/web/**`):**
  - Add `"walkthrough"` to `RoomsRail` + a `WalkthroughRoom` component (sibling of the
    other room panels), wired like the others via `onApplyDoc`/`onFiles`.
  - On-preview placement layer over `Stage` (a placement overlay that maps pointer →
    composition px): click-to-type, click-waypoints, drag-rectangle. This is the only
    genuinely new interaction surface; keep it a thin overlay that emits calls to the
    existing pure fns.
  - Filmstrip of screens; per-screen duration/transition; "Build walkthrough" + login
    preset.
- **Verifiable:** typecheck; build; e2e "upload 2 screenshots → build → draw a callout
  → cursor path → export a walkthrough mp4."

### Sequencing & parallelism
- M1 is the prerequisite for M2 (cross-track drag needs headers) and improves M4
  (walkthrough clips get real headers). M3 and M4 are independent of each other and can
  run in parallel after M1. Within every wave, Engine and Web work on disjoint trees.
- **The one schema change is confined to M1** and is additive/defaulted — no migration,
  no `version` bump, existing saved docs keep parsing.

---

## F. Ruthless priority (if you only do three things)

1. **Track headers + hide/lock/mute/solo/rename + add/remove/reorder tracks (M1).**
   Without labeled, controllable tracks the timeline is unmanageable — this is the #1
   ask and unblocks everything.
2. **The Walkthrough room (M4).** The feature already *works* via chat and is
   completely undiscoverable; a room turns a hidden power-tool into a headline feature
   for almost no engine cost.
3. **Cross-track drag + snapping + follow-playhead (M2).** This is what makes the
   timeline *feel* like CapCut rather than a read-only strip.

Everything else (multi-select, persisted markers) is high-value but secondary to these
three.
