# Cadence — UX Roadmap

_A senior product-design review of the Cadence editor, with a concrete plan to hit
the "very, very easy" bar without losing pro depth._

**North-star, as built:** graded dark, **amber** = action/brand, **teal** =
selection/applied, **Fraunces italic** for the user's own words (`.voice`),
**Space Grotesk** for chrome. Conversation-first Director + a rooms rail (Media /
Edit / Color / VFX / Audio / Deliver) + a direct-manipulation timeline. The
edit-doc is the single source of truth; every mutation routes through
`useDocHistory.commit` so undo/redo is universal.

**Scope note:** this document changes no code. It references the real components
in `apps/web/src/components/*` and the demo engine in
`packages/director/src/demo.ts`. Effort tags: **S** = <1 day, **M** = 1–3 days,
**L** = a week+.

---

## 1. Heuristic review, per surface

Scored against Nielsen's heuristics with an emphasis on _visibility of system
state_, _recognition over recall_, and _the beginner's first 90 seconds_.

### 1.1 Director chat — `DirectorRail.tsx`
**Works**
- The empty state is genuinely good: one clear CTA ("Choose video or photos"),
  a plain-language promise ("no timeline knowledge needed"), and the amber
  upload affordance. This is the strongest onboarding moment in the app.
- User turns render in Fraunces italic (`.voice`) — the north-star signature is
  legible and emotionally warm; it makes the user's intent feel _authored_.
- Director replies are tone-coded (`edit` = teal border, `error` = red,
  `info` = muted). Good, quiet status differentiation.
- Suggestion chips appear only while `messages.length <= 2` — a nice
  progressive fade-out so they don't nag.

**Confusing / missing**
- **The composer is dead until media exists** (`disabled={!hasMedia}`,
  placeholder "Add a video first"). A curious beginner types their idea first
  and hits a wall. There's no way to say "here's what I want" _before_ or
  _while_ uploading.
- **No streaming / progress narration.** `busy` shows three amber dots and
  "Director is editing…" — but a highlight cut, transcription, and export all
  look identical. The user can't tell a 300ms grade from a 20s render.
- **No message affordances.** You can't retry a failed edit, copy a reply, or
  "undo just that" from the transcript. An error message is a dead end — the
  only recovery is retyping.
- **Suggestions are static strings**, not context-aware. After a highlight cut,
  the obvious next suggestions ("add captions", "make it vertical") aren't
  surfaced here — they live only in QuickActions, which is a different surface.
- The transcript and QuickActions/room panels are **two parallel input
  systems** with no visible link. A tap on a QuickAction posts a `you` message
  ("cut a 60-second highlight…") into the chat, which is good — but the reverse
  discoverability (chat → chips) is missing.

### 1.2 Rooms rail — `RoomsRail.tsx`
**Works**
- Tight 68px icon rail, `aria-current="page"`, amber active state, tooltips
  with a one-line hint. Reads as a pro app's left dock.

**Confusing / missing**
- **Hidden on mobile entirely** (`hidden md:flex`). On a phone there is _no way
  to reach Color, VFX, Audio, or Deliver_ — a mass-market editor cannot ship
  its export panel behind a desktop-only rail. This is the single biggest
  responsiveness gap.
- **No state indication per room.** A room with applied edits (a look in Color,
  music in Audio) looks identical to an untouched one. A small teal dot on
  rooms that have content would turn the rail into a progress map.
- The brand "C" tile at the top is decorative but non-interactive — a wasted
  slot that users will click expecting "home".

### 1.3 Room panels — `RoomPanel.tsx`
**Works**
- Every room shares the same `Shell` (uppercase label + a horizontally
  scrolling strip). Consistent, low-chrome, and it keeps the vertical space for
  the preview.
- **Color room is a highlight**: preset pills _plus_ four live sliders
  (brightness/contrast/saturation/warmth) that edit the doc instantly via the
  pure `adjustColor` — with a Reset that disables when neutral. This is exactly
  the "simple by default, pro on demand" balance the whole app should copy.
