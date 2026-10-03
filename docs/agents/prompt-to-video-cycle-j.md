# Cycle J — Product Manager + AI-director: prompt-based video making (feature #6)

**One sentence in, a complete editable video out** — with or without uploaded media.

> "30s Instagram promo for my coffee shop, warm vibe, upbeat music" ·
> "birthday wish for Ayesha" · "explain how photosynthesis works in 45s" ·
> "travel recap of Istanbul using my photos"

Everything below is free and offline. The real Claude planner is written, unit-tested with a mock, and **dormant** behind the money gate (see "Money gate").

## 1. The pipeline

```
prompt ──parseBrief──▶ Brief ──copy templates──▶ Storyboard (zod) ──review UI──▶ realiseStoryboard ──▶ EditDoc
        (genre, platform,        (scenes: copy, timing,        (edit / reorder /       (buildTextVideo + add_graphic +
         length, mood, nouns)     palette, graphic, media)      regenerate a scene)     generate_music + auto_sfx [+ TTS])
```

| Piece | File | What it is |
|---|---|---|
| Storyboard schema + planner seam | `packages/director/src/storyboard.ts` | zod `Storyboard` / `StoryboardScene`, `StoryboardPlanner` interface, `ClaudeStoryboardPlanner` (dormant), `selectStoryboardPlanner`, pure edit helpers (`moveScene`, `updateScene`, `removeScene`) |
| Understanding the sentence | `storyboard-brief.ts` | `parseBrief()` — genre (12) + confidence, platform, aspect, length, mood, music word, palette word, theme word, language, and the nouns: subject, name, relation, age, place, topic, count, offer, when, where, quote |
| Hand-written copy | `storyboard-copy.ts` | beats per genre with several variants each; category packs (coffee, food, fitness, beauty, tech, fashion, education, real estate); 14 occasions; a verified knowledge base for 11 explainer topics; tips banks for 11 topics; 15 place banks; stock-phrase packs for en/es/fr/de/ur(Roman) |
| The deterministic planner | `storyboard-stub.ts` | `planVideo()`, `regenerateScene()`, `refineStoryboard()`, `setStoryboardStyle()`, 12 palettes, mood → theme / music / look / transitions |
| Realiser + tools | `prompt-video.ts`, `prompt-video-refine.ts` | `buildStoryboardVisuals()` (pure), `realiseStoryboard()`, tools `plan_video`, `make_video_from_prompt`, `refine_video` |
| StubDirector routing | `stub-director.ts` | `parsePromptVideo()`, `parseRefineVideo()`, fallback help text |
| UI | `PromptStudio.tsx`, `PromptVideoPane.tsx`, `lib/prompt-studio-bus.ts` | the studio, the Text room "Describe" tab, a window event bus |

