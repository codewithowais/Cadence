# Product manager — First-run ease & discoverability

Owner lane: `DirectorRail.tsx`, `QuickActions.tsx`, and the new `CommandPalette.tsx`,
`OnboardingChecklist.tsx`, `NextSteps.tsx`, `PromptLibrary.tsx`, `lib/suggestions.ts`,
`lib/commands.ts`, `lib/recent-prompts.ts`. Shared files only get small appended
wiring (mount + props + one key binding).

## 1. Audit — the first two minutes today

Walked landing → `/editor` (empty) → first edit → export, as a non-technical creator.

| # | Moment | What happens now | Why it hurts |
|---|--------|------------------|--------------|
| 1 | Empty editor | Rail card ("Add a video — or photos" + 4 text starters) and a Stage card ("Start with words or footage"). | Two equal-weight entry points, no sense of "what's the path to a finished video". No progress. |
| 2 | After upload | Three fixed suggestions, shown only while `messages ≤ 2`, then gone forever. | After the first edit the rail goes quiet: nothing says what to do next. |
| 3 | 60+ Director tools | Discoverable only by (a) 11 one-tap chips, (b) a long "Try: …" wall of text when a request doesn't match, (c) guessing. | Recognition over recall fails; most capabilities are invisible (slow motion, freeze frame, platform presets, karaoke, text themes…). |
| 4 | "I didn't understand" | `helpMessage` dumps 15–20 examples in one grey paragraph. Nothing is clickable. | The user has to re-type. The message reads like an error, not help. |
| 5 | Re-running a prompt | Composer forgets everything; retyping is the only way. | Iterating ("warmer… no, cinematic") is slow. |
| 6 | Doing anything non-prompt | Undo, export, panels, rooms, shortcuts are spread across TopBar, RoomsRail, overflow menu and hidden keys. | No single "find anything" entry point. Keyboard users have no way to jump. |
| 7 | Director network error | Red bubble, no retry. | Dead end. |

## 2. Plan — problem → feature → success signal

| # | User problem | Feature | Success signal |
|---|--------------|---------|----------------|
| F1 | "I don't know what this app can do / where a thing lives." | **⌘K / Ctrl+K command palette** (`CommandPalette.tsx`, `lib/commands.ts`). Fuzzy-searches every room, context-aware one-tap edit, the whole prompt library, project actions (export, undo, redo, panels, shortcuts, play) and recent prompts. Anything that doesn't match becomes "Ask the Director: …". Also opened from a TopBar "Search" button. | Any capability reachable in ≤ 3 keystrokes; zero "no results" dead ends (free text always runs). |
| F2 | "What's the path to a finished video?" | **Getting-started checklist** (`OnboardingChecklist.tsx`): *Add footage or start with text → Make your first edit → Preview it → Export*. Ticks itself off from real editor state (content present, a doc change after content existed, playback, an export run). Dismissible, progress persisted per browser. Collapsed to one "Next: …" line with a CTA so it never crowds the chat. | % of first sessions reaching "Export" ↑; checklist completion rate. |
| F3 | "I made one edit — now what?" | **Next-step chips** (`NextSteps.tsx`) under the latest Director edit, from a PURE `nextSteps(doc, mode, lastTools)`: after a highlight → captions / vertical / remove filler; after a text video → another theme / vertical / animation; nothing is suggested that's already applied (captions on, already vertical, a look set…). | Edits per session ↑; share of edits started from a chip. |
| F4 | "What can I even say?" | **Prompt library** (`PromptLibrary.tsx`): 66 verified ideas in 9 goals (Make it shorter, Social-ready, Captions & titles, Look & feel, Motion & timing, Sound, Text videos, Photos, Quality), searchable, context-aware ("needs footage" badges). Click inserts into the composer (tweakable); ↵ runs. Every prompt is unit-tested to route to a real tool. | Library opens → prompt runs conversion; unmatched-request rate ↓. |
| F5 | "Let me try that again, slightly different." | **Recent prompts**: ↑/↓ in the composer walks the last 20 prompts (persisted per browser, storage failures ignored); recents also appear in the palette. | Re-runs without retyping. |
| F6 | "It said it didn't understand and I'm stuck." | **Friendly no-match**: "I'm not sure how to do "…" yet — closest things I can do:" + 3 clickable closest prompts (pure token/synonym ranking) + "See all ideas". Errors get a **Try again** chip. | Recovery rate after a no-match ↑. |

