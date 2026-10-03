/**
 * 3D LUT support — PURE (no I/O, no DOM): parse an Adobe/Resolve `.cube`, sample it
 * (trilinear), apply it to RGBA bytes, serialize one back to `.cube`, fit a CSS-safe
 * SVG-filter APPROXIMATION for the live preview, and a few bundled free looks.
 *
 * Why an approximation for the browser preview: CSS/SVG filters cannot express an
 * arbitrary 3D table, and the preview draws footage with native `<video>`. So the
 * preview fits `out ≈ curve_c( M · in )` (a 3×4 colour matrix + a per-channel 1-D
 * tone curve) to the LUT by least squares and applies that with an SVG filter. The
 * EXPORT applies the exact LUT through ffmpeg `lut3d`, and the node canvas applies it
 * exactly via {@link applyLutToRgba}. `lutApproxError` reports how close the preview
 * is, so the UI can be honest ("approximate").
 *
 * Bundled looks are generated from small colour functions into a 17³ grid, addressed
 * as `bundled:<key>` in `ColorGrade.lut` (no file on disk; the exporter materializes
 * a `.cube` for ffmpeg on demand).
 */

export interface Lut3D {
  title?: string;
  /** Grid size N (N×N×N entries). */
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** N³ × 3 floats, RED varies fastest, then green, then blue (the .cube order). */
  data: Float32Array;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Max grid size accepted (65³ is the practical Resolve/ffmpeg upper bound). */
export const LUT_MAX_SIZE = 65;

/**
 * Parse `.cube` text. Supports TITLE, DOMAIN_MIN/MAX, LUT_3D_SIZE and the data rows;
 * ignores comments (#) and blank lines. 1-D LUTs (LUT_1D_SIZE) are rejected with a
 * clear error. Throws on malformed/truncated tables so a bad import fails loudly.
 */
export function parseCube(text: string): Lut3D {
  let size = 0;
  let title: string | undefined;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const head = line.split(/\s+/)[0]!.toUpperCase();
    if (head === "TITLE") {
      title = line.replace(/^TITLE\s*/i, "").replace(/^"|"$/g, "");
    } else if (head === "LUT_3D_SIZE") {
      size = Number(line.split(/\s+/)[1]);
    } else if (head === "LUT_1D_SIZE") {
      throw new Error("1D .cube LUTs aren't supported — import a 3D LUT (LUT_3D_SIZE).");
    } else if (head === "DOMAIN_MIN" || head === "DOMAIN_MAX") {
      const p = line.split(/\s+/).slice(1).map(Number);
      if (p.length < 3 || p.some((x) => !Number.isFinite(x))) throw new Error(`Bad ${head} line in .cube.`);
      if (head === "DOMAIN_MIN") domainMin = [p[0]!, p[1]!, p[2]!];
      else domainMax = [p[0]!, p[1]!, p[2]!];
    } else if (/^[-+0-9.]/.test(line)) {
      const p = line.split(/\s+/).map(Number);
      if (p.length < 3 || p.slice(0, 3).some((x) => !Number.isFinite(x))) throw new Error("Bad data row in .cube.");
      vals.push(p[0]!, p[1]!, p[2]!);
    }
    // other keywords (LUT_3D_INPUT_RANGE, …) are ignored
  }
  if (!Number.isInteger(size) || size < 2 || size > LUT_MAX_SIZE) {
    throw new Error(size ? `Unsupported LUT_3D_SIZE ${size} (2–${LUT_MAX_SIZE}).` : "Not a 3D .cube (missing LUT_3D_SIZE).");
  }
  const expected = size * size * size * 3;
  if (vals.length !== expected) {
    throw new Error(`The .cube table is ${vals.length < expected ? "truncated" : "too long"}: expected ${expected / 3} rows, got ${vals.length / 3}.`);
  }
  return { title, size, domainMin, domainMax, data: Float32Array.from(vals) };
}

/** Serialize a LUT to `.cube` text (round-trips through {@link parseCube}). */
export function lutToCube(lut: Lut3D): string {
  const out: string[] = [];
  if (lut.title) out.push(`TITLE "${lut.title.replace(/"/g, "'")}"`);
  out.push(`LUT_3D_SIZE ${lut.size}`);
  out.push(`DOMAIN_MIN ${lut.domainMin.join(" ")}`);
  out.push(`DOMAIN_MAX ${lut.domainMax.join(" ")}`);
  const d = lut.data;
  for (let i = 0; i < d.length; i += 3) {
    out.push(`${d[i]!.toFixed(6)} ${d[i + 1]!.toFixed(6)} ${d[i + 2]!.toFixed(6)}`);
  }
  return out.join("\n") + "\n";
}