- Media room's per-clip reorder/remove with `aria-label`s is honest and usable.

**Confusing / missing**
- **The rooms are strips, not rooms.** Color and Audio have real controls, but
  VFX is just four pills that fire NL prompts ("punch in for emphasis at 2s" is
  hard-coded to 2s!), and there is **no first-class panel for the
  interaction-demo engine at all** (see §7). "Room" oversells a one-line pill
  bar.
- **Horizontal overflow hides controls.** On a 13" laptop the Audio room's
  pills + two volume sliders + mute already overflow; the sliders scroll out of
  sight with no scroll affordance. Critical controls should never require a
  horizontal scroll to discover.
- **Deliver buries Export in a scrolling strip** next to aspect + quality chips.
  Export is the most important button in the app and it's the same size and
  weight as a "1:1" chip. (The TopBar `ExportMenu` is the real export path;
  having two competing exports is confusing.)
- VFX "punch in … at 2s" and the kinetic title hard-coded to `"Cadence"` are
  demo-ware: they'll do surprising things on a 45-second clip.

### 1.4 Preview / transport — `Stage.tsx`
**Works**
- Live preview on the real media with looks, Ken Burns, crossfades, PiP b-roll,
  punch-in, and captions is the product's magic — and it's genuinely live.
- Transport is clean: amber play FAB, `mm:ss / mm:ss` readout, a styled
  `.scrubber`, a mute toggle whose pressed state is color-carried.
- Aspect-correct letterboxed frame with a soft shadow reads premium.

**Confusing / missing**
- **rAF playback clock is decoupled from the `<video>` element.** `timeSec`
  advances on a `requestAnimationFrame` timer while the `<video>` is only
  re-seeked at cut boundaries. On a longer clip the audio and the visual can
  drift, and the scrubber is authoritative rather than the media — surprising
  when sound is on.
- **No frame-step, no in/out, no loop.** A beginner wanting "trim the boring
  start" has no J-K-L, no `.`/`,` frame-step, no "set start here".
- **"nudge end ±0.1s" is cryptic** and desktop-only (`hidden sm:flex`). It
  edits the last clip's duration — a concept the label never explains.
- No volume _level_ control in the transport, only mute; no fullscreen; no
  "fit / actual size".

### 1.5 Timeline — `CutsStrip.tsx`
**Works**
- This is a real NLE-lite: drag-trim with snapping (8px to edges/playhead/
  markers), split at playhead (S), drag-reorder with a drop indicator,
  ripple/plain delete, duplicate, per-clip volume/mute, zoom 1–24× with a nice
  ruler tick algorithm, markers, and a decoded audio waveform envelope.
- Every op routes through the editor's `commit`, so the whole timeline is
  undoable and drags coalesce into single undo steps. Architecturally excellent.
- Selected clip → a contextual `ClipInspector` with duration steppers, volume,
  reorder, split, duplicate, delete. Good recognition-over-recall.

**Confusing / missing**
- **No thumbnails on clips.** Clips show a duration string or a truncated
  caption; a beginner scanning for "the part where I wave" has nothing to look
  at. Filmstrip thumbnails are the #1 timeline legibility upgrade.
- **Discoverability of trim.** Trim handles are `opacity-0` until hover or
  selection. A first-timer doesn't know clip edges are draggable. The toolbar
  hint ("click a cut to select · drag the ruler to scan") is easy to miss.
- **Markers are editor-only and don't persist** (noted in CHANGELOG as a schema
  follow-up). A user who sets markers and reloads loses them — a quiet betrayal.
- The inspector is a _wrapping flex row_ of ~8 buttons; on a narrow timeline it
  reflows unpredictably. "Ripple delete" vs "Delete" is pro jargon with no
  visual cue for which one closes the gap.
- Right-click-to-remove a marker is invisible; there's no menu telling you.
- Keyboard reorder/trim exists only via the inspector's arrow buttons — the
  clip elements are focusable (`tabIndex=0`) but arrow keys don't nudge them.

