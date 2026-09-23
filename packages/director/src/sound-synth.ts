/**
 * Procedural sound — royalty-free BACKGROUND MUSIC and SOUND EFFECTS synthesized
 * from scratch in pure TypeScript (no samples, no Web Audio, no network, no deps).
 *
 * Pure + deterministic: the same recipe (mood / duration / tempo / seed) always
 * yields the same PCM, bit for bit, in Node (verify gate, tests) and in the
 * browser (preview). That's what lets the edit-doc store only the RECIPE (the
 * media `src` is `synth:music?…`) — the audio is re-created on demand.
 *
 * Signal path (music): arrangement (sections × chords × patterns) → voices
 * (kick/snare/clap/hat/shaker/tom, bass, e-piano, pluck, piano, pad, strings,
 * bells, drone, vinyl crackle) written into a stereo dry bus + a reverb send →
 * Freeverb-style stereo reverb → DC-block → peak-normalize to −3 dBFS → end
 * fade to digital silence (a clean, seamless end — never a hard cut-off).
 */

export const SYNTH_SAMPLE_RATE = 44100;

const TAU = Math.PI * 2;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
/** Cheap soft-clip (Padé tanh approximation, exact ±1 beyond |x| ≥ 3). */
const softClip = (x: number): number => (x <= -3 ? -1 : x >= 3 ? 1 : (x * (27 + x * x)) / (27 + 9 * x * x));

/** Deterministic PRNG (mulberry32) — every random choice goes through this. */
export function makeRng(seed: number): () => number {
  let a = (Math.floor(seed) >>> 0) ^ 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- moods -------------------------------------------------------------------

export const MUSIC_MOODS = ["lofi", "upbeat", "cinematic", "corporate", "ambient"] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];

type ChordQuality = "maj" | "min" | "maj7" | "min7" | "dom7" | "maj9" | "min9" | "sus2" | "add9";
const QUALITY: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  maj9: [0, 4, 7, 11, 14],
  min9: [0, 3, 7, 10, 14],
  sus2: [0, 2, 7],
  add9: [0, 4, 7, 14],
};
interface ChordSpec {
  /** Semitones above the key's tonic. */
  root: number;
  q: ChordQuality;
}
const ch = (root: number, q: ChordQuality): ChordSpec => ({ root, q });

export interface MoodDef {
  label: string;
  blurb: string;
  /** Default tempo (BPM). */
  bpm: number;
  /** Tempo range the UI offers. */
  bpmRange: [number, number];
  /** Tonic pitch class (0 = C). */
  key: number;
  /** 0.5 = straight 8ths; >0.5 delays the off-beats (swing). */
  swing: number;
  /** Bars each chord lasts. */
  barsPerChord: number;
  tonic: ChordSpec;
  progressions: ChordSpec[][];
  /** Reverb wet level 0..1. */
  reverb: number;
}

export const MOOD_DEFS: Record<MusicMood, MoodDef> = {
  lofi: {
    label: "Chill lo-fi",
    blurb: "Dusty keys, lazy swing, vinyl crackle",
    bpm: 82,
    bpmRange: [70, 95],
    key: 5,
    swing: 0.6,
    barsPerChord: 1,
    tonic: ch(0, "maj9"),
    progressions: [
      [ch(2, "min9"), ch(7, "dom7"), ch(0, "maj9"), ch(9, "min9")],
      [ch(0, "maj9"), ch(9, "min7"), ch(2, "min9"), ch(7, "dom7")],
      [ch(5, "maj7"), ch(4, "min7"), ch(2, "min7"), ch(0, "maj9")],
    ],
    reverb: 0.22,
  },
  upbeat: {
    label: "Upbeat pop",
    blurb: "Four-on-the-floor, bright plucks",
    bpm: 118,
    bpmRange: [105, 132],
    key: 7,
    swing: 0.5,
    barsPerChord: 1,
    tonic: ch(0, "maj"),
    progressions: [
      [ch(0, "maj"), ch(7, "maj"), ch(9, "min"), ch(5, "maj")],
      [ch(9, "min"), ch(5, "maj"), ch(0, "maj"), ch(7, "maj")],
      [ch(0, "add9"), ch(5, "maj"), ch(9, "min"), ch(7, "maj")],
    ],
    reverb: 0.16,
  },
  cinematic: {
    label: "Cinematic",
    blurb: "Swelling strings, drums of war",
    bpm: 72,
    bpmRange: [60, 90],
    key: 2,
    swing: 0.5,
    barsPerChord: 1,
    tonic: ch(0, "min"),
    progressions: [
      [ch(0, "min"), ch(8, "maj"), ch(3, "maj"), ch(10, "maj")],
      [ch(0, "min"), ch(10, "maj"), ch(8, "maj"), ch(7, "maj")],
      [ch(0, "min"), ch(5, "min"), ch(8, "maj"), ch(7, "maj")],
    ],
    reverb: 0.4,
  },
  corporate: {
    label: "Corporate",
    blurb: "Uplifting piano, light groove",
    bpm: 104,
    bpmRange: [92, 120],
    key: 0,
    swing: 0.5,
    barsPerChord: 1,
    tonic: ch(0, "maj"),
    progressions: [
      [ch(0, "maj"), ch(9, "min"), ch(5, "maj"), ch(7, "maj")],
      [ch(0, "add9"), ch(7, "maj"), ch(9, "min7"), ch(5, "maj7")],
      [ch(5, "maj7"), ch(7, "maj"), ch(4, "min7"), ch(9, "min")],
    ],
    reverb: 0.2,
  },
  ambient: {
    label: "Ambient",
    blurb: "Slow pads, shimmering bells",
    bpm: 64,
    bpmRange: [50, 80],
    key: 4,
    swing: 0.5,
    barsPerChord: 2,
    tonic: ch(0, "maj7"),
    progressions: [
      [ch(0, "maj7"), ch(5, "maj7")],
      [ch(0, "sus2"), ch(9, "min7"), ch(5, "maj7"), ch(7, "sus2")],
      [ch(0, "maj9"), ch(4, "min7"), ch(5, "maj7"), ch(2, "min7")],
    ],
    reverb: 0.55,
  },
};

export function isMusicMood(v: unknown): v is MusicMood {
  return typeof v === "string" && (MUSIC_MOODS as readonly string[]).includes(v);
}

// ---- arrangement (pure, testable) --------------------------------------------