/** Trilinear sample of the LUT at an input colour (each channel 0..1 of the domain). */
export function sampleLut(lut: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size;
  const last = n - 1;
  const fr = clamp01((r - lut.domainMin[0]) / (lut.domainMax[0] - lut.domainMin[0] || 1)) * last;
  const fg = clamp01((g - lut.domainMin[1]) / (lut.domainMax[1] - lut.domainMin[1] || 1)) * last;
  const fb = clamp01((b - lut.domainMin[2]) / (lut.domainMax[2] - lut.domainMin[2] || 1)) * last;
  const r0 = Math.min(last - 1, Math.floor(fr));
  const g0 = Math.min(last - 1, Math.floor(fg));
  const b0 = Math.min(last - 1, Math.floor(fb));
  const tr = fr - r0;
  const tg = fg - g0;
  const tb = fb - b0;
  const d = lut.data;
  const at = (ri: number, gi: number, bi: number, c: number): number => d[(ri + gi * n + bi * n * n) * 3 + c]!;
  const res: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(r0, g0, b0, c) * (1 - tr) + at(r0 + 1, g0, b0, c) * tr;
    const c10 = at(r0, g0 + 1, b0, c) * (1 - tr) + at(r0 + 1, g0 + 1, b0, c) * tr;
    const c01 = at(r0, g0, b0 + 1, c) * (1 - tr) + at(r0 + 1, g0, b0 + 1, c) * tr;
    const c11 = at(r0, g0 + 1, b0 + 1, c) * (1 - tr) + at(r0 + 1, g0 + 1, b0 + 1, c) * tr;
    const c0 = c00 * (1 - tg) + c10 * tg;
    const c1 = c01 * (1 - tg) + c11 * tg;
    res[c] = c0 * (1 - tb) + c1 * tb;
  }
  return res;
}

/**
 * Apply the LUT to RGBA bytes IN PLACE (alpha untouched). `strength` 0..1 blends
 * between the original and the graded colour. Used by the node canvas (exact) and
 * available to any browser canvas path.
 */
export function applyLutToRgba(px: Uint8ClampedArray | Uint8Array, lut: Lut3D, strength = 1): void {
  const s = clamp01(strength);
  if (s === 0) return;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]! / 255;
    const g = px[i + 1]! / 255;
    const b = px[i + 2]! / 255;
    const o = sampleLut(lut, r, g, b);
    px[i] = Math.round(255 * clamp01(r + (o[0] - r) * s));
    px[i + 1] = Math.round(255 * clamp01(g + (o[1] - g) * s));
    px[i + 2] = Math.round(255 * clamp01(b + (o[2] - b) * s));
  }
}

// ---- CSS-safe preview approximation -----------------------------------------

export interface LutApprox {
  /** 3 rows × [r, g, b, bias] (feColorMatrix rows, 0..1 units). */
  matrix: number[];
  /** Per-channel tone-curve tables (feComponentTransfer `table`), 33 entries each. */
  tables: [number[], number[], number[]];
  /** Mean absolute error (0..1) of the fit over a 9³ probe grid. */
  meanError: number;
}

const TABLE_BINS = 33;

/** Solve the 4×4 normal equations A·x = b (Gauss–Jordan with pivoting). */
function solve4(A: number[][], b: number[]): number[] {
  const n = 4;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const d = M[col]![col]! || 1e-9;
    for (let c = col; c <= n; c++) M[col]![c] = M[col]![c]! / d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      for (let c = col; c <= n; c++) M[r]![c] = M[r]![c]! - f * M[col]![c]!;
    }
  }
  return M.map((row) => row[n]!);
}

/**
 * Fit `curve_c( M·in )` to the LUT for the SVG-filter preview: least-squares affine
 * colour matrix, then a per-channel tone curve binned over the matrix output.
 */
