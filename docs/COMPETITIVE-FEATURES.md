# Cadence — Competitive Feature Survey & Prioritized Plan

> **Author:** Video-editing product strategist. **ADVISORY / RESEARCH ONLY — no code
> changed** (this doc is the only file written).
> **Goal:** make Cadence "the best, easiest editing tool" — more editing tools + more
> transitions, and make everything easier to use.
> **Date:** 2026-09-07.

## Sources & method (honesty note)

- **Cadence state = verified in code**, not from the older status docs. I read
  `packages/core/src/schema.ts`, `packages/director/src/{tools,edits,tracks,trims,demo}.ts`,
  `packages/render-ffmpeg/src/plan.ts`, `apps/web/src/components/*` (CutsStrip, RoomPanel,
  Stage, Editor, RoomsRail, ShortcutsHelp, dashboard/templates), and
  `apps/web/src/lib/{design-presets,text-presets,beats,history,edit-ops}.ts`.
  **Important:** the code is now *ahead* of `docs/CAPCUT-STATUS.md`. Items that doc lists as
  "missing" are in fact **shipped in code** — speed ramps (`speedRamp` on `VideoClip` +
  `set_speed_ramp`), LUT import (`ColorGrade.lut` + `apply_lut`), adjustment layers
  (`AdjustmentClip` + `add_adjustment`), and **55/56 transitions** (`TRANSITION_TYPES`,
  grouped gallery). This plan is built on the **code truth**, so it does not re-propose
  things Cadence already has.
- **Competitor state = live web search (Sep 2026)** for the fast-moving tools: CapCut,
  Descript (Underlord), DaVinci Resolve, Premiere Pro, Canva, Runway, Clipchamp, Final Cut.
  See the Sources list at the bottom.
- **My own knowledge (Jan 2026 cutoff)** fills in **VN** and **InVideo** (no fresh search
  hit for their exact current lists) and the stable, well-known parts of every editor. Where
  a claim rests on memory rather than a fetched page, it is stable/uncontroversial feature
  fact, not a version-specific novelty.

---

## What Cadence actually has today (verified baseline)

So the gap analysis is honest, here is the confirmed inventory:

- **Timeline & tracks:** real multi-track visual + audio layers with z-order = array order;
  track headers with name/hide/lock/mute/solo; add/remove/reorder tracks; cross-track clip
  drag; magnetic main track + ripple; snapping (edges/playhead/markers/beats); playhead-
  anchored zoom + Fit + zoom-to-clip. Media clips are **drag-droppable onto the timeline**
  (`onDropMedia`). **One `EditDoc` per editor** (no multi-sequence).
- **Trim/motion/speed:** ripple/roll/slip/slide; split/ripple-delete/duplicate; constant
  speed **and speed ramps** (curve editor + `set_speed_ramp`); reverse; freeze-frame;
  Ken Burns; keyframe editor (diamonds) for x/y/scale/rotation/opacity/volume with easing,
  now with **export fidelity** (`keyframeTransformExpr`).
- **Transitions:** **55 types** in a **grouped gallery** (Fades/Wipes/Slides/Smooth/Covers/
  Reveals/Opens&Closes/Shapes/Diagonals/Slices/Zoom/Effects), applied **per-cut** via a ◇
  chip → popover, with duration; `set_transition`/`clear_transition`.
- **Text/titles/captions:** titles + lower-thirds; kinetic **in**-animation (kinetic/pop/
  bounce/typewriter); **12 text presets**; auto-captions from transcript; caption styling;
  edit-by-transcript (Words room); ~20 emoji stickers. **No out-animation, no karaoke/word
  highlight, no vector shapes.**
- **Color:** ~48 look presets (Design room) across cinematic/warm/cool/social/mono/retro
  families; manual grade; RGB tone curves + curve editor; global hue shift; **LUT import
  (.cube)**; **adjustment layers**; scopes.
- **Compositing/VFX:** chroma key + despill; shape mask (rect/ellipse, feather, invert);
  blur/pixelate region; blend modes; whole-frame vignette/grain/light-leak.
- **Audio:** per-clip & per-track volume/mute; fade handles; pan; auto-mix ducking; LUFS
  loudnorm; beat detection + beat-snap (manual); base-media waveform. **No noise reduction /
  voice isolation on audio; no EQ/compressor; no music library.**