### Genres (12)
promo / ad · explainer · birthday & greeting (birthday, anniversary, Eid, Ramadan, graduation, congratulations, wedding, Valentine, Diwali, Christmas, new year, parents' day, thanks, get well) · travel recap · tutorial / tips · announcement (incl. hiring) · quote / motivation · event invite · product launch · testimonial · intro / outro · slideshow from photos.

### Determinism
`planVideo({prompt, media, overrides, seed})` is pure: the same input gives the same Storyboard (the seed defaults to a hash of the prompt). "Regenerate" bumps the seed; "regenerate this scene" bumps that scene's `variant`. Nothing reads the clock, the network, or `Math.random`.

### Honesty rules baked into the copy
* A customer **testimonial** is never invented as fact: if the prompt has no quote the card is a stand-in marked `needsEdit` (shown as "needs your detail"; a note explains it).
* **Explainers** use verified steps for the 11 topics it knows. For any other topic the scenes are a clearly generic outline marked `needsEdit`, with a note: "I don't have verified facts for this topic yet".
* **Tutorial how-to** steps for unknown topics are likewise flagged. Offers, dates and venues only appear if the user typed them.
* Urdu is written in **Roman** script because the bundled fonts have no Arabic glyphs (a known follow-up from Cycle H).

## 2. The Claude seam (dormant)

`Storyboard` is exactly the JSON an LLM would emit; `storyboardSystemPrompt()` is the contract in words. `ClaudeStoryboardPlanner(complete, fallback)`:

* takes an **injected** `complete({system, user}) => Promise<string>` — this package contains no HTTP client, no key, no network code;
* extracts the first balanced JSON object (fenced or not), validates with zod, sanitises media ids against the project's media, and **falls back to the stub planner** on any failure (bad JSON, schema mismatch, thrown error).

`selectStoryboardPlanner(stub, env, complete)` returns the Claude planner only when `env.DIRECTOR_MODE === "claude"` **and** a completion function was supplied. The tools call it with the default env and no completion, so the stub is always used today. Tested with a mock in `tests/prompt-video.test.ts` (valid JSON used, junk/error/invalid schema fall back, default env never enables Claude).

## 3. The realiser

`realiseStoryboard(project, sb)`:

1. `buildTextVideo` — the same engine as `make_text_video`, so every scene is a normal text scene (Text room, inspector, restyle all work).
2. Re-dress: per-scene gradient/pattern/transition from the storyboard, palette text + accent colours.
3. Uploaded photos / clips: an image or video clip per assigned scene on a `tv-media` track under the words. They are dimmed through their own **colour grade** (brightness) — not a scrim shape — because the export draws shapes after text (a known limitation), whereas a grade exports identically. `tv-media` and the `graphics-*` lanes survive restyle/reframe (additive change in `buildTextVideo`, only when rebuilding from scenes).
4. Existing tools: `add_graphic` (CTA for the platform: link-in-bio / follow / subscribe / like; badges; stickers), `generate_music` (mood picked from the storyboard, or the user's own audio file), `auto_sfx`, and — only when the storyboard asks for it — `generate_voiceover` + `auto_duck`.
5. The Storyboard is stored on the doc (`doc.textVideo.storyboard`, an additive `z.unknown()` field on the recipe) so refinement, the storyboard review and version history survive reloads.

### TTS / voice-over
Off by default. A "voice-over" chip / phrase sets `voiceover: true`; the realiser then calls the existing `generate_voiceover` tool, which needs `TTS_PROVIDER=cli|api` (a paid/metered service). With none configured the tool throws its normal message; the realiser records it as a **warning** ("Voice-over is off…"), builds everything else, and never fails. Verified by a unit test, an eval and the e2e.

## 4. UI

* **Landing hero**: a plain GET form (`/editor?describe=…`) — works before any JS loads; plus "Describe a whole video" example chips.
* **New project**: "Describe a video" creates a project and opens `/project/{id}?studio=1`.
* **Editor empty state**: primary "Describe your video" button (Stage), the rail's empty state, and the "didn't understand" reply ("Describing a whole video? Open the Describe-your-video studio"), plus the stub Director's help text.
* **Studio** (`PromptStudio`): prompt box (Fraunces italic) + example chips; chips for platform · length · vibe · language · music · voice-over (all default to *Auto*); attach photos/clips (registered as project media without touching the timeline; thumbnails toggle on/off).
* **Storyboard review** (before anything is built): scene cards with editable heading + supporting line, seconds, media pick, ↑ ↓ reorder, ↻ regenerate this scene, × delete, a mini gradient thumbnail, "needs your detail" badge; right column: Regenerate / Punchier / Shorter / Longer / Different style, theme, palette swatches, music, SFX, voice-over, shape. Notes (honesty hints) above the list.
* **Create video** → one undoable commit (toast "Undo"), opens the Text room on Scenes, with the Director message and next-step chips.
* **After creation**: Text room → **Describe** tab (refine chips + "Review storyboard" which re-opens the studio on the stored storyboard) and the rail's next-step chips ("Make it punchier", "Make the video shorter", "Try a different style").

## 5. Director routing (StubDirector)

* Creation: any request that has no user-supplied script (a colon script / quoted words stay a **text video**), no video footage to edit, and a clear genre with a real noun — or "make/create … video/promo/…" — routes to `make_video_from_prompt`. On a project that already has a timeline it only fires for an explicit "make a … video" or a self-contained description with a noun ("birthday wish for Ayesha"); "add a title: Happy Birthday" stays an edit; "make a slideshow from my photos" stays `make_slideshow`.
* Refinement: "make it punchier / shorter / longer", "a different style", "regenerate / try again" → `refine_video` (punchier / shorter / different-style also work on any plain text video).
* Fallback: the "didn't understand" text and UI now suggest this feature.

## 6. Gates (see CHANGELOG S7.x for the numbers)
`npm run typecheck` (root + web) · `npm run test:unit` (new `tests/prompt-video.test.ts`: classification × 19 genres, planner determinism/schema/timing, overrides, media assignment, regenerate/refine/style, honesty flags, Claude seam with a mock, realiser, routing) · `npm run verify` (new check 71: one proof frame per genre) · `npm run evals` (11 new prompts g–q, each renders a proof frame) · `next build` · Playwright `e2e/prompt-video.spec.ts` (hero → studio → storyboard → edit → create → refine → real `.mp4` export; photos; composer routing + unmatched fallback).

## 7. Money gate — exact status
* **No paid API is called, wired, or reachable by default.** `DIRECTOR_MODE` is not read by the app's runtime path; `selectStoryboardPlanner` returns the stub unless the host *also* injects a completion function, and nothing in the repo does.
* The Claude planner is dormant code + a mock-tested contract. Turning it on later needs: (1) approval at the ⛔ MONEY GATE, (2) an Anthropic key in env, (3) a host that builds a `CompleteFn` from the SDK and passes it to `selectStoryboardPlanner`.
* TTS voice-over stays gated and gracefully off. No other metered service was added.

## 8. Limitations
* Copy is template-written: specific to the user's nouns, but not a language model — unusual requests fall back to a flagged generic outline. The Claude planner is the upgrade path.
* Explainer facts are verified for 11 topics only (photosynthesis, water cycle, internet, black holes, compound interest, vaccines, blockchain, AI learning, greenhouse effect, electricity, gravity); everything else is a flagged outline.
* Languages: stock phrases (greetings, CTAs, "you're invited") are localised for es/fr/de/ur-Roman; birthday wishes are fully localised; descriptive lines stay English so they can be edited.
* No colour emoji in the exported video (the card shows them; the bundled fonts have none). Emoji are a storyboard-card decoration only.
* Uploaded media sits under the words per scene (full-frame, dimmed), aligned to the scene timing at creation.
* Graphics added at creation live on their own `graphics-*` tracks. A restyle / reframe keeps them (and the `tv-media` photos) at their old times; a brand-new script from the Text room's Create tab starts clean. If scenes are added/removed afterwards, those overlays are not re-timed.
* Preview of generated music/sfx follows the existing limits (the "exporting before generated music finishes composing" note from Cycle I).