export interface MusicRecipe {
  mood: MusicMood;
  /** Length of the finished bed, seconds (fitted to the video). */
  durationSec: number;
  /** Requested tempo; nudged ≤ ±8% so whole bars fit the duration. */
  bpm?: number;
  seed?: number;
}

export type SectionName = "intro" | "a" | "b" | "break" | "end";
export interface MusicSection {
  name: SectionName;
  startBar: number;
  bars: number;
  /** 0 = sparse … 2 = full. */
  energy: number;
}
export interface MusicChord {
  bar: number;
  /** Absolute MIDI notes of the voicing. */
  notes: number[];
  /** Bass MIDI note (chord root, low register). */
  bass: number;
}
export interface Arrangement {
  mood: MusicMood;
  seed: number;
  /** The tempo actually used (fitted). */
  bpm: number;
  beatSec: number;
  beatsPerBar: 4;
  bars: number;
  durationSec: number;
  /** When the last (ending) bar starts. */
  endBarSec: number;
  /** True when the tempo was nudged so the bars fit the duration exactly. */
  fitted: boolean;
  sections: MusicSection[];
  chords: MusicChord[];
}

/** Voice a chord around a centre register (close voicing, root position-ish). */
function voiceChord(key: number, spec: ChordSpec, center: number): number[] {
  const base = 12 * Math.floor((center - (key + spec.root)) / 12) + key + spec.root;
  return QUALITY[spec.q].map((iv) => {
    let n = base + iv;
    while (n > center + 10) n -= 12;
    while (n < center - 7) n += 12;
    return n;
  }).sort((a, b) => a - b);
}

function bassNote(key: number, spec: ChordSpec): number {
  let n = 36 + ((key + spec.root) % 12);
  if (n > 43) n -= 12;
  return n;
}

/**
 * Lay out the song: tempo fitted so an integer number of 4/4 bars spans the
 * duration (within ±8% of the requested BPM), sections by energy, one chord per
 * `barsPerChord`, and a final ENDING bar on the tonic that rings out to the end.
 */
export function arrangeMusic(recipe: MusicRecipe): Arrangement {
  const def = MOOD_DEFS[recipe.mood];
  const seed = Math.floor(recipe.seed ?? 1) >>> 0;
  const durationSec = Math.max(1, recipe.durationSec);
  const target = clamp(recipe.bpm ?? def.bpm, 40, 200);
  const barAt = (bpm: number): number => (4 * 60) / bpm;
  let bars = Math.max(1, Math.round(durationSec / barAt(target)));
  let bpm = (bars * 4 * 60) / durationSec;
  let fitted = true;
  if (Math.abs(bpm / target - 1) > 0.08) {
    // Too short/odd to fit exactly — keep the tempo; the last bar rings out.
    bpm = target;
    bars = Math.max(1, Math.floor(durationSec / barAt(target)) || 1);
    fitted = false;
  }
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const endBarSec = Math.min(durationSec, (bars - 1) * barSec);

  // Sections: intro → A → (break) → B → end.
  const sections: MusicSection[] = [];
  const intro = bars >= 16 ? 2 : bars >= 6 ? 1 : 0;
  const body = Math.max(0, bars - 1 - intro);
  if (intro) sections.push({ name: "intro", startBar: 0, bars: intro, energy: 0 });
  if (body > 0) {
    const aBars = Math.max(1, Math.floor(body / 2));
    sections.push({ name: "a", startBar: intro, bars: aBars, energy: 1 });
    let rest = body - aBars;
    let at = intro + aBars;
    if (body >= 12) {
      sections.push({ name: "break", startBar: at, bars: 2, energy: 0.5 });
      at += 2;
      rest -= 2;
    }
    if (rest > 0) sections.push({ name: "b", startBar: at, bars: rest, energy: 2 });
  }
  sections.push({ name: "end", startBar: bars - 1, bars: 1, energy: 0 });

  const prog = def.progressions[seed % def.progressions.length]!;
  const center = recipe.mood === "cinematic" ? 60 : recipe.mood === "ambient" ? 64 : 62;
  const chords: MusicChord[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const spec = bar === bars - 1 && bars > 1 ? def.tonic : prog[Math.floor(bar / def.barsPerChord) % prog.length]!;
    chords.push({ bar, notes: voiceChord(def.key, spec, center), bass: bassNote(def.key, spec) });
  }
  return {
    mood: recipe.mood,
    seed,
    bpm: round3(bpm),
    beatSec,
    beatsPerBar: 4,
    bars,
    durationSec,
    endBarSec,
    fitted,
    sections,
    chords,
  };
}

/** Beat times (seconds from the start of the bed) of an arrangement's grid. */
export function arrangementBeats(arr: Arrangement, every: "beat" | "bar" = "beat"): number[] {
  const step = every === "bar" ? arr.beatSec * 4 : arr.beatSec;
  const out: number[] = [];
  for (let t = 0; t < arr.durationSec - 1e-6; t += step) out.push(round3(t));
  return out;
}

// ---- mixing bus ----------------------------------------------------------------

/** A stereo dry bus + a stereo reverb send. */
class Bus {
  readonly L: Float32Array;
  readonly R: Float32Array;
  readonly sL: Float32Array;
  readonly sR: Float32Array;
  readonly n: number;
  readonly sr: number;
  constructor(n: number, sr: number) {
    this.n = n;
    this.sr = sr;
    this.L = new Float32Array(n);
    this.R = new Float32Array(n);
    this.sL = new Float32Array(n);
    this.sR = new Float32Array(n);
  }
}

