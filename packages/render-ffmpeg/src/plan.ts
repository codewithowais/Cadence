/**
 * PURE EditDoc → ffmpeg args. No I/O, no spawning, no probing — deterministic so
 * it is fully testable without ffmpeg installed (the verify gate asserts on the
 * args this produces).
 *
 * EDITS-AS-CODE: the EditDoc is the source of truth; this translates it faithfully
 * into an ffmpeg filtergraph. FAITHFULNESS: every filter used here is
 * identity-preserving (trim/concat/scale/crop/eq/colorbalance/drawtext/zoompan/
 * xfade/fade/unsharp/hqdn3d) — real detail work only, NEVER a generative redraw of
 * faces or content.
 *
 * Filter names/syntax follow ffmpeg's documented filtergraph API
 * (ffmpeg.org/ffmpeg-filters.html) — trim, setpts, scale, crop, eq, colorbalance,
 * drawtext, zoompan, xfade, fade, unsharp, hqdn3d, concat, amix, adelay — all
 * long-stable, standard filters.
 */
import {
  calloutScreenRect,
  cursorPositionAt,
  docDurationSec,
  sourceSpanSec,
  speedRampIntegral,
  type AdjustmentClip,
  type BlendMode,
  type CalloutClip,
  type ChromaKey,
  type Clip,
  type ColorGrade,
  type Curves,
  type CursorClip,
  type EditDoc,
  type ImageClip,
  type Keyframe,
  type KeyframeEasing,
  type KeyframeProp,
  type Mask,
  type RegionFx,
  type SolidClip,
  type TextClip,
  type TransitionType,
  type VideoClip,
  type Vfx,
} from "@cadence/core";

/** What a built plan carries. `args` is the ffmpeg argv (no shell needed). */
export interface ExportPlan {
  /** Full ffmpeg argument vector (spawn-ready; no shell quoting required). */
  args: string[];
  /** Resolved input paths, in ffmpeg input order (for inspection/tests). */
  inputs: string[];
  /** The `-filter_complex` graph string (for inspection/tests). */
  filterComplex: string;
  /** Output file path. */
  outFile: string;
}