- **AI-native:** highlight cut, filler/silence removal, auto-reframe (centered; subject
  tracking gated), edit-by-transcript, TTS voice-over. **Faithful upscale** (lanczos +
  unsharp + hqdn3d), gated AI super-res. **No generative video/b-roll, no eye-contact, no
  background removal, no audio enhance** (by design/gating so far).
- **Templates/ease:** 3 project-start templates (blank/talking-head/slideshow); Walkthrough/
  Demo builder (cursor/typewriter/callout); prompt-native Director (59 tools); drag-drop;
  collapsible rails; undo/redo (keyboard + `useDocHistory` + UndoToast); keyboard shortcuts
  (Space/←→/S/Del/M/⌘Z…). **No command palette, no history panel, no favorites, no auto-edit
  to music, no template gallery inside the editor.**
- **Export:** real `.mp4` via ffmpeg; platform/codec/fps presets; aspect presets; SRT/VTT;
  quality presets. **No GIF, no transparent/ProRes-alpha, no direct social publish.**

---

## A. Competitive matrix

Legend: **✅ have** · **🟡 partial** · **❌ missing**. Cadence column reflects **code**, not docs.
Competitor cells mark whether that product is known for the capability (✅), has a weak/partial
version (🟡), or lacks it (—). Competitors abbreviated: **CC** CapCut, **PR** Premiere,
**DR** DaVinci Resolve, **FC** Final Cut, **DS** Descript, **CV** Canva, **CL** Clipchamp,
**RW** Runway, **IV** InVideo, **VN** VN.

### 1. Core editing tools

| Feature | CC | PR | DR | FC | DS | CV | CL | Cadence |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| Multi-track timeline + layers | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ |
| Magnetic / auto-ripple timeline | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Split / trim / ripple / duplicate | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Roll / slip / slide | 🟡 | ✅ | ✅ | ✅ | — | — | — | ✅ |
| Keyframes (pos/scale/rot/opacity) | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | 🟡 | ✅ |
| Speed ramp / time-remap | ✅ | ✅ | ✅ | ✅ | — | 🟡 | 🟡 | ✅ |
| Snapping + timeline zoom | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **PiP / split-screen layout presets** | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | ✅ | ✅ | ❌ (manual only) |
| **Auto-edit to music / beat-synced auto-cut** | ✅ | 🟡 | 🟡 | — | ✅ | ✅ | 🟡 | 🟡 (beat-snap, no auto-cut) |
| Multiple sequences / comps | 🟡 | ✅ | ✅ | ✅ | 🟡 | — | 🟡 | ❌ |
| **Stabilization** | ✅ | ✅ | ✅ | ✅ | — | — | — | ❌ |

### 2. Transitions & effects

| Feature | CC | PR | DR | FC | DS | CV | CL | Cadence |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| Large transition library | ✅ (100s) | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ (55) |
| **Drag transition between clips** | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ❌ (popover only) |
| **One-tap "apply to all cuts" / auto** | ✅ | 🟡 | 🟡 | 🟡 | ✅ | ✅ | 🟡 | ❌ |
| **Hover-preview of transition** | ✅ | 🟡 | 🟡 | ✅ | — | ✅ | 🟡 | ❌ |
| Effects/filters browser w/ thumbnails | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | 🟡 (pills, no thumbs) |
| Whole-frame VFX (vignette/grain/leak) | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | 🟡 | ✅ |
| Animated stickers / GIPHY | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | ✅ | ✅ | 🟡 (static emoji) |

### 3. Text / titles / captions

| Feature | CC | PR | DR | FC | DS | CV | CL | Cadence |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| Title templates / motion titles | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | 🟡 (12 presets, in-anim) |
| Text in **and out** animation | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | 🟡 (in only) |
| Auto captions | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Karaoke / word highlight captions** | ✅ | 🟡 | 🟡 | 🟡 | ✅ | ✅ | 🟡 | ❌ |
| **Animated caption style templates** | ✅ | 🟡 | — | 🟡 | ✅ | ✅ | 🟡 | 🟡 (style, no animation) |
| Caption translation | ✅ | ✅ | 🟡 | 🟡 | ✅ | ✅ | ✅ | ❌ |
| Vector shapes (rect/arrow/callout) | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | 🟡 (callout only) |

### 4. Audio

