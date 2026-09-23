/**
 * "Sound made easy" — pure edit-doc operations for generated music, sound
 * effects, smart ducking, beat sync and voice enhance. Everything is plain
 * EditDoc data (edits-as-code):
 *
 *  - Generated audio is an ordinary `audio` MediaAsset whose `src` is a RECIPE
 *    (`synth:music?mood=lofi&bpm=82&dur=30&seed=3`, `synth:sfx?kind=whoosh&seed=1`).
 *    The browser materializes the recipe into a WAV File (same path as an upload),
 *    so preview and export treat it exactly like user audio; a reloaded project
 *    re-creates it with zero storage. Deterministic (see sound-synth.ts).
 *  - SFX are audio clips on a dedicated "sfx" track, placed so the sound's HIT
 *    lands on the event (a whoosh peaks on the cut, a riser lands on it).
 *  - Ducking is ordinary `volume` keyframes on the music clip (editable; exported
 *    by the existing `volume=…:eval=frame` path, heard in the preview).
 *  - Voice enhance is the doc flag `voiceEnhance` (export filter chain).
 */
import { parseEditDoc, type Clip, type EditDoc, type Keyframe, type MediaAsset } from "@cadence/core";
import type { Transcript } from "@cadence/understanding";
import {
  arrangeMusic,
  arrangementBeats,
  isSfxKind,
  isSynthSrc,
  musicSrc,
  MOOD_DEFS,
  parseSynthSrc,
  SFX_DEFS,
  sfxSrc,
  type Arrangement,
  type MusicMood,
  type MusicRecipe,
  type SfxKind,
} from "./sound-synth";
import { addMusic, isMainVisualTrack } from "./edits";
import { isTextVideo, setTextVideoScenes, textVideoScenes } from "./textvideo";

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Track that carries sound effects (an overlay/free-positioned audio lane). */
export const SFX_TRACK_ID = "sfx";

/** FNV-1a (32-bit) → 8 hex chars; stable ids for recipes. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The media asset for a generated music bed (id derived from the recipe). */
export function musicAsset(r: MusicRecipe): MediaAsset {
  const src = musicSrc(r);
  const arr = arrangeMusic(r);
  return {
    id: `synth-music-${r.mood}-${hash(src)}`,
    kind: "audio",
    src,
    durationSec: round(r.durationSec),
    label: `${MOOD_DEFS[r.mood].label} · ${Math.round(arr.bpm)} BPM (generated)`,
    hasAudio: true,
  };
}

/** The (shared) media asset for one sound effect kind. */
export function sfxAsset(kind: SfxKind, seed = 1): MediaAsset {
  return {
    id: `synth-sfx-${kind}${seed === 1 ? "" : `-${seed}`}`,
    kind: "audio",
    src: sfxSrc(kind, seed),
    durationSec: SFX_DEFS[kind].durationSec,
    label: `${SFX_DEFS[kind].label} (sound effect)`,
    hasAudio: true,
  };
}

// ---- helpers -----------------------------------------------------------------------

/** Program length: the timeline end ignoring music/SFX beds (they fit TO it). */
export function programDurationSec(doc: EditDoc): number {
  let end = 0;
  for (const t of doc.tracks) {
    if (t.id === "music" || t.id === SFX_TRACK_ID) continue;
    for (const c of t.clips) end = Math.max(end, c.start + c.duration);
  }
  return end;
}

/** Whether someone (probably) talks: a video with audio, or a voice-over. */
function hasSpeechSource(doc: EditDoc): boolean {
  if (doc.tracks.some((t) => t.id === "voiceover" && !t.muted && t.clips.length > 0)) return true;
  for (const t of doc.tracks) {
    if (t.kind !== "visual" || !isMainVisualTrack(t.id) || t.muted) continue;
    for (const c of t.clips) {
      if (c.kind !== "video") continue;
      const m = doc.media.find((x) => x.id === c.mediaId);
      if (m?.hasAudio !== false && c.volume > 0) return true;
    }
  }
  return false;
}

