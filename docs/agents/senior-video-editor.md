# Senior Video Editor — "Editing speed & timeline craft"

Owner: senior-video-editor agent · Branch: `worktree-agent-a6f35f8ba33de55e2` (base `master @ e036a14`)

Goal: make everyday cutting FAST for people with CapCut / Premiere / Resolve
muscle memory — without requiring anyone to know what a "ripple" or an "edit
point" is. Every feature is edit-doc data changed by PURE doc-in/doc-out ops,
applied through the editor's undoable `commit`, and (where natural) callable by
the Director as a typed tool.

## Audit (what already existed at e036a14)

| Area | State before | Gap |
|---|---|---|
| Transport | Space play/pause, ←/→ ±1s, ⇧←/→ ±5s, Home | No JKL shuttle, no frame step, no in/out marks |
| Snapping | Always on (clip edges, playhead, markers, ends), invisible | No way to turn it off; no feedback when a drag snaps |
| Gaps | "Delete" leaves a gap; upper layers can hold gaps | No way to see or close them except dragging |
| Selection | One clip at a time | No multi-select, no group delete / duplicate / nudge |
| Attributes | Look / transform / motion set per clip | No way to copy one clip's settings onto others |
| Cutting | `S` splits the selected / active main clip | No "split every track", no jump between cuts |
| Speed | Constant speed slider keeps the clip's LENGTH (consumes more/less source) | No one-tap 0.5× / 2× that keeps the same footage (CapCut behaviour) |
| Freeze | `freeze_frame` freezes the WHOLE clip | No "hold this frame for 2s and carry on" |
| Preview | Stage seeks `sourceIn + (t − start)` — ignores speed / freeze / reverse | Speed + freeze edits previewed wrong frames |

## What ships (6 feature groups)

1. **Transport: JKL shuttle, frame step, in/out range**
   - `J` / `K` / `L` — reverse / stop / forward; tap again for 2× then 4×.
     1× forward is real playback with sound; other rates scrub the picture.
   - `,` / `.` step one frame (⇧ = 10 frames), at the project fps.
   - `I` / `O` mark in / out; ⌥X clears. The range is shaded on the ruler with
     a chip: **Remove range** (ripple-delete across every unlocked track —
     footage, captions, music and markers all close up) and **Keep only range**.
     `Delete` with no clip selected removes the marked range.
   - User value: the two fastest editing gestures in any NLE (scan + mark + lift).
2. **Snapping toggle + snap indicator** — a magnet button (and `N`) turns
   snapping on/off (remembered per browser); while dragging, a teal guide line
   shows exactly which edge/playhead/marker you snapped to.
3. **Gaps you can see and close** — empty space on a sequence lane is drawn as a
   dashed "gap" block; click it to close just that gap, or **Close gaps** in the
   toolbar to pack every lane. Captions/titles/b-roll over the footage follow.
4. **Multi-select** — ⇧/⌘-click to add/remove clips, ⇧-drag on an empty lane for
   a marquee, ⌘A selects everything, Esc clears. Group **ripple-delete** (Del),
   **duplicate** (⌘D) and **nudge** (⌥←/→ one frame, ⇧⌥ ten frames; a single
   magnetic main clip reorders instead). A selection bar shows the count.
5. **Copy / paste attributes** — ⌘⇧C copies the selected clip's settings, ⌘⇧V
   pastes them onto every selected clip. The inspector's **Paste attributes**
   popover lets you pick groups: Look, Transform & blend, Motion (keyframes /
   Ken Burns / text animation), Audio (volume, fades, pan), Speed.
6. **Cutting pack**
   - **Split all tracks** at the playhead (⇧S + toolbar).
   - **Previous / next cut** (↑ / ↓) jumps the playhead between edit points;
     ⇧↑ / ⇧↓ jump between markers.
   - **Speed presets** (0.5× · 1× · 1.5× · 2×) that keep the same footage — the
     clip gets longer/shorter and the timeline ripples (captions follow).
   - **Freeze frame here** (`F` + inspector): splits the clip at the playhead and
     inserts a 2s still of that exact frame; the rest plays on after it.
   - Preview parity fix: the Stage now maps time through core's `sourceTimeAt`
     (speed / ramp / freeze / reverse) and sets the `<video>` playbackRate, so the
     preview shows the same frame the canvas renderer and ffmpeg export do.