/** Constant-power pan gains for -1 (left) … 1 (right). */
function panGains(pan: number): [number, number] {
  const a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

/**
 * Render a mono voice `fn(t, i)` (t = seconds since note-on) starting at `t0`
 * for `dur` seconds into the bus with pan + reverb send.
 */
function voice(
  bus: Bus,
  t0: number,
  dur: number,
  gain: number,
  pan: number,
  send: number,
  fn: (t: number, i: number) => number,
): void {
  const s0 = Math.round(t0 * bus.sr);
  const len = Math.round(dur * bus.sr);
  const [gl, gr] = panGains(pan);
  const end = Math.min(bus.n, s0 + len);
  const inv = 1 / bus.sr;
  for (let s = Math.max(0, s0); s < end; s++) {
    const i = s - s0;
    const v = fn(i * inv, i) * gain;
    bus.L[s] = bus.L[s]! + v * gl;
    bus.R[s] = bus.R[s]! + v * gr;
    if (send > 0) {
      bus.sL[s] = bus.sL[s]! + v * gl * send;
      bus.sR[s] = bus.sR[s]! + v * gr * send;
    }
  }
}

/** Attack/release envelope for a held note of length `dur`. */
function ar(t: number, dur: number, att: number, rel: number): number {
  if (t < att) return t / att;
  if (t > dur - rel) return Math.max(0, (dur - t) / rel);
  return 1;
}

/** polyBLEP band-limited saw (phase 0..1, dt = f/sr). */
function blepSaw(phase: number, dt: number): number {
  let v = 2 * phase - 1;
  if (phase < dt) {
    const x = phase / dt;
    v -= x + x - x * x - 1;
  } else if (phase > 1 - dt) {
    const x = (phase - 1) / dt;
    v -= x * x + x + x + 1;
  }
  return v;
}

// ---- instruments ---------------------------------------------------------------

function kick(bus: Bus, t0: number, gain: number, rng: () => number, punch = 1): void {
  let ph = 0;
  const sr = bus.sr;
  voice(bus, t0, 0.5, gain, 0, 0.02, (t, i) => {
    const f = 44 + 120 * punch * Math.exp(-t * 32);
    ph += f / sr;
    const body = Math.sin(TAU * ph) * Math.exp(-t * 6.5);
    const click = i < 130 ? (rng() * 2 - 1) * 0.35 * (1 - i / 130) : 0;
    return softClip(1.6 * (body + click));
  });
}

function snare(bus: Bus, t0: number, gain: number, rng: () => number, bright = 1, pan = 0.05): void {
  let hp = 0;
  let prev = 0;
  let lp = 0;
  const a = 1 - Math.exp((-TAU * (2500 + 3500 * bright)) / bus.sr);
  voice(bus, t0, 0.28, gain, pan, 0.25, (t) => {
    const n = rng() * 2 - 1;
    hp = 0.92 * (hp + n - prev);
    prev = n;
    lp += a * (hp - lp);
    const noise = lp * Math.exp(-t * 17);
    const tone = Math.sin(TAU * 185 * t) * Math.exp(-t * 28) * 0.55;
    return noise * 0.9 + tone;
  });
}

function clap(bus: Bus, t0: number, gain: number, rng: () => number, pan = -0.05): void {
  let hp = 0;
  let prev = 0;
  voice(bus, t0, 0.32, gain, pan, 0.35, (t) => {
    const n = rng() * 2 - 1;
    hp = 0.85 * (hp + n - prev);
    prev = n;
    let env = 0;
    for (const off of [0, 0.011, 0.022]) if (t >= off) env = Math.max(env, Math.exp(-(t - off) * 180));
    if (t >= 0.022) env = Math.max(env, 0.55 * Math.exp(-(t - 0.022) * 16));
    return hp * env;
  });
}

function hat(bus: Bus, t0: number, gain: number, rng: () => number, open = false, pan = 0.25): void {
  let h1 = 0;
  let p1 = 0;
  let h2 = 0;
  let p2 = 0;
  voice(bus, t0, open ? 0.3 : 0.07, gain, pan, 0.1, (t) => {
    const n = rng() * 2 - 1;
    h1 = 0.55 * (h1 + n - p1);
    p1 = n;
    h2 = 0.55 * (h2 + h1 - p2);
    p2 = h1;
    return h2 * Math.exp(-t * (open ? 13 : 70));
  });
}

function shaker(bus: Bus, t0: number, gain: number, rng: () => number, pan = -0.3): void {
  let h = 0;
  let p = 0;
  voice(bus, t0, 0.09, gain, pan, 0.1, (t) => {
    const n = rng() * 2 - 1;
    h = 0.6 * (h + n - p);
    p = n;
    const env = t < 0.012 ? t / 0.012 : Math.exp(-(t - 0.012) * 45);
    return h * env;
  });
}

function tom(bus: Bus, t0: number, gain: number, freq: number, rng: () => number, pan = 0): void {
  let ph = 0;
  const sr = bus.sr;
  let lp = 0;
  voice(bus, t0, 1.1, gain, pan, 0.45, (t) => {
    ph += (freq * (1 + 0.7 * Math.exp(-t * 14))) / sr;
    const body = Math.sin(TAU * ph) * Math.exp(-t * 4.2);
    lp += 0.08 * ((rng() * 2 - 1) - lp);
    const thump = lp * Math.exp(-t * 30) * 1.4;
    return softClip(1.3 * (body + thump));
  });
}

function bass(bus: Bus, t0: number, dur: number, midi: number, gain: number, drive = 1.4): void {
  const f = midiHz(midi);
  let ph = 0;
  const dt = f / bus.sr;
  voice(bus, t0, dur, gain, 0, 0, (t) => {
    ph = (ph + dt) % 1;
    const v = Math.sin(TAU * ph) + 0.28 * Math.sin(2 * TAU * ph);
    return softClip(drive * v) * ar(t, dur, 0.006, Math.min(0.08, dur * 0.4));
  });
}

/**
 * A sine oscillator by complex rotation (4 mults/sample instead of Math.sin);
 * accurate for the few-second notes it's used on. `next()` returns sin(phase).
 */
class Rot {
  private s: number;
  private c: number;
  private readonly cw: number;
  private readonly sw: number;
  constructor(freq: number, sr: number, phase = 0) {
    const w = (TAU * freq) / sr;
    this.cw = Math.cos(w);
    this.sw = Math.sin(w);
    this.s = Math.sin(phase);
    this.c = Math.cos(phase);
  }
  next(): number {
    const s = this.s;
    const ns = s * this.cw + this.c * this.sw;
    this.c = this.c * this.cw - s * this.sw;
    this.s = ns;
    return s;
  }
}

/** Per-sample multiplier for an exp(-t·rate) decay. */
const decayK = (rate: number, sr: number): number => Math.exp(-rate / sr);

function epiano(bus: Bus, t0: number, dur: number, midi: number, gain: number, pan: number): void {
  const sr = bus.sr;
  const f = midiHz(midi);
  const tail = dur + 0.35;
  const mod = new Rot(f, sr);
  const trem = new Rot(4.6, sr);
  const w = (TAU * f) / sr;
  const kIdx = decayK(3.2, sr);
  const kEnv = decayK(1.1, sr);
  let idx = 1.4;
  let env = 1;
  voice(bus, t0, tail, gain, pan, 0.35, (t, i) => {
    const m = mod.next() * (idx + 0.15);
    const car = Math.sin(w * i + m);
    idx *= kIdx;
    env *= kEnv;
    const rel = t > dur ? Math.max(0, 1 - (t - dur) / 0.35) : 1;
    return car * env * rel * Math.min(1, t / 0.003) * (1 + 0.14 * trem.next());
  });
}

function pluck(bus: Bus, t0: number, midi: number, gain: number, pan: number, rng: () => number, decay = 0.994): void {
  const sr = bus.sr;
  const period = Math.max(2, Math.round(sr / midiHz(midi)));
  const line = new Float32Array(period);
  let lp = 0;
  for (let i = 0; i < period; i++) {
    lp += 0.5 * ((rng() * 2 - 1) - lp);
    line[i] = lp;
  }
  let idx = 0;
  voice(bus, t0, 0.9, gain, pan, 0.3, (t) => {
    const a = line[idx]!;
    const b = line[(idx + 1) % period]!;
    const v = decay * 0.5 * (a + b);
    line[idx] = v;
    idx = (idx + 1) % period;
    return a * (t > 0.75 ? Math.max(0, 1 - (t - 0.75) / 0.15) : 1);
  });
}

function piano(bus: Bus, t0: number, dur: number, midi: number, gain: number, pan: number, rng: () => number): void {
  const sr = bus.sr;
  const f = midiHz(midi);
  const tail = dur + 0.6;
  const parts = [1, 2, 3, 4, 5, 6]
    .map((n) => ({ f: f * n * Math.sqrt(1 + 0.00035 * n * n), a: 1 / Math.pow(n, 1.25), k: decayK(1.3 + n * 0.9, sr) }))
    .filter((p) => p.f < sr * 0.45);
  const osc = parts.map((p) => new Rot(p.f, sr));
  const env = parts.map((p) => p.a);
  const ks = parts.map((p) => p.k);
  voice(bus, t0, tail, gain * 0.55, pan, 0.3, (t) => {
    let v = 0;
    for (let k = 0; k < osc.length; k++) {
      v += env[k]! * osc[k]!.next();
      env[k] = env[k]! * ks[k]!;
    }
    const hammer = t < 0.004 ? (rng() * 2 - 1) * 0.25 : 0;
    const rel = t > dur ? Math.max(0, 1 - (t - dur) / 0.6) : 1;
    return (v + hammer) * rel * Math.min(1, t / 0.002);
  });
}

function pad(
  bus: Bus,
  t0: number,
  dur: number,
  midi: number,
  gain: number,
  pan: number,
  opts: { attack?: number; release?: number; cutoff?: number; vibrato?: number } = {},
): void {
  const sr = bus.sr;
  const att = opts.attack ?? 0.6;
  const rel = opts.release ?? 0.9;
  const total = dur + rel;
  const f = midiHz(midi);
  const det = [Math.pow(2, 7 / 1200), Math.pow(2, -7 / 1200)];
  const ph = [0.13, 0.61];
  let lp1 = 0;
  let lp2 = 0;
  const baseCut = opts.cutoff ?? 1400;
  const vib = opts.vibrato ?? 0;
  let a = 0;
  let fm = 1;
  voice(bus, t0, total, gain, pan, 0.6, (t, i) => {
    // Control-rate (every 64 samples) filter sweep + vibrato.
    if ((i & 63) === 0) {
      fm = 1 + vib * Math.sin(TAU * 5.2 * t);
      a = 1 - Math.exp((-TAU * baseCut * (1 + 0.25 * Math.sin(TAU * 0.13 * t))) / sr);
    }
    let v = 0;
    for (let k = 0; k < 2; k++) {
      const dt = (f * det[k]! * fm) / sr;
      let p = ph[k]! + dt;
      if (p >= 1) p -= 1;
      ph[k] = p;
      v += blepSaw(p, dt);
    }
    lp1 += a * (v - lp1);
    lp2 += a * (lp1 - lp2);
    const env = t < att ? t / att : t > dur ? Math.max(0, 1 - (t - dur) / rel) : 1;
    return lp2 * 0.5 * env * env;
  });
}

function bell(bus: Bus, t0: number, midi: number, gain: number, pan: number, decay = 1.6): void {
  const sr = bus.sr;
  const f = midiHz(midi);
  const o1 = new Rot(f, sr);
  const o2 = new Rot(f * 2, sr);
  const o3 = new Rot(f * 3.01, sr);
  const k0 = decayK(decay, sr);
  const k2 = decayK(1.5, sr);
  const k3 = decayK(2.5, sr);
  let e0 = 1;
  let e2 = 0.45;
  let e3 = 0.25;
  voice(bus, t0, 3.2, gain, pan, 0.7, (t) => {
    const v = o1.next() + e2 * o2.next() + e3 * o3.next();
    const out = v * e0 * Math.min(1, t / 0.004) * (t > 2.9 ? Math.max(0, (3.2 - t) / 0.3) : 1);
    e0 *= k0;
    e2 *= k2;
    e3 *= k3;
    return out;
  });
}

function drone(bus: Bus, t0: number, dur: number, midi: number, gain: number): void {
  const sr = bus.sr;
  const f = midiHz(midi);
  const o1 = new Rot(f, sr);
  const w2 = (TAU * 2 * f) / sr;
  const lfo = new Rot(0.2, sr);
  const edge = Math.min(1.5, dur / 3);
  voice(bus, t0, dur, gain, 0, 0.3, (t, i) => {
    const v = o1.next() + 0.5 * Math.sin(w2 * i + 0.3 * lfo.next());
    return v * ar(t, dur, edge, edge);
  });
}

function crackle(bus: Bus, rng: () => number, level: number): void {
  let lp = 0;
  let pop = 0;
  const rate = 7 / bus.sr;
  for (let s = 0; s < bus.n; s++) {
    lp += 0.05 * ((rng() * 2 - 1) - lp);
    if (rng() < rate) pop = (0.4 + rng() * 0.6) * (rng() < 0.5 ? -1 : 1);
    const v = (lp * 0.25 + pop) * level;
    pop *= 0.82;
    bus.L[s] = bus.L[s]! + v;
    bus.R[s] = bus.R[s]! + v * 0.9;
  }
}

// ---- reverb + master -------------------------------------------------------------

/** Freeverb-style stereo reverb of the send bus, mixed into the dry bus. */
function reverb(bus: Bus, wet: number, room = 0.8, damp = 0.3): void {
  if (wet <= 0) return;
  const scale = bus.sr / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491];
  const aps = [556, 441, 341];
  const n = bus.n;
  const acc = new Float64Array(n);
  const run = (input: Float32Array, out: Float32Array, spread: number): void => {
    acc.fill(0);
    // Parallel combs, one whole-buffer pass each (cache-friendly, no per-sample objects).
    for (const d of combs) {
      const len = Math.round((d + spread) * scale);
      const buf = new Float64Array(len);
      let i = 0;
      let f = 0;
      for (let s = 0; s < n; s++) {
        const o = buf[i]!;
        f = o * (1 - damp) + f * damp;
        buf[i] = input[s]! * 0.2 + f * room;
        if (++i === len) i = 0;
        acc[s] = acc[s]! + o;
      }
    }
    // Series allpasses.
    for (const d of aps) {
      const len = Math.round((d + spread) * scale);
      const buf = new Float64Array(len);
      let i = 0;
      for (let s = 0; s < n; s++) {
        const o = buf[i]!;
        const y = acc[s]!;
        buf[i] = y + o * 0.5;
        if (++i === len) i = 0;
        acc[s] = o - y;
      }
    }
    for (let s = 0; s < n; s++) out[s] = out[s]! + acc[s]! * wet;
  };
  run(bus.sL, bus.L, 0);
  run(bus.sR, bus.R, 23);
}