/** Resolves a media id to a concrete file path (server path / URL). */
export type ResolveMediaPath = (mediaId: string) => string;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * Escape an ffmpeg EXPRESSION for use inside a single-quoted filter option value:
 * every comma becomes `\,` EXACTLY ONCE. Inside single quotes ffmpeg treats `\,`
 * as a literal comma (the expression evaluator's argument separator), so a comma
 * MUST be built plain and escaped a single time here — never pre-escaped in the
 * fragments AND re-escaped, which yields `\\,` and makes ffmpeg's eval reject the
 * whole graph ("Missing ')' or too many args" → "Error parsing global options:
 * Invalid argument", export fails at runtime). Build the expression with PLAIN
 * commas, then call this once at the point it is embedded.
 */
function escExpr(expr: string): string {
  return expr.replace(/,/g, "\\,");
}

/** CRF (quality) per preset — lower = higher quality/bitrate. */
const CRF: Record<string, number> = { standard: 23, high: 20, ultra: 18 };

// --- color helpers ----------------------------------------------------------

/** #RRGGBB / #RRGGBBAA → { color: "0xRRGGBB", alpha: 0..1 } for ffmpeg. */
export function hexToFfColor(hex: string): { color: string; alpha: number } {
  const h = hex.replace(/^#/, "");
  const rgb = h.slice(0, 6);
  const aa = h.length >= 8 ? h.slice(6, 8) : "";
  const alpha = aa ? Math.round((parseInt(aa, 16) / 255) * 1000) / 1000 : 1;
  return { color: `0x${rgb}`, alpha };
}

/** eq filter from a ColorGrade (brightness/contrast/saturation), or null if neutral. */
export function eqFromLook(look: ColorGrade): string | null {
  // eq.brightness is ADDITIVE (-1..1, 0 = neutral); our brightness is a multiplier.
  const bright = clamp(r3(look.brightness - 1), -1, 1);
  const contrast = r3(look.contrast);
  const sat = r3(look.saturation);
  const parts: string[] = [];
  if (bright !== 0) parts.push(`brightness=${bright}`);
  if (contrast !== 1) parts.push(`contrast=${contrast}`);
  if (sat !== 1) parts.push(`saturation=${sat}`);
  return parts.length ? `eq=${parts.join(":")}` : null;
}

/**
 * Warm "overlay" as a faithful colorbalance push toward red / away from blue in
 * mids + highlights — the ffmpeg equivalent of the canvas soft-light warm overlay.
 * Tints color only; never touches identity/content. Null when warmth is 0.
 */
export function warmColorbalance(warmth: number): string | null {
  if (warmth <= 0) return null;
  const w = clamp(warmth, 0, 1);
  const rm = r3(w * 0.3);
  const bm = r3(-w * 0.3);
  const rh = r3(w * 0.2);
  const bh = r3(-w * 0.2);
  return `colorbalance=rm=${rm}:bm=${bm}:rh=${rh}:bh=${bh}`;
}

/**
 * Format tone-curve control points as the ffmpeg `curves` points string
 * "x0/y0 x1/y1 …" (verified against ffmpeg-filters.html `curves`). Space-separated,
 * slash-joined — no commas, so it is graph-safe inside a single-quoted value.
 */
function curvePointsStr(points: [number, number][]): string {
  return points.map(([x, y]) => `${r3(x)}/${r3(y)}`).join(" ");
}

/**
 * The ffmpeg `curves` filter for a set of RGB tone curves (master + per-channel),
 * or null when empty. curves=master/red/green/blue='pts' — every option name
 * verified against ffmpeg-filters.html. Faithful: a tonal remap only.
 */
export function curvesFilter(c: Curves): string | null {
  const parts: string[] = [];
  if (c.master && c.master.length) parts.push(`master='${curvePointsStr(c.master)}'`);
  if (c.r && c.r.length) parts.push(`red='${curvePointsStr(c.r)}'`);
  if (c.g && c.g.length) parts.push(`green='${curvePointsStr(c.g)}'`);
  if (c.b && c.b.length) parts.push(`blue='${curvePointsStr(c.b)}'`);
  return parts.length ? `curves=${parts.join(":")}` : null;
}

/**
 * Escape a LOCAL file path for use as a filtergraph option value (e.g.
 * `lut3d=file=<path>`). We pass argv directly (no shell), so only filtergraph
 * escaping applies: backslash first, then the option/graph metacharacters that
 * would otherwise end the value (' : , ; [ ]). A plain path is unchanged.
 */
export function escapeFilterPath(p: string): string {
  return p
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

/**
 * The per-clip look chain (eq + warm + hue + curves + optional LUT), as filter
 * segments. The LUT (.cube) is applied LAST — a creative film-emulation look on top
 * of the technical correction — via ffmpeg `lut3d=file=<path>` (verified against
 * ffmpeg-filters.html). The LUT asset id/path is resolved through `resolveLut` (the
 * SAME resolver as media, so it reuses the media whitelist) and escaped for the
 * graph; lut3d reads a LOCAL file only (no arbitrary protocols). When `resolveLut`
 * is absent, or `look.lut` is unset, NO lut3d is emitted — so existing plans are
 * byte-identical. Canvas can't parse a .cube (documented export-only limit).
 */
function lookFilters(look: ColorGrade, resolveLut?: ResolveMediaPath): string[] {
  const out: string[] = [];
  const eq = eqFromLook(look);
  if (eq) out.push(eq);
  const warm = warmColorbalance(look.warmth);
  if (warm) out.push(warm);
  // Hue rotation (degrees) → ffmpeg `hue=h=` (verified against ffmpeg-filters.html).
  if (look.hueShift && look.hueShift !== 0) out.push(`hue=h=${r3(look.hueShift)}`);
  // RGB tone curves → ffmpeg `curves` (exact; canvas can't preview curves).
  if (look.curves) {
    const cf = curvesFilter(look.curves);
    if (cf) out.push(cf);
  }
  // LUT (.cube) → ffmpeg `lut3d`, applied last (creative look on top of correction).
  if (look.lut && resolveLut) {
    out.push(`lut3d=file=${escapeFilterPath(resolveLut(look.lut))}`);
  }
  return out;
}

// --- chroma key / blend / mask / region (compositing) -----------------------

/**
 * Chroma-key filter segments for a keyed clip: `chromakey=color:similarity:blend`
 * (makes the key color transparent) plus an optional `despill=type=…:mix=spill`
 * spill-suppression pass. Every option verified against ffmpeg-filters.html
 * (chromakey: color/similarity/blend; despill: type/mix). The keyed stream carries
 * alpha, so overlaying it composites over the layer beneath. Faithful: removes a
 * background color only.
 */
export function chromaFilters(chroma: ChromaKey): string[] {
  const { color } = hexToFfColor(chroma.color);
  const out = [
    `chromakey=color=${color}:similarity=${r3(clamp(chroma.similarity, 0.01, 1))}:blend=${r3(clamp(chroma.blend, 0, 1))}`,
  ];
  if (chroma.spill > 0) {
    // despill type must match the key color family (green/blue screen).
    const h = chroma.color.replace(/^#/, "");
    const b = parseInt(h.slice(4, 6) || "0", 16);
    const g = parseInt(h.slice(2, 4) || "0", 16);
    const type = b > g ? "blue" : "green";
    out.push(`despill=type=${type}:mix=${r3(clamp(chroma.spill, 0, 1))}`);
  }
  return out;
}

/**
 * Map a BlendMode to the ffmpeg `blend` filter's `all_mode` name — every name
 * verified against ffmpeg-filters.html (screen/multiply/overlay/addition/softlight).
 * "normal" has no blend equivalent (a plain overlay is used instead).
 */
export function ffBlendMode(mode: BlendMode): string {
  switch (mode) {
    case "screen":
      return "screen";
    case "multiply":
      return "multiply";
    case "overlay":
      return "overlay";
    case "soft-light":
      return "softlight";
    case "add":
      return "addition";
    case "normal":
    default:
      return "normal";
  }
}

/**
 * A `geq` alpha expression (0..255) for a mask shape over a FULL-frame clip. The
 * shape is a rect or ellipse in composition px; `feather` softens the edge; `invert`
 * reveals the outside. When `withChroma`, the mask MULTIPLIES the existing alpha
 * (alpha(X,Y), from a prior chromakey) so the two combine. All commas are escaped
 * for the filtergraph. (Ellipse/feather via geq is the documented approach; the canvas
 * previews the same shape with a clip path + feather.)
 */
function maskAlphaExpr(mask: Mask, withChroma: boolean): string {
  const x = r3(mask.x);
  const y = r3(mask.y);
  const w = r3(Math.max(1, mask.w));
  const h = r3(Math.max(1, mask.h));
  const f = Math.max(0, mask.feather);
  // Build the WHOLE expression with PLAIN commas and escape it ONCE at the end
  // (escExpr). The previous version escaped each fragment as it was built, so the
  // commas already written as `\,` inside `d`/`dist` were escaped a second time
  // into `\\,` — which ffmpeg's expression evaluator rejects, breaking export for
  // any doc with a shape mask (green-screen / shaped reveal).
  let frac: string;
  if (mask.shape === "ellipse") {
    const cx = r3(mask.x + mask.w / 2);
    const cy = r3(mask.y + mask.h / 2);
    const rx = r3(Math.max(1, mask.w / 2));
    const ry = r3(Math.max(1, mask.h / 2));
    // Normalized radial distance d (=1 at the edge); inside when d<=1.
    const d = `sqrt(pow((X-${cx})/${rx},2)+pow((Y-${cy})/${ry},2))`;
    if (f > 0) {
      // Feather band as a fraction of the radius: ramp 1→0 across [1-fb, 1].
      const fb = r3(Math.min(0.9, f / Math.max(1, mask.w / 2)));
      frac = `clip((1-${d})/${r3(fb)},0,1)`;
    } else {
      frac = `if(lte(${d},1),1,0)`;
    }
  } else {
    // Rect: distance to the nearest edge (px); inside when all four are >= 0.
    const dist = `min(min(X-${x},${x}+${w}-X),min(Y-${y},${y}+${h}-Y))`;
    if (f > 0) {
      frac = `clip(${dist}/${r3(f)},0,1)`;
    } else {
      frac = `if(gte(${dist},0),1,0)`;
    }
  }
  if (mask.invert) frac = `(1-(${frac}))`;
  // Read the incoming alpha via geq's `alpha(x,y)` accessor (NOT `a(x,y)` — `a` is
  // only the OUTPUT plane name, so `a(X,Y)` is an unknown function and breaks the
  // graph). Multiplying by the shape fraction combines the chroma key with the mask.
  return escExpr(withChroma ? `alpha(X,Y)*(${frac})` : `255*(${frac})`);
}

/** The `geq` filter that applies a shape mask's alpha, preserving RGB. */
function maskGeqFilter(mask: Mask, withChroma: boolean): string {
  return `geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='${maskAlphaExpr(mask, withChroma)}'`;
}

/**
 * Graph entries that blur/pixelate a rectangular REGION of a clip: split the
 * stream, crop the region, run `boxblur` (blur) or `pixelize` (pixelate/mosaic) on
 * it, then overlay it back at the same position. Filter names verified against
 * ffmpeg-filters.html (split/crop/boxblur/pixelize/overlay). `inLabel`→`outLabel`.
 * Faithful: obscures a region only.
 */
function regionFxGraph(rf: RegionFx, inLabel: string, outLabel: string): string[] {
  const x = Math.round(rf.x);
  const y = Math.round(rf.y);
  const w = Math.max(2, Math.round(rf.w));
  const h = Math.max(2, Math.round(rf.h));
  const amt = clamp(rf.amount, 0, 1);
  const reg =
    rf.type === "blur"
      ? `boxblur=${Math.max(2, Math.round(2 + amt * 30))}:1`
      : `pixelize=w=${Math.max(2, Math.round(4 + amt * 60))}:h=${Math.max(2, Math.round(4 + amt * 60))}`;
  return [
    `[${inLabel}]split[${inLabel}m][${inLabel}r]`,
    `[${inLabel}r]crop=${w}:${h}:${x}:${y},${reg}[${inLabel}b]`,
    `[${inLabel}m][${inLabel}b]overlay=${x}:${y}[${outLabel}]`,
  ];
}

// --- speed ramp (setpts / atempo) -------------------------------------------

/**
 * Video setpts for a speed-retimed clip. Standard ffmpeg speed control:
 * `setpts=PTS/speed` (speed>1 shrinks PTS → faster; <1 stretches → slow-mo),
 * combined with the per-clip PTS reset. Confirmed against ffmpeg's setpts docs
 * (ffmpeg.org/ffmpeg-filters.html #setpts). We read `duration*speed` seconds of
 * SOURCE (see sourceSpanSec) so the output occupies the clip's timeline duration.
 */
function speedSetpts(speed: number): string {
  return speed === 1 ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${r3(speed)}`;
}

/**
 * How many pieces a speed-RAMP clip is segmented into on export. Each segment
 * reads its own source window and applies a constant `setpts`/`atempo` at that
 * segment's AVERAGE rate — a piecewise-constant approximation of the continuous
 * ramp (the same segmenting strategy the docs describe for time-varying values).
 * More segments ⇒ closer to the curve; 8 is a good, cheap default.
 */
const RAMP_SEGMENTS = 8;

/**
 * atempo chain matching a speed factor. ffmpeg's atempo accepts [0.5, 100.0]; a
 * factor outside a single step is achieved by daisy-chaining (per the atempo
 * docs). We keep every step within [0.5, 2.0] — the conservative, universally
 * supported window — so e.g. 0.25 → atempo=0.5,atempo=0.5 and 4 →
 * atempo=2.0,atempo=2.0. Faithful: retimes audio, no pitch-correction redraw.
 */
export function atempoChain(speed: number): string[] {
  if (speed === 1) return [];
  const steps: number[] = [];
  let remaining = speed;
  // Bring the factor down into [0.5, 2] by repeatedly pulling out a 2.0 step.
  while (remaining > 2.0 + 1e-9) {
    steps.push(2.0);
    remaining /= 2.0;
  }
  // …or up into range by pulling out 0.5 steps.
  while (remaining < 0.5 - 1e-9) {
    steps.push(0.5);
    remaining /= 0.5;
  }
  steps.push(r3(remaining));
  return steps.map((s) => `atempo=${r3(s)}`);
}

// --- static zoom / crop (manual reframe) ------------------------------------

/**
 * A static punch-in / reframe from a visual clip's transform: scale the covered
 * WxH frame up by `transform.scale` and crop back to WxH, offset by the pan
 * (transform.x/y away from center). Distinct from the animated emphasis pulse —
 * this is a fixed zoom. Null when there is nothing to do (scale≈1, no pan).
 * Faithful: scale=lanczos + crop only. Mirrors the canvas transform.scale.
 */
function staticZoomFilters(
  clip: VideoClip | ImageClip,
  W: number,
  H: number,
): string[] {
  const s = clip.transform.scale;
  const panX = Math.round(clip.transform.x - W / 2);
  const panY = Math.round(clip.transform.y - H / 2);
  if (s <= 1.0001 && panX === 0 && panY === 0) return [];
  const scale = Math.max(1, s);
  const sw = Math.max(W, Math.round((W * scale) / 2) * 2);
  const sh = Math.max(H, Math.round((H * scale) / 2) * 2);
  // Centered crop, shifted by the pan; clamp so the window stays inside the frame.
  const cx = clamp(Math.round((sw - W) / 2 - panX), 0, sw - W);
  const cy = clamp(Math.round((sh - H) / 2 - panY), 0, sh - H);
  return [`scale=${sw}:${sh}:flags=lanczos`, `crop=${W}:${H}:${cx}:${cy}`];
}

// --- transition library (xfade names) ---------------------------------------

/**
 * Map an EditDoc transitionType to the ffmpeg xfade `transition` name. The
 * original 7 values keep their historical aliases; every NEW value in the expanded
 * transition library IS a literal ffmpeg xfade name, so it maps to itself. Every
 * name is a documented ffmpeg xfade transition (vf_xfade.c): fade, fadeblack,
 * fadewhite, fadegrays, dissolve, pixelize, distance, radial, hblur, wipe{left,
 * right,up,down,tl,tr,bl,br}, slide/smooth/cover/reveal {left,right,up,down},
 * circle{open,close,crop}, {horz,vert}{open,close}, diag{tl,tr,bl,br},
 * {hl,hr,vu,vd}slice, squeeze{h,v}, zoomin, fade{fast,slow}. Faithful: xfade
 * blends existing frames. Backward-compatible: the legacy aliases are preserved.
 */
export function xfadeTransition(type: TransitionType): string {
  switch (type) {
    // --- legacy aliases (preserved byte-for-byte) ---
    case "crossfade":
      return "fade";
    case "dip-to-black":
      return "fadeblack";
    case "slide":
      return "slideleft";
    case "wipe":
      return "wipeleft";
    case "dissolve":
      return "dissolve";
    case "zoom":
      return "zoomin";
    case "smooth":
      return "smoothleft";
    // --- new values ARE xfade names → map to themselves ---
    default:
      return type;
  }
}

// --- drawtext ---------------------------------------------------------------

/**
 * Escape a caption/title string for a drawtext `text=` value inside a
 * filter_complex graph. We pass argv directly (no shell), so only filtergraph +
 * drawtext escaping applies: backslash, colon, quote, percent, and the graph
 * metacharacters , ; [ ] =. Newlines collapse to spaces.
 */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/=/g, "\\=")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/[\r\n]+/g, " ");
}

/**
 * One drawtext filter drawing `text` for a clip's styling, gated to
 * [gateStart, gateEnd]. Factored out so the typewriter can emit one slice per
 * character-count (each a prefix of the full text) reusing the same styling.
 */
function oneDrawtext(clip: TextClip, text: string, gateStart: number, gateEnd: number): string {
  const { color, alpha } = hexToFfColor(clip.color);
  const tx = Math.round(clip.transform.x);
  const ty = Math.round(clip.transform.y);
  const start = r3(clip.start);
  // transform.x/y is the clip anchor; canvas uses center anchor + middle baseline.
  let x =
    clip.align === "center"
      ? `${tx}-text_w/2`
      : clip.align === "right"
        ? `${tx}-text_w`
        : `${tx}`;
  let y = `${ty}-text_h/2`;

  // Kinetic intro: slide from (fromX, fromY) toward the resting position over
  // `durationSec`, eased (1-(1-p)^3) — mirrors core's textKinetic. Commas inside
  // expression fn-calls are escaped for the filtergraph. (Export honors the slide;
  // the scale-in is a preview/canvas nicety.) Typewriter never slides.
  const a = clip.anim;
  if (a.style === "kinetic" && a.durationSec > 0 && (a.fromX !== 0 || a.fromY !== 0)) {
    const p = `clip((t-${start})/${r3(a.durationSec)}\\,0\\,1)`;
    const e = `(1-pow(1-${p}\\,3))`;
    if (a.fromX !== 0) x = `(${x})+(${r3(a.fromX)})*(1-${e})`;
    if (a.fromY !== 0) y = `(${y})+(${r3(a.fromY)})*(1-${e})`;
  }

  const parts = [
    `text='${escapeDrawtext(text)}'`,
    `x=${x}`,
    `y=${y}`,
    `fontsize=${Math.round(clip.fontSize)}`,
    `fontcolor=${color}${alpha < 1 ? `@${alpha}` : ""}`,
  ];
  // Stroked outline (drawtext border) behind the glyphs, for readability.
  if (clip.outline && clip.outline.width > 0) {
    const oc = hexToFfColor(clip.outline.color);
    parts.push(`borderw=${Math.max(1, Math.round(clip.outline.width))}`);
    parts.push(`bordercolor=${oc.color}${oc.alpha < 1 ? `@${oc.alpha}` : ""}`);
  }
  // Pill background behind captions.
  if (clip.background) {
    const bg = hexToFfColor(clip.background);
    parts.push("box=1");
    parts.push(`boxcolor=${bg.color}${bg.alpha < 1 ? `@${bg.alpha}` : ""}`);
    parts.push(`boxborderw=${Math.max(6, Math.round(clip.fontSize * 0.3))}`);
  }
  parts.push(`enable='between(t\\,${r3(gateStart)}\\,${r3(gateEnd)})'`);
  return `drawtext=${parts.join(":")}`;
}

/**
 * drawtext filter(s) for a text clip. A normal clip → one drawtext gated to its
 * whole span. A "typewriter" clip → one drawtext PER character-count: slice k
 * (the first k chars) is shown over [start+(k-1)·step, start+k·step), and the
 * final slice holds to the clip end — reproducing the core `typewriterText`
 * reveal with the documented "reveal via time-gated text slices" approach.
 */
function drawtextsFor(clip: TextClip): string[] {
  const end = clip.start + clip.duration;
  const a = clip.anim;
  if (a.style === "typewriter" && a.durationSec > 0 && clip.text.length > 0) {
    const full = clip.text;
    const n = full.length;
    const step = a.durationSec / n;
    const out: string[] = [];
    for (let k = 1; k <= n; k++) {
      const gStart = clip.start + (k - 1) * step;
      const gEnd = k < n ? clip.start + k * step : end;
      out.push(oneDrawtext(clip, full.slice(0, k), gStart, gEnd));
    }
    return out;
  }
  return [oneDrawtext(clip, clip.text, clip.start, end)];
}

// --- callout / highlight (drawbox border + optional dim + label) -------------

/**
 * Filter segments for one callout: a bright rounded-ish border (drawbox), an
 * optional dim of the area OUTSIDE the rect (four filled drawboxes: top / bottom
 * / left / right), and an optional label (drawtext). All time-gated with the
 * clip's [start, end] via `enable`. Coordinates are the PLAIN rect {x,y,w,h}:
 * drawbox can't magnify, so the export keeps the faithful highlight (the zoom is
 * a canvas/Stage preview affordance). Every filter here is documented ffmpeg
 * (drawbox / drawtext), confirmed against ffmpeg-all.html.
 */
function calloutFilters(clip: CalloutClip, W: number, H: number): string[] {
  const start = r3(clip.start);
  const end = r3(clip.start + clip.duration);
  const gate = `enable='between(t\\,${start}\\,${end})'`;
  const rx = Math.round(clip.x);
  const ry = Math.round(clip.y);
  const rw = Math.round(clip.w);
  const rh = Math.round(clip.h);
  const out: string[] = [];

  // Dim OUTSIDE the rect: four filled black boxes around it.
  if (clip.dim && clip.dimOpacity > 0) {
    const a = r3(Math.min(0.95, clip.dimOpacity));
    const dcol = `black@${a}`;
    const boxes: [number, number, number, number][] = [
      [0, 0, W, Math.max(0, ry)], // top
      [0, ry + rh, W, Math.max(0, H - (ry + rh))], // bottom
      [0, ry, Math.max(0, rx), rh], // left
      [rx + rw, ry, Math.max(0, W - (rx + rw)), rh], // right
    ];
    for (const [bx, by, bw, bh] of boxes) {
      if (bw <= 0 || bh <= 0) continue;
      out.push(`drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=${dcol}:t=fill:${gate}`);
    }
  }

  // Bright border around the rect.
  if (clip.borderWidth > 0) {
    const bc = hexToFfColor(clip.color);
    const t = Math.max(1, Math.round(clip.borderWidth));
    out.push(
      `drawbox=x=${rx}:y=${ry}:w=${rw}:h=${rh}:color=${bc.color}${bc.alpha < 1 ? `@${bc.alpha}` : ""}:t=${t}:${gate}`,
    );
  }

  // Optional label above (or below when there's no room) the rect.
  if (clip.label) {
    const fs = Math.max(18, Math.round(Math.min(W, H) * 0.03));
    const bc = hexToFfColor(clip.color);
    const above = ry - Math.round(fs * 1.6);
    const ly = above > 0 ? above : ry + rh + Math.round(fs * 0.5);
    out.push(
      `drawtext=text='${escapeDrawtext(clip.label)}':x=${rx}:y=${ly}:fontsize=${fs}:fontcolor=0x0a0d12:box=1:boxcolor=${bc.color}${bc.alpha < 1 ? `@${bc.alpha}` : ""}:boxborderw=${Math.round(fs * 0.4)}:${gate}`,
    );
  }
  return out;
}

// --- cursor overlay (moving pointer + click ripples) ------------------------

/**
 * A piecewise-linear time (`t`) expression for one axis of the pointer path.
 * Before the first waypoint it holds the first value, after the last it holds the
 * last, and between each pair it interpolates linearly in `t`. Commas inside the
 * `if()`/`between()` calls are escaped for the filtergraph. (The canvas/Stage use
 * the eased `cursorPositionAt`; the export approximates with linear segments.)
 */
/**
 * A piecewise-LINEAR ffmpeg time expression through `points` (each {at, v}) in the
 * variable `varName` (e.g. `t` for seconds, `on` for output-frame index): before
 * the first point it holds the first value, after the last it holds the last, and
 * between each pair it interpolates linearly. Commas inside if()/lt() are escaped
 * for the filtergraph. This is the shared building block behind the cursor path
 * AND the keyframe approximations — the eased `valueAt` curve (canvas/Stage) is
 * approximated here as linear segments (a documented export limit).
 */
function piecewiseLinearExpr(points: { at: number; v: number }[], varName: string): string {
  const pts = [...points].sort((a, b) => a.at - b.at);
  const last = pts[pts.length - 1]!;
  let expr = `${r3(last.v)}`;
  // Build from the last segment backwards so the nesting reads first-to-last.
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const span = Math.max(1e-6, b.at - a.at);
    const seg = `${r3(a.v)}+(${r3(b.v - a.v)})*(${varName}-${r3(a.at)})/${r3(span)}`;
    expr = `if(lt(${varName}\\,${r3(b.at)})\\,${seg}\\,${expr})`;
  }
  // Before the first point, hold the first value.
  const first = pts[0]!;
  return `if(lt(${varName}\\,${r3(first.at)})\\,${r3(first.v)}\\,${expr})`;
}

function cursorAxisExpr(wps: { atSec: number; v: number }[]): string {
  return piecewiseLinearExpr(wps.map((w) => ({ at: w.atSec, v: w.v })), "t");
}

// --- keyframe approximation (scale zoompan + volume expression) --------------

/**
 * Zoompan approximating a clip's SCALE keyframes over its lifetime. Keyframe `t`
 * (0..1 clip-progress) maps to the output-frame index `on` over the clip's frame
 * count; the z expression is piecewise-linear through the keyframe values (mirrors
 * `valueAt` for scale, linearized for export — the same trade-off as the cursor
 * path). Centered, so it zooms about the frame center. Null when the clip has no
 * scale keyframes. Faithful: scales the existing frame only.
 */
function keyframeScaleZoompan(clip: VideoClip | ImageClip, W: number, H: number, fps: number): string | null {
  const scaleKfs = (clip.keyframes ?? []).filter((k) => k.prop === "scale");
  if (scaleKfs.length === 0) return null;
  const d = Math.max(1, Math.round(clip.duration * fps));
  const points = scaleKfs.map((k) => ({ at: Math.round(k.t * d), v: Math.max(0.01, k.value) }));
  const zExpr = piecewiseLinearExpr(points, "on");
  return `zoompan=z='${zExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps}`;
}

/**
 * The `volume` filter segment for an audio chain. When the clip has VOLUME
 * keyframes, emit a time-expression volume (`volume='<expr>':eval=frame`, the
 * documented way to ride volume over time) whose `t` is clip-local seconds
 * (keyframe `t` 0..1 → t·duration). Otherwise a constant volume. Faithful: levels
 * only.
 */
function keyframeVolumeFilter(clip: VideoClip | Extract<Clip, { kind: "audio" }>): string {
  const volKfs = (clip.keyframes ?? []).filter((k) => k.prop === "volume");
  if (volKfs.length === 0) return `volume=${r3(clip.volume)}`;
  const points = volKfs.map((k) => ({ at: r3(k.t * clip.duration), v: clamp(k.value, 0, 1) }));
  return `volume='${piecewiseLinearExpr(points, "t")}':eval=frame`;
}

// --- transform keyframes (x / y / rotation / opacity time expressions) --------

/**
 * ONE easing curve as an ffmpeg expression over a clamped local progress `lp`
 * (a 0..1 sub-expression). MIRRORS core's keyframeEase EXACTLY so the export
 * matches the eased `valueAt` curve the canvas/Stage draw (unlike the cursor path
 * and the scale zoompan, which linearize):
 *  - linear      → lp
 *  - ease-in     → lp^3                              (easeInCubic)
 *  - ease-out    → 1-(1-lp)^3                         (easeOutCubic)
 *  - ease-in-out → lp<0.5 ? 4·lp^3 : 1-(-2·lp+2)^3/2 (easeInOutCubic)
 * Commas inside the fn-calls are escaped for the filtergraph.
 */
function keyframeEaseExpr(easing: KeyframeEasing, lp: string): string {
  switch (easing) {
    case "ease-in":
      return `pow(${lp}\\,3)`;
    case "ease-out":
      return `(1-pow(1-(${lp})\\,3))`;
    case "ease-in-out":
      return `if(lt(${lp}\\,0.5)\\,4*pow(${lp}\\,3)\\,1-pow(-2*(${lp})+2\\,3)/2)`;
    case "linear":
    default:
      return lp;
  }
}

/**
 * A piecewise EASED ffmpeg expression (in the variable `varName` — `t` for
 * overlay/rotate seconds, `T` for geq seconds) through transform keyframe points,
 * matching the PURE `valueAt` resolver SEGMENT-FOR-SEGMENT: hold the first value
 * before the first point, hold the last after the last, and between a→b use
 * a.v+(b.v-a.v)·ease(b.easing, clip((var-a.at)/span,0,1)) — the easing belongs to
 * the INCOMING keyframe, exactly as `valueAt` does. Built last-segment-first so the
 * nested `if(lt(...))` reads first→last. Commas are escaped for the filtergraph.
 */
function piecewiseKeyframeExpr(
  points: { at: number; v: number; easing: KeyframeEasing }[],
  varName: string,
): string {
  const pts = [...points].sort((a, b) => a.at - b.at);
  const last = pts[pts.length - 1]!;
  let expr = `${r3(last.v)}`;
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const span = Math.max(1e-6, b.at - a.at);
    const lp = `clip((${varName}-${r3(a.at)})/${r3(span)}\\,0\\,1)`;
    const seg = `${r3(a.v)}+(${r3(b.v - a.v)})*(${keyframeEaseExpr(b.easing, lp)})`;
    expr = `if(lt(${varName}\\,${r3(b.at)})\\,${seg}\\,${expr})`;
  }
  const first = pts[0]!;
  return `if(lt(${varName}\\,${r3(first.at)})\\,${r3(first.v)}\\,${expr})`;
}

/**
 * THE pure helper closing the keyframe export-fidelity gap for x/y/rotation/
 * opacity: an ffmpeg time expression (variable `varName`, seconds — `t` for
 * overlay/rotate, `T` for geq) for a keyframed transform `prop` over the clip's
 * ON-TIMELINE span, matching `valueAt` (eased). Keyframe `t` (0..1 clip-progress)
 * maps to ABSOLUTE timeline seconds (clip.start + t·duration). Returns null when
 * the clip has NO keyframes for `prop`, so callers keep their byte-identical fast
 * path. Shared by plan.ts (below) and the verify gate, so preview and export agree
 * (the "one pure helper → parity" rule). Faithful: moves/rotates/fades the existing
 * layer only, never a content change.
 */
export function keyframeTransformExpr(
  clip: { start: number; duration: number; keyframes?: Keyframe[] },
  prop: KeyframeProp,
  varName = "t",
): string | null {
  const kfs = (clip.keyframes ?? []).filter((k) => k.prop === prop);
  if (kfs.length === 0) return null;
  const points = kfs.map((k) => ({
    at: r3(clip.start + k.t * clip.duration),
    v: k.value,
    easing: k.easing,
  }));
  return piecewiseKeyframeExpr(points, varName);
}

/**
 * A stereo `pan` filter placing the clip in the stereo field: -1 hard left, 0
 * center, +1 hard right. Left gain = 1-max(0,pan), right gain = 1+min(0,pan), so
 * center is unchanged and the ends silence the opposite channel.
 * `pan=stereo|c0=…|c1=…` (c0=left, c1=right) verified against ffmpeg-filters.html.
 * Null when centered. Faithful: repositions, no content change.
 */
export function panFilter(pan: number): string | null {
  if (!pan) return null;
  const p = clamp(pan, -1, 1);
  const lg = r3(1 - Math.max(0, p));
  const rg = r3(1 + Math.min(0, p));
  return `pan=stereo|c0=${lg}*c0|c1=${rg}*c1`;
}

/**
 * `afade` in/out segments over an audio clip of `segDur` seconds. Fade-in ramps
 * from the head; fade-out ends at the tail. Options t/st/d verified against
 * ffmpeg-filters.html. Empty when there are no fades. Faithful: levels only.
 */
export function afadeFilters(fadeIn: number, fadeOut: number, segDur: number): string[] {
  const out: string[] = [];
  if (fadeIn > 0) out.push(`afade=t=in:st=0:d=${r3(fadeIn)}`);
  if (fadeOut > 0) out.push(`afade=t=out:st=${r3(Math.max(0, segDur - fadeOut))}:d=${r3(fadeOut)}`);
  return out;
}

/**
 * Filter segments for one cursor clip: a single drawtext whose x/y are time
 * expressions gliding a pointer glyph along the waypoints (with a dark box behind
 * it so the marker stays visible under any font fallback), plus, for each click,
 * concentric drawbox rings gated in sequence to approximate the expanding ripple.
 */
function cursorFilters(clip: CursorClip): string[] {
  const start = r3(clip.start);
  const end = r3(clip.start + clip.duration);
  const bc = hexToFfColor(clip.color);
  const col = `${bc.color}${bc.alpha < 1 ? `@${bc.alpha}` : ""}`;
  const out: string[] = [];

  const xExpr = cursorAxisExpr(clip.waypoints.map((w) => ({ atSec: w.atSec, v: w.x })));
  const yExpr = cursorAxisExpr(clip.waypoints.map((w) => ({ atSec: w.atSec, v: w.y })));
  const fs = Math.max(10, Math.round(clip.size));
  // A pointer glyph, gliding with t; box=1 keeps a visible marker if the glyph
  // falls back. Approximates the canvas arrow (documented).
  out.push(
    `drawtext=text='${escapeDrawtext("➤")}':x='${xExpr}':y='${yExpr}':fontsize=${fs}:fontcolor=${col}:box=1:boxcolor=black@0.35:boxborderw=2:enable='between(t\\,${start}\\,${end})'`,
  );

  // Click ripples: at each click, sample the (fixed) pointer position and draw
  // three rings, each gated to a third of the ripple's life (expanding outward).
  const dur = clip.rippleSec;
  const rings = 3;
  const maxR = clip.size * 1.6;
  for (const c of clip.clicks) {
    const pos = cursorPositionAt(clip, c);
    for (let j = 0; j < rings; j++) {
      const rad = Math.round((maxR * (j + 1)) / rings);
      const gs = r3(c + (j * dur) / rings);
      const ge = r3(c + ((j + 1) * dur) / rings);
      const bx = Math.round(pos.x - rad);
      const by = Math.round(pos.y - rad);
      out.push(
        `drawbox=x=${bx}:y=${by}:w=${rad * 2}:h=${rad * 2}:color=${col}:t=3:enable='between(t\\,${gs}\\,${ge})'`,
      );
    }
  }
  return out;
}

/**
 * Push a base visual clip's video chain into the graph, applying an optional
 * region blur/pixelate AFTER it (split → crop → boxblur/pixelize → overlay). Keeps
 * the four base paths (all-video / slideshow / generic video / generic image)
 * consistent so regionFx works wherever a clip lives.
 */
function pushVideoChain(
  filters: string[],
  head: string,
  chain: string[],
  regionFx: RegionFx | undefined,
  outName: string,
): void {
  if (regionFx) {
    filters.push(`[${head}]${chain.join(",")}[${outName}pre]`);
    filters.push(...regionFxGraph(regionFx, `${outName}pre`, outName));
  } else {
    filters.push(`[${head}]${chain.join(",")}[${outName}]`);
  }
}

// --- clip collection --------------------------------------------------------

/**
 * The BASE visual layer: the LOWEST (earliest in array order = bottom of the
 * stack) non-hidden visual track that carries any video/image clip. The base is
 * concat/xfade'd (the fast path); every HIGHER visual track composites over it
 * (collectUpperLayers). The legacy "broll" lane is never the base — it is always
 * an overlay — so a broll-only doc still gets a lavfi/solid base beneath it, as
 * before. Returns the base track's video/image clips sorted by start (unchanged
 * from the historical single-track behavior).
 */
function baseVisualTrack(doc: EditDoc): EditDoc["tracks"][number] | null {
  for (const track of doc.tracks) {
    if (track.kind !== "visual" || track.hidden) continue;
    if (track.id === "broll") continue; // b-roll is always overlaid, never the base
    if (track.clips.some((c) => c.kind === "video" || c.kind === "image")) return track;
  }
  return null;
}

function collectVisualBase(doc: EditDoc): (VideoClip | ImageClip)[] {
  const track = baseVisualTrack(doc);
  if (!track) return [];
  const base: (VideoClip | ImageClip)[] = [];
  for (const clip of track.clips) {
    if (clip.kind === "video" || clip.kind === "image") base.push(clip);
  }
  base.sort((a, b) => a.start - b.start);
  return base;
}

/**
 * Every visual layer ABOVE the base — the true multi-track z-order fix. Iterates
 * non-hidden visual tracks in ARRAY ORDER (bottom→top), skipping the base track,
 * and returns their video/image clips (sorted by start WITHIN each track). Each is
 * composited over the base via the overlay/blend path below, carrying its own
 * transform (PiP or full-frame), blendMode, chroma, and mask. The legacy "broll"
 * track is one of these upper layers — so in the common single-visual-track case
 * (base + broll only) this returns exactly the old b-roll list, and the export
 * graph is byte-for-byte unchanged (the fast path).
 */
function collectUpperLayers(doc: EditDoc): (VideoClip | ImageClip)[] {
  const baseId = baseVisualTrack(doc)?.id;
  const out: (VideoClip | ImageClip)[] = [];
  for (const track of doc.tracks) {
    if (track.kind !== "visual" || track.hidden) continue;
    if (track.id === baseId) continue;
    const layer: (VideoClip | ImageClip)[] = [];
    for (const clip of track.clips) {
      if (clip.kind === "video" || clip.kind === "image") layer.push(clip);
    }
    layer.sort((a, b) => a.start - b.start);
    out.push(...layer);
  }
  return out;
}

/**
 * Whether a solo is active among AUDIO-contributing tracks (any non-hidden audio
 * track, or the base visual track, with `solo` set). When true, only soloed audio
 * plays — CapCut solo semantics.
 */
function soloActive(doc: EditDoc): boolean {
  const baseId = baseVisualTrack(doc)?.id;
  return doc.tracks.some((t) => !t.hidden && t.solo && (t.kind === "audio" || t.id === baseId));
}

function collectTextClips(doc: EditDoc): TextClip[] {
  const out: TextClip[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) if (clip.kind === "text") out.push(clip);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function collectCallouts(doc: EditDoc): CalloutClip[] {
  const out: CalloutClip[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) if (clip.kind === "callout") out.push(clip);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function collectCursors(doc: EditDoc): CursorClip[] {
  const out: CursorClip[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) if (clip.kind === "cursor") out.push(clip);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Adjustment-layer clips, in start order. A `hidden` track contributes nothing (a
 * hidden adjustment layer is skipped, matching `activeClipsAt` / the canvas). All
 * default off, so a doc with no adjustment clips returns [] and the export graph is
 * byte-for-byte unchanged (the fast path).
 */
function collectAdjustments(doc: EditDoc): AdjustmentClip[] {
  const out: AdjustmentClip[] = [];
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) if (clip.kind === "adjustment") out.push(clip);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * The gated filter chain for ONE adjustment layer: the SAME per-clip grade chain
 * (`lookFilters`: eq / colorbalance / hue / curves / lut3d) plus, optionally, the
 * whole-frame vignette + grain — each segment gated to the clip's window with
 * `enable='between(t,start,end)'` (the documented ffmpeg timeline-editing option,
 * supported by every filter used here). The grade applies to the FINAL composited
 * stream, so it grades everything beneath the layer over its span. `lightLeak` is
 * not applied per-adjustment (it needs a separate blended source over the window);
 * the whole-doc `vfx.lightLeak` finishing pass still covers that case. Faithful:
 * tone/color only. Returns [] when the adjustment is fully neutral (no-op).
 */
function adjustmentFilters(
  clip: AdjustmentClip,
  resolveLut: ResolveMediaPath,
): string[] {
  const start = r3(clip.start);
  const end = r3(clip.start + clip.duration);
  const gate = (f: string): string => `${f}:enable='between(t\\,${start}\\,${end})'`;
  const out = lookFilters(clip.grade, resolveLut).map(gate);
  const vfx = clip.vfx;
  if (vfx) {
    if (vfx.grain > 0) out.push(gate(`noise=alls=${Math.round(clamp(vfx.grain, 0, 1) * 40)}:allf=t+u`));
    if (vfx.vignette > 0) {
      const a = r3(Math.PI / 5 + clamp(vfx.vignette, 0, 1) * (Math.PI / 2.2 - Math.PI / 5));
      out.push(gate(`vignette=angle=${a}`));
    }
  }
  return out;
}

/**
 * Extra audio-track clips (music / voice-over), honoring per-track flags:
 *  - `hidden` or `muted` track → dropped from the mix.
 *  - when any audio track solos → only soloed tracks contribute.
 * All flags default off, so a doc with no flags set collects every audio clip
 * exactly as before (the fast path).
 */
function collectAudioClips(doc: EditDoc): { clip: Extract<Clip, { kind: "audio" }>; trackId: string }[] {
  const solo = soloActive(doc);
  const out: { clip: Extract<Clip, { kind: "audio" }>; trackId: string }[] = [];
  for (const track of doc.tracks) {
    if (track.hidden || track.muted) continue;
    if (solo && !track.solo) continue;
    for (const clip of track.clips) if (clip.kind === "audio") out.push({ clip, trackId: track.id });
  }
  return out;
}

/** Fade-from-black / fade-to-black detected from the "fades" solid track. */
function detectFades(doc: EditDoc, total: number): { in: number; out: { st: number; d: number } | null } {
  let fadeIn = 0;
  let fadeOut: { st: number; d: number } | null = null;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== "solid") continue;
      const s = clip as SolidClip;
      // fade FROM black: black solid at the very start that ramps OUT → video fades in.
      if (s.start <= 0.05 && s.transitionOutSec > 0) fadeIn = Math.max(fadeIn, s.transitionOutSec);
      // fade TO black: black solid that ramps IN near the end → video fades out.
      if (s.transitionInSec > 0 && s.start + s.duration >= total - 0.05) {
        fadeOut = { st: r3(s.start), d: r3(s.transitionInSec) };
      }
    }
  }
  return { in: r3(fadeIn), out: fadeOut };
}

// --- Ken Burns (zoompan) ----------------------------------------------------

function zoompanFor(clip: ImageClip, w: number, h: number, fps: number): string {
  const d = Math.max(1, Math.round(clip.duration * fps));
  const z = Math.max(1, clip.motion.zoom);
  // Linear zoom 1 → z over the clip; centered window with a fractional pan drift.
  const zExpr = `1+(${r3(z - 1)})*on/${d}`;
  const panX = r3(clip.motion.panX);
  const panY = r3(clip.motion.panY);
  const xExpr = `iw/2-(iw/zoom/2)+(${panX})*iw*on/${d}`;
  const yExpr = `ih/2-(ih/zoom/2)+(${panY})*ih*on/${d}`;
  return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${d}:s=${w}x${h}:fps=${fps}`;
}

// --- punch-in emphasis (zoompan on video) -----------------------------------

/**
 * A zoompan that pulses a video clip's scale from 1 → zoom → 1 over the clip-local
 * emphasis window (sine pulse), centered — mirrors core's emphasisScale. `on` is
 * this input's output-frame index (PTS reset per clip), so the window is in
 * clip-local frames. Null when the clip has no emphasis. Faithful: scales only.
 */
function emphasisZoompan(clip: VideoClip, w: number, h: number, fps: number): string | null {
  const e = clip.emphasis;
  if (!e || e.durationSec <= 0 || e.zoom <= 1) return null;
  const sf = Math.max(0, Math.round((e.atSec - clip.start) * fps));
  const ef = Math.round((e.atSec + e.durationSec - clip.start) * fps);
  const span = ef - sf;
  if (span <= 0) return null;
  // Sine pulse 1 → zoom → 1 across [sf, ef] frames, identity elsewhere. Built with
  // PLAIN commas and escaped ONCE (escExpr) so the graph is valid: balanced parens,
  // single-`\,` commas, and `z`/`x`/`y` each single-quoted. `d=1` (one output frame
  // per input frame) with an explicit `s`/`fps` places the zoompan validly AFTER the
  // scale/crop reframe (it re-emits at WxH), never fused into scale's options.
  const zExpr = escExpr(
    `if(between(on,${sf},${ef}),1+(${r3(e.zoom - 1)})*sin((on-${sf})/${span}*PI),1)`,
  );
  return `zoompan=z='${zExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps}`;
}

// --- main -------------------------------------------------------------------

/**
 * Turn an EditDoc into ffmpeg args. Pure. `resolveMediaPath` maps a mediaId to a
 * concrete file path; `outFile` is where the .mp4 lands.
 */
export function buildExportPlan(
  doc: EditDoc,
  resolveMediaPath: ResolveMediaPath,
  outFile: string,
): ExportPlan {
  const { width: W, height: H, fps } = doc.meta;
  const total = r3(docDurationSec(doc));

  const inputArgs: string[] = [];
  const inputs: string[] = [];
  let inputIdx = 0;
  // isFile=true (default) restricts this input to the local `file` protocol —
  // defense-in-depth against SSRF/arbitrary-read even if a path check is bypassed.
  // The synthetic lavfi source passes isFile=false.
  const addInput = (perInputOpts: string[], path: string, isFile = true): number => {
    const opts = isFile ? ["-protocol_whitelist", "file,crypto", ...perInputOpts] : perInputOpts;
    inputArgs.push(...opts, "-i", path);
    inputs.push(path);
    return inputIdx++;
  };

  const filters: string[] = [];
  const base = collectVisualBase(doc);
  const allVideo = base.length > 0 && base.every((c) => c.kind === "video");
  const allImage = base.length > 0 && base.every((c) => c.kind === "image");
  const hasCrossfade = base.some((c) => c.transitionInSec > 0);

  // Normalize every audio segment to a common rate/layout so concat/acrossfade
  // never desync on mismatched sources (aformat is documented ffmpeg).
  const AUDIO_FORMAT = "aformat=sample_rates=44100:channel_layouts=stereo";
  /**
   * Build a video clip's [a{i}] audio segment. A source with no audio stream
   * (`asset.hasAudio === false`) can't be mapped as `[idx:a]`, so we synthesize
   * matching silence (anullsrc) for its timeline duration — that's what lets a
   * multi-video concat/crossfade with a muted/silent clip still export. Real audio
   * is speed-retimed (atempo) and normalized (aformat).
   */
  const audioSegmentFilter = (c: VideoClip, srcIdx: number, i: number): string => {
    const asset = doc.media.find((m) => m.id === c.mediaId);
    // A frozen frame carries no audio, so synthesize silence for its duration —
    // same path as a source with no audio stream.
    if (c.freezeAtSec !== undefined || asset?.hasAudio === false) {
      const silIdx = addInput(
        ["-f", "lavfi", "-t", String(r3(c.duration))],
        `anullsrc=channel_layout=stereo:sample_rate=44100`,
        false,
      );
      return `[${silIdx}:a]asetpts=PTS-STARTPTS,${AUDIO_FORMAT}[a${i}]`;
    }
    const pan = panFilter(c.pan);
    const aChain = [
      "asetpts=PTS-STARTPTS",
      // Reversed clip → reverse its audio too (areverse), keeping A/V locked.
      ...(c.reversed ? ["areverse"] : []),
      // Constant volume, or a keyframed volume expression (volume=…:eval=frame).
      keyframeVolumeFilter(c),
      ...(pan ? [pan] : []),
      ...atempoChain(c.speed),
      // afade after atempo so fade times are in output (timeline) seconds.
      ...afadeFilters(c.fadeInSec, c.fadeOutSec, c.duration),
      AUDIO_FORMAT,
    ];
    return `[${srcIdx}:a]${aChain.join(",")}[a${i}]`;
  };

  /**
   * The ffmpeg input for a video clip: a normal clip trims a source window
   * (-ss/-t = duration*speed); a freeze clip seeks to the freeze source time
   * (-ss) and holds one frame in the graph (see videoClipVChain).
   */
  const videoClipInput = (c: VideoClip): number =>
    c.freezeAtSec !== undefined
      ? addInput(["-ss", String(r3(c.freezeAtSec))], resolveMediaPath(c.mediaId))
      : addInput(["-ss", String(r3(c.sourceIn)), "-t", String(r3(sourceSpanSec(c)))], resolveMediaPath(c.mediaId));

  /**
   * The video filter chain for a video clip. Freeze → grab one frame (trim) and
   * clone it for the clip duration (tpad=stop_mode=clone). Otherwise → optional
   * reverse, speed setpts, scale/crop, static zoom, emphasis pulse, and any
   * keyframed scale (zoompan). `appendFps` adds a trailing fps= (needed by xfade
   * and the generic concat path).
   */
  const videoClipVChain = (c: VideoClip, appendFps: boolean): string[] => {
    const emph = emphasisZoompan(c, W, H, fps);
    const kfZoom = keyframeScaleZoompan(c, W, H, fps);
    const head =
      c.freezeAtSec !== undefined
        ? ["trim=end_frame=1", "setpts=PTS-STARTPTS", `tpad=stop_mode=clone:stop_duration=${r3(c.duration)}`]
        : [...(c.reversed ? ["reverse"] : []), speedSetpts(c.speed)];
    return [
      ...head,
      `scale=${W}:${H}:force_original_aspect_ratio=increase`,
      `crop=${W}:${H}`,
      ...staticZoomFilters(c, W, H),
      ...(emph ? [emph] : []),
      ...(kfZoom ? [kfZoom] : []),
      ...lookFilters(c.look, resolveMediaPath),
      "format=yuv420p",
      ...(appendFps ? [`fps=${fps}`] : []),
    ];
  };

  /**
   * Emit a SPEED-RAMP video clip as `[v{i}]` (+ `[a{i}]` when `includeAudio`) by
   * SEGMENTING it into `RAMP_SEGMENTS` pieces, each reading its own source window
   * with its own `setpts` (and matching `atempo` for audio) at that segment's
   * average rate, then concatenating them. This approximates CapCut's speed curve
   * with the same segmenting strategy the doc describes; it mirrors the shared
   * pure `speedRampIntegral` so preview and export agree. `reversed` is honored by
   * reading the mirrored source window per segment and adding `reverse`/`areverse`.
   * (emphasis / keyframe-zoom are not applied on a ramped clip — documented limit.)
   */
  const emitRampedClip = (c: VideoClip, i: number, includeAudio: boolean): void => {
    const ramp = c.speedRamp!;
    const dur = Math.max(1e-6, c.duration);
    const totalSpan = dur * speedRampIntegral(ramp, 1); // total source seconds consumed
    const asset = doc.media.find((m) => m.id === c.mediaId);
    const hasAudio = includeAudio && asset?.hasAudio !== false;
    const pan = panFilter(c.pan);
    const vSeg: string[] = [];
    const aSeg: string[] = [];
    for (let s = 0; s < RAMP_SEGMENTS; s++) {
      const p0 = s / RAMP_SEGMENTS;
      const p1 = (s + 1) / RAMP_SEGMENTS;
      const i0 = speedRampIntegral(ramp, p0);
      const i1 = speedRampIntegral(ramp, p1);
      const segTimeline = dur * (p1 - p0); // this segment's timeline seconds
      const segSource = dur * (i1 - i0); // source seconds it consumes
      const rate = segSource / Math.max(1e-6, segTimeline); // segment's average speed
      // Forward reads sourceIn+dur*i0; reversed reads the mirrored window then flips.
      const srcStart = c.reversed ? c.sourceIn + totalSpan - dur * i1 : c.sourceIn + dur * i0;
      const idx = addInput(
        ["-ss", String(r3(srcStart)), "-t", String(r3(segSource))],
        resolveMediaPath(c.mediaId),
      );
      const vChain = [
        ...(c.reversed ? ["reverse"] : []),
        `setpts=(PTS-STARTPTS)/${r3(rate)}`,
        `scale=${W}:${H}:force_original_aspect_ratio=increase`,
        `crop=${W}:${H}`,
        ...staticZoomFilters(c, W, H),
        ...lookFilters(c.look, resolveMediaPath),
        "format=yuv420p",
        `fps=${fps}`,
      ];
      const vlab = `vr${i}_${s}`;
      pushVideoChain(filters, `${idx}:v`, vChain, undefined, vlab);
      vSeg.push(`[${vlab}]`);
      if (hasAudio) {
        const alab = `ar${i}_${s}`;
        const aChain = [
          "asetpts=PTS-STARTPTS",
          ...(c.reversed ? ["areverse"] : []),
          ...(pan ? [pan] : []),
          ...atempoChain(rate),
          AUDIO_FORMAT,
        ];
        filters.push(`[${idx}:a]${aChain.join(",")}[${alab}]`);
        aSeg.push(`[${alab}]`);
      }
    }
    filters.push(`${vSeg.join("")}concat=n=${RAMP_SEGMENTS}:v=1:a=0[v${i}]`);
    if (includeAudio) {
      if (hasAudio) {
        filters.push(`${aSeg.join("")}concat=n=${RAMP_SEGMENTS}:v=0:a=1[a${i}]`);
      } else {
        // No source audio ⇒ synthesize matching silence (mirrors audioSegmentFilter).
        const silIdx = addInput(
          ["-f", "lavfi", "-t", String(r3(c.duration))],
          `anullsrc=channel_layout=stereo:sample_rate=44100`,
          false,
        );
        filters.push(`[${silIdx}:a]asetpts=PTS-STARTPTS,${AUDIO_FORMAT}[a${i}]`);
      }
    }
  };
  /** True when a video clip must take the segmented speed-ramp export path. */
  const isRamped = (c: VideoClip): boolean =>
    !!c.speedRamp && c.speedRamp.length > 0 && c.freezeAtSec === undefined;

  let videoLabel = "";
  let audioLabel: string | null = null;

  if (allVideo) {
    // ---- Video cuts (highlight / filler): concat (hard cuts) OR xfade -------
    // A cut carries a real A→B dissolve when the incoming clip has a transition
    // (transitionInSec>0) AND overlaps the previous clip (setTransition lays that
    // overlap). When every boundary has one we chain `xfade` on the video and
    // `acrossfade` on the audio across the overlaps; otherwise (all hard cuts, the
    // default) we `concat` exactly as before. Filters: xfade (vf_xfade),
    // acrossfade (af_acrossfade), anullsrc + aformat (all documented ffmpeg).
    const useXfade = base.length > 1 && base.slice(1).every((c) => (c as VideoClip).transitionInSec > 0);
    base.forEach((clip, i) => {
      const c = clip as VideoClip;
      // Speed retime, reverse, freeze, static zoom, emphasis, and scale keyframes
      // are all resolved by the shared helpers (used by the generic path too).
      // xfade needs both inputs on the same timebase/framerate to blend cleanly.
      // Speed-ramp clips take the segmented path (own inputs + concat → v{i}/a{i}).
      if (isRamped(c)) {
        emitRampedClip(c, i, true);
        return;
      }
      const idx = videoClipInput(c);
      const vChain = videoClipVChain(c, useXfade);
      pushVideoChain(filters, `${idx}:v`, vChain, c.regionFx, `v${i}`);
      filters.push(audioSegmentFilter(c, idx, i));
    });
    if (base.length === 1) {
      videoLabel = "v0";
      audioLabel = "a0";
    } else if (useXfade) {
      // Video: chain xfade across each overlap. offset = accumulated timeline length
      // so far minus the incoming transition (the crossfade begins that far in).
      let prevV = "v0";
      let acc = base[0]!.duration;
      for (let i = 1; i < base.length; i++) {
        const inClip = base[i] as VideoClip;
        const xf = r3(inClip.transitionInSec);
        const offset = r3(Math.max(0, acc - xf));
        const name = xfadeTransition(inClip.transitionType);
        const out = i === base.length - 1 ? "vcat" : `vxf${i}`;
        filters.push(`[${prevV}][v${i}]xfade=transition=${name}:duration=${xf}:offset=${offset}[${out}]`);
        prevV = out;
        acc = r3(acc - xf + inClip.duration);
      }
      videoLabel = "vcat";
      // Audio: acrossfade across the SAME overlaps (joins the end of one clip with
      // the start of the next, overlapping by the transition), so audio and video
      // stay the same length and cuts don't pop.
      let prevA = "a0";
      for (let i = 1; i < base.length; i++) {
        const xf = r3((base[i] as VideoClip).transitionInSec);
        const out = i === base.length - 1 ? "acat" : `axf${i}`;
        filters.push(`[${prevA}][a${i}]acrossfade=d=${xf}[${out}]`);
        prevA = out;
      }
      audioLabel = "acat";
    } else {
      const segLabels = base.map((_, i) => `[v${i}][a${i}]`);
      filters.push(`${segLabels.join("")}concat=n=${base.length}:v=1:a=1[vcat][acat]`);
      videoLabel = "vcat";
      audioLabel = "acat";
    }
  } else if (allImage && hasCrossfade && base.length > 1) {
    // ---- Slideshow: images looped, Ken Burns, crossfaded via xfade --------
    base.forEach((clip, i) => {
      const c = clip as ImageClip;
      const idx = addInput(["-loop", "1", "-t", String(r3(c.duration))], resolveMediaPath(c.mediaId));
      const vChain = [
        `scale=${W}:${H}:force_original_aspect_ratio=increase`,
        `crop=${W}:${H}`,
        "setpts=PTS-STARTPTS",
        zoompanFor(c, W, H, fps),
        ...lookFilters(c.look, resolveMediaPath),
        "format=yuv420p",
        `fps=${fps}`,
      ];
      pushVideoChain(filters, `${idx}:v`, vChain, c.regionFx, `v${i}`);
    });
    // Chain xfades, accumulating offsets. Each transition's TYPE comes from the
    // incoming clip (crossfade→fade, dip-to-black→fadeblack, slide→slideleft,
    // wipe→wipeleft), so the transition library is honored on export.
    let prev = "v0";
    let acc = base[0]!.duration;
    for (let i = 1; i < base.length; i++) {
      const inClip = base[i]!;
      const xf = r3(inClip.transitionInSec || 0.5);
      const offset = r3(acc - xf);
      const name = xfadeTransition(inClip.transitionType);
      const out = i === base.length - 1 ? "vxf" : `vxf${i}`;
      filters.push(`[${prev}][v${i}]xfade=transition=${name}:duration=${xf}:offset=${offset}[${out}]`);
      prev = out;
      acc = r3(acc - xf + inClip.duration);
    }
    videoLabel = "vxf";
  } else if (base.length > 0) {
    // ---- Generic fallback: scale each visual, concat (video only) ---------
    const segLabels: string[] = [];
    base.forEach((clip, i) => {
      const c = clip;
      if (c.kind === "video") {
        // Speed-ramp clips take the segmented path (video-only here; audio comes
        // from the audio-track pass, matching the non-ramped generic behavior).
        if (isRamped(c)) {
          emitRampedClip(c, i, false);
          segLabels.push(`[v${i}]`);
          return;
        }
        // Video: reuse the shared helpers (reverse/freeze/speed/zoom/keyframes).
        const idx = videoClipInput(c);
        pushVideoChain(filters, `${idx}:v`, videoClipVChain(c, true), c.regionFx, `v${i}`);
        segLabels.push(`[v${i}]`);
        return;
      }
      // Image: looped still + optional scale keyframes (Ken Burns keyframed zoom).
      const idx = addInput(["-loop", "1", "-t", String(r3(c.duration))], resolveMediaPath(c.mediaId));
      const kfZoom = keyframeScaleZoompan(c, W, H, fps);
      const vChain = [
        "setpts=PTS-STARTPTS",
        `scale=${W}:${H}:force_original_aspect_ratio=increase`,
        `crop=${W}:${H}`,
        ...staticZoomFilters(c, W, H),
        ...(kfZoom ? [kfZoom] : []),
        ...lookFilters(c.look, resolveMediaPath),
        "format=yuv420p",
        `fps=${fps}`,
      ];
      pushVideoChain(filters, `${idx}:v`, vChain, c.regionFx, `v${i}`);
      segLabels.push(`[v${i}]`);
    });
    if (base.length === 1) {
      videoLabel = "v0";
    } else {
      filters.push(`${segLabels.join("")}concat=n=${base.length}:v=1:a=0[vcat]`);
      videoLabel = "vcat";
    }
  } else {
    // ---- No media: solid/text-only doc → lavfi color base -----------------
    const bg = hexToFfColor(doc.meta.background);
    const dur = total > 0 ? total : 1;
    const idx = addInput(
      ["-f", "lavfi"],
      `color=c=${bg.color}:s=${W}x${H}:r=${fps}:d=${r3(dur)}`,
      false,
    );
    filters.push(`[${idx}:v]format=yuv420p[vbg]`);
    videoLabel = "vbg";
  }

  // ---- Multi-track layer compositing (z-order) ----------------------------
  // Every visual track ABOVE the base (in array order, bottom→top) composites
  // over it here — the true multi-layer export. Each clip carries its own look:
  //   • a plain layer clip is a PiP (scaled + positioned, time-gated overlay) —
  //     e.g. a corner b-roll, or a full-frame second video (scale 1, centered);
  //   • chroma / mask → alpha-composited via overlay (green-screen / shaped reveal);
  //   • blendMode     → blended over the base via blend=all_mode=… (a texture /
  //                     double-exposure / leak layer that spans the timeline).
  // In the common single-visual-track case (base + a "broll" lane) this is exactly
  // the historical b-roll overlay pass — byte-for-byte unchanged.
  const overlayLayers = collectUpperLayers(doc);
  overlayLayers.forEach((clip, i) => {
    const blend = clip.blendMode ?? "normal";
    const chroma = clip.chroma;
    const mask = clip.mask;
    const isBlend = blend !== "normal";
    const isAlpha = !!chroma || !!mask; // overlay with an alpha (chroma/mask)
    const isFull = isBlend || isAlpha; // any compositing effect ⇒ full-frame layer
    const boxW = isFull ? W : Math.max(2, Math.round(W * clip.transform.scale));
    const boxH = isFull ? H : Math.max(2, Math.round(H * clip.transform.scale));
    const st = r3(clip.start);
    const en = r3(clip.start + clip.duration);

    // TRANSFORM KEYFRAMES (x/y/rotation/opacity) export for a PLAIN PiP overlay
    // (no blend / chroma / mask): those force full-frame compositing where per-frame
    // position/rotation is ill-defined, and a plain PiP (the b-roll / layer clip) is
    // the common animated case. Each expr is null when the clip has no keyframes for
    // that prop (via keyframeTransformExpr), so a clip with NONE keeps the byte-
    // identical static overlay below — the fast path. `t`/`T` are TIMELINE seconds
    // (the setpts shift comes first), matching the absolute-time mapping. Faithful.
    const kfEligible = !isFull;
    const xExpr = kfEligible ? keyframeTransformExpr(clip, "x") : null;
    const yExpr = kfEligible ? keyframeTransformExpr(clip, "y") : null;
    const rotExpr = kfEligible ? keyframeTransformExpr(clip, "rotation") : null; // degrees
    const opExpr = kfEligible ? keyframeTransformExpr(clip, "opacity", "T") : null; // geq uses T
    const hasXformKf = !!(xExpr || yExpr || rotExpr || opExpr);
    // A rotated box grows to a CONSTANT square big enough to hold the PiP box at any
    // angle, so the (static or time-varying) overlay centering stays valid per frame.
    const rotBox = Math.round(Math.hypot(boxW, boxH));
    // A blend layer spans the whole timeline so both blend inputs are equal length.
    const inDur = isBlend ? total || clip.duration : clip.duration;
    const idx =
      clip.kind === "image"
        ? addInput(["-loop", "1", "-t", String(r3(inDur))], resolveMediaPath(clip.mediaId))
        : addInput(
            ["-ss", String(r3((clip as VideoClip).sourceIn)), "-t", String(r3(inDur))],
            resolveMediaPath(clip.mediaId),
          );
    const chain: string[] = [
      `scale=${boxW}:${boxH}:force_original_aspect_ratio=increase`,
      `crop=${boxW}:${boxH}`,
      ...lookFilters(clip.look, resolveMediaPath),
    ];
    if (isAlpha) {
      // Alpha path: operate in rgba so chroma transparency + the geq mask survive.
      chain.push("format=rgba");
      if (chroma) chain.push(...chromaFilters(chroma));
      if (mask) chain.push(maskGeqFilter(mask, !!chroma));
      // A blend layer's PTS starts at 0 (spans the timeline); an overlay aligns to start.
      chain.push(`setpts=PTS-STARTPTS+${st}/TB`);
    } else if (isBlend) {
      chain.push("format=yuv420p", "setpts=PTS-STARTPTS");
    } else if (hasXformKf) {
      // Rotation/opacity need an alpha plane (transparent rotate corners + a per-frame
      // alpha); operate in rgba (like the mask path) so geq's r/g/b/a apply. The setpts
      // shift comes FIRST so geq's `T` and rotate's `t` read TIMELINE seconds — matching
      // keyframeTransformExpr's absolute-time mapping (and the overlay x/y `t`).
      chain.push(rotExpr || opExpr ? "format=rgba" : "format=yuv420p");
      chain.push(`setpts=PTS-STARTPTS+${st}/TB`);
      if (opExpr) {
        // Per-frame alpha: opacity 0..1 → 0..255, riding the eased valueAt over time.
        chain.push(`geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='(${opExpr})*255'`);
      }
      if (rotExpr) {
        // Rotate about the box center into the constant rotBox square; c=none keeps the
        // exposed corners transparent (alpha-safe). Keyframe degrees → radians.
        chain.push(`rotate=a='(${rotExpr})*PI/180':ow=${rotBox}:oh=${rotBox}:c=none`);
      }
    } else {
      chain.push("format=yuv420p", `setpts=PTS-STARTPTS+${st}/TB`);
    }
    filters.push(`[${idx}:v]${chain.join(",")}[bov${i}]`);
    const out = `vbr${i}`;
    if (isBlend) {
      const op = r3(clip.transform.opacity);
      filters.push(`[${videoLabel}][bov${i}]blend=all_mode=${ffBlendMode(blend)}:all_opacity=${op}[${out}]`);
    } else if (hasXformKf) {
      // Center the (possibly time-varying) box at (x,y): overlay x/y = center − half.
      // A rotated clip grew to rotBox×rotBox; otherwise the PiP box. x/y default to the
      // static transform when they have no keyframes, so one animated axis still works.
      const ovW = rotExpr ? rotBox : boxW;
      const ovH = rotExpr ? rotBox : boxH;
      const ox = xExpr ? `(${xExpr})-${r3(ovW / 2)}` : String(Math.round(clip.transform.x - ovW / 2));
      const oy = yExpr ? `(${yExpr})-${r3(ovH / 2)}` : String(Math.round(clip.transform.y - ovH / 2));
      filters.push(
        `[${videoLabel}][bov${i}]overlay=x='${ox}':y='${oy}':enable='between(t\\,${st}\\,${en})'[${out}]`,
      );
    } else {
      // Full-frame alpha layers overlay at 0:0; a PiP at its box center.
      const ox = isFull ? 0 : Math.round(clip.transform.x - boxW / 2);
      const oy = isFull ? 0 : Math.round(clip.transform.y - boxH / 2);
      filters.push(`[${videoLabel}][bov${i}]overlay=${ox}:${oy}:enable='between(t\\,${st}\\,${en})'[${out}]`);
    }
    videoLabel = out;
  });

  // ---- Burn-in captions / titles (drawtext, time-gated) -------------------
  // Typewriter text expands to one drawtext per character-count (drawtextsFor).
  const texts = collectTextClips(doc);
  if (texts.length > 0) {
    const chain = texts.flatMap(drawtextsFor).join(",");
    filters.push(`[${videoLabel}]${chain}[vtext]`);
    videoLabel = "vtext";
  }

  // ---- Callout / highlight boxes (drawbox border + optional dim + label) ---
  // Faithful overlay: a bright border around the rect, an optional dim of the
  // area OUTSIDE it (four filled drawboxes), and an optional label. All
  // time-gated via drawbox/drawtext `enable`. (The optional `zoom` magnifies in
  // the canvas/Stage preview; the export keeps the faithful highlight box.)
  const callouts = collectCallouts(doc);
  callouts.forEach((clip, i) => {
    const parts = calloutFilters(clip, W, H);
    if (parts.length === 0) return;
    const out = `vco${i}`;
    filters.push(`[${videoLabel}]${parts.join(",")}[${out}]`);
    videoLabel = out;
  });

  // ---- Cursor overlay (moving pointer + click ripples) --------------------
  // drawtext x/y are time (`t`) expressions, so ONE drawtext glides the pointer
  // glyph along the waypoints (piecewise-linear). Each click fires concentric
  // drawbox rings gated in sequence (an expanding ripple; drawbox geometry can't
  // read `t`, so the ripple is built from time-gated static rings).
  const cursors = collectCursors(doc);
  cursors.forEach((clip, i) => {
    const parts = cursorFilters(clip);
    if (parts.length === 0) return;
    const out = `vcur${i}`;
    filters.push(`[${videoLabel}]${parts.join(",")}[${out}]`);
    videoLabel = out;
  });

  // ---- Adjustment layers (grade everything beneath, gated to a window) -----
  // An adjustment layer applies its color grade (eq/curves/colorbalance/hue/lut3d)
  // — the SAME chain used per-clip — to the FINAL composited stream, gated by
  // `enable='between(t,start,end)'`, so one grade spans every clip beneath it over
  // its span. Applied here (after the visual composite + overlays) as a
  // post-composite pass, ordered by start. When there are no adjustment clips this
  // is a no-op and the graph is byte-for-byte unchanged (the fast path).
  const adjustments = collectAdjustments(doc);
  adjustments.forEach((clip, i) => {
    const parts = adjustmentFilters(clip, resolveMediaPath);
    if (parts.length === 0) return;
    const out = `vadj${i}`;
    filters.push(`[${videoLabel}]${parts.join(",")}[${out}]`);
    videoLabel = out;
  });

  // ---- Fade from / to black -----------------------------------------------
  const fades = detectFades(doc, total);
  const fadeParts: string[] = [];
  if (fades.in > 0) fadeParts.push(`fade=t=in:st=0:d=${fades.in}`);
  if (fades.out) fadeParts.push(`fade=t=out:st=${fades.out.st}:d=${fades.out.d}`);
  if (fadeParts.length > 0) {
    filters.push(`[${videoLabel}]${fadeParts.join(",")}[vfade]`);
    videoLabel = "vfade";
  }

  // ---- Quality: faithful upscale (lanczos) + unsharp + hqdn3d -------------
  const q = doc.quality;
  const qParts: string[] = [];
  if (q.denoise > 0) {
    const d = q.denoise;
    qParts.push(`hqdn3d=${r3(d * 4)}:${r3(d * 3)}:${r3(d * 6)}:${r3(d * 4.5)}`);
  }
  if (q.targetWidth && q.targetHeight && (q.targetWidth !== W || q.targetHeight !== H)) {
    qParts.push(`scale=${q.targetWidth}:${q.targetHeight}:flags=lanczos`);
  }
  if (q.sharpen > 0) {
    qParts.push(`unsharp=5:5:${r3(q.sharpen * 1.5)}:5:5:0`);
  }
  if (qParts.length > 0) {
    filters.push(`[${videoLabel}]${qParts.join(",")}[vout]`);
    videoLabel = "vout";
  }

  // ---- VFX finishing pass (vignette / grain / warm light-leak) ------------
  // Filter names verified against ffmpeg docs: `vignette` (angle darkens edges),
  // `noise=alls=N:allf=t+u` (temporal+uniform grain), and a warm color source
  // `blend=all_mode=screen:all_opacity=…` (the light leak). Faithful: tone/texture
  // only, mirroring the canvas finishing pass.
  const vfx = doc.vfx;
  const vfxParts: string[] = [];
  if (vfx.grain > 0) {
    // strength 0..1 → noise 0..100 (kept modest so grain stays filmic, not harsh).
    vfxParts.push(`noise=alls=${Math.round(clamp(vfx.grain, 0, 1) * 40)}:allf=t+u`);
  }
  if (vfx.vignette > 0) {
    // strength 0..1 → angle from the default PI/5 up to ~PI/2.2 (stronger falloff).
    const a = r3(Math.PI / 5 + clamp(vfx.vignette, 0, 1) * (Math.PI / 2.2 - Math.PI / 5));
    vfxParts.push(`vignette=angle=${a}`);
  }
  if (vfxParts.length > 0) {
    filters.push(`[${videoLabel}]${vfxParts.join(",")}[vvfx]`);
    videoLabel = "vvfx";
  }
  if (vfx.lightLeak) {
    // A warm color source screen-blended over the frame — a broad warm leak wash.
    const dur = total > 0 ? total : 1;
    const li = addInput(["-f", "lavfi"], `color=c=0xffb060:s=${W}x${H}:r=${fps}:d=${r3(dur)}`, false);
    filters.push(`[${li}:v]format=yuv420p[leaksrc]`);
    filters.push(`[${videoLabel}][leaksrc]blend=all_mode=screen:all_opacity=0.16[vleak]`);
    videoLabel = "vleak";
  }

  // ---- Base-track mute / solo ---------------------------------------------
  // The base video's embedded audio (audioLabel) follows its track's flags: a
  // MUTED base track drops it; when a SOLO is active elsewhere and the base isn't
  // soloed, it drops too. We keep the base video and sink the now-unused audio pad
  // (anullsink) so the filtergraph has no dangling output. All flags default off,
  // so this never fires for existing docs (fast path).
  const baseTrack = baseVisualTrack(doc);
  const dropBaseAudio =
    !!audioLabel && ((baseTrack?.muted ?? false) || (soloActive(doc) && !(baseTrack?.solo ?? false)));
  let sinkAudioLabel: string | null = null;
  if (dropBaseAudio) {
    sinkAudioLabel = audioLabel;
    audioLabel = null;
  }

  // ---- Extra audio-track clips (e.g. music), delayed + mixed --------------
  const audioClips = collectAudioClips(doc);
  const extraAudioLabels: string[] = [];
  audioClips.forEach(({ clip, trackId }, i) => {
    const idx = addInput(
      ["-ss", String(r3(clip.sourceIn)), "-t", String(r3(clip.duration))],
      resolveMediaPath(clip.mediaId),
    );
    const delayMs = Math.round(clip.start * 1000);
    const pan = panFilter(clip.pan);
    // Music ducks under speech (auto-mix already sets volume in the doc); a
    // keyframed volume rides the level over time (volume=…:eval=frame). Fades/pan
    // apply in clip-local time BEFORE the adelay that places it on the timeline.
    const chain = [
      "asetpts=PTS-STARTPTS",
      keyframeVolumeFilter(clip),
      ...(pan ? [pan] : []),
      ...afadeFilters(clip.fadeInSec, clip.fadeOutSec, clip.duration),
      `adelay=${delayMs}|${delayMs}`,
    ];
    filters.push(`[${idx}:a]${chain.join(",")}[m${i}]`);
    extraAudioLabels.push(`[m${i}]`);
    void trackId;
  });
  if (extraAudioLabels.length > 0) {
    const mixInputs = (audioLabel ? [`[${audioLabel}]`] : []).concat(extraAudioLabels);
    filters.push(`${mixInputs.join("")}amix=inputs=${mixInputs.length}:normalize=0[amix]`);
    audioLabel = "amix";
  }

  // ---- Loudness normalization (EBU R128) ----------------------------------
  // Normalize the final mix to a streaming loudness target via `loudnorm`
  // (I/TP/LRA verified against ffmpeg-filters.html). Single-pass, applied last so
  // it sees the whole mix. Faithful: gain only, no content change.
  if (audioLabel && doc.loudnorm) {
    filters.push(`[${audioLabel}]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
    audioLabel = "aout";
  }

  // Discard a dropped base-audio pad so it isn't a dangling filtergraph output.
  if (sinkAudioLabel) filters.push(`[${sinkAudioLabel}]anullsink`);

  // ---- Assemble argv -------------------------------------------------------
  const filterComplex = filters.join(";");
  const preset = q.preset;
  const crf = String(CRF[preset] ?? 23);

  const args: string[] = ["-hide_banner", "-y"];
  args.push(...inputArgs);
  args.push("-filter_complex", filterComplex);
  args.push("-map", `[${videoLabel}]`);
  if (audioLabel) args.push("-map", `[${audioLabel}]`);
  args.push("-r", String(fps));
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", crf, "-pix_fmt", "yuv420p");
  if (audioLabel) {
    args.push("-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }
  args.push("-movflags", "+faststart");
  args.push(outFile);

  return { args, inputs, filterComplex, outFile };
}
