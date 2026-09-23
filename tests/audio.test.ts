/**
 * "Sound made easy" — pure audio ops: procedural music (arrangement / length
 * fitting / listen-proxy health), SFX placement, auto-SFX planning, duck
 * keyframes, beat sync, the voice-enhance filter chain, and Director routing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEditDoc, valueAt, type EditDoc } from "@cadence/core";
import {
  addSfx,
  analyzePcm,
  arrangeMusic,
  arrangementBeats,
  autoDuck,
  autoSfx,
  beatSync,
  buildTextVideo,
  DIRECTOR_TOOLS,
  duckKeyframes,
  emptyDoc,
  encodeWav,
  generatedMusicOf,
  generateMusic,
  mergeIntervals,
  MOOD_DEFS,
  musicBeatTimes,
  musicSrc,
  MUSIC_MOODS,
  parseSynthSrc,
  planAutoSfx,
  ProjectState,
  renderMusic,
  renderSfx,
  setVoiceEnhance,
  SFX_DEFS,
  SFX_KINDS,
  snapBoundaries,
  speechRegions,
  StubDirector,
  textVideoScenes,
} from "@cadence/director";
import { buildExportPlan, voiceEnhanceFilters } from "@cadence/render-ffmpeg";

const SR = 22050; // listen-proxy renders at a lower rate to keep the suite fast

function footageDoc(extra: unknown[] = []): EditDoc {
  return parseEditDoc({
    version: 1,
    meta: { width: 1280, height: 720 },
    media: [{ id: "v", kind: "video", src: "a.mp4", durationSec: 12 }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 12, mediaId: "v" }] }, ...extra],
  });
}

function slideshowDoc(): EditDoc {
  const clips = [0, 1, 2, 3].map((i) => ({
    id: `img${i}`,
    kind: "image",
    start: i * 2.6,
    duration: 3.2,
    mediaId: `p${i}`,
    transitionInSec: i === 0 ? 0 : 0.6,
  }));
  return parseEditDoc({
    version: 1,
    media: [0, 1, 2, 3].map((i) => ({ id: `p${i}`, kind: "image", src: `p${i}.png` })),
    tracks: [
      { id: "photos", kind: "visual", clips },
      { id: "titles", kind: "visual", clips: [{ id: "t", kind: "text", start: 0, duration: 2.4, text: "Trip" }] },
      { id: "captions", kind: "visual", clips: [{ id: "cap", kind: "text", start: 4, duration: 1, text: "no pop" }] },
    ],
  });
}

// ---- arrangement ---------------------------------------------------------------

test("arrangeMusic fits whole bars to the video length within ±8% of the tempo", () => {
  for (const mood of MUSIC_MOODS) {
    for (const dur of [7.3, 15, 30, 61.7]) {
      const a = arrangeMusic({ mood, durationSec: dur });
      const barsSpan = a.bars * 4 * a.beatSec;
      if (a.fitted) {
        assert.ok(Math.abs(barsSpan - dur) < 1e-6, `${mood} ${dur}s: ${a.bars} bars span ${barsSpan}`);
        assert.ok(Math.abs(a.bpm / MOOD_DEFS[mood].bpm - 1) <= 0.0801, `${mood} tempo nudged ≤8% (${a.bpm})`);
      }
      assert.equal(a.sections[a.sections.length - 1]!.name, "end", "always ends on an ending bar");
      assert.equal(a.chords.length, a.bars);
    }
  }
  // Long beds get intro + A + break + B + end.
  const long = arrangeMusic({ mood: "upbeat", durationSec: 60 });
  assert.deepEqual(long.sections.map((s) => s.name), ["intro", "a", "break", "b", "end"]);
  // The last chord is the tonic (a real resolution).
  assert.deepEqual(long.chords[long.chords.length - 1]!.notes, arrangeMusic({ mood: "upbeat", durationSec: 60, seed: 2 }).chords.at(-1)!.notes);
});

test("arrangementBeats is the exact tempo grid (beats and bars)", () => {
  const a = arrangeMusic({ mood: "corporate", durationSec: 20 });
  const beats = arrangementBeats(a);
  const bars = arrangementBeats(a, "bar");
  assert.equal(beats.length, a.bars * 4);
  assert.equal(bars.length, a.bars);
  assert.ok(Math.abs(beats[4]! - bars[1]!) < 1e-3);
});

// ---- listen-proxy (can't hear it, so measure it) --------------------------------

test("every mood renders healthy audio: no clipping, no DC, real level, silent tail, deterministic", () => {
  for (const mood of MUSIC_MOODS) {
    const a = renderMusic({ mood, durationSec: 6, seed: 5 }, SR);
    const s = analyzePcm(a);
    assert.ok(s.peakDb <= -1 && s.peakDb > -4, `${mood} peak ${s.peakDb.toFixed(2)} dBFS`);
    assert.equal(s.clipped, 0, `${mood} has no clipped samples`);
    assert.ok(s.dc < 2e-3, `${mood} DC ${s.dc}`);
    assert.ok(s.rmsDb > -32 && s.rmsDb < -8, `${mood} RMS ${s.rmsDb.toFixed(1)} dBFS`);
    assert.ok(s.tailPeakDb < -60, `${mood} ends in silence (tail ${s.tailPeakDb.toFixed(0)} dBFS)`);
    assert.equal(a.channels[0].length, Math.ceil(6 * SR));
    const b = renderMusic({ mood, durationSec: 6, seed: 5 }, SR);
    assert.deepEqual(Array.from(b.channels[0].subarray(1000, 1400)), Array.from(a.channels[0].subarray(1000, 1400)), `${mood} deterministic`);
  }
  // Different seeds → different takes.
  const x = renderMusic({ mood: "lofi", durationSec: 4, seed: 1 }, SR).channels[0];
  const y = renderMusic({ mood: "lofi", durationSec: 4, seed: 2 }, SR).channels[0];
  assert.notDeepEqual(Array.from(x.subarray(20000, 20100)), Array.from(y.subarray(20000, 20100)));
});

test("every SFX renders healthy audio with its hit inside the sound", () => {
  for (const kind of SFX_KINDS) {
    const a = renderSfx(kind, SR);
    const s = analyzePcm(a);
    const def = SFX_DEFS[kind];
    assert.ok(def.hitSec < def.durationSec);
    assert.ok(s.peakDb <= -1 && s.peakDb > -8, `${kind} peak ${s.peakDb.toFixed(2)}`);
    assert.equal(s.clipped, 0);
    assert.ok(s.dc < 2e-3, `${kind} DC ${s.dc}`);
    assert.ok(s.tailPeakDb < -40, `${kind} tail ${s.tailPeakDb.toFixed(0)}`);
  }
});

test("encodeWav writes a valid 16-bit stereo PCM header", () => {
  const a = renderSfx("pop", SR);
  const wav = encodeWav(a);
  const dv = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), "WAVE");
  assert.equal(dv.getUint16(22, true), 2);
  assert.equal(dv.getUint32(24, true), SR);
  assert.equal(dv.getUint16(34, true), 16);
  assert.equal(dv.getUint32(40, true), a.channels[0].length * 4);
  assert.equal(wav.length, 44 + a.channels[0].length * 4);
});

test("the recipe codec round-trips (the doc stores only the recipe)", () => {
  const r = { mood: "cinematic" as const, durationSec: 12.5, bpm: 70, seed: 9 };
  const back = parseSynthSrc(musicSrc(r));
  assert.deepEqual(back, { type: "music", recipe: r });
  assert.deepEqual(parseSynthSrc("synth:sfx?kind=whoosh&seed=1"), { type: "sfx", kind: "whoosh", seed: 1 });
  assert.equal(parseSynthSrc("song.mp3"), null);
  assert.equal(parseSynthSrc("synth:music?mood=polka&dur=3"), null);
});

// ---- generate music ------------------------------------------------------------

test("generateMusic lays a fitted bed: under speech it sits low, on text it's up front", () => {
  const doc = generateMusic(footageDoc(), { mood: "lofi" });
  const clip = doc.tracks.find((t) => t.id === "music")!.clips[0]!;
  assert.equal(clip.kind, "audio");
  assert.equal(clip.duration, 12);
  assert.equal(clip.kind === "audio" && clip.volume, 0.28);
  const asset = doc.media.find((m) => m.id === (clip.kind === "audio" ? clip.mediaId : ""))!;
  assert.match(asset.src, /^synth:music\?mood=lofi/);
  assert.equal(asset.durationSec, 12);
  // A new take replaces the old one and prunes the unused generated asset.
  const again = generateMusic(doc, { mood: "upbeat" });
  assert.equal(again.media.filter((m) => m.src.startsWith("synth:music")).length, 1);
  // Text video (no speech) → music up front, mood from the theme.
  const tv = buildTextVideo(emptyDoc(), { script: "Big news.\nWe launched today.\nTry it free.", theme: "neon" });
  const tvm = generateMusic(tv);
  const g = generatedMusicOf(tvm)!;
  assert.equal(g.recipe.mood, "upbeat");
  const tclip = tvm.tracks.find((t) => t.id === "music")!.clips[0]!;
  assert.equal(tclip.kind === "audio" && tclip.volume, 0.7);
  // Beat grid is on the timeline.
  const beats = musicBeatTimes(tvm);
  assert.ok(beats.length > 4 && beats[0] === 0);
});

// ---- SFX --------------------------------------------------------------------------

test("addSfx puts the HIT on the moment (and trims to the program end)", () => {
  const w = addSfx(footageDoc(), { kind: "whoosh", atSec: 3 });
  const c = w.tracks.find((t) => t.id === "sfx")!.clips[0]!;
  assert.equal(c.start, 3 - SFX_DEFS.whoosh.hitSec);
  assert.ok(w.media.some((m) => m.id === "synth-sfx-whoosh"));
  // A riser near the start skips its early build via sourceIn.
  const r = addSfx(footageDoc(), { kind: "riser", atSec: 1 });
  const rc = r.tracks.find((t) => t.id === "sfx")!.clips[0]!;
  assert.equal(rc.start, 0);
  assert.equal(rc.kind === "audio" && rc.sourceIn, SFX_DEFS.riser.hitSec - 1);
  // A boom right at the end never extends the video.
  const b = addSfx(footageDoc(), { kind: "boom", atSec: 11.5 });
  const bc = b.tracks.find((t) => t.id === "sfx")!.clips[0]!;
  assert.ok(bc.start + bc.duration <= 12 + 1e-9);
  assert.throws(() => addSfx(footageDoc(), { kind: "pop", atSec: 20 }));
});

test("planAutoSfx: whoosh on crossfades, pop on titles (never captions), punchy adds boom/riser", () => {
  const doc = slideshowDoc();
  const subtle = planAutoSfx(doc);
  const whooshes = subtle.filter((e) => e.kind === "whoosh").map((e) => e.t);
  assert.deepEqual(whooshes, [2.9, 5.5, 8.1]);
  assert.ok(subtle.some((e) => e.kind === "pop" && e.t === 0));
  assert.ok(!subtle.some((e) => Math.abs(e.t - 4) < 1e-6), "captions never pop");
  const punchy = planAutoSfx(doc, { style: "punchy" });
  assert.equal(punchy[0]!.kind, "boom");
  assert.ok(punchy.some((e) => e.kind === "riser"));
  // Near-duplicates collapse (the riser and the last whoosh share a moment).
  for (let i = 1; i < punchy.length; i++) assert.ok(punchy[i]!.t - punchy[i - 1]!.t >= 0.3);
  const applied = autoSfx(doc, { style: "punchy" });
  assert.equal(applied.doc.tracks.find((t) => t.id === "sfx")!.clips.length, applied.events.length);
  // Re-running replaces (no pile-up).
  assert.equal(autoSfx(applied.doc).doc.tracks.find((t) => t.id === "sfx")!.clips.length, subtle.length);
});

// ---- ducking --------------------------------------------------------------------------

test("duckKeyframes rides the bed down only while someone talks", () => {
  const kfs = duckKeyframes({ start: 0, duration: 10 }, [{ start: 2, end: 4 }], 0.6, 0.15, 0.25, 0.5);
  const at = (sec: number): number => valueAt(kfs, "volume", sec / 10, 0.6);
  assert.equal(at(0.5), 0.6);
  assert.ok(Math.abs(at(3) - 0.15) < 1e-9, `ducked mid-speech (${at(3)})`);
  assert.ok(at(1.9) < 0.6 && at(1.9) > 0.15, "ramping down just before speech");
  assert.equal(at(8), 0.6);
  assert.ok(kfs.every((k) => k.easing === "linear"), "linear = the export's piecewise-linear expression");
  for (let i = 1; i < kfs.length; i++) assert.ok(kfs[i]!.t > kfs[i - 1]!.t);
  assert.deepEqual(mergeIntervals([{ start: 0, end: 1 }, { start: 1.2, end: 2 }], 0.3), [{ start: 0, end: 2 }]);
});

test("autoDuck keyframes the music under voice-over + captions; flat when only a video talks", () => {
  const withVo = parseEditDoc({
    ...generateMusic(footageDoc([
      { id: "captions", kind: "visual", clips: [{ id: "k", kind: "text", start: 6, duration: 2, text: "hi" }] },
    ])),
  });
  const vo = parseEditDoc({
    ...withVo,
    media: [...withVo.media, { id: "vo", kind: "audio", src: "vo.webm", durationSec: 2 }],
    tracks: [...withVo.tracks, { id: "voiceover", kind: "audio", clips: [{ id: "v1", kind: "audio", start: 1, duration: 2, mediaId: "vo" }] }],
  });
  assert.deepEqual(speechRegions(vo), [{ start: 1, end: 3 }, { start: 6, end: 8 }]);
  const { doc, mode } = autoDuck(vo, { depthDb: -12 });
  assert.equal(mode, "keyframes");
  const m = doc.tracks.find((t) => t.id === "music")!.clips[0]!;
  assert.ok(m.kind === "audio" && m.keyframes && m.keyframes.length >= 6);
  const lvl = (sec: number): number => valueAt(m.kind === "audio" ? m.keyframes : [], "volume", sec / 12, 0);
  assert.ok(Math.abs(lvl(2) - 0.6 * Math.pow(10, -12 / 20)) < 1e-3);
  assert.equal(lvl(5), 0.6);
  // A talking video with no timing → a flat duck.
  const flat = autoDuck(generateMusic(footageDoc()));
  assert.equal(flat.mode, "flat");
  // Nobody speaks → a clear error.
  const tv = generateMusic(buildTextVideo(emptyDoc(), { script: "One.\nTwo.\nThree." }));
  assert.throws(() => autoDuck(tv), /Nobody speaks/);
});

// ---- beat sync --------------------------------------------------------------------------

test("snapBoundaries keeps order and a minimum scene length", () => {
  const out = snapBoundaries([1.1, 1.3, 3.9], [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], 0.5);
  assert.deepEqual(out, [1, 1.5, 4]);
});

test("beatSync lands every slideshow cut on the generated music's beat grid", () => {
  const doc = generateMusic(slideshowDoc(), { mood: "corporate" });
  const { doc: synced, cuts } = beatSync(doc);
  assert.equal(cuts, 3);
  const grid = musicBeatTimes(synced);
  const photos = synced.tracks.find((t) => t.id === "photos")!.clips.slice().sort((a, b) => a.start - b.start);
  for (const c of photos.slice(1)) {
    const tin = c.kind === "image" ? c.transitionInSec : 0;
    const cut = c.start + tin / 2;
    assert.ok(grid.some((b) => Math.abs(b - cut) < 2e-3), `cut ${cut} on a beat`);
  }
  // The music was re-composed to end with the video, on a bar line (same tempo).
  const g = generatedMusicOf(synced)!;
  const end = photos.at(-1)!.start + photos.at(-1)!.duration;
  assert.ok(Math.abs(g.recipe.durationSec - end) < 2e-3);
  assert.ok(Math.abs(g.arrangement.bpm - generatedMusicOf(doc)!.arrangement.bpm) < 0.05);
  // Footage is refused with a pointer to Split at beats.
  assert.throws(() => beatSync(generateMusic(footageDoc())), /Split at beats/);
});

test("beatSync re-times text-video scenes to bars", () => {
  const tv = generateMusic(buildTextVideo(emptyDoc(), { script: "Big news.\nWe launched a new app today.\nIt edits video for you.\nTry it free." }), { mood: "upbeat" });
  const { doc } = beatSync(tv, { every: "bar" });
  const bars = musicBeatTimes(doc, "bar");
  let acc = 0;
  for (const s of textVideoScenes(doc)) {
    acc += s.durationSec ?? 0;
    assert.ok(bars.some((b) => Math.abs(b - acc) < 2e-3) || Math.abs(acc - generatedMusicOf(doc)!.recipe.durationSec) < 2e-3, `scene boundary ${acc} on a bar`);
  }
});

// ---- voice enhance --------------------------------------------------------------------------

test("voice enhance: chain on the voice only; off is byte-identical", () => {
  const chain = voiceEnhanceFilters();
  assert.deepEqual(chain.map((f) => f.split("=")[0]), ["highpass", "acompressor", "equalizer", "equalizer", "deesser", "alimiter"]);
  const base = generateMusic(footageDoc(), { mood: "lofi" });
  const withVo = parseEditDoc({
    ...base,
    media: [...base.media, { id: "vo", kind: "audio", src: "vo.webm", durationSec: 2 }],
    tracks: [...base.tracks, { id: "voiceover", kind: "audio", clips: [{ id: "v1", kind: "audio", start: 1, duration: 2, mediaId: "vo" }] }],
  });
  const resolve = (id: string): string => `/m/${id}`;
  const off = buildExportPlan(withVo, resolve, "/o.mp4").filterComplex;
  const onDoc = setVoiceEnhance(withVo, true);
  const on = buildExportPlan(onDoc, resolve, "/o.mp4").filterComplex;
  assert.ok(!off.includes("acompressor"));
  assert.equal((on.match(/acompressor/g) ?? []).length, 2, "base speech + voice-over, not the music");
  assert.ok(on.includes("[avox]"));
  // Toggling off restores the exact original doc + graph.
  const back = setVoiceEnhance(onDoc, false);
  assert.equal(JSON.stringify(back), JSON.stringify(withVo));
  assert.equal(buildExportPlan(back, resolve, "/o.mp4").filterComplex, off);
  assert.ok(!("voiceEnhance" in parseEditDoc({ version: 1 })), "old docs gain no field");
});

// ---- Director ---------------------------------------------------------------------------------

test("the audio tools are registered in DIRECTOR_TOOLS", () => {
  const keys = Object.keys(DIRECTOR_TOOLS);
  for (const k of ["generate_music", "add_sfx", "auto_sfx", "auto_duck", "enhance_voice", "beat_sync"]) {
    assert.ok(keys.includes(k), `${k} is registered`);
  }
});

test("StubDirector routes plain-language sound requests", async () => {
  const names = async (req: string, doc: EditDoc, media = doc.media): Promise<string[]> => {
    const p = new ProjectState({ doc, media });
    return (await new StubDirector().interpret(req, p)).toolCalls.map((c) => c.name);
  };
  const vid = footageDoc();
  assert.deepEqual(await names("add some chill lo-fi music", vid), ["generate_music"]);
  assert.deepEqual(await names("add background music", vid), ["generate_music"], "no upload → generate");
  const withSong = parseEditDoc({ ...vid, media: [...vid.media, { id: "song", kind: "audio", src: "song.mp3", durationSec: 30 }] });
  assert.deepEqual(await names("add background music", withSong), ["add_music"], "an uploaded song is still used");
  assert.ok((await names("add sound effects", slideshowDoc())).includes("auto_sfx"));
  assert.ok(!(await names("add sound effects", slideshowDoc())).includes("auto_mix"));
  assert.ok((await names("enhance my voice", vid)).includes("enhance_voice"));
  const ss = generateMusic(slideshowDoc(), { mood: "upbeat" });
  assert.ok((await names("cut the photos to the beat", ss)).includes("beat_sync"));
  assert.ok((await names("duck the music under my voice", generateMusic(vid))).includes("auto_duck"));
  assert.ok((await names("add a whoosh at 3s", vid)).includes("add_sfx"));
  assert.ok(!(await names("letters pop in one by one", vid)).includes("add_sfx"));
  assert.ok(!(await names("cinematic look", vid)).includes("generate_music"));
});