/** DC-block (1-pole HP ≈ 20 Hz), peak-normalize, then fade to true silence. */
function master(bus: Bus, peakDb: number, fadeInSec: number, fadeOutSec: number): void {
  const r = 1 - (TAU * 20) / bus.sr;
  for (const ch of [bus.L, bus.R]) {
    let x1 = 0;
    let y1 = 0;
    for (let s = 0; s < bus.n; s++) {
      const x = ch[s]!;
      const y = x - x1 + r * y1;
      x1 = x;
      y1 = y;
      ch[s] = y;
    }
  }
  let peak = 0;
  for (const ch of [bus.L, bus.R]) for (let s = 0; s < bus.n; s++) peak = Math.max(peak, Math.abs(ch[s]!));
  const g = peak > 0 ? Math.pow(10, peakDb / 20) / peak : 0;
  const fi = Math.max(1, Math.round(fadeInSec * bus.sr));
  const fo = Math.max(1, Math.round(fadeOutSec * bus.sr));
  for (const ch of [bus.L, bus.R]) {
    for (let s = 0; s < bus.n; s++) {
      let e = 1;
      if (s < fi) e = s / fi;
      const fromEnd = bus.n - 1 - s;
      if (fromEnd < fo) e *= 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / fo);
      ch[s] = ch[s]! * g * e;
    }
  }
}

