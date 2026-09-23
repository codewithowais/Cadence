# Sound made easy — audio engineer notes

Owner: senior audio engineer / sound designer lane. Goal: great-sounding videos
with one click, no audio skills and no licensing worries. Everything here is
**procedural or filter-based, free and local** (no downloaded sample packs, no
network, no metered APIs — nothing behind the money gate).

## Audit (before)

| Area | State at e036a14 | Gap |
|---|---|---|
| Music | upload-only (`add_music` needs an audio asset) | text videos / slideshows have no easy, licence-free bed |
| SFX | none | no whoosh/pop on transitions, text pop-ins |
| Ducking | `auto_mix` sets a flat 0.28 music volume | music stays low even where nobody speaks; no depth control |
| Voice | `clean_audio` (afftdn) + `loudnorm` | no "make my voice sound good" preset (HPF, compression, presence, de-ess) |
| Beat sync | detect beats (Web Audio estimate) → markers → split | slideshows / text videos can't be *timed* to the beat |
| Metering | none | no way to see levels or clipping |
| Preview | `<audio>` per clip honors `volume` only | keyframed volume, fades and track mute/solo were export-only |

## What ships (6 features)

1. **Royalty-free music generator** — five moods (`lofi`, `upbeat`, `cinematic`,
   `corporate`, `ambient`), procedurally synthesized in pure TypeScript
   (drums, bass, e-piano/pluck/piano/pad/strings, stereo reverb, vinyl crackle).
   The tempo is nudged (±8%) so a whole number of bars fits the video exactly;
   the last bar resolves to the tonic and rings out so it **ends**, never cuts off.
   The recipe (`synth:music?mood=…&bpm=…&dur=…&seed=…`) is stored as the media
   `src` — edits-as-code: the doc stores the recipe, the browser materializes it
   into a WAV `File` (same path as an uploaded file), so preview + export just work
   and a reloaded project re-creates its music with zero storage.
2. **Sound effects** — `whoosh`, `pop`, `click`, `ding`, `riser`, `boom`,
   synthesized the same way (`synth:sfx?kind=…`). Each SFX knows its *hit point*
   so a whoosh peaks exactly on the cut and a riser lands on it. One click "add at
   playhead", or **Auto-SFX** (whoosh on transitions / scene changes, pop on text
   pop-ins; "punchy" adds clicks on hard cuts, a boom on the first title and a
   riser into the last scene) — deduped and throttled.
3. **Voice enhance** — doc flag `voiceEnhance` → export chain on the *voice*
   (base video audio + voice-over track, never the music):
   `highpass=f=80 → acompressor(threshold=0.1, ratio=3, attack=10, release=120,
   makeup=1.8) → equalizer f=3200 (+3 dB presence) → equalizer f=250 (−2 dB mud)
   → deesser → alimiter(level=false)`. Every option name was read from the bundled
   binary (`ffmpeg -h filter=…`, ffmpeg 6.0) and proven in a real encode.
   Export-only (like Clean audio), stated in the UI.
4. **Smart auto-duck** — `auto_duck` rides the music *down only while someone
   talks* (voice-over clips + caption spans + transcript speech), with adjustable
   depth (dB) and ramps, written as ordinary volume keyframes (so it's editable in
   the keyframe UI and exported with the existing `volume=…:eval=frame`). The
   preview now honors keyframed volume, fades, and track mute/solo — heard the same.
5. **Beat sync** — `beat_sync` re-times slideshow photos / text-video scenes so
   every cut lands on a beat (or a bar). Beats come from the generated music's
   exact grid, else the timeline's beat markers.
6. **Level meters** — Audio room shows per-bus (Voice, Music, SFX) and master
   meters at the playhead (RMS + peak dBFS, amber at −6, red over −1 dBFS),
   computed from the decoded sources × the doc's gains.

## Where the code lives

- `packages/director/src/sound-synth.ts` — pure DSP: PRNG, oscillators, drum/
  instrument voices, reverb, arrangement (`arrangeMusic`), `renderMusic`,
  `renderSfx`, `encodeWav`, `analyzePcm` (RMS / peak / DC listen-proxy).
- `packages/director/src/audio.ts` — pure doc ops + recipe codec:
  `generateMusic`, `addSfx`, `autoSfx`, `autoDuck`, `beatSync`,
  `setVoiceEnhance`, `musicBeatTimes`, `synthRecipeFromSrc`.
- `packages/director/src/tools.ts` — tools appended: `generate_music`, `add_sfx`,
  `auto_sfx`, `auto_duck`, `enhance_voice`, `beat_sync`. StubDirector routes them.
- `packages/render-ffmpeg/src/plan.ts` — `voiceEnhanceFilters()` + gated insertion.
- `apps/web/src/lib/synth-audio.ts` — browser materializer (recipe → WAV File, cached).
- `apps/web/src/lib/audio-mix.ts` — preview gain (keyframes/fades/mute/solo) + meters.
- `apps/web/src/components/SoundPanel.tsx` — the UI, mounted in `AudioRoom`.

## Listen-proxy (can't hear, so measure)

`tests/audio.test.ts` and verify check 67 render every mood + every SFX and assert:
peak ≤ −1 dBFS (no clipping), |DC| < 0.002, RMS in a sane band, silent tail at
the very end (seamless end), and that a real ffmpeg encode of generated music +
SFX + voice-enhance + auto-duck produces a non-empty mp4 with an audio stream.

## Known limitations

- Voice enhance is export-only (the browser preview plays the untreated voice).
- Stereo pan still export-only in the preview (needs a Web Audio graph).
- Music is synthesized on the main thread (~0.2–1 s for typical short videos).
- Beat sync only re-times photo/solid scenes (footage is cut with "Split at beats").

## Merge notes for the integrator

- Added `"sfx"` to the overlay track-id sets in `apps/web/src/lib/doc.ts`,
  `apps/web/src/lib/edit-ops.ts` (one token) and `packages/director/src/edits.ts`
  so SFX clips are free-positioned and never rippled back-to-back.
- `EditDoc.voiceEnhance` appended (optional → old docs byte-identical).
