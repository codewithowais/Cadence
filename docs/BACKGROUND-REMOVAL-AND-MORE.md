# Cadence — Background Removal & More: Design Plan

> **Author:** Senior video-editing product + rendering architect.
> **ADVISORY / DESIGN ONLY — no code changed** (this doc is the only file written).
> **Date:** 2026-09-07.
> **Goal:** design **background removal** (faithful, matte-based) plus a curated set of
> other high-impact "best" features for Cadence, all with effortless UX, honoring
> Cadence's two hard rules: (1) **faithfulness** — never generatively redraw content;
> (2) **money gate + pluggable providers** — paid/compute-heavy AI is off by default
> behind an honest, swappable seam.

---

## 0. Verified baseline (read the code, not the docs)

Everything below is anchored to the **actual repository code** as of this date:

- **Provider seam (the pattern to mirror exactly):**
  - `packages/enhance/src/provider.ts` — `EnhanceProvider { id, label, usesAI,
    preservesIdentity: true, isAvailable(), enhance(req) }` + a pure `buildCliArgs(template,
    vars)` argv builder.
  - `packages/enhance/src/registry.ts` — `EnhanceConfig`, `configFromEnv(env)` keyed off
    `ENHANCE_PROVIDER` (default `free`), `allProviders(cfg)` (for UI listing), `selectProvider(cfg)`
    (switch → falls back to the free path).
  - `packages/enhance/src/providers/{free,local,api,cli}.ts` — `free` is available + non-AI
    (work happens in the ffmpeg filtergraph), the rest are AI/gated.
  - `packages/understanding/src/tts.ts` — the **closer template for a gated-by-default seam**:
    `TtsProvider { id, label, usesAI, isAvailable(), synthesize(req) }`, a `NoneTtsProvider`
    (default, `isAvailable()===false`, `synthesize()` throws `TTS_UNAVAILABLE_MESSAGE` — a
    concrete "money-gated; set TTS_PROVIDER=…" string), `CliTtsProvider` (command template +
    pure `buildTtsArgs`), `ApiTtsProvider` (POST bytes, `TTS_API_URL`/`TTS_API_KEY`), plus
    `ttsConfigFromEnv`, `allTtsProviders`, `selectTtsProvider`. **Node built-ins are imported
    LAZILY** inside functions so the module stays import-safe for the browser bundle (the
    barrel is re-exported through `@cadence/director`, which `RoomPanel` imports).
  - `packages/understanding/src/whisper-transcriber.ts` — the **security guard to reuse**:
    `assertLocalMediaPath(src, env)` rejects protocol/pseudo-path/flag shapes, `realpath`s to
    collapse symlinks + `..`, and requires containment inside the uploads dir
    (`CADENCE_MEDIA_DIR` / `<tmp>/cadence-uploads`). ffmpeg is invoked with
    `-protocol_whitelist file,pipe`. **Any new provider that hands a client-supplied media
    path to a CLI/ffmpeg MUST run this guard first.**

- **Schema (`packages/core/src/schema.ts`):** clips are a discriminated union
  (`video|image|text|audio|solid|cursor|callout|adjustment`). `VideoClip`/`ImageClip`
  already carry `chroma?: ChromaKey`, `mask?: Mask`, `blendMode`, `regionFx?`. `ChromaKey`
  = `{color, similarity, blend, spill}`. `SolidClip` is a full-frame color fill. `Track`
  array order **is** z-order; a track id of `broll` is always overlaid (never the base).
  `Meta.background` is the fit-to-frame ground color.

- **Export compositing (`packages/render-ffmpeg/src/plan.ts`):** a base visual track is
  concat/xfade'd; every higher visual track (and the `broll` lane) is composited over it in
  `collectUpperLayers`. The **alpha overlay path already exists** (~line 1395):
  `format=rgba` → `chromaFilters(chroma)` (`chromakey=…` + optional `despill`) →
  `maskGeqFilter(mask)` → `setpts` shift → `overlay=x:y:enable='between(t,…)'`. Blend layers
  use `blend=all_mode=…`. **A produced alpha matte plugs into this same path** with one added
  filter (`alphamerge`) — no new compositor.