| Feature | CC | PR | DR | FC | DS | CV | CL | Cadence |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| Volume/fade/pan/ducking | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| LUFS normalize | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ✅ |
| **Noise reduction / voice isolation** | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ❌ |
| **Studio-sound / one-click enhance** | ✅ | ✅ | 🟡 | 🟡 | ✅ | 🟡 | ✅ | ❌ |
| **EQ / compressor** | 🟡 | ✅ | ✅ | ✅ | 🟡 | — | 🟡 | ❌ |
| Beat detection → cut sync | ✅ | 🟡 | 🟡 | — | ✅ | ✅ | 🟡 | 🟡 (snap, no AI tool) |
| Music / SFX library | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

### 5. Color

| Feature | CC | PR | DR | FC | DS | CV | CL | Cadence |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| Look/filter presets | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ (~48) |
| Manual grade + curves | ✅ | ✅ | ✅ | ✅ | — | 🟡 | 🟡 | ✅ |
| LUT import (.cube) | 🟡 | ✅ | ✅ | ✅ | — | — | — | ✅ |
| Adjustment layers | 🟡 | ✅ | ✅ | ✅ | — | — | — | ✅ |
| Scopes (waveform/vectorscope) | 🟡 | ✅ | ✅ | ✅ | — | — | — | ✅ |
| **HSL secondary (per-hue)** | 🟡 | ✅ | ✅ | ✅ | — | — | — | 🟡 (global hue) |
| **Auto color / white balance** | ✅ | ✅ | ✅ | ✅ | — | 🟡 | ✅ | ❌ |

### 6. AI features

| Feature | CC | PR | DR | FC | DS | CV | RW | IV | Cadence |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| Prompt-native / chat editing | 🟡 | 🟡 | — | — | ✅ | ✅ | ✅ | ✅ | ✅ (core strength) |
| Text-based (transcript) editing | 🟡 | ✅ | — | — | ✅ | — | — | 🟡 | ✅ |
| Filler-word / silence removal | ✅ | 🟡 | 🟡 | 🟡 | ✅ | — | — | 🟡 | ✅ |
| Auto-reframe / smart conform | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | — | 🟡 | 🟡 (centered) |
| **Background removal (no green screen)** | ✅ | 🟡 | ✅ | ✅ | 🟡 | ✅ | ✅ | 🟡 | ❌ |
| **Magic/subject mask (AI roto)** | ✅ | 🟡 | ✅ | ✅ | — | 🟡 | ✅ | — | 🟡 (gated) |
| **Eye contact / gaze correction** | 🟡 | — | — | — | ✅ | — | — | — | ❌ |
| **Studio-sound / speech enhance** | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 | — | 🟡 | ❌ |
| Generative video / b-roll / extend | 🟡 | ✅ | — | — | 🟡 | ✅ | ✅ | ✅ | ❌ (out of scope: faithful) |
| TTS voice-over | ✅ | 🟡 | — | — | ✅ | ✅ | 🟡 | ✅ | ✅ |
| Auto-edit / one-prompt full video | ✅ | — | — | — | ✅ | ✅ | 🟡 | ✅ | 🟡 (chains tools) |

### 7. Templates & ease-of-use

| Feature | CC | PR | DR | FC | DS | CV | CL | VN | Cadence |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| **In-editor template gallery** | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | ✅ | ✅ | ✅ | ❌ (3 start templates) |
| Drag-drop media to timeline | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Command palette / search actions** | 🟡 | ✅ | 🟡 | ✅ | ✅ | 🟡 | — | — | ❌ |
| **Undo history panel** | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | 🟡 | ❌ (toast only) |
| **Favorites / recents (effects, looks)** | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 | ✅ | ❌ |
| Keyboard-first editing | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | 🟡 | 🟡 (basic) |
| Guided/onboarding flows | ✅ | 🟡 | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 (Demo room only) |
| Brand kit (fonts/colors/logo) | 🟡 | ✅ | 🟡 | 🟡 | 🟡 | ✅ | ✅ | 🟡 | ❌ |

### 8. Export & delivery

| Feature | CC | PR | DR | FC | DS | CV | CL | Cadence |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| MP4 + platform/codec/fps presets | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Aspect presets (9:16/1:1/4:5) | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ |
| SRT/VTT sidecar | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ✅ |
| **GIF / animated export** | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ❌ |
| **Transparent / alpha (ProRes/WebM)** | 🟡 | ✅ | ✅ | ✅ | — | — | — | ❌ |
| **Direct social publish / share link** | ✅ | 🟡 | — | — | ✅ | ✅ | ✅ | ❌ |

---

## B. Gap list → what to ADD (prioritized)

Ordered by **impact × ease**. Each: **why**, **easiest-UX approach**, and **engine/schema vs
UI-only**. P0 = ship first (ease-of-use + high-impact tools).