// ---- music render -------------------------------------------------------------------

export interface RenderedAudio {
  sampleRate: number;
  /** [left, right]. */
  channels: [Float32Array, Float32Array];
  durationSec: number;
}

/** Synthesize a full music bed from a recipe. Deterministic. */
export function renderMusic(recipe: MusicRecipe, sampleRate = SYNTH_SAMPLE_RATE): RenderedAudio {
  const arr = arrangeMusic(recipe);
  const def = MOOD_DEFS[arr.mood];
  const n = Math.max(1, Math.ceil(arr.durationSec * sampleRate));
  const bus = new Bus(n, sampleRate);
  const rng = makeRng(arr.seed * 131 + 17);
  const beat = arr.beatSec;
  const bar = beat * 4;
  const eighth = (k: number): number => (k % 2 === 1 ? beat * (Math.floor(k / 2) + def.swing) : beat * (k / 2));
  const energyAt = (b: number): number => arr.sections.find((s) => b >= s.startBar && b < s.startBar + s.bars)?.energy ?? 1;
  const sectionAt = (b: number): SectionName => arr.sections.find((s) => b >= s.startBar && b < s.startBar + s.bars)?.name ?? "a";
  const isLastBeforeChange = (b: number): boolean => b + 1 < arr.bars && sectionAt(b + 1) !== sectionAt(b) && sectionAt(b + 1) !== "end";
  const hum = (): number => (rng() - 0.5) * 0.008;
  const vel = (base: number): number => base * (0.88 + rng() * 0.24);

  for (let b = 0; b < arr.bars; b++) {
    const t = b * bar;
    const e = energyAt(b);
    const chord = arr.chords[b]!;
    const end = b === arr.bars - 1;
    const ringOut = Math.max(0.5, arr.durationSec - t);
    const chordStart = b % def.barsPerChord === 0;

    if (end) {
      // ENDING: one tonic statement that rings out to the very end.
      switch (arr.mood) {
        case "lofi":
          for (const m of chord.notes) epiano(bus, t, Math.min(ringOut, 2.4), m, vel(0.17), (m % 5) / 5 - 0.4);
          bass(bus, t, Math.min(ringOut, 1.6), chord.bass, 0.32);
          if (arr.bars > 1) kick(bus, t, 0.5, rng);
          break;
        case "upbeat":
          for (const m of chord.notes) pad(bus, t, Math.min(ringOut, 1.8), m, 0.1, (m % 3) / 3 - 0.3, { attack: 0.01, release: 0.8, cutoff: 3200 });
          for (const m of [chord.notes[0]! + 12, chord.notes[1]! + 12]) pluck(bus, t, m, 0.3, 0.2, rng);
          bass(bus, t, Math.min(ringOut, 1.2), chord.bass, 0.35);
          if (arr.bars > 1) {
            kick(bus, t, 0.8, rng);
            hat(bus, t, 0.1, rng, true);
          }
          break;
        case "cinematic":
          for (const m of chord.notes) pad(bus, t, Math.min(ringOut, 3), m, 0.14, (m % 4) / 4 - 0.4, { attack: 0.05, release: 1.5, cutoff: 1800, vibrato: 0.003 });
          drone(bus, t, ringOut, chord.bass - 12, 0.25);
          if (arr.bars > 1) tom(bus, t, 0.9, 55, rng);
          break;
        case "corporate":
          for (const m of chord.notes) piano(bus, t, Math.min(ringOut, 2), m, vel(0.3), (m % 4) / 4 - 0.4, rng);
          piano(bus, t, Math.min(ringOut, 2), chord.notes[0]! + 12, 0.24, 0.3, rng);
          bass(bus, t, Math.min(ringOut, 1.2), chord.bass, 0.3);
          if (arr.bars > 1) kick(bus, t, 0.55, rng);
          break;
        case "ambient":
          for (const m of chord.notes) pad(bus, t, Math.min(ringOut, 3.5), m, 0.12, (m % 5) / 5 - 0.4, { attack: 0.8, release: 2, cutoff: 1100 });
          bell(bus, t + 0.2, chord.notes[chord.notes.length - 1]! + 12, 0.12, 0.35);
          break;
      }
      continue;
    }

    switch (arr.mood) {
      case "lofi": {
        // Keys: chord on 1 and a syncopated re-hit on the "and" of 2.
        const keysLen = beat * 1.4;
        for (const m of chord.notes) {
          epiano(bus, t + hum(), keysLen, m, vel(0.14), (m % 5) / 5 - 0.4);
          if (e > 0) epiano(bus, t + eighth(3) + hum(), beat * 1.6, m, vel(0.1), (m % 5) / 5 - 0.4);
        }
        if (e > 0) {
          bass(bus, t, beat * 1.2, chord.bass, vel(0.36));
          bass(bus, t + eighth(5), beat * 0.9, chord.bass + (rng() < 0.3 ? 7 : 0), vel(0.3));
          kick(bus, t, vel(0.7), rng);
          kick(bus, t + eighth(5), vel(0.5), rng);
          snare(bus, t + beat, vel(0.3), rng, 0.2);
          snare(bus, t + beat * 3, vel(0.32), rng, 0.2);
          for (let k = 0; k < 8; k++) hat(bus, t + eighth(k) + hum(), vel(k % 2 ? 0.05 : 0.08), rng, false, 0.3);
          if (e >= 2 && rng() < 0.5) epiano(bus, t + eighth(6), beat, chord.notes[chord.notes.length - 1]! + 12, 0.07, 0.5);
          if (isLastBeforeChange(b)) snare(bus, t + eighth(7), 0.18, rng, 0.2);
        }
        break;
      }
      case "upbeat": {
        if (chordStart) for (const m of chord.notes) pad(bus, t, bar, m, e > 0 ? 0.07 : 0.1, (m % 3) / 3 - 0.3, { attack: 0.08, release: 0.3, cutoff: e >= 2 ? 3600 : 2200 });
        if (e > 0) {
          for (let q = 0; q < 4; q++) kick(bus, t + q * beat, vel(0.8), rng);
          clap(bus, t + beat, vel(0.42), rng);
          clap(bus, t + beat * 3, vel(0.42), rng);
          for (let k = 0; k < 8; k++) {
            if (k % 2 === 1) hat(bus, t + eighth(k), vel(0.15), rng, e >= 2 && k % 4 === 3);
            bass(bus, t + eighth(k), beat * 0.42, chord.bass + (k % 2 === 1 && e >= 2 ? 12 : 0), vel(0.3));
          }
          const steps = e >= 2 ? 16 : 8;
          const arp = [...chord.notes, chord.notes[0]! + 12];
          for (let k = 0; k < steps; k++) {
            const m = arp[(k * (e >= 2 ? 3 : 1)) % arp.length]! + 12;
            pluck(bus, t + (k * bar) / steps, m, vel(0.2), k % 2 ? 0.35 : -0.35, rng, 0.992);
          }
          if (isLastBeforeChange(b)) for (let k = 0; k < 4; k++) snare(bus, t + beat * 3 + (k * beat) / 4, 0.12 + k * 0.05, rng, 1);
        } else {
          bass(bus, t, bar * 0.9, chord.bass, 0.2);
          for (let k = 0; k < 4; k++) pluck(bus, t + k * beat, chord.notes[k % chord.notes.length]! + 12, 0.16, 0, rng);
        }
        break;
      }
      case "cinematic": {
        if (chordStart) {
          for (const m of chord.notes) pad(bus, t, bar * def.barsPerChord, m, 0.12, (m % 4) / 4 - 0.4, { attack: e > 0 ? 0.5 : 1.2, release: 1.0, cutoff: e >= 2 ? 2200 : 1300, vibrato: 0.003 });
          pad(bus, t, bar, chord.bass, 0.16, 0, { attack: 0.8, release: 1, cutoff: 500 });
        }
        if (e >= 1) {
          tom(bus, t, vel(0.9), 55, rng);
          tom(bus, t + beat * 2.5, vel(0.6), 70, rng, -0.2);
          if (e >= 2) {
            tom(bus, t + beat * 1.5, vel(0.4), 90, rng, 0.3);
            tom(bus, t + beat * 3, vel(0.5), 62, rng);
            for (let k = 0; k < 8; k++) piano(bus, t + (k * beat) / 2, beat * 0.4, chord.notes[k % chord.notes.length]! + 12, 0.14, 0.35, rng);
          }
          if (isLastBeforeChange(b)) for (let k = 0; k < 6; k++) tom(bus, t + beat * 3 + (k * beat) / 6, 0.25 + k * 0.08, 110 - k * 6, rng);
        } else if (e > 0) {
          tom(bus, t, 0.45, 55, rng);
        }
        break;
      }
      case "corporate": {
        const arp = [chord.notes[0]!, chord.notes[1]!, chord.notes[2]!, chord.notes[1]!];
        for (let k = 0; k < 8; k++) piano(bus, t + eighth(k) + hum(), beat * 0.6, arp[k % 4]! + (k >= 4 && e >= 2 ? 12 : 0), vel(0.26), k % 2 ? 0.25 : -0.25, rng);
        if (chordStart) for (const m of chord.notes) pad(bus, t, bar, m, 0.05, 0, { attack: 0.3, release: 0.5, cutoff: 2600 });
        if (e > 0) {
          bass(bus, t, beat * 0.9, chord.bass, vel(0.3));
          bass(bus, t + beat * 2, beat * 0.9, chord.bass, vel(0.28));
          kick(bus, t, vel(0.6), rng);
          kick(bus, t + beat * 2, vel(0.55), rng);
          clap(bus, t + beat, vel(0.3), rng);
          clap(bus, t + beat * 3, vel(0.3), rng);
          if (e >= 2) for (let k = 0; k < 16; k++) shaker(bus, t + (k * beat) / 4, vel(k % 4 === 2 ? 0.12 : 0.07), rng);
          if (isLastBeforeChange(b)) for (let k = 0; k < 4; k++) snare(bus, t + beat * 3 + (k * beat) / 4, 0.1 + k * 0.04, rng, 1);
        }
        break;
      }
      case "ambient": {
        if (chordStart) {
          for (const m of chord.notes) pad(bus, t, bar * def.barsPerChord + 0.5, m, 0.1, (m % 5) / 5 - 0.4, { attack: 2.2, release: 2.4, cutoff: 1000 + 500 * e });
          drone(bus, t, bar * def.barsPerChord + 1, chord.bass - 12, 0.16);
        }
        const bells = e >= 2 ? 4 : e >= 1 ? 2 : 1;
        for (let k = 0; k < bells; k++) {
          const at = t + (Math.floor(rng() * 8) * beat) / 2;
          const m = chord.notes[Math.floor(rng() * chord.notes.length)]! + 12;
          bell(bus, at, m, vel(0.08), (rng() - 0.5) * 0.8);
        }
        break;
      }
    }
  }

  if (arr.mood === "lofi") crackle(bus, rng, 0.012);
  reverb(bus, def.reverb, arr.mood === "ambient" || arr.mood === "cinematic" ? 0.86 : 0.78);
  const fadeOut = Math.min(1.2, Math.max(0.15, arr.durationSec * 0.15));
  master(bus, -3, 0.012, fadeOut);
  return { sampleRate, channels: [bus.L, bus.R], durationSec: n / sampleRate };
}