/** Pick a mood that suits the project (text-video theme, or chill under speech). */
export function suggestMood(doc: EditDoc): MusicMood {
  const theme = doc.textVideo?.theme;
  if (theme) {
    const byTheme: Record<string, MusicMood> = {
      bold: "upbeat",
      neon: "upbeat",
      playful: "upbeat",
      retro: "upbeat",
      minimal: "lofi",
      handwritten: "lofi",
      elegant: "ambient",
      aurora: "ambient",
      cinematic: "cinematic",
      corporate: "corporate",
    };
    return byTheme[theme] ?? "upbeat";
  }
  if (hasSpeechSource(doc)) return "lofi";
  if (doc.tracks.some((t) => t.clips.some((c) => c.kind === "image"))) return "corporate";
  return "upbeat";
}

function ensureMedia(doc: EditDoc, asset: MediaAsset): void {
  if (!doc.media.some((m) => m.id === asset.id)) doc.media.push(asset);
}

/** Drop generated assets no clip references any more (they're free to re-create). */
function pruneSynthMedia(doc: EditDoc): void {
  const used = new Set<string>();
  for (const t of doc.tracks) for (const c of t.clips) if ("mediaId" in c && typeof c.mediaId === "string") used.add(c.mediaId);
  doc.media = doc.media.filter((m) => !isSynthSrc(m.src) || used.has(m.id));
}

// ---- 1. generated music ------------------------------------------------------------

export interface GenerateMusicOptions {
  mood?: MusicMood;
  /** Tempo (BPM); nudged ≤ ±8% so the bars end exactly with the video. */
  bpm?: number;
  seed?: number;
  /** Bed length; defaults to the program length (or 30 s with nothing on the timeline). */
  durationSec?: number;
  /** Mix level 0..1; defaults to 0.28 under speech, 0.7 otherwise. */
  volume?: number;
}

/**
 * Compose a royalty-free music bed fitted to the video and lay it on the "music"
 * track (replacing any previous music). Pure: only the recipe is stored.
 */
export function generateMusic(doc: EditDoc, opts: GenerateMusicOptions = {}): EditDoc {
  const mood = opts.mood ?? suggestMood(doc);
  const program = programDurationSec(doc);
  const durationSec = round(clamp(opts.durationSec ?? (program > 0 ? program : 30), 2, 600));
  const recipe: MusicRecipe = { mood, durationSec, bpm: opts.bpm ?? MOOD_DEFS[mood].bpm, seed: opts.seed ?? 1 };
  const asset = musicAsset(recipe);
  const volume = opts.volume ?? (hasSpeechSource(doc) ? 0.28 : 0.7);
  const next = structuredClone(addMusic(doc, asset, { volume, durationSec }));
  const music = next.tracks.find((t) => t.id === "music");
  if (music) music.name = music.name ?? "Music";
  pruneSynthMedia(next);
  return parseEditDoc(next);
}

/** The generated-music recipe behind the doc's music clip (if it's generated). */
export function generatedMusicOf(doc: EditDoc): { recipe: MusicRecipe; arrangement: Arrangement; clipStart: number; sourceIn: number } | null {
  const clip = doc.tracks.find((t) => t.id === "music")?.clips.find((c) => c.kind === "audio");
  if (!clip || clip.kind !== "audio") return null;
  const asset = doc.media.find((m) => m.id === clip.mediaId);
  const r = parseSynthSrc(asset?.src);
  if (!r || r.type !== "music") return null;
  return { recipe: r.recipe, arrangement: arrangeMusic(r.recipe), clipStart: clip.start, sourceIn: clip.sourceIn };
}

/** Timeline beat times of the generated music (exact grid), or [] when none. */
export function musicBeatTimes(doc: EditDoc, every: "beat" | "bar" = "beat"): number[] {
  const g = generatedMusicOf(doc);
  if (!g) return [];
  const clip = doc.tracks.find((t) => t.id === "music")!.clips.find((c) => c.kind === "audio")!;
  return arrangementBeats(g.arrangement, every)
    .map((b) => round(b - g.sourceIn + g.clipStart))
    .filter((t) => t >= g.clipStart - 1e-6 && t <= clip.start + clip.duration + 1e-6);
}

// ---- 2. sound effects -----------------------------------------------------------------

export interface AddSfxOptions {
  kind: SfxKind;
  /** Timeline moment the sound should HIT (the cut / pop-in). */
  atSec: number;
  volume?: number;
}

function sfxTrack(doc: EditDoc): EditDoc["tracks"][number] {
  let track = doc.tracks.find((t) => t.id === SFX_TRACK_ID);
  if (!track) {
    track = { id: SFX_TRACK_ID, kind: "audio", clips: [], name: "Sound FX", hidden: false, locked: false, muted: false, solo: false };
    doc.tracks.push(track);
  }
  return track;
}

