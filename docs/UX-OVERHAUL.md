# Cadence — UX/UI Overhaul Plan

Advisory only. No code was changed to produce this document. It audits the whole
app and specifies a concrete redesign, grounded in the real components. Every
recommendation cites the file it touches so engineering can act without re-deriving
context.

Author lens: senior UX/UI + design-systems. Ruthless bias toward a **non-pro**
user who wants CapCut-level ease, not a pro NLE.

---

## 0. TL;DR — the top moves

1. **Give the canvas room to breathe.** The editor permanently spends ~380px on
   the chat rail and (when open) ~440px on the code panel. Make **both collapsible
   to a thin re-open tab**, persisted, with keyboard shortcuts. This is the single
   biggest win for editing space. (`Editor.tsx`, `DirectorRail.tsx`, `CodeDrawer.tsx`, `RoomsRail.tsx`)
2. **Collapse Color + VFX into ONE "Design" surface** — a browsable, thumbnail
   preset gallery (Looks / Color / Backgrounds / Text / Overlays) instead of two
   overlapping pill-strips. Ship a **much larger, named preset set**. (`RoomsRail.tsx`, `RoomPanel.tsx`, `lib/status.ts`, `lib/text-presets.ts`)
3. **Rebuild the Media room as a thumbnail grid** with real posters, type/duration
   badges, and — critically — make each tile a **drag source**. (`RoomPanel.tsx`)
4. **Add true drag-and-drop onto the timeline** — from the Media grid and from the
   OS (drop files onto a track lane). Today there is *zero* HTML5 DnD anywhere. (`CutsStrip.tsx`, `Editor.tsx`, `Stage.tsx`)
5. **De-clutter the brand marks in editor chrome.** The "C" logo renders **twice**
   at once (rails) plus the DirectorRail tagline; keep one, drop the rest.
6. **Standardize the design system** — the pieces are good but ad hoc (pill, slider,
   panel styles are re-declared per component). Extract shared primitives.

---

## A. Heuristic audit — ranked problems

Severity: **P0** = blocks the stated user goals · **P1** = major friction · **P2** = polish.