// ---- sound effects ----------------------------------------------------------------

export const SFX_KINDS = ["whoosh", "pop", "click", "ding", "riser", "boom"] as const;
export type SfxKind = (typeof SFX_KINDS)[number];

export interface SfxDef {
  label: string;
  /** Rendered length, seconds. */
  durationSec: number;
  /** The moment of impact inside the sound — placed ON the cut / pop-in. */
  hitSec: number;
  /** Default mix volume 0..1. */
  volume: number;
}

export const SFX_DEFS: Record<SfxKind, SfxDef> = {
  whoosh: { label: "Whoosh", durationSec: 0.8, hitSec: 0.42, volume: 0.55 },
  pop: { label: "Pop", durationSec: 0.18, hitSec: 0.01, volume: 0.6 },
  click: { label: "Click", durationSec: 0.08, hitSec: 0.002, volume: 0.5 },
  ding: { label: "Ding", durationSec: 1.6, hitSec: 0.004, volume: 0.45 },
  riser: { label: "Riser", durationSec: 2.2, hitSec: 2.0, volume: 0.5 },
  boom: { label: "Boom", durationSec: 2.0, hitSec: 0.02, volume: 0.7 },
};

export function isSfxKind(v: unknown): v is SfxKind {
  return typeof v === "string" && (SFX_KINDS as readonly string[]).includes(v);
}