let sfxSeq = 0;

/** Place one SFX clip so its hit lands at `atSec` (trimmed to the program end). */
function pushSfx(doc: EditDoc, kind: SfxKind, atSec: number, volume: number | undefined, programEnd: number): void {
  const def = SFX_DEFS[kind];
  const asset = sfxAsset(kind);
  ensureMedia(doc, asset);
  const track = sfxTrack(doc);
  const start = Math.max(0, atSec - def.hitSec);
  // The part of the sound before t=0 is skipped via sourceIn (a riser at 0.5 s).
  const sourceIn = Math.max(0, def.hitSec - atSec);
  let duration = def.durationSec - sourceIn;
  if (programEnd > 0) duration = Math.min(duration, programEnd - start);
  if (duration < 0.03) return;
  (track.clips as unknown[]).push({
    id: `sfx-${kind}-${Math.round(atSec * 1000)}-${(sfxSeq++).toString(36)}`,
    kind: "audio",
    start: round(start),
    duration: round(duration),
    mediaId: asset.id,
    sourceIn: round(sourceIn),
    volume: clamp(volume ?? def.volume, 0, 1),
  });
}

/** Add one sound effect whose hit lands at `atSec`. Pure. */
export function addSfx(doc: EditDoc, opts: AddSfxOptions): EditDoc {
  if (!isSfxKind(opts.kind)) throw new Error(`Unknown sound effect "${String(opts.kind)}".`);
  const clone: EditDoc = structuredClone(doc);
  const end = programDurationSec(clone);
  if (end > 0 && opts.atSec > end) throw new Error("That's past the end of the video — move the playhead back.");
  pushSfx(clone, opts.kind, Math.max(0, opts.atSec), opts.volume, end);
  return parseEditDoc(clone);
}

export interface SfxEvent {
  t: number;
  kind: SfxKind;
  /** Why it's there (for the summary / UI). */
  reason: "transition" | "scene" | "cut" | "text" | "title" | "build";
}

const PRIORITY: Record<SfxKind, number> = { boom: 5, riser: 4, whoosh: 3, ding: 2, pop: 1, click: 0 };

/**
 * Plan the SFX for a doc (pure, no mutation): whoosh on transitions / text-video
 * scene changes, pop on text pop-ins (not captions). `punchy` adds clicks on hard
 * cuts, a boom on the opening title and a riser into the last scene. Events
 * within 0.3 s collapse to the most important one; capped at `max`.
 */
export function planAutoSfx(doc: EditDoc, opts: { style?: "subtle" | "punchy"; max?: number } = {}): SfxEvent[] {
  const style = opts.style ?? "subtle";
  const max = opts.max ?? 40;
  const end = programDurationSec(doc);
  const events: SfxEvent[] = [];
  const tv = isTextVideo(doc);
  const boundaries: number[] = [];

  if (tv) {
    const bgs = doc.tracks
      .flatMap((t) => t.clips)
      .filter((c) => /^tv-s\d+-bg$/.test(c.id))
      .sort((a, b) => a.start - b.start);
    for (const c of bgs.slice(1)) {
      const tin = "transitionInSec" in c ? (c.transitionInSec as number) : 0;
      const t = round(c.start + tin / 2);
      boundaries.push(t);
      events.push({ t, kind: "whoosh", reason: "scene" });
    }
  } else {
    for (const track of doc.tracks) {
      if (track.kind !== "visual" || !isMainVisualTrack(track.id) || track.hidden) continue;
      const clips = track.clips
        .filter((c) => c.kind === "video" || c.kind === "image" || c.kind === "solid")
        .sort((a, b) => a.start - b.start);
      for (let i = 1; i < clips.length; i++) {
        const c = clips[i]!;
        const tin = "transitionInSec" in c ? (c.transitionInSec as number) : 0;
        const t = round(c.start + tin / 2);
        boundaries.push(t);
        if (tin > 0) events.push({ t, kind: "whoosh", reason: "transition" });
        else if (style === "punchy") events.push({ t, kind: "click", reason: "cut" });
      }
    }
  }

  // Text pop-ins (titles, text-video lines, kinetic titles) — never captions.
  const texts = doc.tracks
    .filter((t) => t.id !== "captions" && !t.hidden)
    .flatMap((t) => t.clips)
    .filter((c): c is Extract<Clip, { kind: "text" }> => c.kind === "text")
    .sort((a, b) => a.start - b.start);
  texts.forEach((c, i) => {
    const t = round(c.start + (c.anim?.delaySec ?? 0));
    if (style === "punchy" && i === 0 && t < 1.5) events.push({ t, kind: "boom", reason: "title" });
    else events.push({ t, kind: "pop", reason: "text" });
  });

  if (style === "punchy" && boundaries.length > 0) {
    const last = boundaries[boundaries.length - 1]!;
    if (last >= SFX_DEFS.riser.hitSec + 0.5) events.push({ t: last, kind: "riser", reason: "build" });
  }

  // Keep events inside the program; collapse near-duplicates by priority.
  const inside = events.filter((e) => e.t >= 0 && (end <= 0 || e.t < end - 0.05));
  inside.sort((a, b) => a.t - b.t || PRIORITY[b.kind] - PRIORITY[a.kind]);
  const out: SfxEvent[] = [];
  for (const e of inside) {
    const prev = out[out.length - 1];
    if (prev && e.t - prev.t < 0.3) {
      if (PRIORITY[e.kind] > PRIORITY[prev.kind]) out[out.length - 1] = e;
      continue;
    }
    out.push(e);
  }
  return out.slice(0, max);
}