### 1.6 Applied-status — `AppliedStatus.tsx`
**Works**
- Exactly the right idea: a live, read-only chip strip (Aspect / Cuts / Look /
  Quality / Captions / Music) so an edit "visibly registers". Tone-coded to the
  north-star (teal = applied, amber = quality). This is the app's confidence
  layer and it's underused.

**Confusing / missing**
- **Chips are inert.** They report state but you can't click "Look: Cinematic"
  to change or remove it. They're the perfect place for one-click _undo of a
  specific edit_ ("×" to remove the look) — recognition + reversibility in one.
- No animation when a chip appears, so the "it registered!" moment is silent.
  A brief teal pulse on add would close the feedback loop.
- Doesn't surface everything the doc can hold (speed ramps, transitions, VFX
  overlays, voice-over) — so some edits register and some don't, unpredictably.

### 1.7 Top bar — `TopBar.tsx`
**Works**
- Click-to-rename title, undo/redo icon buttons with shortcut hints, a
  `{ } code` toggle, contextual Save (project-bound only), Export menu, and a
  tidy overflow (shortcuts / duplicate / start-over). Dense but well-labeled.

**Confusing / missing**
- **Two exports** (TopBar `ExportMenu` + Deliver room button) with different
  capabilities is a classic "which button is real?" trap.
- Undo/redo are 32px icon-only buttons far from the timeline where edits happen;
  discoverability of undo — the #1 confidence tool for beginners — is low.
- Save vs Export vs Duplicate-as-JSON is three different "keep my work" verbs
  with overlapping mental models and no first-run explanation.
- `{ } code` is a power-user escape hatch sitting at equal weight with Save —
  fine for the "edits-as-code" identity, but it will mystify the mass-market
  user it's adjacent to.

### 1.8 Export — `ExportMenu.tsx` / `DeliverRoom` / `exportDoc`
**Works**
- The honesty is admirable: real `.mp4` via ffmpeg, graceful 501 → "here's the
  edit-doc JSON" fallback, security-confined paths. The messaging in
  `exportDoc` ("faithful, no content changes") matches the north-star values.

**Confusing / missing**
- **Export is a black box.** "Rendering your video with ffmpeg…" then a file
  drops. No progress %, no cancel, no "12s of 40s". For a 4K export this is a
  long, silent, un-cancellable wait.
- The ffmpeg-missing fallback dumps a JSON file on a non-technical user with a
  message about `docker compose up` — accurate but alienating for the target
  audience. It needs a "what is this?" and a hosted-render path (money-gated).
- No preview-of-output (thumbnail/first frame), no share step, no history of
  past exports.

---

## 2. The "very, very easy" bar

Goal: a non-editor uploads a clip and has something they're proud to post in
**under two minutes**, without learning a single timeline concept. Principles:

### 2.1 Onboarding & empty states
- **Let people type intent before/while uploading.** Enable the composer in a
  "tell me what you want and I'll ask for footage" mode; queue the request and
  fire it the instant media loads. (`DirectorRail` `disabled={!hasMedia}` →
  a deferred-intent state.)
- **A 3-step first-run coach mark** overlaying the three real surfaces: "1 Add
  media · 2 Describe or tap · 3 Export". Dismissible, `localStorage`-remembered
  (the app already uses `cadence:*` keys), reduced-motion safe.
- **Recipe starters, not blank prompts.** Replace generic suggestion strings
  with outcome cards: "Talking-head → clean cut + captions", "Photos → 30s
  reel", "Product demo → guided walkthrough". Each is a _chain_ of tools, which
  the Director already supports.

### 2.2 Sensible defaults
- **Auto-transcribe on upload** (already done) → **auto-offer** the two edits
  that footage type implies. Video with speech → pre-stage "Remove filler +
  Captions" as a one-tap "Apply starter". Photos → the slideshow already
  auto-builds; keep that, it's the best default in the app.
- **Default unmuted preview** (already the case) is correct — beginners expect
  sound.
- **Aspect intent from the platform, not the math.** Offer "TikTok / Reels
  (9:16)", "YouTube (16:9)", "Instagram (1:1/4:5)" labels alongside the ratios
  the Deliver/Color rooms use.