### P0 — ease-of-use wins & transition polish (mostly UI-only)

1. **One-tap "Auto transitions" + "Apply to all cuts"** — *UI-only.*
   *Why:* Cadence has 55 transitions but each is applied per-cut via a popover — tedious.
   Every rival lets you carpet the timeline in one action. *UX:* a header button in the Edit
   room / CutsStrip: "Auto transitions" (pick one style + duration → `set_transition` looped
   over all cut boundaries) and "Apply to all" inside the existing gallery popover. Pure calls
   to the existing `onSetTransition`. Biggest ease win for the least work.

2. **Drag-a-transition between clips** — *UI-only.*
   *Why:* the discoverable, industry-standard gesture; the ◇ chip is not obvious. *UX:* make
   the gallery entries draggable and the cut boundary a drop target (Cadence already has
   drag-drop plumbing for media via `onDropMedia`; mirror it for transitions). Drop → same
   `set_transition`.

3. **Hover-preview of transitions & looks** — *UI-only.*
   *Why:* users pick blind today; CapCut/FCP animate a thumbnail on hover. *UX:* on gallery
   hover, run the existing pure preview helper (`transitionMotion`/`transitionStyle` in
   grade.ts) on a tiny looped A/B thumbnail. Same for the look pills → live thumbnail of the
   grade. No engine change.

4. **In-editor template gallery** — *UI-only (uses existing tools).*
   *Why:* templates are the #1 ease lever for CapCut/Canva/VN; Cadence has only 3 project
   *start* templates and none reachable mid-edit. *UX:* a "Templates" panel that applies a
   saved sequence of existing Director tool calls (intro title + look + captions + music + end
   card) onto current media. Ships as data + a runner over tools already present.

5. **Command palette (⌘K) + searchable actions** — *UI-only.*
   *Why:* 59 tools + 8 rooms is a lot of surface; a fuzzy action launcher lowers the floor and
   speeds pros. *UX:* ⌘K over a static registry of {label → Director tool / room jump}. Pure
   client.

6. **Undo history panel + favorites/recents** — *UI-only.*
   *Why:* `useDocHistory` already stores the stack; only a toast exposes it. Favorites for
   looks/transitions/text-presets is a proven speed-up (recents already exist in the
   dashboard). *UX:* a collapsible history list (jump to any state) + a ★ on gallery items
   persisted to localStorage, surfaced as a "Recent/Favorites" row atop each gallery.

7. **Caption style templates + one-click styling presets** — *UI-only.*
   *Why:* auto-captions exist but styling is manual sliders; rivals ship "TikTok-style"
   one-tap caption looks. *UX:* extend `text-presets.ts` with caption-specific presets
   (big-bold-center, boxed, outline, neon) wired to the existing `style_captions` path.

### P1 — high-impact editing tools (engine + UI)

8. **Karaoke / word-highlight captions** — *engine + schema + UI.*
   *Why:* the single most-requested modern caption feature (CapCut/Descript/Canva); the
   transcript already carries word timings. *UX:* a "Highlight words" toggle on captions.
   *Work:* add per-word timing + active-word color to the caption/text clip; renderers draw
   the highlighted word (canvas + ffmpeg drawtext time-gating like the typewriter path).

9. **PiP / split-screen layout presets** — *engine-light + UI.*
   *Why:* reaction videos, side-by-side, grid — huge for social; Cadence can *build* it
   manually (transform + tracks) but there is no preset. *UX:* a "Layouts" picker
   (2-up, 3-up, PiP corner, top/bottom) that positions selected clips onto tracks with the
   right `transform`. Mostly a preset generator over existing transform/track ops; optional
   `add_layout` Director tool.

10. **Audio noise reduction / voice enhance ("Clean audio")** — *engine + UI.*
    *Why:* the biggest quality-per-click win in Descript/Premiere/Resolve; Cadence has zero
    audio denoise. *UX:* one "Clean audio" button in the Audio room. *Work:* ffmpeg
    `afftdn` (dependency-free) as the faithful default; optional `arnndn` (RNNoise model,
    gated) for stronger cleanup. Schema flag on audio/video clip + `enhance_audio` tool.
    Faithful, on-brand.

11. **Text out-animation + more motion-title templates** — *engine-light + UI.*
    *Why:* titles only animate *in*; pros expect symmetric out. *UX:* mirror the in-anim path
    for out-anim in `TextAnim`; add a dozen motion-title presets to `text-presets.ts`.