/** Replace the "sfx" track with an automatic SFX pass (see `planAutoSfx`). Pure. */
export function autoSfx(doc: EditDoc, opts: { style?: "subtle" | "punchy"; max?: number } = {}): { doc: EditDoc; events: SfxEvent[] } {
  const events = planAutoSfx(doc, opts);
  const clone: EditDoc = structuredClone(doc);
  clone.tracks = clone.tracks.filter((t) => t.id !== SFX_TRACK_ID);
  const end = programDurationSec(clone);
  for (const e of events) pushSfx(clone, e.kind, e.t, undefined, end);
  pruneSynthMedia(clone);
  return { doc: parseEditDoc(clone), events };
}

/** Remove every sound effect. Pure. */
export function clearSfx(doc: EditDoc): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  clone.tracks = clone.tracks.filter((t) => t.id !== SFX_TRACK_ID);
  pruneSynthMedia(clone);
  return parseEditDoc(clone);
}

// ---- 3. smart auto-duck ------------------------------------------------------------------

export interface Interval {
  start: number;
  end: number;
}

/** Merge overlapping / near intervals (gap < `gap`), sorted. */
export function mergeIntervals(list: Interval[], gap = 0): Interval[] {
  const sorted = list.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start - last.end <= gap) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/**
 * Where someone speaks, on the TIMELINE: voice-over clips, caption spans, and
 * (when transcripts are supplied) transcript segments mapped through the main
 * video clips' source windows (constant speed).
 */
export function speechRegions(doc: EditDoc, transcripts: Transcript[] = []): Interval[] {
  const out: Interval[] = [];
  const vo = doc.tracks.find((t) => t.id === "voiceover");
  if (vo && !vo.muted && !vo.hidden) for (const c of vo.clips) if (c.kind === "audio") out.push({ start: c.start, end: c.start + c.duration });
  const caps = doc.tracks.find((t) => t.id === "captions");
  if (caps && !caps.hidden) for (const c of caps.clips) if (c.kind === "text") out.push({ start: c.start, end: c.start + c.duration });
  if (transcripts.length > 0) {
    const byMedia = new Map(transcripts.map((t) => [t.mediaId, t]));
    for (const track of doc.tracks) {
      if (track.kind !== "visual" || !isMainVisualTrack(track.id) || track.muted) continue;
      for (const c of track.clips) {
        if (c.kind !== "video") continue;
        const tr = byMedia.get(c.mediaId);
        if (!tr) continue;
        const speed = c.speed || 1;
        const srcEnd = c.sourceIn + c.duration * speed;
        for (const seg of tr.segments) {
          const s = Math.max(seg.start, c.sourceIn);
          const e = Math.min(seg.end, srcEnd);
          if (e <= s) continue;
          out.push({ start: c.start + (s - c.sourceIn) / speed, end: c.start + (e - c.sourceIn) / speed });
        }
      }
    }
  }
  return mergeIntervals(out, 0.05);
}