### 2.3 One-tap actions
- Keep QuickActions, but **make the top row outcome-first and stateful**: an
  action that's already applied shows as active (teal), tapping again removes
  it. Today `QuickActions` buttons are stateless fire-and-forget; the Color/
  Deliver pills already model `active` — unify on that pattern.
- **Parameterize the dangerous hard-codes.** "Punch-in at 2s" should punch in at
  the _playhead_; the kinetic title should prompt for text (or default to the
  project title) instead of literally "Cadence".

### 2.4 Undo confidence
- **Promote undo to a always-visible, labeled control** near the timeline, not
  just a 32px TopBar icon. Pair it with a transient toast after every Director
  edit: "Cinematic look applied · **Undo**". The commit history already exists;
  this is pure surfacing.
- **Make AppliedStatus chips removable** (× to revert that one edit) — targeted
  undo without walking the whole history stack.

### 2.5 Live feedback
- **Differentiate busy states.** `busy` should carry a label: "Transcribing…",
  "Cutting highlight…", "Rendering 4K…". A determinate bar for export.
- **Pulse on apply.** When a new AppliedStatus chip appears or the doc changes,
  a 200ms teal pulse (reduced-motion: opacity only) tells the eye "that worked".
- **Optimistic scrub to the change.** After an edit, seek the playhead to the
  first affected clip and auto-play 2s so the user _sees_ what changed instead
  of hunting for it.

### 2.6 Progressive disclosure
- **Two-tier every room:** a "Simple" face (2–4 outcome chips) and a "More"
  toggle that reveals the sliders/pro controls. Color already does this
  implicitly (presets then sliders); make it explicit and copy it everywhere.
- **Hide the timeline by default for first-timers**, collapsed to a thin strip;
  expand on first interaction or via a "Show timeline" affordance. The
  conversation + preview is enough for the 2-minute path.
- Keep `{ } code` exactly where it is — it's the identity payoff for the curious,
  correctly tucked behind a toggle.

### 2.7 Prompting ↔ direct manipulation balance
- **Rule of thumb:** _describe to create, touch to refine._ The Director is best
  at the first 80% ("make a 30s vertical reel with captions and a warm look");
  the timeline/inspector/sliders own the last 20% ("this cut is 0.3s too long").
- **Round-trip both ways.** A direct edit should post a plain-language note into
  the chat ("Trimmed clip 2 to 4.2s") so the transcript stays a complete,
  narratable history — the same way QuickActions already post a `you` message.
  This keeps the "edits-as-conversation" story true even when the user drags.

---

## 3. Per-room UX specs

Each room gets a **Simple face** (always visible, ≤4 controls) and **More**
(revealed on demand). All controls stay on the doc-as-source-of-truth model so
they reflect NL edits too (the Color room is the reference implementation).

### 3.1 Media
- **Simple:** a horizontal **thumbnail tray** of media (not text pills), each
  with duration/dimension badge, drag-to-reorder, and an "×" remove. A big
  dashed "+ Add" drop target that also accepts OS drag-drop.
- **More:** per-item "replace", "trim source in/out before it hits the
  timeline", transcript preview for videos (so captions feel trustworthy).
- **Keep uncluttered:** one row of thumbnails; everything else in a per-item
  popover on click. Replaces today's text-pill list in `RoomPanel`'s `media`
  branch.

### 3.2 Edit (currently QuickActions)
- **Simple:** outcome chips, stateful (applied = teal, tap to remove), ordered
  by the footage type. Top 4 for video: **Highlight · Captions · 9:16 ·
  Cinematic**. For photos: **Slideshow · 9:16 · Warm · Music**.
- **More:** the full grid (today's `VIDEO_ACTIONS`/`IMAGE_ACTIONS`), plus a
  "Trim & split" hint that focuses the timeline.
- **Controls:** chips (tap), with the "Remove filler / Highlight" pair exposing
  a target-length slider on long-press/expand ("highlight length: 30s") instead
  of the hard-coded 60s.

### 3.3 Color
- **Keep as-is; it's the model.** Simple = preset pills (Warm/Cool/Vivid/B&W/
  Cinematic/…); More = the four live sliders + Reset.