| # | Sev | Problem | Where | Heuristic |
|---|-----|---------|-------|-----------|
| A1 | **P0** | **No way to hide the chat or code panel.** The chat rail is always mounted at `--rail-w` (min 300px, default 380). The code panel can be toggled but the chat rail cannot — editing space is permanently taxed. On a 1440px screen the rail eats ~26% before any code panel. | `Editor.tsx` L1215-1233 (rail always rendered), L1362-1376 (code toggled) | Flexibility & efficiency; user control |
| A2 | **P0** | **"Styles/colors/design" are scattered across two rooms with overlap.** Looks live in **Color**; effects, text, stickers, chroma, masks live in **VFX**; backgrounds live nowhere discoverable (the schema supports `meta.background` + `SolidClip` but there's no UI surface). A non-pro has to know which room hides which knob. | `RoomsRail.tsx` L17-18; `RoomPanel.tsx` ColorRoom L839+, VfxRoom L1136+ | Match to real world; consistency |
| A3 | **P0** | **Media room is a horizontal text-pill strip, not a browsable view.** Clips are rounded chips with a `kind` word + filename + up/down/delete. No thumbnail, no poster, no visual scan. The user literally said "media view isn't easy to see." | `RoomPanel.tsx` L232-301 | Recognition over recall; visibility |
| A4 | **P0** | **No drag-and-drop of media onto the timeline** (nor OS-file drop). A grep for `onDrop`/`dataTransfer`/`draggable` across `components/` + `app/` returns **nothing**. Clips can only be pointer-dragged *once already on* the timeline; getting media *onto* a specific track is impossible except via Director prompts. | `CutsStrip.tsx` (pointer-drag only, L1010-1048), `RoomPanel.tsx` media chips | Match to real world; user control |
| A5 | **P1** | **Redundant brand marks in editor chrome.** The amber "C" renders in `RoomsRail` (L34) *and* `DirectorRail` (L46) at the same time, plus DirectorRail's "Cadence / Describe the edit. I'll make it." tagline sits in prime editing real estate. Reads as watermark-y clutter. (NB: the "Cadence 0"/"Photo 1" text in the *preview* is the test fixture's drawn content, per the brief — not chrome; excluded.) | `RoomsRail.tsx` L34, `DirectorRail.tsx` L45-51 | Aesthetic & minimalist design |
| A6 | **P1** | **Contextual room panels are dense horizontal pill-scrollers.** Color/VFX/Audio/Deliver each render a `flex ... overflow-x-auto` strip of tiny 12px pills and 120px sliders. Discoverability is poor: a control you can't see (scrolled off) doesn't exist to a novice. Rooms cap at `max-h-[42vh]` and scroll. | `RoomPanel.tsx` Shell L109-116, Rows throughout | Visibility; recognition |
| A7 | **P1** | **The "Edit" room and the timeline both fight for the same job.** QuickActions is a prompt-firing strip; the timeline is direct manipulation. A novice doesn't know that "one-tap" chips and the timeline are two routes to the same doc. | `QuickActions.tsx`, `CutsStrip.tsx` | Consistency; mental model |
| A8 | **P1** | **Preset feedback is prompt-mediated, so looks feel laggy/opaque.** Color LOOK pills fire `onAction("give it a X look")` → a Director round-trip, while the sliders below apply *instantly* client-side via `onApplyDoc`. Two latencies for one panel. | `RoomPanel.tsx` L890-902 (looks via `onAction`) vs L866-877 (sliders via `onApplyDoc`) | Consistency; feedback |
| A9 | **P2** | **No thumbnails on preset controls anywhere.** Looks, text presets, transitions are all text. CapCut/Figma-grade tools show the result. | `RoomPanel.tsx`, `CutsStrip.tsx` | Recognition over recall |
| A10 | **P2** | **Design-system drift.** `Pill`, `FxSlider`, `GradeSlider`, `VolumeSlider`, `NudgeField`, `IconButton` are defined locally; the same "rounded-full border border-line bg-elevated" chip pattern is re-typed in 6+ files with small variations. | `RoomPanel.tsx`, `TopBar.tsx`, `QuickActions.tsx`, `AppliedStatus.tsx` | Consistency & standards |
| A11 | **P2** | **Empty/first-run states are thin outside the chat rail.** The Stage empty state is just "Preview will appear here"; rooms show "No media yet." with no CTA. Onboarding lives only in the chat rail's dashed card. | `Stage.tsx` L211-215; `RoomPanel.tsx` L236 | Help & documentation; onboarding |
| A12 | **P2** | **Mobile: the whole editor is desktop-only.** `RoomsRail` is `hidden md:flex`, resize handles are `hidden md:block`, panel widths key off `md:`. Below `md` the layout stacks with no room switcher and no timeline affordances. | `RoomsRail.tsx` L31, `Editor.tsx` L1216, L1230 | Flexibility; accessibility |

**Surrounding surfaces (landing · dashboard · settings):**

| # | Sev | Problem | Where | Heuristic |
|---|-----|---------|-------|-----------|
| A13 | **P0** | **Native `window.prompt` / `window.confirm` for create-name, rename, and delete.** Unstyled, unbranded, not mobile-friendly, untestable. Biggest UX debt in the authed app. | `dashboard/ProjectHub.tsx`, `dashboard/ProjectCard.tsx`, `dashboard/NewProjectMenu.tsx` | Consistency; error prevention |
| A14 | **P1** | **No project thumbnails on dashboard cards.** A *video* project shows a generic film icon only — text-only cards for a visual tool. | `dashboard/ProjectCard.tsx` | Recognition over recall |
| A15 | **P1** | **Hydration flashes** — dashboard view/sort and editor prefs default-then-hydrate from localStorage → visible flicker; some controls flash disabled on first paint. | `dashboard/ProjectHub.tsx`, `settings/EditorPrefs.tsx` | Feedback; polish |
| A16 | **P1** | **Non-sticky nav** on landing and authed pages; on mobile the in-page anchor nav (`hidden sm:inline-block`) and signed-in email both vanish. | `app/page.tsx`, `TopNav.tsx` | Navigation; mobile |
| A17 | **P1** | **Incomplete menu keyboard semantics.** `role="menu"` components lack in-menu arrow nav + focus return (unlike the exemplary `SettingsView` tablist). | `dashboard/ProjectCard.tsx`, `dashboard/NewProjectMenu.tsx` | Accessibility |
| A18 | **P2** | **Settings tabs not URL-addressable**; refresh/back resets to Profile; members mgmt is a visible "coming soon" dead-end. | `settings/SettingsView.tsx` | User control; deep-linking |
| A19 | **P2** | **Jargon leakage** for a mass-market tool: "append-only edit-doc history", exposed User ID, `docker compose` hints. | `dashboard/page.tsx`, `settings/ProfileForm.tsx` | Match to real world |
| A20 | **P2** | **Validation mismatch** — ProfileForm `maxLength={200}` but error fires >120; duplicated dashboard header markup (fallback vs `ProjectHub`); red destructive states use raw Tailwind colors, not a token. | `settings/ProfileForm.tsx`, `dashboard/page.tsx`, `globals.css` | Error prevention; consistency |
| A21 | **P2** | **Dark-only, no light mode**; `layout.tsx` has no skip-link/`<main>` landmark. | `app/layout.tsx`, `globals.css` | Accessibility; flexibility |

> **Strengths to preserve** (don't regress these in the overhaul): strong token discipline;
> genuinely good empty/error/offline states; optimistic updates with revert (`ProjectHub`);
> `prefers-reduced-motion` compliance; global `:focus-visible` rings; the fully-accessible
> `SettingsView` tablist (use it as the a11y reference for A17); and the try-before-signup
> `PromptChips` onboarding pattern.

---

## B. Concrete redesign specs (the six asks)

### B1 — Collapse / hide the chat panel AND the code panel

**Goal:** reclaim up to ~800px of canvas; both panels one keystroke or one click away.

**Current:** `Editor.tsx` holds `railWidth` (persisted `cadence:railW`), `codeWidth`
(`cadence:codeW`), `codeOpen` (not persisted). The chat rail is rendered
unconditionally (L1215); only the code panel is conditionally mounted (L1362).

**Spec — chat rail (DirectorRail):**
- New state `railOpen` (default `true`), persisted to `localStorage["cadence:railOpen"]`
  alongside the existing width keys (L313-333 pattern).
- **Collapsed presentation:** the rail column collapses to a **44px vertical stub**
  pinned to the left edge (inside the `md:w-[var(--rail-w)]` wrapper, L1216): a chat-bubble
  icon + a rotated "Director" label + an amber unread dot if new director messages arrived
  while collapsed. Click anywhere on the stub → expand.
- **Expanded → collapse control:** a chevron button in the DirectorRail brand header
  (`DirectorRail.tsx` L45) — `‹‹` collapses. Mirror it on the stub.
- **Keyboard:** `[` toggles the chat rail. Add to the global handler in `Editor.tsx`
  (L1158-1205) *after* the `typing` guard, and register in `SHORTCUTS` (`ShortcutsHelp.tsx` L6).
- **Persistence:** restore on mount in the existing width-restore effect (L313-324).

**Spec — code panel (CodeDrawer):**
- Already toggled via `codeOpen`/`onToggleCode` (TopBar `{ } code` button, L203-215).
  Two upgrades: (a) **persist** `codeOpen` to `localStorage["cadence:codeOpen"]`;
  (b) **keyboard** `]` toggles it (register in `SHORTCUTS`).
- CodeDrawer already has a close "×" (L14-21) — keep; make the TopBar button read as a
  true toggle (it already sets `aria-pressed`).

**Spec — "focus mode" (bonus, cheap):** `\` (backslash) collapses *both* rails at once →
maximal canvas. A small toast confirms "Focus mode — press \ to bring panels back."

**Layout mechanics:** the flex row in `Editor.tsx` (L1213) already uses `--rail-w`/`--code-w`
CSS vars on wrapper divs. Collapsing = swap the wrapper's width to `44px` (rail) / `0` +
unmount (code), and hide the corresponding `ResizeHandle` (L1229, L1364). No engine work.

**Acceptance:** rail + code each toggle by click and by key; state survives reload;
canvas visibly grows; `?` help lists the new keys; nothing shifts layout on mobile
(guard behind `md:`).

---

### B2 — One "Design" surface (consolidate Looks / Filters / Color / Backgrounds / Text / Overlays)

**This is the "add more options, pic styles, design and colors — all in ONE place with easy
UI" ask.** Today: `Color` room = looks + grade + curves + scopes; `VFX` room = effects +
stickers + text + chroma + blend + blur + mask. Backgrounds have no UI. The overlap is the
core problem.

**Move:** Replace the `color` and `vfx` rooms with a single **Design** room (rename the rail
entry; keep VFX's advanced compositing under an "Advanced" disclosure so pros keep it).

`RoomsRail.tsx` L12-21 — new room set:
```
Media · Edit · Design · Words · Audio · Deliver   (+ Demo under an "…more")
```
(Color + VFX → **Design**; this also thins the 8-item rail that currently scrolls concepts.)

**Information architecture of the Design panel** — a left **category list**, a right
**thumbnail gallery**. Categories:

| Category | What it is | Backed by (exists today) |
|----------|-----------|--------------------------|
| **Looks / Filters** | One-tap graded looks, applied instantly | `LOOKS` + `LOOK_SIGNATURES` (`lib/status.ts` L4-31); apply via `adjustColor`/`currentGrade` **client-side** (fixes A8) not `onAction` |
| **Color grade** | Brightness/Contrast/Saturation/Warmth/Hue + tone curve + scopes | ColorRoom sliders/`CurveEditor`/`Scopes` (`RoomPanel.tsx` L839-961) — moved verbatim under this tab |
| **Backgrounds** | Solid color / gradient / letterbox fill behind the frame | `meta.background` (`schema.ts` L433) + `SolidClip` (L481-493) — **new UI, existing schema** |
| **Text styles** | Titles, subtitles, lower-thirds, captions styling | `TEXT_PRESETS` (`lib/text-presets.ts` L118+) + `StickersTextSection` (`RoomPanel.tsx` L1380) |
| **Overlays / FX** | Vignette, grain, light leak, stickers, PiP b-roll | VFX effects Row (`RoomPanel.tsx` L1238-1246) + stickers |
| **Advanced** *(disclosure)* | Chroma key, blend mode, blur/pixelate region, mask | VFX rows L1258-1366 — kept, tucked away from novices |

**Interaction & layout:**
- **Gallery, not pills.** Each preset is a **96×54 (16:9) thumbnail card** rendering the
  *user's own current frame* with the look/filter's `cssFilter(grade)` applied (the same
  `cssFilter` the Stage and `Scopes` already use — `RoomPanel.tsx` L704, `Stage.tsx` L229).
  So the user previews the result on their footage before committing. Label under each.
- Active preset gets the teal selection ring (reuse the `Pill` active token:
  `border-teal/40 bg-teal/10`).
- **Instant + undoable:** every card applies through `onApplyDoc(...)` (client-side pure fns),
  never a Director round-trip — kills the A8 latency split.
- **Collapsed/expanded:** Design panel opens as a **taller sheet** (≈`max-h-[52vh]`, up from
  `42vh`) because a gallery needs rows; a "Compact" toggle returns it to a single strip for
  power users. Category list persists last-open category (`localStorage["cadence:designCat"]`).
- **Search/scan:** a top filter field ("warm", "bw"…) filters cards live.

**Propose MORE presets (named).** Ship these in addition to the current 8 looks:

*Looks / Filters (grouped families so the gallery has structure):*
- **Cinematic:** Teal & Orange, Blockbuster, Moody Blue, Golden Hour, Bleach Bypass, Film Noir *(noir exists)*
- **Warm/Film:** Kodak Warm, Portra, Sunset, Amber Glow, Faded Film *(vintage exists)*
- **Cool/Clean:** Arctic, Clean Cool *(cool exists)*, Slate, Overcast
- **Vibrant/Social:** Pop *(vivid exists)*, Punchy *(vibrant exists)*, Neon Night, Candy
- **Mono:** True B&W *(bw exists)*, High-Contrast Mono, Silver, Sepia
- **Retro:** VHS, 80s Chrome, Faded Polaroid, Cross-Process

*Color palettes (for Backgrounds + Text color chips — a curated swatch set):*
- **Ink** `#0a0d12`, **Amber** `#f5b944`, **Teal** `#45d3c4` *(brand tokens, globals.css)*
- Neutrals: Charcoal, Slate, Bone, Paper White
- Accents: Coral, Magenta, Lime, Sky, Violet, Sunflower
- Gradients: Sunset (amber→magenta), Ocean (teal→ink), Mono Fade, Vaporwave

*Text styles (extend the 4 today — bold-title/subtitle/handwritten/meme):*
- Lower Third, Caption Box, Big Bold Center, Quote, Ticker/News, Neon Glow, Typewriter,
  Minimal Serif *(reuse the `voice`/Fraunces face, globals.css L76)*, Sticker Label, Outline.

*Backgrounds:* Solid (swatch), Vertical Gradient, Radial Glow, Letterbox (2.39:1 bars),
Blurred-clip Backdrop (reuse the clip as a blurred fill behind a fit-to-frame image — great
for photos that don't match the aspect).

> All of the above are **presets over existing engine primitives** (`ColorGrade`, `SolidClip`,
> `TextClip`, `cssFilter`, `chromaKey`, `regionBlur`). No schema change needed for the core set.
> Gradient backgrounds are the one item that may want a tiny schema add (see D, "engine flags").

---

### B3 — Redesign the Media panel (easy to see, drag source)

**Current:** `RoomPanel.tsx` L232-301 — a `Shell` of horizontal chips: `[kind] filename [dur]`
+ up/down/remove micro-buttons. No poster. Below it, a read-only `TrackPanel`.

**Spec — Media grid:**
- Replace the chip strip with a **responsive thumbnail grid** (`grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2`),
  shown in a taller panel (`max-h-[46vh] overflow-y-auto`).
- **Each tile:**
  - **16:9 poster.** Video → a `<video>` seeked to ~1s or a captured frame (the app already
    probes video via `probeVideo`, `Editor.tsx` L98; and can render a frame via
    `renderFrameBlob`, used in Deliver L1019). Image → the object URL (`urls[m.id]`).
    Audio → a waveform mini (reuse `WaveformStrip`, `CutsStrip.tsx` L233) or a music glyph.
  - **Badges:** a `kind` chip (top-left) + duration or `W×H` (bottom-right) — data already
    computed at L238-245.
  - **Label:** filename, truncated, under the poster.
  - **Hover actions:** "+ Add to timeline", reorder ‹ ›, remove × (replaces the always-on
    micro-buttons; keeps the same handlers `onReorderMedia`/`onRemoveMedia`).
  - **Selected state:** teal ring.
- **Drag source (feeds B4):** each tile is `draggable`, sets
  `dataTransfer.setData("application/x-cadence-media", m.id)` and a drag image = the poster.
- **Empty state:** a real dropzone card — "Drop video, photos or audio here, or **Browse**"
  wired to the existing hidden file input (`fileRef`, L217-230). This is also the OS-drop
  target for the Media room.
- **Keep** the `TrackPanel` map (L1641+) below the grid as a compact "Layers" legend, but
  restyle to match (see C).

**Acceptance:** uploaded clips show posters; a novice can visually pick a clip; tiles drag;
audio shows a waveform; empty state invites a drop.

---

### B4 — Drag-and-drop onto the timeline (from Media panel and the OS)

**Current:** none. `CutsStrip.tsx` supports **pointer-drag of clips already on the timeline**
(`onClipPointerDown` → move/trim/fade, L1010-1160; cross-track via `moveClipToTrack`). There is
no way to drag a *new* media in, and no OS-file drop. The editor's only file intake is the
hidden `<input type=file>` in DirectorRail / RoomPanel.

**Spec — internal DnD (Media tile → timeline lane):**
- Media tiles are `draggable` and carry the media id (B3).
- The `lanes` container (`CutsStrip.tsx` `lanesRef`, ~L943) and each lane div (L998-1001) gain
  `onDragOver` (preventDefault + show a drop indicator) and `onDrop`:
  - Compute the target **track** from the lane under the cursor (there is already
    `trackAtY`, L502-514, and lane geometry in `laneRefs`), and the **start time** from
    cursor x (reuse `pxToSec` + `laneRectX`, L558-560, and the existing `snap`).
  - On drop, call a **new `Editor` handler `onDropMediaToTrack(mediaId, trackId, startSec)`**
    that inserts a clip for that media at that lane/time. This composes existing ops:
    for a **sequential visual/audio** track, append/insert via the doc helpers already used
    (`appendVideos`/`addMusic` patterns in `Editor.tsx`); for an **overlay/b-roll** lane,
    place freely (mirrors `moveClipToTrack`, L927-935). If the media isn't yet in the doc,
    register it (same path as `handleFiles`).
  - Show the **existing drop indicator / insert line** (`TrackInsertLine`, L1505; `dropIndicator`
    state already exists, L989) so internal DnD reuses the visual language clip-moves already use.
- **Keyboard/parity fallback:** the Media tile "+ Add to timeline" button (B3) calls the same
  handler with a sensible default (end of the main track), so DnD is never the *only* path
  (accessibility).

**Spec — OS file drop:**
- Wrap the editor `<main>` (or the timeline `<section>`) with `onDragOver`/`onDrop` that reads
  `e.dataTransfer.files` and routes them straight into the existing `handleFiles(files)`
  (`Editor.tsx` L335) — same probing, same undoable commit. A full-editor **drop overlay**
  ("Drop to add media") appears while a file drag is over the window (listen on `dragenter`/
  `dragleave` at the `Editor` root).
- If the drop lands on a specific lane, prefer placing there (internal path); a drop anywhere
  else = "add to project" (Media grid).

**Guardrails:** locked tracks reject drops (there's already a `track.locked` check, L1023/L528);
type mismatch (audio onto a visual lane) shows a "can't drop here" cursor and no-ops
(`clipFitsTrack` exists, L146-149).

**Acceptance:** drag a Media tile onto a lane → clip lands at the snapped time on that track,
undoable; drag files from Finder/Explorer onto the editor → they load; wrong-type/locked
drops are rejected with feedback.

---

### B5 — Remove the brand / "AI" watermark from editor chrome

**Finding (honest):** there is **no literal "AI"/"Made with" watermark**. What reads as
watermark-y clutter is **duplicated branding**:
- `RoomsRail.tsx` L34 — amber "C" tile at the top of the vertical rail.
- `DirectorRail.tsx` L45-51 — a second amber "C" **plus** "Cadence / Describe the edit. I'll
  make it." in the chat header, occupying editing real estate.
- `TopNav.tsx` L25 — "C" + "Cadence" (this one is fine; it's the app nav on dashboard/settings,
  not the editor).

**Spec:**
- **Keep exactly one** brand mark in the editor: the `RoomsRail` "C" (it doubles as the
  home affordance). **Remove** the "C" and the tagline block from `DirectorRail`
  (L45-51) — replace with a slim, functional header: just the collapse chevron (B1) and a
  small "Director" label, or nothing. This declutters the most-looked-at panel.
- Make the `RoomsRail` "C" a **link home** (`backHref`), so it earns its place instead of
  being decoration.
- Confirm no brand overlay bleeds onto the **Stage** (it doesn't today — the "Cadence 0"/
  "Photo 1" text is fixture content, per the brief; leave it).

**Acceptance:** one brand mark in the editor; DirectorRail header is functional, not branded;
canvas and preview carry no app logo.

---

### B6 — Overall UI/UX polish + consistency (landing · dashboard · editor · settings)

*(Editor-side polish is specified in A6-A12 and the design-system section C. Landing/
dashboard/settings specifics are appended from the surface audit below.)*

Editor-wide polish, concretely:
- **Unify preset latency (A8):** looks apply client-side like sliders.
- **Rooms become panels, not scrollers (A6):** wrap-instead-of-scroll (the `Row` helper at
  L408 already wraps — extend that pattern to the top strips that currently `overflow-x-auto`).
- **Consistent empty states (A11):** Stage, Media, each room share one `<EmptyState icon title
  hint cta/>` primitive.
- **Onboarding:** a first-run 3-step coach ("1 Add media · 2 Describe or tap a style · 3
  Export") shown once (persisted flag), anchored to RoomsRail → Design → Deliver.
- **Mobile (A12):** convert `RoomsRail` into a bottom tab bar under `md`; make rooms full-width
  sheets; give the timeline pinch-zoom (zoom state already exists, `CutsStrip.tsx` L388).

**Dashboard (highest-value surface fixes):**
- **Kill native dialogs (A13).** Replace `window.prompt`/`confirm` in `ProjectHub`,
  `ProjectCard`, `NewProjectMenu` with: **inline rename** on the card title (mirror the
  editor's `EditableTitle`, `TopBar.tsx` L41-89 — reuse it), and a **styled confirm modal**
  for delete that names the project. Reuse the Wave-0 `EmptyState`/modal primitive.
- **Add card thumbnails (A14).** Render the project's poster via `renderFrameBlob` of its
  saved doc at t=0 (same route Deliver uses); fall back to the kind icon. Make the whole card
  one link target (remove the nested-`<Link>` dead zones); kebab stops propagation.
- **Fix hydration flash (A15).** Read the persisted view/sort from a cookie server-side (or
  render neutral until hydrated with `visibility` held) so the grid/list + sort don't flip.
- **Menu a11y (A17).** Give the kebab + split-button menus arrow-key roving focus and
  focus-return on close — copy the pattern already implemented in `SettingsView`.
- **De-jargon (A19).** "append-only edit-doc history" → "Your projects, auto-saved."; hide the
  raw User ID behind a "copy ID" affordance in settings.
- **De-dupe header (A20).** Single source for the "Projects" H1 (only in `ProjectHub`).

**Landing:**
- **Sticky header** with a persistent primary CTA (A16); expose the in-page anchor nav on
  mobile (drop `hidden sm:inline-block`, or a small menu).
- **Resolve the two-CTA split:** make "Open editor" the single amber primary everywhere;
  demote "Sign in to save" to a text link. Repeated identically in hero + `FinalCta`.
- Fix the `HowItWorks` connector-line vs grid mismatch at the `sm:grid-cols-2` breakpoint;
  fix the ragged trailing gap in `FeatureShowcase`'s 3-in-4-col last group.
- Cards that hover-lift but aren't links = false affordance; either link them or drop the lift.

**Settings:**
- **URL-addressable tabs (A18)** via `?tab=` (or route segments) so refresh/back/deep-link work.
- Fix the ProfileForm `maxLength` (set to 120 to match validation) (A20).
- DangerZone: replace the dead disabled Delete with an actionable "Request deletion" (mailto/
  support) so mobile users (no hover for the `title`) understand it.
- Make faint uppercase labels meet contrast (bump `--color-faint` usage on labels to `muted`).

**App-wide:**
- Add a **skip-to-content link** + root `<main>` landmark (`layout.tsx`) (A21).
- Introduce a `--color-danger` token ramp and migrate raw `red-*` usages (A20).
- Sticky `TopNav`; show a signed-in indicator on mobile (avatar initial even when email hides).

---

## C. Design-system notes (standardize this)

The palette and type choices are strong; the problem is **local re-implementation**. Extract a
small primitives layer (e.g. `components/ui/`) and migrate rooms onto it.

**Tokens (keep — already good, `globals.css` L4-27):**
- Surfaces: `--color-ink` (app bg) → `--color-panel` → `--color-elevated`; borders `--color-line`
  / `--color-line-soft`. Text `--color-text` / `--color-muted` / `--color-faint`.
- **Amber = action/brand**, **Teal = selection/applied.** This two-accent rule is used
  consistently (Pill active = teal, primary buttons = amber) — **codify it** as the rule:
  *amber = "do", teal = "is on".*
- Add semantic aliases so components stop hardcoding: `--space-*` scale, `--radius-pill:999px`,
  `--radius-card:16px`, `--focus: var(--color-amber)`.

**Spacing scale:** the app informally uses 4/8/12/16px (`gap-2`, `px-4`, `py-2`). Make it
explicit: **4 · 8 · 12 · 16 · 24 · 32**. Panels pad `px-4 py-2`; cards `p-3`; galleries `gap-2`.

**Type scale:** two families exist — `--font-chrome` (Space Grotesk) for UI, `--font-voice`
(Fraunces italic) for the user's words (`.voice`, L76). Formalize sizes: `10px` (uppercase
tracking labels) · `11px` (meta) · `12px` (controls) · `14px` (body) · `16px+` (titles). The
`text-[10px] uppercase tracking-wider text-faint` label is a de-facto component → make it
`<Label/>`.

**Components to standardize (each is re-declared today):**
| Primitive | Today | Standardize to |
|-----------|-------|----------------|
| `Pill` | local in `RoomPanel.tsx` L118 | shared, variants: default / active(teal) / danger |
| Slider | `FxSlider` L422, `GradeSlider` L516, `VolumeSlider` L147 — 3 near-dupes | one `<Slider label value fmt/>` with `aria-valuetext` (already good) |
| `NudgeField` | L468 | shared stepper |
| `IconButton` | `TopBar.tsx` L144 | shared; used by TopBar + rooms |
| Chip/Badge | re-typed in Media, Tracks, AppliedStatus, ProjectCard | one `<Badge tone/>` |
| Panel `Shell`/`Row` | L109/L408 | one `<Panel>` + `<Row>` layout pair |
| `EmptyState` | none (ad hoc) | new shared primitive |
| **Thumbnail** | none | new `<PresetThumb>` / `<MediaThumb>` — the backbone of B2 & B3 |

**Sliders:** move the inline `style={{accentColor: var(--color-teal)}}` + repeated classes
into the shared component; adopt the nicer `.scrubber` thumb style (globals.css L83-110) app-wide
so every range looks like the transport scrubber.

**Motion:** respect the existing `prefers-reduced-motion` block (L112-118); keep transitions at
`120ms ease` (already the norm).

---

## D. Phased implementation plan (waves)

Principle: **isolate the three hot shared files** — `Editor.tsx`, `RoomPanel.tsx`,
`CutsStrip.tsx` — and sequence their edits so waves don't collide. Everything else is disjoint.

**Shared-file sequencing rule:** each hot file is touched by **at most one wave at a time**;
later waves rebase on the prior wave's version. `Editor.tsx` is the true bottleneck (it owns all
state + handlers), so its changes are front-loaded into small, additive commits (new state +
new handler props) that later waves consume.

### Wave 0 — Design-system foundation (disjoint; no hot files)
- New `components/ui/` primitives: `Pill`, `Slider`, `Badge`, `IconButton`, `Panel`, `Row`,
  `Label`, `EmptyState`, `Thumb`. Token aliases in `globals.css`.
- **Files:** `globals.css`, new `components/ui/*`. **No** editor logic touched.
- **Verify:** typecheck · build · Storybook-less visual check (render in `/editor`). E2E: none.

### Wave 1 — Panel collapse + brand cleanup (B1, B5)
- `Editor.tsx`: add `railOpen`/persist, `codeOpen` persist, `[` `]` `\` shortcuts (additive to
  the L1158 handler + width-restore effect).
- `DirectorRail.tsx`: collapse chevron + collapsed stub; **remove brand block** (B5).
- `RoomsRail.tsx`: make "C" a home link.
- `ShortcutsHelp.tsx`: add the 3 new keys.
- **Hot file:** `Editor.tsx` (first, small). **Verify:** toggle by key/click, reload persistence;
  E2E: "collapse chat, reload, still collapsed."

### Wave 2 — Media grid + drag source (B3)
- `RoomPanel.tsx` media branch (L232-301) → thumbnail grid using Wave-0 `Thumb`/`Badge`.
  Add `draggable` + `dataTransfer`. Reuse `renderFrameBlob`/`urls` for posters.
- **Hot file:** `RoomPanel.tsx` (media branch only — disjoint from Color/VFX rewrite in Wave 3).
- **Verify:** posters render for video/image/audio; tiles drag (dragstart sets data). E2E:
  "upload → tile appears with poster."

### Wave 3 — Design surface consolidation (B2)
- `RoomsRail.tsx`: Color+VFX → **Design** (rail entries).
- `RoomPanel.tsx`: new `DesignRoom` (category list + gallery) that **absorbs** `ColorRoom`
  (L839) and `VfxRoom` (L1136) — move, don't rewrite, the working controls; add the gallery
  shell, preset thumbnails, Backgrounds tab.
- New `lib/design-presets.ts`: the expanded named preset set (looks families, palettes, text,
  backgrounds) as data over existing engine fns.
- Fix A8: looks apply via `onApplyDoc`, not `onAction`.
- **Hot file:** `RoomPanel.tsx` (Color/VFX region — sequence **after** Wave 2's media edit;
  different region, but land Wave 2 first to avoid a merge in the same file).
- **Verify:** every old Color/VFX control still works; look cards preview on the user's frame;
  Backgrounds apply. E2E: "apply Teal&Orange → doc grade changes; set gradient background."

### Wave 4 — Timeline drag-and-drop (B4)
- `CutsStrip.tsx`: `onDragOver`/`onDrop` on lanes; reuse `trackAtY`, `pxToSec`, `snap`,
  `dropIndicator`, `TrackInsertLine`.
- `Editor.tsx`: new `onDropMediaToTrack` handler (composes existing insert ops) + wire prop
  into `CutsStrip`'s `edit` object (L1329).
- `Editor.tsx` / `main`: OS-file drop overlay → `handleFiles`.
- **Hot files:** `CutsStrip.tsx` (first substantial edit — schedule last so it rebases on nothing
  else) **and** `Editor.tsx` (second small additive handler, after Wave 1). Land Wave 1's
  `Editor.tsx` changes before starting Wave 4's.
- **Verify:** internal drag places clips; OS drop loads files; locked/wrong-type rejected;
  all undoable. E2E: "drag media tile to b-roll lane → PiP clip at cursor time."

### Wave 5 — Cross-surface polish + mobile + onboarding (B6, A11-A21)
Split into disjoint sub-streams that can run in parallel (different files):
- **5a Dashboard:** kill native dialogs → inline rename + confirm modal (A13); card
  thumbnails + single link target (A14); menu a11y (A17); hydration fix (A15); de-jargon +
  header de-dupe (A19/A20). Files: `dashboard/*`, `app/dashboard/page.tsx`.
- **5b Landing:** sticky header, single CTA, mobile anchor nav, `HowItWorks`/`FeatureShowcase`
  grid fixes (A16). Files: `app/page.tsx`, `components/landing/*`.
- **5c Settings + app shell:** URL-addressable tabs (A18), ProfileForm limit fix, DangerZone
  actionable button, contrast, skip-link + `<main>` (A20/A21). Files: `settings/*`,
  `app/settings/page.tsx`, `app/layout.tsx`, `TopNav.tsx`, `globals.css` (danger token).
- **5d Editor mobile + onboarding:** `RoomsRail` → bottom tabs under `md`; room sheets;
  first-run coach (A11-A12). **Hot file:** `Editor.tsx` (mobile layout) — run last, rebased
  on Waves 1 & 4.
- **Verify:** responsive at 375/768/1440; onboarding shows once; a11y pass (focus, labels,
  skip-link); E2E "rename a project inline, delete via modal."

**Engine/schema flags (kept minimal — most is pure UI over existing pure fns):**
- **B2 gradient backgrounds:** may need a small `SolidClip`/`meta.background` extension for a
  gradient value (today it's a hex, `schema.ts` L433/L484). Solid colors + letterbox + blurred
  backdrop need **no** schema change. Scope this one item with engine before Wave 3, or ship
  solids first and add gradients in a follow-up.
- Everything else (Looks, text styles, overlays, media posters, DnD placement) composes
  **existing** `@cadence/director` pure fns and `@cadence/core` helpers — UI-only.

---

## Appendix — file map (what to touch)

- **Layout / panels:** `apps/web/src/components/Editor.tsx` (state, handlers, flex layout,
  shortcuts), `DirectorRail.tsx` (chat + collapse + brand), `CodeDrawer.tsx`, `RoomsRail.tsx`
  (rail entries, brand), `ResizeHandle.tsx`.
- **Rooms:** `RoomPanel.tsx` (Media grid, Design consolidation, Audio/Deliver stay),
  `QuickActions.tsx`, `AppliedStatus.tsx`, `TranscriptRoom.tsx`, `DemoRoom.tsx`.
- **Timeline / preview:** `CutsStrip.tsx` (DnD), `Stage.tsx` (OS-drop overlay host).
- **Chrome:** `TopBar.tsx`, `TopNav.tsx`, `ShortcutsHelp.tsx`.
- **Data / presets:** `lib/status.ts` (LOOKS), `lib/text-presets.ts`, new `lib/design-presets.ts`,
  `lib/doc.ts` (backgrounds), `lib/fx.ts`.
- **Tokens:** `app/globals.css`. **New:** `components/ui/*`.
- **Surrounding surfaces:** `app/page.tsx`, `app/dashboard/page.tsx`, `app/settings/page.tsx`,
  `components/{landing,dashboard,settings}/*`.
</content>