export interface AutoDuckOptions {
  /** How far the music dips under speech, in dB (negative). Default −12 dB. */
  depthDb?: number;
  /** Music level between sentences (0..1). Default max(current, 0.6). */
  bedVolume?: number;
  /** Ramp down before speech starts (s). Default 0.25. */
  attackSec?: number;
  /** Ramp back up after speech ends (s). Default 0.6. */
  releaseSec?: number;
  /** Which track to duck. Default "music". */
  track?: string;
  /** Extra speech intervals (timeline seconds), e.g. from a live transcript. */
  speech?: Interval[];
  transcripts?: Transcript[];
}

/** Volume keyframes (clip-progress 0..1) riding a clip down under `regions`. Pure. */
export function duckKeyframes(
  clip: { start: number; duration: number },
  regions: Interval[],
  bed: number,
  ducked: number,
  attackSec: number,
  releaseSec: number,
): Keyframe[] {
  const dur = clip.duration;
  const shifted = regions
    .map((r) => ({ start: r.start - clip.start - attackSec, end: r.end - clip.start + releaseSec }))
    .filter((r) => r.end > 0 && r.start < dur);
  // Bridge short gaps (a swell shorter than ~0.35 s just pumps); widen the bridge
  // until there are at most 60 dips so the export expression stays compact.
  let gap = 0.35;
  let local = mergeIntervals(shifted, gap);
  while (local.length > 60) local = mergeIntervals(shifted, (gap *= 1.6));
  if (local.length === 0) return [];
  const pts: { at: number; v: number }[] = [];
  const add = (at: number, v: number): void => {
    const a = clamp(at, 0, dur);
    const last = pts[pts.length - 1];
    if (last && a <= last.at + 1e-4) {
      last.v = Math.min(last.v, v);
      return;
    }
    pts.push({ at: a, v });
  };
  add(0, local[0]!.start <= 0 ? ducked : bed);
  for (const r of local) {
    // r already includes the attack before and the release after the speech.
    const downEnd = Math.min(r.start + attackSec, r.end);
    const upStart = Math.max(downEnd, r.end - releaseSec);
    if (r.start > 0) add(r.start, bed);
    add(downEnd, ducked);
    add(upStart, ducked);
    if (r.end < dur) add(r.end, bed);
  }
  const last = pts[pts.length - 1]!;
  if (last.at < dur - 1e-4) add(dur, last.v);
  // LINEAR ramps: the export's volume expression is piecewise-linear, so linear
  // keyframes are heard identically in the preview and the .mp4.
  return pts.map((p) => ({ prop: "volume", t: round(p.at / dur), value: round(p.v), easing: "linear" }));
}

/**
 * Smart ducking: the music rides DOWN only while someone speaks (voice-over,
 * captions, transcript speech) and swells back between sentences. Written as
 * editable volume keyframes. With a talking video but no speech timing, the
 * whole bed is ducked flat (like auto-mix). Pure.
 */
export function autoDuck(doc: EditDoc, opts: AutoDuckOptions = {}): { doc: EditDoc; regions: Interval[]; mode: "keyframes" | "flat" } {
  const trackId = opts.track ?? "music";
  const clone: EditDoc = structuredClone(doc);
  const track = clone.tracks.find((t) => t.id === trackId && t.kind === "audio");
  const clips = (track?.clips ?? []).filter((c): c is Extract<Clip, { kind: "audio" }> => c.kind === "audio");
  if (clips.length === 0) throw new Error("Add music first — then I can duck it under the voice.");
  const depthDb = clamp(opts.depthDb ?? -12, -40, -1);
  const attack = clamp(opts.attackSec ?? 0.25, 0.02, 2);
  const release = clamp(opts.releaseSec ?? 0.6, 0.02, 4);
  const regions = mergeIntervals([...speechRegions(clone, opts.transcripts), ...(opts.speech ?? [])], 0.05);
  const factor = Math.pow(10, depthDb / 20);
  let mode: "keyframes" | "flat" = "keyframes";
  for (const clip of clips) {
    const bed = clamp(opts.bedVolume ?? Math.max(clip.volume, 0.6), 0, 1);
    const ducked = round(bed * factor);
    const others = (clip.keyframes ?? []).filter((k) => k.prop !== "volume");
    if (regions.length === 0) {
      if (!hasSpeechSource(clone)) throw new Error("Nobody speaks yet — add a voice-over or captions and I'll duck the music under it.");
      clip.volume = ducked;
      clip.keyframes = others.length ? others : undefined;
      mode = "flat";
      continue;
    }
    const kfs = duckKeyframes(clip, regions, bed, ducked, attack, release);
    clip.volume = round(bed);
    clip.keyframes = kfs.length || others.length ? [...others, ...kfs] : undefined;
  }
  return { doc: parseEditDoc(clone), regions, mode };
}