- **Add:** a before/after press-and-hold on the preview, and make each preset
  pill show `active` from the doc (already wired via `status.look`).
- **Add:** the sliders should live in a poppable panel so they don't force the
  Shell to scroll horizontally on small screens.

### 3.4 VFX
- **Replace the four NL pills with real controls.** This room today just fires
  hard-coded prompts.
  - **B-roll:** pick a media → a **9-cell corner picker** for PiP position +
    a size slider (drives `transform.scale/x/y` the Stage already reads).
  - **Punch-in:** "Add at playhead" + an intensity slider; visualize the pulse
    on the clip.
  - **Overlays:** vignette / grain / light-leak toggles (the `apply_vfx` tool
    exists) as chips with intensity.
  - **Transitions:** a small transition picker between selected clips
    (crossfade / dip-to-black / slide / wipe — all already in the engine).
- **Keep uncluttered:** icon + label chips that open a compact popover with the
  one slider each needs.

### 3.5 Audio
- **Simple:** **Add music/voice-over**, a master **Duck-under-speech** toggle,
  and a **preview mute**. That's the 2-minute path.
- **More:** the per-track volume sliders (Music / Voice), and a per-clip volume
  in the inspector (already exists).
- **Fix the overflow:** put the sliders in a vertical popover, not inline in the
  scrolling `Shell`, so they're never scrolled off-screen. Add simple **level
  meters** so "is my music too loud?" is answerable by eye.
- **Voice-over recorder** stays — it's a differentiator — but add a live input
  meter and a 3-2-1 countdown.

### 3.6 Deliver
- **Make Export the hero.** One primary amber **Export** button, big, with the
  output spec beneath it ("1080×1920 · MP4 · 30fps"). Remove the competing
  strip-button; keep aspect/quality as the "More" controls.
- **Platform presets:** "TikTok/Reels", "YouTube", "Instagram", "Original" that
  set aspect+resolution+fps together.
- **Progress + result:** a determinate render bar with cancel, then a result
  card (first-frame thumbnail, file size, "Download", "Export again",
  "Copy edit-doc"). Fold the ffmpeg-missing JSON fallback into a calm "advanced
  / self-host" disclosure rather than a surprise download.
- **One export path.** Resolve the TopBar-vs-Deliver duplication: TopBar =
  quick "Export (last settings)"; Deliver = the full options surface.

---

## 4. Timeline UX (make it a real, approachable NLE)

`CutsStrip.tsx` is already strong; these turn it from "impressive demo" into
"trustworthy tool".

### 4.1 Selection
- Click = select + seek (already). Add **click empty lane = deselect**,
  **Shift-click = range/multi-select** (for batch delete/volume), and a clear
  focus ring distinct from the amber selected ring (use teal for keyboard focus
  vs amber for selection to match the north-star roles).

### 4.2 Trimming
- **Always show a subtle grab affordance** on clip edges (a 2px inset handle at
  rest, not `opacity-0`) so trim is discoverable without hover.
- Show a **live duration/timecode tooltip** at the dragged edge ("4.2s").
- Enforce and _show_ `MIN_CLIP_SEC` (the code guards it; the UI should hint when
  you hit the floor).

### 4.3 Snapping
- Snapping to edges/playhead/markers exists (`SNAP_PX = 8`). **Show it:** a
  magnet flash / vertical guide line at the snap target when engaged, and a
  **hold-Alt to disable snap** modifier for fine control.

### 4.4 Zoom
- Keep the 1–24× slider; add **zoom-to-fit** and **zoom-to-selection** buttons,
  **Ctrl/Cmd-scroll to zoom** at the cursor, and **fit on double-click** of the
  ruler. Persist zoom per project.

### 4.5 Playhead
- Make the playhead **draggable across the whole track stack** (today the ruler
  seeks; extend the grab area to the playhead cap). Snap the playhead to clip
  edges with a modifier. Keep it visually authoritative (amber line + cap).