- **Preview (`packages/render-node/src/canvas-engine.ts`):** the canvas approximates chroma
  by dropping the fill (~line 408: "the keyed background is dropped … the export uses real
  chromakey"), masks via clip-path + feather, blends via `globalCompositeOperation`. It is a
  pure function shared with the browser Stage.

- **VFX/Design UI (`apps/web/src/components/RoomPanel.tsx`):** the **Design** room has
  categories `looks | grade | backgrounds | text | overlays | advanced`. `AdvancedSection`
  (~line 1676) holds the pro compositing controls (chroma key "Green screen" pill, blend,
  blur/pixelate, mask), wired through the browser edit-ops in `apps/web/src/lib/fx.ts`
  (`chromaKey`/`clearChroma`/`currentChroma`/`compositeScope`/`compositeTargets`) → the
  editor's undoable commit path for instant preview. `BackgroundsGallery` (~line 1426) sets
  `meta.background`. Rooms are defined in `RoomsRail.tsx`
  (`media|edit|design|words|demo|audio|deliver`).

- **Director parity:** `packages/director/src/edits.ts` has `chromaKey(...)`; tools are
  registered in `packages/director/src/tools.ts` (every capability is reachable by prompt
  AND by hand). `scripts/verify.ts` renders a doc at a time offset and asserts non-blank
  frames via `renderAndAssert(doc, timeSec, outName)` (e.g. `checkBroll`, `checkEnhance`).

- **Wave convention (`docs/WAVE-PLAN.md`, `docs/COMPETITIVE-FEATURES.md`):** each wave runs
  two agents on **disjoint** trees — **Engine** owns `packages/**` (+ `scripts/verify.ts`);
  **Web** owns `apps/web/**`. Integrate → gate → commit between waves.

**Honesty note on the "free removal already works" claim:** Cadence's chroma key is a real,
shipped background *removal* — but only for footage shot on a solid color (green/blue
screen). Removing the background from *ordinary* footage (a person at a desk, no green
screen) needs a matte model; that is the gated path this doc adds.

---

## A. Background removal — full design

### A.1 What "remove background" means here (faithfulness boundary)

- **Allowed (this design):** produce an **alpha matte** (a per-pixel opacity map of the
  subject) and **composite the subject over a chosen background**. The subject pixels are
  never redrawn — we only decide which existing pixels are kept.
- **Not allowed (out of scope, off-brand):** generative background **replacement/extension**
  (inventing scenery behind the subject), generative fill, face/scene redraw. We composite
  the *real* subject over a background the user supplies (solid / blur-of-original / their own
  image / their own video), never over synthesized content.

This mirrors the standing `preservesIdentity: true` contract in `@cadence/enhance`: a matting
provider removes/keeps pixels; it must never hallucinate subject pixels.

### A.2 The FREE path (ships today, make it obvious)

**Chroma key = free background removal without a model.** If you shoot on green/blue screen,
`ChromaKey` already removes the background and composites over the track beneath — canvas
preview + real ffmpeg export, no provider, no cost. The design surfaces this prominently so
users learn the free path exists (see UX, A.7).

The AI matting path below is the *same compositing pipeline* — it just swaps the "which pixels
are background" decision from a color key to a produced matte, so ordinary (non-green-screen)
footage can have its background removed too.

### A.3 The pluggable matting provider contract (new package `@cadence/matting`)

Mirror `@cadence/enhance` and `tts.ts` **exactly** — same file shapes, same env-driven
registry, same lazy-Node-import discipline, same honest gated message.

```
packages/matting/src/
  provider.ts     // MattingProvider interface + pure helpers
  registry.ts     // MattingConfig, configFromEnv, allProviders, selectProvider
  providers/
    none.ts       // NoneMattingProvider — default, unavailable, honest gated throw
    cli.ts        // CliMattingProvider — local rembg / RVM / MODNet via a command template
    api.ts        // ApiMattingProvider — hosted metered endpoint
  index.ts        // barrel (mirror enhance/index.ts)
```

**`provider.ts`:**

```ts
export interface MatteRequest {
  /** Client-supplied source media path — MUST pass assertLocalMediaPath before use. */
  inputPath: string;
  /** Where the provider writes the matte (grayscale alpha) or an RGBA cutout. */
  outputPath: string;
  kind: "image" | "video";
  /** What the output file is: a single-channel matte, or a premultiplied RGBA cutout. */
  outputMode: "matte" | "rgba";
}

export interface MatteResult {
  outputPath: string;
  provider: string;
  usesAI: boolean;
  outputMode: "matte" | "rgba";
  /** True: the subject pixels are never redrawn — removal only. Standing contract. */
  preservesIdentity: true;
  note?: string;
}

export interface MattingProvider {
  id: string;
  label: string;
  usesAI: boolean;
  /** Always true — matting keeps/removes pixels, never invents subject content. */
  preservesIdentity: true;
  /** True when this provider can run in the current environment (configured). */
  isAvailable(): Promise<boolean>;
  /** Produce a matte/cutout for req; throws with an honest message when unavailable. */
  matte(req: MatteRequest): Promise<MatteResult>;
}

/** The honest, actionable message when no matting provider is configured. */
export const MATTING_UNAVAILABLE_MESSAGE =
  "AI background removal isn't configured (compute-gated). For FREE removal, shoot on a " +
  "green screen and use Chroma Key. For any footage, set MATTING_PROVIDER=cli with " +
  "MATTING_CLI_COMMAND (e.g. a rembg / Robust-Video-Matting / MODNet wrapper), or " +
  "MATTING_PROVIDER=api with MATTING_API_URL + MATTING_API_KEY.";

/** Pure argv builder — reuse enhance's buildCliArgs shape ({input}{output}{mode}). */
export function buildMattingArgs(template: string, vars: Record<string, string>): string[] { /* … */ }
```

**`registry.ts`** (keyed off `MATTING_PROVIDER`, default `none`):

```ts
export interface MattingConfig { provider: string; cliCommand?: string; apiUrl?: string; apiKey?: string; }
export function mattingConfigFromEnv(env = process.env): MattingConfig {
  return {
    provider: env.MATTING_PROVIDER?.toLowerCase() || "none",
    cliCommand: env.MATTING_CLI_COMMAND,
    apiUrl: env.MATTING_API_URL,
    apiKey: env.MATTING_API_KEY,
  };
}
export function allMattingProviders(cfg): MattingProvider[] { /* [None, Cli, Api] */ }
export function selectMattingProvider(cfg): MattingProvider { /* switch → NoneMattingProvider default */ }
```

**Providers:**

- **`NoneMattingProvider`** (default): `usesAI=false`, `isAvailable()===false`, `matte()`
  throws `MATTING_UNAVAILABLE_MESSAGE`. Exactly like `NoneTtsProvider` — never a silent no-op,
  never a fake file. This is what keeps AI matting **off by default**.
- **`CliMattingProvider`**: runs any local CLI from `MATTING_CLI_COMMAND` with tokens
  `{input} {output} {mode}`, e.g.
  - rembg (image/frames): `rembg i {input} {output}`
  - Robust Video Matting (video, best for temporal stability):
    `rvm --input {input} --output-composition {output} --output-type matte`
  - MODNet wrapper script: `modnet-matte {input} {output}`

  `isAvailable()` = the command is a non-empty string (mirrors `CliTtsProvider`). Node's
  `spawn` is imported lazily. **`assertLocalMediaPath(inputPath)` runs before spawn.**
- **`ApiMattingProvider`**: POSTs the file bytes to `MATTING_API_URL` with
  `Authorization: Bearer <MATTING_API_KEY>` and `x-faithful: true`, writes back the matte/cutout
  bytes. `isAvailable()` = both url+key present. Point it at a faithful matting endpoint (RVM /
  BiRefNet / a hosted rembg), never a generative model — the same operator-responsibility note
  `@cadence/enhance` already carries.

**Env additions (`.env.example`)** — mirror the ENHANCE/TTS blocks:

```
# Background removal (matting). Default "none" = FREE chroma-key only (green screen).
# AI matting for any footage is compute-gated: wire a CLI or API.
MATTING_PROVIDER=none
# MATTING_CLI_COMMAND=rvm --input {input} --output-composition {output} --output-type matte
# MATTING_API_URL=
# MATTING_API_KEY=
```

### A.4 Edits-as-code integration (schema + how it renders)

The matte is a **produced asset referenced by the clip**, so the EditDoc stays declarative and
the render stays a pure function of the doc (re-render is deterministic; no opaque state).

**Schema addition — one optional field on `VideoClip` and `ImageClip`:**

```ts
/**
 * Background removal via a produced alpha matte (NOT a color key — see `chroma` for the
 * free green-screen path). `matteAssetId` references a MediaAsset (kind "video" or "image")
 * holding the grayscale matte (or premultiplied RGBA cutout) produced by a MattingProvider.
 * When present, the clip is alpha-composited over the layer beneath, exactly like a chroma
 * key. Optional so existing docs stay valid. Faithful: keeps/removes existing pixels only.
 */
matte: z.object({
  matteAssetId: z.string().min(1),
  /** "matte" = grayscale alpha (alphamerge with the source); "rgba" = premultiplied cutout. */
  mode: z.enum(["matte", "rgba"]).default("matte"),
  /** 0..1 edge feather / erode for a clean composite (maps to a small alpha blur). */
  feather: z.number().min(0).max(1).default(0.15),
}).optional(),
```

Why an asset reference (not inline pixels): the matte is heavy and per-frame for video; storing
it as a `MediaAsset` (produced once, cached, versioned with the doc) keeps the doc small,
keeps re-render deterministic, and reuses the existing media resolver + `assertLocalMediaPath`
whitelist for the matte path.

**"Remove background" is a two-step, honest flow:**

1. **Produce** (server, gated): the editor calls a new API route (or Director tool
   `remove_background`) → `selectMattingProvider(mattingConfigFromEnv())`. If unavailable →
   return `MATTING_UNAVAILABLE_MESSAGE` to the UI (no doc change). If available → run
   `matte(req)`, register the output as a `MediaAsset`, and set `clip.matte.matteAssetId`.
2. **Composite** (pure, free): every renderer reads `clip.matte` and composites — no provider
   needed at render time (the matte is already a file), so preview and export are both offline
   and deterministic after production.

**Export (`render-ffmpeg/plan.ts`)** — extend the existing alpha overlay path in
`collectUpperLayers` (the code at ~line 1395 that already does chroma). The clip becomes an
alpha layer (`isAlpha` also true when `clip.matte` is set):

- `mode: "matte"` → add the matte as an extra input, scale/crop it to the box, then
  `[subject][matte]alphamerge` (subject RGB + matte luma → RGBA), optional `boxblur` on the
  alpha plane for `feather`, then the existing `overlay=…:enable='between(t,…)'`.
- `mode: "rgba"` → the cutout already carries alpha; `format=rgba` then straight into
  `overlay`.

This is **one new `alphamerge` line** on a path that already exists — the compositor,
z-order, PiP transform, blend, and time-gating are all unchanged.

**Preview (`render-node/canvas-engine.ts`)** — parity where possible, documented approximation
where not:

- **Free chroma path:** unchanged (already approximates by dropping the fill / showing a
  subject band).
- **AI matte path, matte produced:** load the matte asset like any media; draw the subject
  into an offscreen canvas, apply the matte as `globalCompositeOperation="destination-in"`
  (grayscale matte) or draw the RGBA cutout directly, then composite over the layer beneath.
  This is **true parity** with export — the same matte pixels. For video mattes the canvas
  preview samples the matte frame at the same source time as the subject (the engine already
  maps source time via `sourceTimeAt`).
- **AI matte path, not yet produced:** show the free chroma-style approximation + a small
  "matte pending — click Remove background" affordance, never a broken frame.

Document the one honest gap (already the norm for `curves`/`lut`): if a video matte can't be
decoded in the browser preview environment, fall back to the chroma-style approximation and
note it — export remains exact.

### A.5 Background options after removal (reuse existing primitives)

Once the subject is matted, the "background" is simply **the track/asset beneath the subject
clip** — Cadence already composites bottom-to-top. The background picker writes existing
primitives onto the base track (or `meta.background`); no new render code:

| Option | How it's built (existing primitive) |
|---|---|
| **Transparent** | No base clip beneath the subject on that track → composites over `meta.background` (or exports with alpha once WebM/ProRes-alpha lands, see Feature #8). |
| **Solid color** | A `SolidClip` under the subject (already exists) or set `meta.background`. |
| **Blur the original (defocus)** | Duplicate the source clip onto the base track with a `regionFx`-style full-frame blur (reuse the blur primitive) — the subject sits sharp over its own blurred plate. Faithful (same footage, defocused). **Popular, and free.** |
| **Image background** | An `ImageClip` on the base track (user's own upload). |
| **Video background** | A `VideoClip` on the base track (user's own footage / b-roll). |

All are the **user's own** content or a defocus of the original — never generated scenery,
keeping the faithfulness rule intact.

### A.6 Director / prompt parity

Add one tool in `packages/director/src/tools.ts` + an edit in `edits.ts`, mirroring
`chromaKey`:

- `remove_background` — runs the matting provider (or returns the honest gated message),
  registers the matte asset, sets `clip.matte`. Params: `clipId?` (default the composite
  target, via the existing `compositeTargets` logic), `background?` (`transparent | solid:#hex
  | blur | asset:<id>`).
- `set_background` — swaps the base-track background primitive (solid/blur/image/video) without
  re-matting.
- `clear_background_removal` — deletes `clip.matte` (undoable), mirroring `clearChroma`.

So the capability is reachable by prompt AND by hand, per Cadence's rule.

### A.7 UX — one-tap, honest, effortless

In the **Design room → Advanced** section (next to the existing "Green screen" chroma pill),
add a **"Remove background"** control that is the front door for *both* paths:

- **One tap "Remove background":**
  - If the footage looks like green screen OR the user picks "green screen", use the **free
    chroma path** instantly (no server round-trip) — this is the default suggestion when a
    dominant edge color is detected.
  - Otherwise it triggers the **AI matte** production. If a provider is configured → progress
    chip → matte appears in preview. If **not configured** → an inline, non-dead-end card:
    *"AI background removal isn't set up. ✅ Free option: shoot on green screen (use Chroma
    Key). To remove the background from any video, connect a provider — [Learn how]."* (the
    exact `MATTING_UNAVAILABLE_MESSAGE`, rendered as UI, never a raw error).
- **Background picker** (appears the moment removal is on): a compact row — **Transparent ·
  Solid (swatch) · Blur original · Image… · Video…** — reusing `BackgroundsGallery` swatches
  and the media picker. Live preview updates on every choice (instant commit path).
- **Green-screen free path surfaced clearly:** the chroma control keeps its "Green screen"
  label and gets a one-line "Free — no AI needed" tag, so users learn the zero-cost route.
- **Progressive disclosure:** one button by default; the color/similarity/spill (chroma) and
  feather/mode (matte) sliders stay tucked under an "Adjust edges" disclosure.

**Preview↔export parity summary:** free chroma = approximate preview / exact export (today's
behavior, documented); AI matte = **exact** preview once produced (same matte pixels), with a
documented fallback only when a video matte can't decode in-browser.

---

## B. Other "best" features (curated ~8, ranked by impact × ease)

Cross-checked against the code and `docs/COMPETITIVE-FEATURES.md` so nothing already shipped is
re-proposed (speed ramps, LUTs, adjustment layers, 55 transitions, keyframes, scopes, chroma,
mask, blend, region blur, loudnorm, auto-reframe-centered, filler/silence removal, TTS, faithful
upscale are **already in code**). Tags: **Free** = no provider/cost, faithful ffmpeg or pure UI;
**Gated** = behind a pluggable provider. **Engine** = `packages/**`; **UI** = `apps/web/**`.

| # | Feature | Impact×Ease | Faithful? | Free/Gated | Engine/UI |
|---|---|---|---|---|---|
| 1 | **Video stabilization (`vidstab`)** | ★★★★★ | Faithful | **Free** | Engine + UI |
| 2 | **One-tap Auto-Enhance** | ★★★★★ | Faithful | **Free** | Engine + UI |
| 3 | **Clean Audio (denoise/voice)** | ★★★★★ | Faithful | **Free** (afftdn) + Gated (arnndn) | Engine + UI |
| 4 | **PiP / split-screen layout presets** | ★★★★★ | Faithful | **Free** | Engine-light + UI |
| 5 | **Auto color / white-balance** | ★★★★☆ | Faithful | **Free** | Engine + UI |
| 6 | **Motion / subject tracking** | ★★★★☆ | Faithful | **Gated** | Engine + UI |
| 7 | **Track-and-blur a face/object** | ★★★★☆ | Faithful | **Gated** (tracking) | Engine + UI |
| 8 | **Transparent/alpha + GIF export** | ★★★★☆ | Faithful | **Free** | Engine + UI |

### 1. Video stabilization — `vidstab` (Free win)
- **Why:** every desktop NLE has it; Cadence has none. Handheld footage is common and a
  "Stabilize" button is a headline quality-per-click.
- **Easiest UX:** an "Stabilize" toggle + strength slider in the Edit room; one click.
- **Faithful/Free:** ffmpeg two-pass `vidstabdetect` → `vidstabtransform`. No model, no cost.
  Faithful (warps/crops existing frames, invents nothing).
- **Engine/UI:** Engine (schema flag `stabilize` on `VideoClip` + a detect/transform pass in
  `plan.ts`; note: two-pass needs a per-clip analysis file — cache it as a produced sidecar
  like the matte). UI (button + slider). *Note the two-pass wrinkle in the plan; it's the
  one non-trivial part.*

### 2. One-tap Auto-Enhance (Free win)
- **Why:** the single most reassuring beginner button — "make it look better" without touching
  sliders. Cadence already has all the primitives (grade, unsharp, `hqdn3d`, loudnorm).
- **Easiest UX:** one "Auto-enhance" button that composes a safe grade (mild contrast/
  saturation), light sharpen, light denoise, and loudnorm — all existing faithful primitives.
- **Faithful/Free:** just presets over shipped filters. No provider.
- **Engine/UI:** Engine-light (a pure `autoEnhance(doc)` helper + Director tool for parity);
  UI (button in Design/Edit). Distinct from the gated AI super-res (`aiUpscale`) already in
  `Quality`.

### 3. Clean Audio — denoise / voice isolation
- **Why:** biggest audio quality-per-click win; Cadence has zero audio denoise today
  (confirmed gap in COMPETITIVE-FEATURES §4).
- **Easiest UX:** one "Clean audio" button + strength in the Audio room.
- **Faithful:** yes — attenuates noise, never synthesizes speech.
- **Free + Gated:** **Free** default = ffmpeg `afftdn` (FFT denoise, dependency-free);
  **Gated** stronger = `arnndn` (RNNoise model file) behind a provider-style flag (an audio
  model path env), off by default. Honest gating: the button works free; "Studio strength"
  needs the model.
- **Engine/UI:** Engine (schema flag on audio/video clip + `enhance_audio` tool + `afftdn`
  in the audio chain); UI (button + strength).

### 4. PiP / split-screen layout presets (Free win)
- **Why:** reaction videos, side-by-side, grids — huge for social. Cadence can build them by
  hand (transform + tracks) but has **no preset** (COMPETITIVE §1).
- **Easiest UX:** a "Layouts" picker (2-up, 3-up, PiP-corner, top/bottom) that positions the
  selected clips onto tracks with the right `transform`.
- **Faithful/Free:** pure preset generator over existing transform/track ops — no render
  change (the multi-track overlay path already composites PiP).
- **Engine/UI:** Engine-light (`applyLayout(doc, preset)` pure helper + `add_layout` tool);
  UI (picker in Edit/Design).

### 5. Auto color / white-balance (Free win)
- **Why:** "fix my colors" one-tap; rivals ship it; Cadence has manual grade + curves but no
  auto (COMPETITIVE §5).
- **Easiest UX:** an "Auto color" button that fills the existing `ColorGrade`.
- **Faithful/Free:** ffmpeg-side neutral-balance / auto-levels feeding the existing grade
  primitive; a color remap only.
- **Engine/UI:** Engine (analysis → grade values, or the ffmpeg `colorbalance`/`normalize`
  path); UI (button in Design). Reuses the whole existing grade export.

### 6. Motion / subject tracking (Gated — the enabler)
- **Why:** unlocks auto-reframe-*with-tracking* (today's auto-reframe is centered only), plus
  #7. High impact but genuinely compute-heavy → gated is correct.
- **Easiest UX:** "Track subject" on a clip → produces a keyframe path; auto-reframe and
  track-and-blur consume it.
- **Faithful:** yes — produces a motion path (data), never alters pixels.
- **Gated:** a `TrackingProvider` seam (same pattern: `none|cli|api`, default `none` with an
  honest message). A produced **track path** is stored as clip keyframes / a sidecar, so once
  produced, consumption is free + deterministic (mirrors the matte approach).
- **Engine/UI:** Engine (provider + schema for the path); UI (button + progress/gated card).

### 7. Track-and-blur a face/object (Gated on tracking, faithful)
- **Why:** privacy blur that *follows* a moving face/plate — Cadence's `regionFx` blur is a
  static rectangle only. Very common ask (privacy, brand removal).
- **Easiest UX:** draw a box → "Blur & follow" → the box rides the track path from #6.
- **Faithful/Gated:** obscures a region (faithful, like existing `regionFx`); gated only
  because it needs the tracker. Falls back to keyframing the box by hand (free) when no
  tracker is configured — never a dead end.
- **Engine/UI:** Engine (`regionFx` gains an optional keyframed rect driven by the track);
  UI (draw + "follow" toggle).

### 8. Transparent/alpha + GIF export (Free win, delivery)
- **Why:** the natural payoff of background removal — export the matted subject with real alpha
  (overlays, stingers), plus GIF for social. Both missing (COMPETITIVE §8).
- **Easiest UX:** Deliver room adds "Transparent (WebM/ProRes-alpha)" and "GIF" formats.
- **Faithful/Free:** ffmpeg `libvpx-vp9`/`prores_ks` (alpha) and `gif` palette pass. No model.
- **Engine/UI:** Engine (export format branches in `plan.ts`/`export.ts`); UI (Deliver
  options). Sequenced *after* background removal so alpha export has a subject to carry.

**Deliberately excluded (off-brand):** generative b-roll / video / background *replacement* /
generative-extend, AI eye-contact — all invent content. Background *removal* (matte) is the
line we do not cross past.

---

## C. UX principles (keep the whole thing "amazing")

1. **One-tap defaults, pro depth underneath.** Every feature is a single button with a sensible
   default (Remove background, Stabilize, Clean audio, Auto-enhance, Auto color, a Layout).
   Sliders live under an "Adjust" disclosure. Beginners never see them; pros are one click away.
2. **Honest gating that never dead-ends.** A gated feature with no provider shows an actionable
   card, not an error: it names the **free alternative** (green screen for removal, `afftdn` for
   audio, manual keyframes for track-and-blur) *and* how to connect a provider — the
   `*_UNAVAILABLE_MESSAGE` strings, rendered as UI. No silent no-ops, no fake outputs.
3. **Live preview, everywhere.** Every commit runs through the undoable pure edit-op path so the
   canvas/Stage updates instantly. Where preview can only approximate (free chroma, an
   undecodable video matte), say so inline; export stays exact.
4. **Progressive disclosure + smart suggestion.** Detect the likely intent (dominant edge color
   → suggest free chroma; handheld shake → suggest stabilize) and offer the cheapest faithful
   path first. Reveal complexity only on demand.
5. **Faithful by construction, and it says so.** Removal/cleanup/retime/regrade only; the UI
   labels free vs AI and never implies invented content.
6. **Prompt = hand parity.** Every new capability ships a Director tool alongside the button.

---

## D. Sequenced roadmap (WAVES on disjoint files)

Matches the repo convention: each wave = **Engine** (`packages/**` + `scripts/verify.ts`) and
**Web** (`apps/web/**`) on disjoint trees, integrated → gated → committed between waves. Each
wave is independently shippable + verifiable (a `renderAndAssert` check per engine feature).

### Wave BG-1 — Background removal, the FREE-first foundation
- **Engine (`packages/**`):**
  - New `packages/matting/**`: `provider.ts`, `registry.ts`, `providers/{none,cli,api}.ts`,
    `index.ts` — mirroring `@cadence/enhance` + `tts.ts` (Node imports lazy; reuse
    `assertLocalMediaPath`). Default `NoneMattingProvider` (honest gated throw).
  - `@cadence/core`: add optional `matte` to `VideoClip`/`ImageClip` (schema only, defaulted).
  - `render-ffmpeg/plan.ts`: extend the existing alpha overlay path (`isAlpha` also true for
    `clip.matte`) with the `alphamerge` (mode "matte") / `format=rgba` (mode "rgba") + feather
    line. `render-node/canvas-engine.ts`: matte-aware preview (destination-in / RGBA draw,
    chroma-style fallback).
  - `@cadence/director`: `remove_background`, `set_background`, `clear_background_removal`.
  - `scripts/verify.ts`: `checkBackgroundMatte` (a synthetic matte over a base → non-blank
    composited frame) + `checkMattingGated` (None provider throws the honest message).
  - `.env.example`: the `MATTING_*` block.
- **Web (`apps/web/**`):**
  - `lib/fx.ts`: `removeBackground`/`clearBackgroundRemoval`/`currentMatte` edit-ops mirroring
    `chromaKey`/`clearChroma`; an API route to invoke the provider (returns matte asset or the
    gated message).
  - `RoomPanel.tsx` Advanced: "Remove background" one-tap + background picker (Transparent /
    Solid / Blur original / Image / Video), the "Free — green screen" tag on chroma, and the
    non-dead-end gated card.
- **Disjoint:** Engine adds the package/schema/render/tools; Web adds edit-ops/route/UI. Ships
  the whole background-removal story (free chroma prominent; AI matte behind an honest gate).

### Wave FX-1 — Free quality wins (stabilize, auto-enhance, auto color)
- **Engine:** `vidstab` two-pass stabilization (schema flag + sidecar analysis in `plan.ts`);
  pure `autoEnhance(doc)` + `autoColor(doc)` helpers + Director tools; verify checks.
- **Web:** Edit-room "Stabilize" + strength; Design-room "Auto-enhance" and "Auto color"
  buttons. **Disjoint.**

### Wave FX-2 — PiP/layouts + delivery (alpha/GIF)
- **Engine:** `applyLayout(doc, preset)` + `add_layout` tool (over existing transform/tracks);
  transparent (WebM/ProRes-alpha) + GIF export branches in `export.ts`/`plan.ts`; verify
  checks (incl. an alpha-export smoke test carrying a matted subject from Wave BG-1).
- **Web:** Edit/Design "Layouts" picker; Deliver-room alpha + GIF format options. **Disjoint.**

### Wave AUD-1 — Clean audio
- **Engine:** `afftdn` faithful denoise (free default) + gated `arnndn` (model path), schema
  flag + `enhance_audio` tool; verify check.
- **Web:** Audio-room "Clean audio" button + strength + honest "Studio strength needs a model"
  gate. **Disjoint.**

### Wave TRK-1 — Tracking + track-and-blur (gated enabler, do after the free wins)
- **Engine:** new `packages/tracking/**` provider seam (`none|cli|api`, default `none`, honest
  message, `assertLocalMediaPath`); a produced track path stored as clip keyframes / sidecar;
  `regionFx` gains an optional keyframed rect; auto-reframe consumes the path; verify checks
  (path-driven blur composites; None provider throws honest message).
- **Web:** "Track subject" + "Blur & follow" controls with progress/gated card and the free
  manual-keyframe fallback. **Disjoint.**

**Quality bars (every wave):** one shared pure helper for preview↔export parity; every new
capability reachable by **prompt AND by hand**; faithful (removal/cleanup/retime/regrade only,
never invented content); honest gating with a named free alternative; a `renderAndAssert` (or
gated-message) verify check per feature.

---

## Summary — top recommendations

- **Background removal is a two-lane design, free-first.** Lane 1 (**free, shipping today**):
  chroma key = real background removal for green-screen footage — just make it obvious. Lane 2
  (**gated, new**): a `@cadence/matting` provider seam (`MATTING_PROVIDER=none|cli|api`, default
  `none` with an honest `MATTING_UNAVAILABLE_MESSAGE`) that produces an **alpha matte** for
  ordinary footage — mirroring `@cadence/enhance`/`tts.ts` exactly, reusing `assertLocalMediaPath`.
- **The matte plugs into the compositor that already exists.** One optional `matte` field on the
  clip + one `alphamerge` line on the alpha overlay path in `plan.ts`; the canvas preview reaches
  **exact parity** once the matte is produced (destination-in / RGBA draw). No new compositor,
  no new z-order logic.
- **Backgrounds after removal reuse existing primitives** (SolidClip / blur-of-original /
  user image / user video / transparent) — never generated scenery, so the faithfulness rule
  holds.
- **The two biggest FREE wins to pair with it:** `vidstab` **stabilization** and `afftdn`
  **Clean audio** — headline quality-per-click, no provider, no cost. Then PiP/layout presets,
  auto-enhance, auto color (all free), and the gated tracking → track-and-blur / true
  auto-reframe as the enabler tier. Alpha/GIF export is the natural delivery payoff of removal.
- **UX throughout:** one-tap defaults, honest never-dead-end gating that always names the free
  path, live preview, progressive disclosure, prompt↔hand parity.

**Doc path:** `/Users/codewithowais/Downloads/video-editing-tool/docs/BACKGROUND-REMOVAL-AND-MORE.md`