// ---- 4. beat sync ------------------------------------------------------------------------

/** Nearest value in a sorted list (binary search). */
function nearest(sorted: number[], t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  const a = sorted[lo]!;
  const b = lo > 0 ? sorted[lo - 1]! : a;
  return Math.abs(b - t) <= Math.abs(a - t) ? b : a;
}

/**
 * Snap cumulative scene boundaries (the time each scene ENDS) onto a beat grid,
 * keeping order and a minimum scene length. Returns the new boundaries. Pure.
 */
export function snapBoundaries(boundaries: number[], beats: number[], minSec: number): number[] {
  const grid = [...new Set(beats.map(round))].sort((a, b) => a - b);
  if (grid.length === 0) return boundaries.slice();
  const out: number[] = [];
  let prev = 0;
  for (const b of boundaries) {
    let s = nearest(grid, b);
    if (s - prev < minSec) s = grid.find((g) => g - prev >= minSec - 1e-6) ?? Math.max(b, prev + minSec);
    out.push(round(s));
    prev = s;
  }
  return out;
}

export interface BeatSyncOptions {
  /** Explicit beat times (timeline s). Default: generated music grid, else markers. */
  beats?: number[];
  /** Snap every scene change to a beat, or only to bar lines (every 4 beats). */
  every?: "beat" | "bar";
}

/**
 * Re-time a slideshow's photos / a text video's scenes so every cut lands ON the
 * beat (or the bar). With generated music the grid is exact and the music is
 * re-fitted to end on the final bar. Footage isn't re-timed (use Split at beats).
 */