### 4.6 Keyboard shortcuts
- Today: Space, ←/→ (±1/±5s), Home, S (split), Del (ripple), M (marker), undo/
  redo, `?`. **Add and advertise:**
  - `,` / `.` frame-step; `I` / `O` set in/out; `Home`/`End` bounds.
  - `[` / `]` trim selected clip start/end to playhead.
  - `+` / `-` zoom; `\` zoom-to-fit.
  - `C` duplicate, `D`/`G` toggle ripple mode.
  - Arrow keys nudge a _selected_ clip when the timeline has focus (it's already
    `tabIndex=0`).
  - Keep the "ignored while typing" guard (already robust in `Editor.tsx`).
- Update `ShortcutsHelp.SHORTCUTS` in lockstep — it's the single source for the
  popover, so it stays honest.

### 4.7 Thumbnails / waveforms
- **Filmstrip thumbnails** on visual clips (sample frames from the object-URL
  `<video>`/`<img>`, cache per media+time like `computeWaveform` already caches
  peaks, off the render path). This is the highest-impact legibility change.
- Waveform already renders as a teal envelope — **overlay it on the audio clip
  itself**, not only in a separate strip, and clip it to the clip bounds.

### 4.8 Drag interactions
- Reorder with a drop indicator exists — **add a ghost/opacity on the dragged
  clip** and auto-scroll when dragging near the lane edges.
- **Cross-track drag** (move a clip between main and b-roll) as a later,
  guarded step. Today reorder is within a sequential track only, which is a safe
  default — keep it until thumbnails land.

---

## 5. Accessibility, responsiveness & motion

### 5.1 Accessibility (WCAG 2.2 AA)
- **Contrast:** verify `--color-faint (#667181)` on `--color-panel (#10151c)` —
  the many `text-faint` labels ("one-tap", "applied", ruler ticks) risk failing
  4.5:1 for the small sizes used. Bump faint or the size where they coincide.
- **Sliders need keyboard + ARIA parity:** the Color/Audio `input[type=range]`
  have `aria-label`s (good) but no `aria-valuetext` with units; add it so a
  screen reader hears "Warmth, 60%", not "0.60".
- **Timeline is a canvas of custom controls:** clips are `role="button"` with
  labels (good). Add a **roving-tabindex** so Tab lands on the timeline once and
  arrows move between clips, and expose trim/split via an ARIA menu or documented
  keys (drag-only actions must have a keyboard equivalent — WCAG 2.1.1).
- **Live regions:** Director replies and busy/applied changes should announce via
  an `aria-live="polite"` region so non-visual users get the "it registered"
  signal that §2.5 gives sighted users.
- **Focus management:** modals (`ShortcutsHelp`, `OverflowMenu`, ExportMenu)
  should trap focus and restore it on close; ShortcutsHelp closes on Esc (good)
  but doesn't trap Tab.
- **Hit targets:** the 24–26px timeline icon buttons and marker glyphs are below
  the 44px touch target; enlarge on coarse pointers.

### 5.2 Responsiveness
- **The rooms rail and its panels must exist on mobile.** Today `RoomsRail` is
  `hidden md:flex` and the ResizeHandles are desktop-only — a phone user can't
  reach Color/VFX/Audio/**Deliver/Export**. Ship a **bottom tab bar** on mobile
  mapping to the six rooms, and render room panels as bottom sheets.
- **Single-column stack under `md`:** preview on top, a collapsible Director
  sheet, a collapsible timeline. The `h-dvh` flex row in `Editor.tsx` should
  switch to a column layout with the panels as sheets.
- **Horizontal-scroll strips are a mobile trap** (Audio/Deliver). Convert the
  `Shell` strips to wrap or to sheets at narrow widths.
- **Timeline touch:** pointer events already power drag (good for touch), but
  add momentum scroll, pinch-to-zoom, and larger handles on coarse pointers.

### 5.3 Motion
- `globals.css` already honors `prefers-reduced-motion` globally (nukes
  animation/transition durations) — **excellent baseline; keep it.**
- For every _new_ feedback animation (chip pulse, snap flash, auto-play-after-
  edit, cursor demo motion), provide a reduced-motion variant that conveys the
  same info via **opacity/color, not movement** (e.g. chip fades in instead of
  sliding). The interaction-demo's gliding cursor should, under reduced-motion,
  **cut between waypoints** rather than ease.
- Keep motion **functional, ≤200ms, ease-out** for UI; reserve longer eases for
  the _content_ (Ken Burns, kinetic titles) which are the product, not chrome.

---

## 6. Prioritized UX backlog

Ranked by impact ÷ effort. Waves are shippable in order.

### ⭐ Top 5 quick wins (do first)
1. **Labeled busy states + determinate export progress** (S) — kill the "silent
   black box". `busy` carries a verb; export shows %/cancel. _Surfaces §1.1,
   §1.8, §2.5._
2. **Undo toast after every edit + make AppliedStatus chips removable** (S) —
   the single biggest confidence lever; the commit history already exists.
   _§1.6, §2.4._
3. **Enable "describe first, upload second"** (S) — defer the intent, fire on
   load; unblocks the most natural first move. _§1.1, §2.1._
4. **De-hardcode the surprising actions** (S) — punch-in at playhead, kinetic
   title uses project title / prompts, highlight length slider. _§1.3, §2.3._
5. **Single, prominent Export** (S) — one hero button, resolve TopBar/Deliver
   duplication, fold JSON fallback into an "advanced" disclosure. _§1.7, §3.6._

### Wave 1 — beginner trust (M, 1–2 wks)
6. **Filmstrip thumbnails on timeline clips** (M) — top legibility win; cache
   like the waveform. _§1.5, §4.7._
7. **Mobile shell: bottom room tabs + panels-as-sheets + single-column stack**
   (M/L) — makes the app usable on a phone; currently Deliver is unreachable.
   _§1.2, §5.2._
8. **First-run 3-step coach marks + recipe starter cards** (M) — replace generic
   suggestions with outcome chains. _§2.1._
9. **Two-tier rooms (Simple/More) applied everywhere** (M) — copy the Color
   model to VFX/Audio/Deliver; fixes horizontal-overflow hiding. _§1.3, §2.6._
10. **Auto-scrub-to-change + apply pulse** (S/M) — close the "did it work?" loop.
    _§2.5._

### Wave 2 — pro depth & polish (M/L)
11. **VFX room real controls** (M) — corner picker + sliders for b-roll/punch-in/
    overlays/transitions instead of NL pills. _§3.4._
12. **Timeline keyboard + a11y parity** (M) — roving tabindex, in/out, frame-step,
    keyboard trim/move, live regions, `aria-valuetext`. _§4.6, §5.1._
13. **Persist markers (+ per-clip muted) in schema** (M) — stop losing user state
    on reload; CHANGELOG already flags this. _§1.5._
14. **Sync the playback clock to the media element** (M) — fix audio/visual drift
    on long clips; make media authoritative, scrubber reactive. _§1.4._
15. **Export result card + history + platform presets** (M) — thumbnail, size,
    re-export, TikTok/YouTube/IG presets; a hosted-render path behind the money
    gate for the ffmpeg-less majority. _§1.8, §3.6._

---

## 7. Interaction-demo — a beginner-first interaction spec

**Context (as built):** the engine already exists (`packages/director/src/
demo.ts`, S3.6). `buildDemo(screens, opts)` turns ordered screenshot _images_
into a walkthrough EditDoc: full-frame screens sequenced with a crossfade, a
**typewriter** text primitive, an eased **cursor** with click ripples, and a
**callout** (highlight box + dim + optional zoom). A `login` preset types an
email + password and glides the cursor to a button and clicks. Fields/buttons
are placed at **fractional positions** (e.g. `fieldXFrac 0.34`, `buttonYFrac
0.63`) because exact pixel detection needs a vision model (money-gated). The
manual tools are `add_cursor` / `type_text` / `add_callout`. **There is no
direct-manipulation UI for any of this yet** — it lives behind Director prompts.

The design job: give a non-editor a way to place cursor/typed-text/clicks **with
almost no effort**, honestly acknowledging we can't yet see the screenshot.

### 7.1 The core interaction: place-by-pointing, not by numbers
- **Click the preview to place.** When a demo screen is showing in the `Stage`,
  the user's click on the frame becomes a fractional `(xFrac, yFrac)` — the exact
  unit `buildDemo`/`typeText`/`addCursor` already consume. No number entry, no
  coordinate fields. This is the whole trick: the screenshot _is_ the canvas.
- **Three place-modes** as a small floating toolbar over the preview when a demo
  screen is active: **Type here**, **Click here**, **Callout here**. Pick a mode,
  click the frame, done.
  - _Type here_ → drops a `type_text` at the click with an inline text field
    (the typewriter animation previews live).
  - _Click here_ → appends a cursor waypoint + click at the point; the cursor
    auto-routes from its previous rest position (the engine already chains
    waypoints).
  - _Callout here_ → drag a box on the frame → `add_callout` with that rect.

### 7.2 Sensible auto-placement (so "just works" beats "place everything")
- **Keep the fractional login defaults** as the zero-effort path: "Build login
  demo" yields a typed email + password + button click with no clicks required.
  Those defaults (`LOGIN` constants) are good starting geometry.
- **Snap-to-guides:** overlay rule-of-thirds + vertical-center guides on the
  frame; placements snap to them (login cards, buttons, and titles cluster on
  center / thirds). This makes a single rough click land "right".
- **Auto-sequence timing:** the engine already extends screen 0 for interactions
  and spaces typing/click with sane gaps (`RATE`, `+0.4s`, `+0.9s glide`). Never
  ask the beginner for timings; expose only a global "faster/slower" speed.
- **Auto-label order:** as the user drops steps, number them (1 type email →
  2 type password → 3 click) and show them as a compact step list beside the
  preview — editable by reorder, mirroring the timeline model.

### 7.3 Nudge, don't type
- Every placed element gets a **draggable handle on the preview** (cursor target,
  text pill, callout box). Dragging updates the fractional position through the
  same `commit` path — so it's undoable and reflects in `{ } code`.
- **Arrow-key nudge** the selected demo element by 1% (Shift = 5%); this is the
  "positions are nudgeable" promise from the CHANGELOG made real and keyboard-
  accessible.
- **Confidence affordance:** because we can't see the screenshot, show a subtle
  "drag me onto your button" coach the first time, and a "does this line up?"
  press-and-hold that plays just that step.

### 7.4 Where it lives in the app
- **A dedicated "Walkthrough" entry**, not a buried pill. Two good homes:
  1. A **template on the dashboard** ("Product walkthrough from screenshots")
     that opens the editor in demo mode, and
  2. An **image-mode recognition:** when uploaded media are UI screenshots, the
     Director offers "Build a walkthrough" alongside "Make a slideshow" (today
     photos auto-route to slideshow only).
- In demo mode, the **VFX room becomes the "Steps" room**: the place-modes
  toolbar, the step list, and per-step timing/speed. This finally gives that
  room real controls (§3.4) and gives the demo engine a UI.

### 7.5 The honest upgrade path
- Label auto-placement as "roughly placed — drag to fit" so expectations are
  set; never claim pixel accuracy we don't have.
- When the **vision auto-detect** (money-gated follow-up) ships, it simply
  pre-fills the same draggable handles at detected field/button rects — the UI
  doesn't change, the placements just start correct. Design the manual flow so
  vision is an accelerator, not a different mode.

---

### Closing note
Cadence's architecture is already doing the hard part right: one edit-doc, one
commit/undo path, pure ops, live preview, and a genuinely warm north-star voice.
The gap to "very, very easy" is almost entirely **surfacing** — showing state,
confirming actions, making touch discoverable, and meeting people on a phone. The
top-5 quick wins are all small and mostly presentational, and they move the
beginner-confidence needle the most.