/** State-variable band-pass (Chamberlin) — stepped per sample. */
function svf(): (x: number, f: number, q: number, sr: number) => number {
  let low = 0;
  let band = 0;
  return (x, f, q, sr) => {
    const k = 2 * Math.sin((Math.PI * Math.min(f, sr / 6)) / sr);
    low += k * band;
    const high = x - low - q * band;
    band += k * high;
    return band;
  };
}

/** Synthesize one sound effect. Deterministic per (kind, seed). */
export function renderSfx(kind: SfxKind, sampleRate = SYNTH_SAMPLE_RATE, seed = 1): RenderedAudio {
  const def = SFX_DEFS[kind];
  const n = Math.ceil(def.durationSec * sampleRate);
  const bus = new Bus(n, sampleRate);
  const rng = makeRng(seed * 977 + kind.length * 31);
  const sr = sampleRate;
  const D = def.durationSec;
  switch (kind) {
    case "whoosh": {
      // Band-passed noise sweeping up to the hit then down, panning L → R.
      const fl = svf();
      const fr = svf();
      for (let s = 0; s < n; s++) {
        const t = s / sr;
        const x = t / D;
        const hit = def.hitSec / D;
        const env = x < hit ? Math.pow(x / hit, 2.2) : Math.pow(Math.max(0, 1 - (x - hit) / (1 - hit)), 1.6);
        const f = x < hit ? 250 + 2600 * Math.pow(x / hit, 1.5) : 2850 - 2200 * ((x - hit) / (1 - hit));
        const nz = rng() * 2 - 1;
        const pan = clamp(-0.8 + 1.6 * x, -1, 1);
        const [gl, gr] = panGains(pan);
        bus.L[s] = bus.L[s]! + fl(nz, f, 0.9, sr) * env * gl;
        bus.R[s] = bus.R[s]! + fr(nz, f * 1.03, 0.9, sr) * env * gr;
        bus.sL[s] = bus.sL[s]! + bus.L[s]! * 0.3;
        bus.sR[s] = bus.sR[s]! + bus.R[s]! * 0.3;
      }
      reverb(bus, 0.25, 0.7);
      break;
    }
    case "pop": {
      let ph = 0;
      voice(bus, 0, D, 1, 0, 0.1, (t) => {
        ph += (380 + 900 * (1 - Math.exp(-t * 60))) / sr;
        return Math.sin(TAU * ph) * Math.exp(-t * 38) * Math.min(1, t / 0.0015);
      });
      break;
    }
    case "click": {
      let hp = 0;
      let prev = 0;
      voice(bus, 0, D, 1, 0, 0, (t, i) => {
        const nz = rng() * 2 - 1;
        hp = 0.6 * (hp + nz - prev);
        prev = nz;
        const burst = i < 90 ? hp * (1 - i / 90) : 0;
        return burst * 0.8 + Math.sin(TAU * 2100 * t) * Math.exp(-t * 180) * 0.6;
      });
      break;
    }
    case "ding": {
      voice(bus, 0, D, 1, 0, 0.35, (t) => {
        const f = 1318.5;
        const v =
          Math.sin(TAU * f * t) * Math.exp(-t * 2.6) +
          0.5 * Math.sin(TAU * f * 2.76 * t) * Math.exp(-t * 5) +
          0.25 * Math.sin(TAU * f * 5.4 * t) * Math.exp(-t * 9) +
          0.12 * Math.sin(TAU * f * 8.93 * t) * Math.exp(-t * 14);
        return v * Math.min(1, t / 0.002) * (t > D - 0.2 ? Math.max(0, (D - t) / 0.2) : 1);
      });
      reverb(bus, 0.2, 0.75);
      break;
    }
    case "riser": {
      // Up-sweeping detuned tone + filtered noise, crescendo into the hit.
      const fl = svf();
      const ph = [0, 0.3, 0.6];
      for (let s = 0; s < n; s++) {
        const t = s / sr;
        const x = Math.min(1, t / def.hitSec);
        const after = t > def.hitSec ? Math.max(0, 1 - (t - def.hitSec) / (D - def.hitSec)) : 1;
        const env = Math.pow(x, 2.4) * after;
        const f = 180 * Math.pow(2, 2.6 * x);
        let tone = 0;
        for (let k = 0; k < 3; k++) {
          const dt = (f * (1 + (k - 1) * 0.006)) / sr;
          ph[k] = (ph[k]! + dt) % 1;
          tone += blepSaw(ph[k]!, dt) * 0.25;
        }
        const nz = fl(rng() * 2 - 1, 400 + 5000 * x, 0.7, sr);
        const v = (tone * 0.6 + nz * 0.8) * env;
        const [gl, gr] = panGains(Math.sin(TAU * 0.8 * t) * 0.4);
        bus.L[s] = bus.L[s]! + v * gl;
        bus.R[s] = bus.R[s]! + v * gr;
        bus.sL[s] = bus.sL[s]! + v * gl * 0.4;
        bus.sR[s] = bus.sR[s]! + v * gr * 0.4;
      }
      reverb(bus, 0.3, 0.8);
      break;
    }
    case "boom": {
      let ph = 0;
      let lp = 0;
      voice(bus, 0, D, 1, 0, 0.5, (t) => {
        ph += (32 + 60 * Math.exp(-t * 9)) / sr;
        lp += 0.02 * ((rng() * 2 - 1) - lp);
        const body = Math.sin(TAU * ph) * Math.exp(-t * 2.2);
        const thump = lp * 4 * Math.exp(-t * 20);
        return softClip(1.8 * (body + thump)) * Math.min(1, t / 0.003);
      });
      reverb(bus, 0.35, 0.85);
      break;
    }
  }
  master(bus, -3, 0.0005, Math.min(0.12, D * 0.25));
  return { sampleRate, channels: [bus.L, bus.R], durationSec: n / sampleRate };
}