## Files

- NEW `packages/director/src/craft.ts` — the pure ops: `splitClipAt`,
  `splitAllAtTime`, `trackGaps`, `closeGap`, `closeGaps`, `rippleDeleteRange`,
  `keepRange`, `insertFreezeFrame`, `retimeClip`, `rippleDeleteClips`,
  `duplicateClips`, `nudgeClips`, `copyClipAttributes`, `pasteClipAttributes`,
  `editPoints`, `nextEditPoint`, `splitKeyframes`.
- `packages/director/src/tools.ts` (appended) — tools `split_all_tracks`,
  `close_gaps`, `cut_range`, `hold_frame`, `retime_clip`.
- `packages/director/src/stub-director.ts` (appended routing) — "split all tracks
  at 4s", "close the gaps", "remove 2s to 5s" / "keep only 2s to 5s",
  "freeze the frame at 3s for 2 seconds".
- NEW `apps/web/src/lib/use-editing-craft.ts` — transport/shuttle loop, in/out,
  snapping, multi-select, attribute clipboard, key map, and the `TimelineEdit`
  callbacks, so `Editor.tsx` only gains a few wiring lines.
- `apps/web/src/lib/edit-ops.ts` — thin re-exports + `splitClip` keyframe fix.
- `apps/web/src/components/CutsStrip.tsx` — UI: snap toggle + guide, in/out
  range on the ruler, gap blocks, multi-select highlight + marquee + selection
  bar, split-all / close-gaps buttons, shuttle badge, inspector speed presets,
  freeze, copy/paste attributes.
- `apps/web/src/components/ShortcutsHelp.tsx` — grouped, complete shortcut list.
- `apps/web/src/lib/preview.ts` + small appended effect in `Stage.tsx` — parity.
- `apps/web/src/components/Editor.tsx` — hook call, one key-handler line, prop
  spread (appended).
- Tests: NEW `tests/editor-craft.test.ts`, NEW `apps/web/e2e/editing-craft.spec.ts`,
  verify check 67 (`checkEditingCraft`) in `scripts/verify.ts`.

## Design decisions / limitations

- In/out marks, shuttle rate, snapping and the selection are editor/UI state
  (like the playhead), not edit-doc data — they describe how you are working,
  not what the video is. Everything they DO goes through doc ops + undo.
- Shuttle rates other than 1× scrub the picture without audio (browsers cannot
  play `<video>` backwards); 1× forward is normal playback with sound.
- Locked tracks never ripple (range remove / close gaps leave them untouched),
  matching Premiere's lock semantics.
- Nudge moves free-positioned clips (overlays, titles, upper layers); clips on a
  magnetic main lane stay back-to-back (reorder them instead).
- Group drag (dragging several clips at once with the mouse) is not included —
  use nudge / cut / paste for groups.
- The marquee starts from the ruler or an empty lane with ⇧ held (a plain click
  there still seeks, as before).
- Esc: an open dialog (shortcuts sheet, command palette, paste picker) always
  gets it first; otherwise Esc clears the selection, then the in/out marks.
- The ShortcutsHelp list is now grouped (Playback · Navigate · Cut & edit ·
  Select · Panels) and includes the ⌘K / Ctrl+K command palette row. `SHORTCUTS`
  keeps its `{ keys, label }` shape (plus a `group` field), so any consumer still works.
- Web `splitClip` now delegates to the engine's `splitClipAtTime`: split halves
  get per-half keyframes / audio fades / speed-ramp curves / karaoke words and
  deterministic ids (`<id>-b`). No existing test needed changing.

## Results (gates)

- `npm run typecheck` ✔ · web `tsc --noEmit` ✔
- `npm run test:unit` ✔ 93/93 (15 new in `tests/editor-craft.test.ts`)
- `npm run verify` ✔ incl. new check 67 (editing craft: split-all frames
  byte-identical, range cut slides the tail intact, freeze = tpad clone,
  2× retime = setpts /2, paste look)
- `npm run evals` ✔ 6/6
- `npm run build -w @cadence/web` ✔
- Playwright on :3101 — `e2e/editing-craft.spec.ts` ✔ and the FULL suite ✔ 26/26
  (incl. `e2e/flows.spec.ts` 4/4).
