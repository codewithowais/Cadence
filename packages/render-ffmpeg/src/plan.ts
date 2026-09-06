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
  type CalloutClip,
  type Clip,
  type ColorGrade,
  type CursorClip,
  type EditDoc,
  type ImageClip,
  type SolidClip,
  type TextClip,
  type TransitionType,
  type VideoClip,
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

/** The per-clip look chain (eq + warm), as filter segments (may be empty). */
function lookFilters(look: ColorGrade): string[] {
  const out: string[] = [];
  const eq = eqFromLook(look);
  if (eq) out.push(eq);
  const warm = warmColorbalance(look.warmth);
  if (warm) out.push(warm);
  return out;
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
 * Map an EditDoc transitionType to the ffmpeg xfade `transition` name. Every
 * name verified against the ffmpeg xfade transition enum (vf_xfade.c, doxygen
 * 7.0): fade, fadeblack, slideleft, wipeleft, dissolve, zoomin, smoothleft are
 * all valid transitions. Faithful: xfade blends existing frames.
 */
export function xfadeTransition(type: TransitionType): string {
  switch (type) {
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
    case "crossfade":
    default:
      return "fade";
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
function cursorAxisExpr(wps: { atSec: number; v: number }[]): string {
  const pts = [...wps].sort((a, b) => a.atSec - b.atSec);
  const last = pts[pts.length - 1]!;
  let expr = `${r3(last.v)}`;
  // Build from the last segment backwards so the nesting reads first-to-last.
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const span = Math.max(1e-6, b.atSec - a.atSec);
    const seg = `${r3(a.v)}+(${r3(b.v - a.v)})*(t-${r3(a.atSec)})/${r3(span)}`;
    expr = `if(lt(t\\,${r3(b.atSec)})\\,${seg}\\,${expr})`;
  }
  // Before the first waypoint, hold the first value.
  const first = pts[0]!;
  return `if(lt(t\\,${r3(first.atSec)})\\,${r3(first.v)}\\,${expr})`;
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

// --- clip collection --------------------------------------------------------

function collectVisualBase(doc: EditDoc): (VideoClip | ImageClip)[] {
  const base: (VideoClip | ImageClip)[] = [];
  for (const track of doc.tracks) {
    if (track.kind !== "visual") continue;
    if (track.id === "broll") continue; // b-roll is overlaid, not concatenated
    for (const clip of track.clips) {
      if (clip.kind === "video" || clip.kind === "image") base.push(clip);
    }
  }
  base.sort((a, b) => a.start - b.start);
  return base;
}

/** B-roll / PiP overlay clips (top "broll" visual track). */
function collectBroll(doc: EditDoc): (VideoClip | ImageClip)[] {
  const out: (VideoClip | ImageClip)[] = [];
  for (const track of doc.tracks) {
    if (track.id !== "broll") continue;
    for (const clip of track.clips) {
      if (clip.kind === "video" || clip.kind === "image") out.push(clip);
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
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

function collectAudioClips(doc: EditDoc): { clip: Extract<Clip, { kind: "audio" }>; trackId: string }[] {
  const out: { clip: Extract<Clip, { kind: "audio" }>; trackId: string }[] = [];
  for (const track of doc.tracks) {
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
  // Commas inside fn-calls are escaped for the filtergraph.
  const zExpr = `if(between(on\\,${sf}\\,${ef})\\,1+(${r3(e.zoom - 1)})*sin((on-${sf})/${span}*PI)\\,1)`;
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
    if (asset?.hasAudio === false) {
      const silIdx = addInput(
        ["-f", "lavfi", "-t", String(r3(c.duration))],
        `anullsrc=channel_layout=stereo:sample_rate=44100`,
        false,
      );
      return `[${silIdx}:a]asetpts=PTS-STARTPTS,${AUDIO_FORMAT}[a${i}]`;
    }
    const aChain = ["asetpts=PTS-STARTPTS", `volume=${r3(c.volume)}`, ...atempoChain(c.speed), AUDIO_FORMAT];
    return `[${srcIdx}:a]${aChain.join(",")}[a${i}]`;
  };

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
      // Speed retime: consume `duration*speed` seconds of source, then setpts
      // (and atempo) map it back onto the clip's timeline duration.
      const idx = addInput(
        ["-ss", String(r3(c.sourceIn)), "-t", String(r3(sourceSpanSec(c)))],
        resolveMediaPath(c.mediaId),
      );
      const emph = emphasisZoompan(c, W, H, fps);
      const vChain = [
        speedSetpts(c.speed),
        `scale=${W}:${H}:force_original_aspect_ratio=increase`,
        `crop=${W}:${H}`,
        ...staticZoomFilters(c, W, H),
        ...(emph ? [emph] : []),
        ...lookFilters(c.look),
        "format=yuv420p",
        // xfade needs both inputs on the same timebase/framerate to blend cleanly.
        ...(useXfade ? [`fps=${fps}`] : []),
      ];
      filters.push(`[${idx}:v]${vChain.join(",")}[v${i}]`);
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
        ...lookFilters(c.look),
        "format=yuv420p",
        `fps=${fps}`,
      ];
      filters.push(`[${idx}:v]${vChain.join(",")}[v${i}]`);
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
      const idx =
        c.kind === "image"
          ? addInput(["-loop", "1", "-t", String(r3(c.duration))], resolveMediaPath(c.mediaId))
          : addInput(
              ["-ss", String(r3((c as VideoClip).sourceIn)), "-t", String(r3(sourceSpanSec(c as VideoClip)))],
              resolveMediaPath(c.mediaId),
            );
      const emph = c.kind === "video" ? emphasisZoompan(c, W, H, fps) : null;
      const vChain = [
        c.kind === "video" ? speedSetpts((c as VideoClip).speed) : "setpts=PTS-STARTPTS",
        `scale=${W}:${H}:force_original_aspect_ratio=increase`,
        `crop=${W}:${H}`,
        ...staticZoomFilters(c, W, H),
        ...(emph ? [emph] : []),
        ...lookFilters(c.look),
        "format=yuv420p",
        `fps=${fps}`,
      ];
      filters.push(`[${idx}:v]${vChain.join(",")}[v${i}]`);
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

  // ---- B-roll / PiP overlays (scaled + positioned, time-gated) ------------
  const broll = collectBroll(doc);
  broll.forEach((clip, i) => {
    const boxW = Math.max(2, Math.round(W * clip.transform.scale));
    const boxH = Math.max(2, Math.round(H * clip.transform.scale));
    const st = r3(clip.start);
    const en = r3(clip.start + clip.duration);
    const idx =
      clip.kind === "image"
        ? addInput(["-loop", "1", "-t", String(r3(clip.duration))], resolveMediaPath(clip.mediaId))
        : addInput(
            ["-ss", String(r3((clip as VideoClip).sourceIn)), "-t", String(r3(clip.duration))],
            resolveMediaPath(clip.mediaId),
          );
    const ovChain = [
      `scale=${boxW}:${boxH}:force_original_aspect_ratio=increase`,
      `crop=${boxW}:${boxH}`,
      ...lookFilters(clip.look),
      "format=yuv420p",
      // Present the b-roll aligned to its timeline start, so it plays from its head.
      `setpts=PTS-STARTPTS+${st}/TB`,
    ];
    filters.push(`[${idx}:v]${ovChain.join(",")}[bov${i}]`);
    // transform.x/y is the box CENTER; overlay x/y is its top-left.
    const ox = Math.round(clip.transform.x - boxW / 2);
    const oy = Math.round(clip.transform.y - boxH / 2);
    const out = `vbr${i}`;
    filters.push(`[${videoLabel}][bov${i}]overlay=${ox}:${oy}:enable='between(t\\,${st}\\,${en})'[${out}]`);
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

  // ---- Extra audio-track clips (e.g. music), delayed + mixed --------------
  const audioClips = collectAudioClips(doc);
  const extraAudioLabels: string[] = [];
  audioClips.forEach(({ clip, trackId }, i) => {
    const idx = addInput(
      ["-ss", String(r3(clip.sourceIn)), "-t", String(r3(clip.duration))],
      resolveMediaPath(clip.mediaId),
    );
    const delayMs = Math.round(clip.start * 1000);
    // Music ducks under speech (auto-mix already sets volume in the doc).
    const chain = [
      "asetpts=PTS-STARTPTS",
      `volume=${r3(clip.volume)}`,
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
