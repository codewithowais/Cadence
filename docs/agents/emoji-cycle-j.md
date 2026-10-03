# Emoji — catalog, picker, stickers, reactions & color-emoji export (Cycle J)

Owner: motion-designer lane, feature #5 "add many more emojis" + the carried-forward
limitation "no color-emoji stickers in export".

## What shipped

| Piece | Where |
|---|---|
| Full catalog: **1,870 base emoji, 3,395 with skin-tone variants**, 9 Unicode groups, subgroups, keywords, search | `packages/core/src/emoji.ts` (API), `emoji-catalog.ts` (generated) |
| Color-emoji drawing, identical in preview / node canvas / export | `packages/core/src/emoji-draw.ts` + `drawText` hook in `draw.ts`; providers: `apps/web/src/lib/emoji-assets.ts` (browser, lazy), `packages/render-node/src/emoji.ts` (node, sync disk) |
| Sprites (Twemoji 15.0 SVG, 3,395 files) + attribution | `apps/web/public/emoji/*.svg`, `ATTRIBUTION.md` |
| Generator | `scripts/sync-emoji.ts` (pinned devDeps `@twemoji/svg@15.0.0`, `emojibase-data@17.0.0`) |
| Picker UI (virtualized, tabs, search, skin tones, recents, favorites, drag) | `apps/web/src/components/EmojiPicker.tsx` — Design → **Emoji**, and compact inside Design → Text styles |
| Drop on the Stage | `apps/web/src/components/EmojiDropZone.tsx` (wraps `<Stage>` in `Editor.tsx`) |
| Sticker + reaction ops (pure) | `packages/director/src/emoji.ts` (`addEmoji`, `addReaction`, `editEmoji`, `REACTION_PACKS`, `timesWhenSaid`) |
| Director tools + StubDirector phrases | `packages/director/src/emoji-tools.ts` → `add_emoji`, `add_reaction`, `edit_emoji` |
| 9 emoji-forward text styles | `apps/web/src/lib/text-presets-pro.ts` (Hot take 🔥, Made with ❤️, Let's go 🚀, Cash in 💰, Winner 🏆, Thank you 🙏, Mind blown 🤯, Party time 🎉, Reaction caption 😂) |

## The rendering decision (why Twemoji sprites, not a font)

Options evaluated:

* **Noto Color Emoji font (OFL-1.1).** Safe license, but the font is ~10 MB (COLRv1 / CBDT) —
  24 MB unpacked as `@fontsource/noto-color-emoji` — and the *browser* canvas and Skia would
  rasterize it through two different font stacks, so pixels would not match.
* **OpenMoji (CC-BY-SA 4.0).** Share-alike is the wrong license for bundling in a product.
* **Twemoji (jdecked fork, graphics CC-BY 4.0).** Attribution-only, one asset per emoji, loads
  lazily, and *the same artwork is drawn by both renderers*. **Chosen.** Attribution ships at
  `apps/web/public/emoji/ATTRIBUTION.md` (and is stated in this doc / README credits).

Cost: 3,395 SVGs ≈ 7.6 MB of files (≈ 15 MB on disk with block rounding), served as static
files and fetched **per emoji on first use** — nothing is in the JS bundle. Twemoji 15.0 covers
Unicode Emoji 15.0; 44 newer emoji (Emoji 15.1–17) have no art and are therefore *not in the
catalog* (a handful still render as the platform glyph if typed into text).

How it works: `drawText` wraps its canvas context with `wrapEmojiCtx(ctx, fontSize, pxScale)`
whenever the text contains emoji **and** a provider is registered. The wrapper intercepts
`measureText` / `fillText` / `strokeText`, splits the string into grapheme clusters (ZWJ
families, flags, keycaps, skin tones stay whole), measures each emoji as an `1.18 × fontSize`
cell and draws a `1.12 × fontSize` sprite there. Plain text takes the untouched native path, so
legacy frames are byte-identical. Sprites are rasterized at a power-of-two bucket (64…512) by
stamping `width`/`height` onto the SVG, with the same rule in both providers. The export already
rasterizes text through the node canvas (`renderTextClipPng` / animated PNG sequences), so
**fixing `drawText` fixed the ffmpeg export** — verify check 71 decodes real `.mp4` frames and
counts flame-colored pixels.

An emoji sticker is therefore just a **text clip whose text is an emoji** (id `emo-{n}-sticker-1`
on its own lane `emoji-{n}`): every text feature — intro/loop/exit animation, keyframes,
transitions, the Text room, Code view — works on it, and emoji can sit inside any text clip.

## Drag & drop contract (for the timeline agent)

Emoji tiles and reaction-pack buttons are `draggable`. On `dragstart` they set:

| `dataTransfer` type | Value |
|---|---|
| `application/x-cadence-emoji` (`EMOJI_DRAG_MIME` from `@cadence/core`) | JSON `{"v":1,"emoji":"🔥","pack":"burst"?}` — `emoji` is already skin-toned; `pack` (optional) is a `REACTION_PACKS` key (`burst`, `float-up`, `clap`, `laugh`, `party`, `sparkle`, `pop`); absent ⇒ a single sticker |
| `text/plain` | the emoji character (so dropping into any text field works) |

`effectAllowed = "copy"`. To accept a drop anywhere (e.g. a timeline lane / the CutsStrip):

```ts
import { EMOJI_DRAG_MIME, decodeEmojiDrag } from "@cadence/core";
import { insertEmojiPayload } from "@/lib/emoji-insert";

onDragOver={(e) => { if (e.dataTransfer.types.includes(EMOJI_DRAG_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
onDrop={(e) => {
  const p = decodeEmojiDrag(e.dataTransfer.getData(EMOJI_DRAG_MIME)); // null if malformed
  if (!p) return;
  const { doc: next, clipId } = insertEmojiPayload(doc, p, { atSec: timeUnderPointer, xFrac, yFrac }); // fracs optional
  commit(next); select(clipId);
}}
```

`decodeEmojiDrag` is defensive (returns `null` for anything that is not a v1 payload). The Stage
drop is already wired by `EmojiDropZone` (it maps the pointer to frame fractions via the preview
canvas rect and uses the playhead as the start time). **A timeline lane drop is NOT wired** (the
CutsStrip is owned by the timeline agent) — use `atSec` = the time under the pointer.

## Director

* `add_emoji { emoji? | query?, atSec?, durationSec?, position?|xFrac,yFrac, scale?, intro?, loop?, exit?, rotation? }`
* `add_reaction { pack, emoji? | query?, whenSaid?, atSec? | atSec[], durationSec?, position?, scale? }`
  — `whenSaid:"love"` plays the pack at every moment that word is spoken (transcript mapped through the cuts).
* `edit_emoji { group?, emoji?, scale?, position?|xFrac,yFrac, atSec?, intro?, loop?, exit?, remove? }`

StubDirector phrases: "add a fire emoji at the top right", "add 🔥 and 😂", "add confetti",
"pop hearts when I say love", "make a fire burst at 2 seconds", "hearts floating up",
"add a laughing reaction", "clap spam", "sparkle burst". `parseEmojiRequest` returns the request
with its matched phrase blanked so the graphics router never also fires on it ("pop hearts…"
must not add the heart *graphic*).

## Limitations

* Twemoji art only (one style); the browser/node rasterizers differ by anti-aliasing (mean
  |ΔRGB| < 1 in verify) rather than being literally the same bytes.
* Emoji newer than Unicode 15.0 are missing from the catalog.
* Native emoji in the DOM (timeline clip labels, caption inputs) still use the platform font —
  only canvas-drawn text (Stage, export) uses the sprites.
* `strokeText` skips emoji (sprites have no outline); text *effects* that outline/hollow the
  fill therefore leave emoji untouched.
* Lane drop on the timeline: see the contract above; not wired here.
* Reaction packs are static layouts of independent text clips (deterministic, editable as a
  group via `edit_emoji`); individual pieces can still be edited in the Text room.