export function lutApprox(lut: Lut3D): LutApprox {
  const G = 9;
  const samples: { x: [number, number, number, number]; y: [number, number, number] }[] = [];
  for (let bi = 0; bi < G; bi++)
    for (let gi = 0; gi < G; gi++)
      for (let ri = 0; ri < G; ri++) {
        const r = ri / (G - 1);
        const g = gi / (G - 1);
        const b = bi / (G - 1);
        samples.push({ x: [r, g, b, 1], y: sampleLut(lut, r, g, b) });
      }
  const AtA: number[][] = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  for (const s of samples) for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) AtA[i]![j]! += s.x[i]! * s.x[j]!;
  const matrix: number[] = [];
  const coefs: number[][] = [];
  for (let c = 0; c < 3; c++) {
    const Atb = [0, 0, 0, 0];
    for (const s of samples) for (let i = 0; i < 4; i++) Atb[i]! += s.x[i]! * s.y[c]!;
    const w = solve4(AtA.map((r) => [...r]), Atb);
    coefs.push(w);
    matrix.push(...w);
  }
  // Per-channel tone curve over the (clamped) matrix output.
  const tables: [number[], number[], number[]] = [[], [], []];
  for (let c = 0; c < 3; c++) {
    const sum = new Array<number>(TABLE_BINS).fill(0);
    const cnt = new Array<number>(TABLE_BINS).fill(0);
    for (const s of samples) {
      const w = coefs[c]!;
      const v = clamp01(w[0]! * s.x[0] + w[1]! * s.x[1] + w[2]! * s.x[2] + w[3]!);
      const bin = Math.round(v * (TABLE_BINS - 1));
      sum[bin]! += s.y[c]!;
      cnt[bin]! += 1;
    }
    const t: number[] = [];
    for (let k = 0; k < TABLE_BINS; k++) t.push(cnt[k]! > 0 ? sum[k]! / cnt[k]! : NaN);
    // Fill empty bins by linear interpolation between known neighbours (identity at the ends).
    for (let k = 0; k < TABLE_BINS; k++) {
      if (!Number.isNaN(t[k]!)) continue;
      let lo = k - 1;
      while (lo >= 0 && Number.isNaN(t[lo]!)) lo--;
      let hi = k + 1;
      while (hi < TABLE_BINS && Number.isNaN(t[hi]!)) hi++;
      const a = lo >= 0 ? t[lo]! : k / (TABLE_BINS - 1);
      const b = hi < TABLE_BINS ? t[hi]! : k / (TABLE_BINS - 1);
      const la = lo >= 0 ? lo : k;
      const hb = hi < TABLE_BINS ? hi : k;
      t[k] = la === hb ? a : a + ((b - a) * (k - la)) / (hb - la);
    }
    tables[c] = t.map((v) => Math.round(clamp01(v) * 10000) / 10000);
  }
  const approx: LutApprox = { matrix: matrix.map((v) => Math.round(v * 10000) / 10000), tables, meanError: 0 };
  approx.meanError = lutApproxError(lut, approx);
  return approx;
}

/** What the SVG filter computes for one input colour (the preview model). */
export function evalLutApprox(a: LutApprox, r: number, g: number, b: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v = clamp01(a.matrix[c * 4]! * r + a.matrix[c * 4 + 1]! * g + a.matrix[c * 4 + 2]! * b + a.matrix[c * 4 + 3]!);
    const f = v * (TABLE_BINS - 1);
    const i0 = Math.min(TABLE_BINS - 2, Math.floor(f));
    const t = f - i0;
    out[c] = a.tables[c]![i0]! * (1 - t) + a.tables[c]![i0 + 1]! * t;
  }
  return out;
}

/** Mean absolute error of the approximation vs the real LUT over a 9³ probe grid. */
export function lutApproxError(lut: Lut3D, a: LutApprox): number {
  let sum = 0;
  let n = 0;
  const G = 9;
  for (let bi = 0; bi < G; bi++)
    for (let gi = 0; gi < G; gi++)
      for (let ri = 0; ri < G; ri++) {
        const r = (ri + 0.5) / G;
        const g = (gi + 0.5) / G;
        const b = (bi + 0.5) / G;
        const want = sampleLut(lut, r, g, b);
        const got = evalLutApprox(a, r, g, b);
        sum += Math.abs(want[0] - got[0]) + Math.abs(want[1] - got[1]) + Math.abs(want[2] - got[2]);
        n += 3;
      }
  return sum / n;
}

/** The inner markup of an SVG `<filter>` implementing the approximation. */
export function lutSvgFilter(id: string, a: LutApprox): string {
  const m = a.matrix;
  const row = (i: number): string => `${m[i * 4]} ${m[i * 4 + 1]} ${m[i * 4 + 2]} 0 ${m[i * 4 + 3]}`;
  const tv = (c: number): string => a.tables[c]!.join(" ");
  return (
    `<filter id="${id}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">` +
    `<feColorMatrix type="matrix" values="${row(0)} ${row(1)} ${row(2)} 0 0 0 1 0"/>` +
    `<feComponentTransfer><feFuncR type="table" tableValues="${tv(0)}"/><feFuncG type="table" tableValues="${tv(1)}"/><feFuncB type="table" tableValues="${tv(2)}"/></feComponentTransfer>` +
    `</filter>`
  );
}

// ---- bundled free looks -------------------------------------------------------

