/**
 * The preview MIX, computed from the edit-doc exactly the way the ffmpeg export
 * mixes it — so what you hear (and see on the meters) is what you get:
 *
 *  - `clipGainAt` — a clip's level at a timeline moment: keyframed volume
 *    (`valueAt`, the same resolver the export linearizes), afade-style linear
 *    fade in/out, and track hidden / muted / solo rules.
 *  - `levelEnvelope` + `mixLevelsAt` — per-bus (Voice / Music / SFX) and master
 *    RMS + peak at the playhead, from each source's decoded PCM × its gain.
 *    Uncorrelated sources add in power (RMS) and peaks add linearly (worst case).
 */
import { sourceTimeAt, valueAt, type AudioClip, type EditDoc, type Track, type VideoClip } from "@cadence/core";
import { decodeAudio } from "./waveform";

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Track ids that never carry the main programme audio. */
const NON_MAIN = new Set(["titles", "captions", "broll", "fades", "music", "voiceover", "sfx", "cursor", "callouts", "demo-text", "adjustments", "shapes"]);

/** Whether a solo is active on any (non-hidden) track — mirrors the export. */
export function soloActive(doc: EditDoc): boolean {
  return doc.tracks.some((t) => !t.hidden && t.solo);
}

/** Whether a track contributes to the mix at all (hidden / muted / solo). */
export function trackAudible(doc: EditDoc, track: Track): boolean {
  if (track.hidden || track.muted) return false;
  if (soloActive(doc) && !track.solo) return false;
  return true;
}

/**
 * A clip's gain (0..1) at timeline time `t`: keyframed/static volume × linear
 * fade-in/out envelope, 0 outside the clip or when its track is silenced.
 */
export function clipGainAt(doc: EditDoc, track: Track, clip: AudioClip | VideoClip, t: number): number {
  if (!trackAudible(doc, track)) return 0;
  const local = t - clip.start;
  if (local < 0 || local > clip.duration) return 0;
  const progress = clip.duration > 0 ? local / clip.duration : 0;
  let g = valueAt(clip.keyframes, "volume", progress, clip.volume);
  if (clip.fadeInSec > 0 && local < clip.fadeInSec) g *= local / clip.fadeInSec;
  const toEnd = clip.duration - local;
  if (clip.fadeOutSec > 0 && toEnd < clip.fadeOutSec) g *= toEnd / clip.fadeOutSec;
  return clamp01(g);
}

// ---- meters ----------------------------------------------------------------------

export interface LevelEnvelope {
  /** Window length in seconds. */
  hopSec: number;
  /** Per-window RMS (linear, max over channels). */
  rms: Float32Array;
  /** Per-window peak (linear). */
  peak: Float32Array;
}

/** RMS + peak envelope of PCM channels in `hopSec` windows. Pure. */
export function levelEnvelope(channels: Float32Array[], sampleRate: number, hopSec = 0.025): LevelEnvelope {
  const hop = Math.max(1, Math.round(sampleRate * hopSec));
  const len = channels[0]?.length ?? 0;
  const n = Math.ceil(len / hop);
  const rms = new Float32Array(n);
  const peak = new Float32Array(n);
  for (let w = 0; w < n; w++) {
    const a = w * hop;
    const b = Math.min(len, a + hop);
    let bestRms = 0;
    let bestPeak = 0;
    for (const ch of channels) {
      let s = 0;
      for (let i = a; i < b; i++) {
        const v = ch[i]!;
        s += v * v;
        const av = v < 0 ? -v : v;
        if (av > bestPeak) bestPeak = av;
      }
      bestRms = Math.max(bestRms, Math.sqrt(s / Math.max(1, b - a)));
    }
    rms[w] = bestRms;
    peak[w] = bestPeak;
  }
  return { hopSec: hop / sampleRate, rms, peak };
}

export type BusId = "voice" | "music" | "sfx";
export interface MeterReading {
  rms: number;
  peak: number;
}
export interface MixLevels {
  buses: Record<BusId, MeterReading>;
  master: MeterReading;
}

/** Which bus a track's audio lands on. */
export function busOf(track: Track): BusId | null {
  if (track.id === "sfx") return "sfx";
  if (track.id === "voiceover") return "voice";
  if (track.kind === "audio") return "music";
  if (track.kind === "visual" && !NON_MAIN.has(track.id)) return "voice"; // footage's own sound
  return null;
}

/** Envelope window around the source time (max over ±1 window, a meter's ballistics). */
function readEnv(env: LevelEnvelope, sourceSec: number): MeterReading {
  const i = Math.floor(sourceSec / env.hopSec);
  let rms = 0;
  let peak = 0;
  for (let k = i - 1; k <= i + 1; k++) {
    if (k < 0 || k >= env.rms.length) continue;
    rms = Math.max(rms, env.rms[k]!);
    peak = Math.max(peak, env.peak[k]!);
  }
  return { rms, peak };
}

/** Per-bus + master level at timeline time `t`. Pure. */
export function mixLevelsAt(doc: EditDoc, envelopes: Record<string, LevelEnvelope | null | undefined>, t: number): MixLevels {
  const pow: Record<BusId, number> = { voice: 0, music: 0, sfx: 0 };
  const pk: Record<BusId, number> = { voice: 0, music: 0, sfx: 0 };
  for (const track of doc.tracks) {
    const bus = busOf(track);
    if (!bus) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "audio" && clip.kind !== "video") continue;
      if (t < clip.start || t >= clip.start + clip.duration) continue;
      const env = envelopes[clip.mediaId];
      if (!env) continue;
      const g = clipGainAt(doc, track, clip, t);
      if (g <= 0) continue;
      const src = clip.kind === "video" ? sourceTimeAt(clip, t) : clip.sourceIn + (t - clip.start);
      const r = readEnv(env, src);
      pow[bus] += (r.rms * g) ** 2;
      pk[bus] += r.peak * g;
    }
  }
  const buses = {
    voice: { rms: Math.sqrt(pow.voice), peak: pk.voice },
    music: { rms: Math.sqrt(pow.music), peak: pk.music },
    sfx: { rms: Math.sqrt(pow.sfx), peak: pk.sfx },
  };
  return {
    buses,
    master: { rms: Math.sqrt(pow.voice + pow.music + pow.sfx), peak: pk.voice + pk.music + pk.sfx },
  };
}

/** Linear → dBFS (−∞ for silence). */
export const toDbfs = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -Infinity);

const envCache = new Map<string, Promise<LevelEnvelope | null>>();

/** Decode (once per media id) and compute a level envelope for a source. Never throws. */
export function loadEnvelope(mediaId: string, source: File | string): Promise<LevelEnvelope | null> {
  const hit = envCache.get(mediaId);
  if (hit) return hit;
  const p = decodeAudio(source)
    .then((buf) => {
      if (!buf) return null;
      const chans: Float32Array[] = [];
      for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
      return levelEnvelope(chans, buf.sampleRate);
    })
    .catch(() => null);
  envCache.set(mediaId, p);
  return p;
}
