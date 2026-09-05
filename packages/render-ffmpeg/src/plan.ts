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
  docDurationSec,
  type Clip,
  type ColorGrade,
  type EditDoc,
  type ImageClip,
  type SolidClip,
  type TextClip,
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

/** One drawtext filter for a text clip, time-gated with between(t,start,end). */
function drawtextFor(clip: TextClip): string {
  const { color, alpha } = hexToFfColor(clip.color);
  const tx = Math.round(clip.transform.x);
  const ty = Math.round(clip.transform.y);
  // transform.x/y is the clip anchor; canvas uses center anchor + middle baseline.
  const x =
    clip.align === "center"
      ? `${tx}-text_w/2`
      : clip.align === "right"
        ? `${tx}-text_w`
        : `${tx}`;
  const y = `${ty}-text_h/2`;
  const parts = [
    `text='${escapeDrawtext(clip.text)}'`,
    `x=${x}`,
    `y=${y}`,
    `fontsize=${Math.round(clip.fontSize)}`,
    `fontcolor=${color}${alpha < 1 ? `@${alpha}` : ""}`,
  ];
  // Pill background behind captions.
  if (clip.background) {
    const bg = hexToFfColor(clip.background);
    parts.push("box=1");
    parts.push(`boxcolor=${bg.color}${bg.alpha < 1 ? `@${bg.alpha}` : ""}`);
    parts.push(`boxborderw=${Math.max(6, Math.round(clip.fontSize * 0.3))}`);
  }
  const start = r3(clip.start);
  const end = r3(clip.start + clip.duration);
  parts.push(`enable='between(t\\,${start}\\,${end})'`);
  return `drawtext=${parts.join(":")}`;
}

// --- clip collection --------------------------------------------------------

function collectVisualBase(doc: EditDoc): (VideoClip | ImageClip)[] {
  const base: (VideoClip | ImageClip)[] = [];
  for (const track of doc.tracks) {
    if (track.kind !== "visual") continue;
    for (const clip of track.clips) {
      if (clip.kind === "video" || clip.kind === "image") base.push(clip);
    }
  }
  base.sort((a, b) => a.start - b.start);
  return base;
}

function collectTextClips(doc: EditDoc): TextClip[] {
  const out: TextClip[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) if (clip.kind === "text") out.push(clip);
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
  const addInput = (perInputOpts: string[], path: string): number => {
    inputArgs.push(...perInputOpts, "-i", path);
    inputs.push(path);
    return inputIdx++;
  };

  const filters: string[] = [];
  const base = collectVisualBase(doc);
  const allVideo = base.length > 0 && base.every((c) => c.kind === "video");
  const allImage = base.length > 0 && base.every((c) => c.kind === "image");
  const hasCrossfade = base.some((c) => c.transitionInSec > 0);

  let videoLabel = "";
  let audioLabel: string | null = null;

  if (allVideo) {
    // ---- Video cut + concat (highlight / filler) --------------------------
    const segLabels: string[] = [];
    base.forEach((clip, i) => {
      const c = clip as VideoClip;
      const idx = addInput(["-ss", String(r3(c.sourceIn)), "-t", String(r3(c.duration))], resolveMediaPath(c.mediaId));
      const vChain = [
        "setpts=PTS-STARTPTS",
        `scale=${W}:${H}:force_original_aspect_ratio=increase`,
        `crop=${W}:${H}`,
        ...lookFilters(c.look),
        "format=yuv420p",
      ];
      filters.push(`[${idx}:v]${vChain.join(",")}[v${i}]`);
      const aChain = ["asetpts=PTS-STARTPTS", `volume=${r3(c.volume)}`];
      filters.push(`[${idx}:a]${aChain.join(",")}[a${i}]`);
      segLabels.push(`[v${i}][a${i}]`);
    });
    if (base.length === 1) {
      videoLabel = "v0";
      audioLabel = "a0";
    } else {
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
    // Chain xfades, accumulating offsets.
    let prev = "v0";
    let acc = base[0]!.duration;
    for (let i = 1; i < base.length; i++) {
      const xf = r3(base[i]!.transitionInSec || 0.5);
      const offset = r3(acc - xf);
      const out = i === base.length - 1 ? "vxf" : `vxf${i}`;
      filters.push(`[${prev}][v${i}]xfade=transition=fade:duration=${xf}:offset=${offset}[${out}]`);
      prev = out;
      acc = r3(acc - xf + base[i]!.duration);
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
              ["-ss", String(r3((c as VideoClip).sourceIn)), "-t", String(r3(c.duration))],
              resolveMediaPath(c.mediaId),
            );
      const vChain = [
        "setpts=PTS-STARTPTS",
        `scale=${W}:${H}:force_original_aspect_ratio=increase`,
        `crop=${W}:${H}`,
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
    );
    filters.push(`[${idx}:v]format=yuv420p[vbg]`);
    videoLabel = "vbg";
  }

  // ---- Burn-in captions / titles (drawtext, time-gated) -------------------
  const texts = collectTextClips(doc);
  if (texts.length > 0) {
    const chain = texts.map(drawtextFor).join(",");
    filters.push(`[${videoLabel}]${chain}[vtext]`);
    videoLabel = "vtext";
  }

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