12. **Vector shapes (rect/ellipse/line/arrow)** — *engine + schema + UI.*
    *Why:* annotations, backgrounds, progress bars, framing — currently only emoji + callout.
    *UX:* a `shape` clip kind drawn on canvas + ffmpeg (`drawbox`/`geq`); a Shapes row in the
    Design room. Small, high-utility.

13. **AI triggers for shipped manual-only features** — *engine-light.*
    *Why:* Cadence's rule is "every capability reachable by prompt AND by hand," but beat
    detection, stickers, text presets, and layouts have no Director tool. *UX:* add
    `detect_beats`, `add_sticker`, `apply_text_preset` (+ `add_layout`) calling the same pure
    fns the buttons call. Restores parity.

14. **Auto-edit to music (beat-synced auto-cut)** — *engine + UI.*
    *Why:* the headline "magic" flow (CapCut/Canva/Descript); Cadence detects beats and can
    snap, but doesn't auto-assemble. *UX:* "Auto-edit to beat" → picks highlight segments and
    cuts them on detected beats (compose `detectBeats` + `create_highlight`). A Director tool
    + one button.

### P2 — depth & delivery (do after P0/P1)

15. **HSL secondary (per-hue) qualifier** — engine + UI. Per-hue-range on top of global hue.
16. **Stabilization** — engine + UI. ffmpeg `vidstab` two-pass; "Stabilize" button. Faithful.
17. **GIF + transparent (WebM/ProRes-alpha) export** — engine + UI. New Deliver formats.
18. **Auto color / white-balance** — engine + UI. ffmpeg-side auto-levels; one "Auto" button.
19. **Multiple sequences / comps** — architectural (L). A project holding N `EditDoc`s +
    switcher. Do last; touches persistence and the whole editor shell.
20. **Music/SFX library + brand kit** — content + UI. Bundled royalty-free set; saved
    fonts/colors/logo applied by presets.

**Deliberately NOT recommended** (off-brand for a *faithful* editor): generative video /
b-roll / generative-extend, AI eye-contact, and generative background *replacement*. Keep
Cadence's honest "retimes/regrades/recomposites existing frames, never invents content"
positioning; background *removal* (matte only) is fine, generative fill is not.

---

## C. "Make it easier" — top 10 UX changes (lower the skill floor, keep pro depth)