// ---- WAV + analysis ---------------------------------------------------------------------

/** Encode stereo float PCM as a 16-bit little-endian PCM WAV file. */
export function encodeWav(audio: RenderedAudio): Uint8Array {
  const [L, R] = audio.channels;
  const n = L.length;
  const bytes = new Uint8Array(44 + n * 4);
  const dv = new DataView(bytes.buffer);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  str(0, "RIFF");
  dv.setUint32(4, 36 + n * 4, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 2, true); // stereo
  dv.setUint32(24, audio.sampleRate, true);
  dv.setUint32(28, audio.sampleRate * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 16, true);
  str(36, "data");
  dv.setUint32(40, n * 4, true);
  let o = 44;
  for (let s = 0; s < n; s++) {
    dv.setInt16(o, Math.round(clamp(L[s]!, -1, 1) * 32767), true);
    dv.setInt16(o + 2, Math.round(clamp(R[s]!, -1, 1) * 32767), true);
    o += 4;
  }
  return bytes;
}

export interface PcmStats {
  peakDb: number;
  rmsDb: number;
  /** Mean sample value (DC offset), worst channel. */
  dc: number;
  /** Samples at or beyond full scale. */
  clipped: number;
  /** Peak level of the final 10 ms (≈ silence ⇒ a clean ending). */
  tailPeakDb: number;
}

const toDb = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -Infinity);

/** Listen-proxy: numeric health of rendered audio (clipping / DC / level / tail). */
export function analyzePcm(audio: RenderedAudio): PcmStats {
  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  let dc = 0;
  let tail = 0;
  const tailN = Math.max(1, Math.round(audio.sampleRate * 0.01));
  let count = 0;
  for (const ch of audio.channels) {
    let sum = 0;
    for (let s = 0; s < ch.length; s++) {
      const v = ch[s]!;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      sumSq += v * v;
      sum += v;
      if (s >= ch.length - tailN) tail = Math.max(tail, a);
    }
    count += ch.length;
    dc = Math.max(dc, Math.abs(sum / Math.max(1, ch.length)));
  }
  return {
    peakDb: toDb(peak),
    rmsDb: toDb(Math.sqrt(sumSq / Math.max(1, count))),
    dc,
    clipped,
    tailPeakDb: toDb(tail),
  };
}

// ---- recipe codec ---------------------------------------------------------------

export type SynthRecipe =
  | { type: "music"; recipe: MusicRecipe }
  | { type: "sfx"; kind: SfxKind; seed: number };

const SYNTH_PREFIX = "synth:";

export function isSynthSrc(src: string | undefined): boolean {
  return typeof src === "string" && src.startsWith(SYNTH_PREFIX);
}

/** `synth:music?mood=…&bpm=…&dur=…&seed=…` — the stored recipe for a music bed. */
export function musicSrc(r: MusicRecipe): string {
  const bpm = r.bpm ?? MOOD_DEFS[r.mood].bpm;
  return `${SYNTH_PREFIX}music?mood=${r.mood}&bpm=${round3(bpm)}&dur=${round3(r.durationSec)}&seed=${Math.floor(r.seed ?? 1) >>> 0}`;
}

export function sfxSrc(kind: SfxKind, seed = 1): string {
  return `${SYNTH_PREFIX}sfx?kind=${kind}&seed=${Math.floor(seed) >>> 0}`;
}

/** Parse a `synth:` src back into its recipe (null for any other src). */
export function parseSynthSrc(src: string | undefined): SynthRecipe | null {
  if (!isSynthSrc(src)) return null;
  const body = src!.slice(SYNTH_PREFIX.length);
  const q = body.indexOf("?");
  const type = q >= 0 ? body.slice(0, q) : body;
  const params = new Map<string, string>();
  for (const part of (q >= 0 ? body.slice(q + 1) : "").split("&")) {
    const eq = part.indexOf("=");
    if (eq > 0) params.set(decodeURIComponent(part.slice(0, eq)), decodeURIComponent(part.slice(eq + 1)));
  }
  const num = (k: string): number | undefined => {
    const v = Number(params.get(k));
    return Number.isFinite(v) ? v : undefined;
  };
  if (type === "music") {
    const mood = params.get("mood");
    const dur = num("dur");
    if (!isMusicMood(mood) || !dur || dur <= 0) return null;
    return { type: "music", recipe: { mood, durationSec: dur, bpm: num("bpm"), seed: num("seed") ?? 1 } };
  }
  if (type === "sfx") {
    const kind = params.get("kind");
    if (!isSfxKind(kind)) return null;
    return { type: "sfx", kind, seed: num("seed") ?? 1 };
  }
  return null;
}

/** Render any synth recipe to PCM (deterministic). */
export function renderSynthRecipe(r: SynthRecipe, sampleRate = SYNTH_SAMPLE_RATE): RenderedAudio {
  return r.type === "music" ? renderMusic(r.recipe, sampleRate) : renderSfx(r.kind, sampleRate, r.seed);
}