export interface BundledLutSpec {
  key: string;
  label: string;
  hint: string;
  /** Input colour 0..1 → graded colour 0..1. */
  fn: (r: number, g: number, b: number) => [number, number, number];
}

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** Smooth S-curve contrast around 0.5 (k ≥ 0). */
const sCurve = (x: number, k: number): number => {
  const y = clamp01(x);
  const s = y * y * (3 - 2 * y);
  return y + (s - y) * k;
};
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

export const BUNDLED_LUTS: readonly BundledLutSpec[] = [
  {
    key: "teal-orange",
    label: "Teal & orange",
    hint: "Blockbuster split-tone: teal shadows, warm highlights",
    fn: (r, g, b) => {
      const l = luma(r, g, b);
      const sh = 1 - clamp01(l * 1.6); // shadows weight
      const hi = clamp01((l - 0.45) * 1.8); // highlights weight
      return [
        sCurve(r + hi * 0.1 - sh * 0.1, 0.5),
        sCurve(g + hi * 0.03 + sh * 0.04, 0.5),
        sCurve(b - hi * 0.12 + sh * 0.14, 0.5),
      ];
    },
  },
  {
    key: "kodak-warm",
    label: "Warm film",
    hint: "Golden warmth with lifted blacks, like a warm stock",
    fn: (r, g, b) => [
      mix(0.03, 1, sCurve(r * 1.07, 0.35)),
      mix(0.02, 1, sCurve(g * 1.01, 0.35)),
      mix(0.015, 0.95, sCurve(b * 0.9, 0.35)),
    ],
  },
  {
    key: "fuji-cool",
    label: "Cool film",
    hint: "Crisp cool tones with a green-leaning shadow",
    fn: (r, g, b) => {
      const l = luma(r, g, b);
      const sh = 1 - clamp01(l * 2);
      return [sCurve(r * 0.94, 0.3), sCurve(g * 1.0 + sh * 0.03, 0.3), sCurve(b * 1.08 + sh * 0.02, 0.3)];
    },
  },
  {
    key: "bleach",
    label: "Bleach bypass",
    hint: "Desaturated, punchy and gritty",
    fn: (r, g, b) => {
      const l = luma(r, g, b);
      const k = 0.5;
      return [sCurve(mix(l, r, k), 0.8), sCurve(mix(l, g, k), 0.8), sCurve(mix(l, b, k), 0.8)];
    },
  },
  {
    key: "noir",
    label: "Noir mono",
    hint: "High-contrast black & white",
    fn: (r, g, b) => {
      const v = sCurve(luma(r, g, b), 0.9);
      return [v, v, v];
    },
  },
  {
    key: "film-fade",
    label: "Faded film",
    hint: "Matte, lifted blacks and soft whites — a faded print",
    fn: (r, g, b) => {
      const l = luma(r, g, b);
      const f = (v: number): number => mix(0.07, 0.94, mix(l, v, 0.85));
      return [f(r), f(g), f(b)];
    },
  },
];

/** Grid size of every bundled LUT. */
export const BUNDLED_LUT_SIZE = 17;
export const BUNDLED_LUT_PREFIX = "bundled:";

export function isBundledLut(id: string | undefined | null): id is string {
  return !!id && id.startsWith(BUNDLED_LUT_PREFIX);
}

export function findBundledLut(id: string): BundledLutSpec | undefined {
  const key = id.startsWith(BUNDLED_LUT_PREFIX) ? id.slice(BUNDLED_LUT_PREFIX.length) : id;
  return BUNDLED_LUTS.find((l) => l.key === key);
}

const bundledCache = new Map<string, Lut3D>();

/** Build (and cache) a bundled LUT as a 17³ grid; null for an unknown id. */
export function bundledLut(id: string): Lut3D | null {
  const spec = findBundledLut(id);
  if (!spec) return null;
  const hit = bundledCache.get(spec.key);
  if (hit) return hit;
  const n = BUNDLED_LUT_SIZE;
  const data = new Float32Array(n * n * n * 3);
  for (let bi = 0; bi < n; bi++)
    for (let gi = 0; gi < n; gi++)
      for (let ri = 0; ri < n; ri++) {
        const o = spec.fn(ri / (n - 1), gi / (n - 1), bi / (n - 1));
        const i = (ri + gi * n + bi * n * n) * 3;
        data[i] = clamp01(o[0]);
        data[i + 1] = clamp01(o[1]);
        data[i + 2] = clamp01(o[2]);
      }
  const lut: Lut3D = { title: spec.label, size: n, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data };
  bundledCache.set(spec.key, lut);
  return lut;
}