1. **Auto transitions / apply-to-all** — carpet or one-tap instead of per-cut popovers. (#1)
2. **Drag transitions & effects onto cuts/clips** — the gesture users already expect. (#2)
3. **Hover-preview everywhere** — transitions, looks, text presets animate on hover. (#3)
4. **In-editor template gallery** — start from a finished-looking result, then tweak. (#4)
5. **Command palette (⌘K)** — type what you want; jump to any tool or room. (#5)
6. **Undo history panel + favorites/recents** — visible safety net + one-click reuse. (#6)
7. **One-click "Clean audio"** — the highest quality-per-effort button we're missing. (#10)
8. **One-tap caption styles** — "make it TikTok-style" without touching sliders. (#7)
9. **Smart defaults on every insert** — new title gets a preset + safe-margin placement;
   dropped music auto-ducks under voice; captions auto-fit. (Extends existing auto behaviors.)
10. **Guided "first video" flow** — a 3-step wizard (pick media → pick template/vibe →
    export) that emits Director tool calls, reusing the Demo-room pattern for onboarding.

---

## D. Sequenced roadmap (WAVES on disjoint files)

Matches the repo convention (`docs/WAVE-PLAN.md`): each wave runs two agents on **disjoint**
trees — **Engine** owns `packages/**` (+ `scripts/verify.ts`); **Web** owns `apps/web/**`.
Integrate → gate → commit between waves. Waves are ordered by impact; every wave is
independently shippable + verifiable.

### Wave A — Ease-of-use blitz (UI-heavy, near-zero engine)
- **Web (`apps/web/**`):** auto-transitions + apply-to-all (#1); drag-a-transition (#2);
  hover-preview for transitions & looks (#3); command palette ⌘K (#5); undo history panel +
  favorites/recents (#6). All reuse existing pure helpers and Director tools.
- **Engine (`packages/**`):** none required (optional: expose a pure `allCutBoundaries(doc)`
  helper in `@cadence/director` for the apply-to-all UI + a `verify` case). **Disjoint.**
- *Ships:* the single biggest perceived ease jump; verifiable by clicking one control and
  seeing N transitions/looks applied with live preview.

### Wave B — Templates, captions styling, text out-anim
- **Engine (`packages/**`):** text **out**-animation in `TextAnim` (mirror in-anim, one pure
  helper, canvas+ffmpeg parity); AI triggers for manual features (`detect_beats`,
  `add_sticker`, `apply_text_preset`) (#13); render/plan verify cases.
- **Web (`apps/web/**`):** in-editor template gallery (#4) as data + tool-sequence runner;
  caption style templates + one-tap caption styling (#7); more motion-title presets in
  `text-presets.ts` (#11 UI half). **Disjoint** (engine adds the out-anim + tools; web adds
  galleries/presets).

### Wave C — High-impact editing tools
- **Engine (`packages/**`):** karaoke/word-highlight captions (schema per-word timing +
  canvas/ffmpeg draw) (#8); vector `shape` clip kind + renderers (#12); `add_layout` layout
  generator over transform/tracks (#9 engine half).
- **Web (`apps/web/**`):** captions "Highlight words" toggle; Shapes row in Design room;
  Layouts picker (PiP/split/grid) (#9 UI half). **Disjoint.**

### Wave D — Audio depth + auto-edit
- **Engine (`packages/**`):** "Clean audio" — `afftdn` faithful denoise + gated `arnndn`,
  schema flag + `enhance_audio` tool (#10); auto-edit-to-beat tool composing
  `detectBeats`+`create_highlight` (#14); verify cases.
- **Web (`apps/web/**`):** Audio-room "Clean audio" button + strength; "Auto-edit to beat"
  button + smart-default ducking on music insert (#9 of section C). **Disjoint.**

### Wave E — Color depth + delivery
- **Engine (`packages/**`):** HSL secondary qualifier (#15); stabilization `vidstab` (#16);
  GIF + transparent WebM/ProRes-alpha export (#17); auto color/white-balance (#18).
- **Web (`apps/web/**`):** Color-room HSL secondary UI + "Stabilize"/"Auto color" buttons;
  Deliver-room GIF/alpha format options. **Disjoint.**

### Wave F — Architectural (do last)
- **Engine + Web (coordinated, single stream):** multiple sequences/comps (#19) — a project
  holding N `EditDoc`s + a switcher; touches persistence (`packages/db`), the editor shell,
  and history. Not disjoint by nature — run as one wave after everything else. Bundle
  music/SFX library + brand kit (#20) here or as a follow-on.

**Quality bars (all waves):** one shared pure helper for preview↔export parity; frame-accurate
where relevant; every new capability reachable by **prompt AND by hand**; faithful (no
generative content invention); a render/plan verify check per feature.

---

## Sources

Web search (Sep 2026) — current competitor features:
- CapCut: https://www.capcut.com/tools/free-video-transitions , https://www.capcut.com/tools/auto-video-editor , https://www.capcut.com/tools/keyframe-animation , https://www.itechguides.com/latest-capcut-pro-features-whats-new-in-2025-us/
- Descript / Underlord: https://www.descript.com/underlord , https://www.descript.com/blog/article/underlord-ai-video-editor-primer , https://www.descript.com/tools/remove-filler-from-video
- DaVinci Resolve: https://www.blackmagicdesign.com/products/davinciresolve/whatsnew , https://vagon.io/blog/davinci-resolve-neural-engine-guide , https://primalvideo.com/guides/15-davinci-resolve-ai-tools-that-will-revolutionize-your-workflow/
- Premiere Pro: https://helpx.adobe.com/premiere/desktop/edit-projects/edit-with-generative-ai/generative-extend-overview.html , https://news.adobe.com/news/2025/04/new-ai-innovation-in-industry
- Canva: https://www.canva.com/video-editor/ai/ , https://grovers.io/tools/canva-magic-studio/
- Runway: https://runway.com/research/introducing-runway-gen-4 , https://getimg.ai/models/runway-ai
- Clipchamp / VN comparisons: https://www.veed.io/learn/clipchamp-vs-capcut , https://www.selecthub.com/video-editing-software/capcut-vs-clipchamp/
- Final Cut Pro: https://www.maginative.com/article/apple-releases-final-cut-pro-11-with-new-ai-features/ , https://support.apple.com/en-us/102825

Own knowledge (Jan 2026 cutoff): VN and InVideo feature details, and the stable/long-standing
feature sets of all editors above (marked as such in the method note).

Cadence state: verified in the repository code listed in the method note. No code changed.