Non-goals: no new Director routing (stub-director is shared), no paid/network services,
no new dependencies.

## 3. Architecture notes

- **One path for everything.** Palette, chips, checklist CTAs and the library never
  implement edits: a prompt goes through the editor's `handleSend` (same as the
  composer), and non-prompt actions call the existing handlers (`undo`, `redo`,
  `setRoom`, `exportDoc`, `toggleRail`, …). `CommandAction` is a small discriminated
  union the Editor maps to those handlers in one switch.
- **Pure logic in `apps/web/src/lib/suggestions.ts` + `commands.ts`** (no React, no `@/`
  imports) so `tests/suggestions.test.ts` imports them directly.
- `Message` gained optional `tools` (tool names of a Director edit), `request` and
  `kind: "unmatched" | "failed"` — additive; old messages render unchanged.
- The palette is a real `dialog` with a `combobox` + `listbox` (`aria-activedescendant`),
  focus returns to the opener on close, motion respects `prefers-reduced-motion`.

## 4. E2E-safety rules (the rail is always mounted)

Existing specs use loose, case-insensitive `getByRole("button", { name })` lookups, and
the rail comes early in DOM order. Labels in always-visible UI (rail chips, checklist,
TopBar search) therefore avoid containing: *Send, Start with text, Cinematic, Kinetic
title, Words, Speed, Media, Design, Audio, Deliver, Tighten pauses, video clip, image
clip*, and never start with *Export / Style / Animate / Background*.

## 5. Status

Built: F1–F6, plus QuickActions polish (applied chips show a quiet ✓ — accessible name
unchanged — and a trailing "More" opens the library).

**Bug fixed on the way (first-run export path):** the Deliver room's "Export .mp4"
passed its click event into `exportDoc(overrideDoc)`, so export failed with
"Cannot read properties of undefined (reading 'length')". `Editor.tsx` now wires it
as `onExport={() => void exportDoc()}` (one token; found by the onboarding e2e).

**Known limitations**
- The checklist's "Download your video" ticks when an export *starts* (the Editor
  exposes `exporting`, not success) — a cancelled export still counts.
- Only the latest Director reply carries chips; older replies stay plain text.
- Clean audio / stabilize / layouts have no Director routing yet, so the library
  lists them as "Opens <room>" shortcuts rather than prompts.
- `SHORTCUTS` (ShortcutsHelp, another lane) doesn't list ⌘K yet; the TopBar search
  button, the composer hint and the palette footer advertise it instead.

Notes:

- `lib/suggestions.ts` — prompt library, goals, `nextSteps`, `closestIdeas`,
  `onboardingSteps`, `pushRecent`, `fuzzyScore`.
- `lib/commands.ts` — `buildCommands`, `rankCommands`.
- `lib/recent-prompts.ts` — localStorage load/save (try/catch).
- `components/CommandPalette.tsx`, `OnboardingChecklist.tsx`, `NextSteps.tsx`,
  `PromptLibrary.tsx`, `Overlay.tsx` (shared accessible modal shell); `DirectorRail.tsx`, `QuickActions.tsx` updated.
- Wiring: `Editor.tsx` (palette state + ⌘K binding + action switch + message metadata),
  `TopBar.tsx` (optional `onOpenPalette` search button).
- Tests: `tests/suggestions.test.ts` (pure logic + every library prompt routes through
  the StubDirector to ≥1 tool in its context), `apps/web/e2e/onboarding.spec.ts`.