export function beatSync(doc: EditDoc, opts: BeatSyncOptions = {}): { doc: EditDoc; cuts: number; beatsUsed: number } {
  const every = opts.every ?? "beat";
  const gen = generatedMusicOf(doc);
  let beats = opts.beats && opts.beats.length > 1 ? opts.beats.slice() : musicBeatTimes(doc, every);
  if (beats.length < 2) {
    const marks = (doc.markers ?? []).map((m) => m.t).sort((a, b) => a - b);
    beats = every === "bar" ? marks.filter((_, i) => i % 4 === 0) : marks;
  }
  if (beats.length < 2) throw new Error("No beat to sync to — generate music or detect beats first.");
  beats = beats.filter((b) => b > 0.05);
  const step = beats.length > 1 ? (beats[beats.length - 1]! - beats[0]!) / (beats.length - 1) : 1;
  const barBeats = gen ? musicBeatTimes(doc, "bar").filter((b) => b > 0.05) : beats;

  let next: EditDoc;
  let cuts = 0;
  if (isTextVideo(doc)) {
    const scenes = textVideoScenes(doc);
    if (scenes.length === 0) throw new Error("This text video has no scenes to sync.");
    let acc = 0;
    const bounds = scenes.map((s) => (acc += s.durationSec ?? 2.5));
    const snapped = snapBoundaries(bounds.slice(0, -1), beats, Math.max(0.8, step));
    const lastMin = (snapped[snapped.length - 1] ?? 0) + Math.max(1, step);
    const endGrid = barBeats.filter((b) => b >= lastMin - 1e-6);
    const end = endGrid.length ? nearest(endGrid, Math.max(bounds[bounds.length - 1]!, lastMin)) : Math.max(bounds[bounds.length - 1]!, lastMin);
    const all = [...snapped, round(end)];
    let prev = 0;
    const retimed = scenes.map((s, i) => {
      const d = round(all[i]! - prev);
      prev = all[i]!;
      return { ...s, durationSec: d };
    });
    next = setTextVideoScenes(doc, retimed);
    cuts = snapped.length;
  } else {
    const clone: EditDoc = structuredClone(doc);
    const track = clone.tracks.find(
      (t) => t.kind === "visual" && isMainVisualTrack(t.id) && t.clips.filter((c) => c.kind === "image" || c.kind === "solid").length >= 2,
    );
    if (!track || track.clips.some((c) => c.kind === "video")) {
      throw new Error("Beat sync re-times photos and text scenes — for footage, use “Split at beats”.");
    }
    const seq = track.clips
      .filter((c) => c.kind === "image" || c.kind === "solid")
      .sort((a, b) => a.start - b.start);
    const tin = (c: (typeof seq)[number]): number => ("transitionInSec" in c ? c.transitionInSec : 0);
    // Perceived cut = middle of each crossfade; the end = the last clip's end.
    const cutsAt = seq.slice(1).map((c) => c.start + tin(c) / 2);
    const lastClip = seq[seq.length - 1]!;
    const oldEnd = lastClip.start + lastClip.duration;
    const snapped = snapBoundaries(cutsAt, beats, Math.max(0.8, step));
    const minLast = (snapped[snapped.length - 1] ?? 0) + Math.max(1, tin(lastClip) + 0.5);
    const endGrid = barBeats.filter((b) => b >= minLast - 1e-6);
    const newEnd = endGrid.length ? nearest(endGrid, Math.max(oldEnd, minLast)) : Math.max(oldEnd, minLast);
    const shift = (t: number): number => {
      // Map overlay times proportionally within the old → new cut segments.
      const oldPts = [0, ...cutsAt, oldEnd];
      const newPts = [0, ...snapped, newEnd];
      for (let i = 0; i < oldPts.length - 1; i++) {
        const a = oldPts[i]!;
        const b = oldPts[i + 1]!;
        if (t <= b || i === oldPts.length - 2) return round(newPts[i]! + ((t - a) / Math.max(1e-6, b - a)) * (newPts[i + 1]! - newPts[i]!));
      }
      return t;
    };
    seq.forEach((c, i) => {
      const startCut = i === 0 ? 0 : snapped[i - 1]!;
      const start = i === 0 ? c.start : startCut - tin(c) / 2;
      const endCut = i === seq.length - 1 ? newEnd : snapped[i]! + tin(seq[i + 1]!) / 2;
      c.start = round(Math.max(0, start));
      c.duration = round(Math.max(0.3, endCut - c.start));
    });
    // Titles / fades follow the new timing.
    for (const t of clone.tracks) {
      if (t === track || t.kind !== "visual") continue;
      for (const c of t.clips) {
        const s = shift(c.start);
        const e = shift(c.start + c.duration);
        c.start = s;
        c.duration = round(Math.max(0.1, e - s));
      }
    }
    next = parseEditDoc(clone);
    cuts = snapped.length;
  }

  // Re-fit the music: a generated bed is re-composed to end on the new last bar
  // (same tempo ⇒ same grid); uploaded music is trimmed to the new length.
  const newEnd = programDurationSec(next);
  if (gen && Math.abs(newEnd - gen.recipe.durationSec) > 0.01) {
    const clip = next.tracks.find((t) => t.id === "music")!.clips.find((c) => c.kind === "audio")!;
    const refit = generateMusic(next, {
      mood: gen.recipe.mood,
      bpm: gen.arrangement.bpm,
      seed: gen.recipe.seed,
      durationSec: round(newEnd - clip.start),
      volume: clip.kind === "audio" ? clip.volume : undefined,
    });
    const newClip = refit.tracks.find((t) => t.id === "music")!.clips.find((c) => c.kind === "audio");
    if (newClip && newClip.kind === "audio" && clip.kind === "audio") {
      newClip.start = clip.start;
      newClip.keyframes = clip.keyframes;
      newClip.fadeInSec = clip.fadeInSec;
      newClip.fadeOutSec = clip.fadeOutSec;
      newClip.pan = clip.pan;
    }
    next = parseEditDoc(refit);
  } else if (!gen) {
    const clone: EditDoc = structuredClone(next);
    for (const c of clone.tracks.find((t) => t.id === "music")?.clips ?? []) {
      if (c.kind === "audio" && c.start + c.duration > newEnd) c.duration = round(Math.max(0.1, newEnd - c.start));
    }
    next = parseEditDoc(clone);
  }
  return { doc: next, cuts, beatsUsed: beats.length };
}

// ---- 5. voice enhance -------------------------------------------------------------------------

/** Toggle one-click voice enhance (export chain on the voice only). Pure. */
export function setVoiceEnhance(doc: EditDoc, on = true): EditDoc {
  const clone: EditDoc = structuredClone(doc);
  if (on) clone.voiceEnhance = true;
  else delete clone.voiceEnhance;
  return parseEditDoc(clone);
}
