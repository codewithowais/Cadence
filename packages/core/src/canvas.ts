/**
 * CANVAS — pure helpers for custom frame sizes / ratios (no I/O, no DOM).
 *
 * One module shared by the Director tools, the web Canvas panel, the Stage preview, the
 * node canvas and the ffmpeg export plan, so a size typed in the UI, a size asked for in
 * plain language and a size exported are always the same numbers.
 *
 *   - bounds + normalization (even dimensions for yuv420p, 64..7680)
 *   - ratio / size text parsing ("21:9", "1.91:1", "1080x1350", "1080 by 1350")
 *   - a platform preset catalogue + UI safe-zone guides
 *   - `mediaFitRect` — where a picture lands in the frame for Fill vs Fit
 */
import type { CanvasSettings, EditDoc } from "./schema";

export const CANVAS_MIN = 64;
export const CANVAS_MAX = 7680;

/** Round to an even integer inside [CANVAS_MIN, CANVAS_MAX] (libx264/yuv420p needs even). */
export function normalizeDim(n: number): number {
  if (!Number.isFinite(n)) return CANVAS_MIN;
  let r = Math.round(n);
  if (r % 2 !== 0) r += 1;
  if (r > CANVAS_MAX) r = CANVAS_MAX;
  if (r < CANVAS_MIN) r = CANVAS_MIN;
  return r;
}

export interface CanvasSizeCheck {
  ok: boolean;
  /** The normalized (even, clamped) size — always usable even when `ok` is false. */
  width: number;
  height: number;
  /** Human-readable notes: what was adjusted, or why the input was refused. */
  issues: string[];
}

/** Validate + normalize a W×H request. `ok` is false only when the input is unusable. */
export function validateCanvasSize(width: number, height: number): CanvasSizeCheck {
  const issues: string[] = [];
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, width: 1920, height: 1080, issues: ["Width and height must be positive numbers."] };
  }
  const w = normalizeDim(width);
  const h = normalizeDim(height);
  if (Math.round(width) !== w) {
    issues.push(
      width > CANVAS_MAX
        ? `Width capped at ${CANVAS_MAX}px.`
        : width < CANVAS_MIN
          ? `Width raised to the ${CANVAS_MIN}px minimum.`
          : `Width rounded to ${w}px (even sizes only).`,
    );
  }
  if (Math.round(height) !== h) {
    issues.push(
      height > CANVAS_MAX
        ? `Height capped at ${CANVAS_MAX}px.`
        : height < CANVAS_MIN
          ? `Height raised to the ${CANVAS_MIN}px minimum.`
          : `Height rounded to ${h}px (even sizes only).`,
    );
  }
  return { ok: true, width: w, height: h, issues };
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Well-known ratios that read better as a decimal than a reduced fraction (1200×628 …). */
const NAMED_RATIOS: { w: number; h: number; label: string }[] = [
  { w: 191, h: 100, label: "1.91:1" },
  { w: 239, h: 100, label: "2.39:1" },
  { w: 185, h: 100, label: "1.85:1" },
  { w: 21, h: 9, label: "21:9" },
  { w: 16, h: 9, label: "16:9" },
  { w: 9, h: 16, label: "9:16" },
  { w: 4, h: 5, label: "4:5" },
  { w: 3, h: 2, label: "3:2" },
  { w: 2, h: 3, label: "2:3" },
  { w: 4, h: 3, label: "4:3" },
  { w: 3, h: 4, label: "3:4" },
  { w: 1, h: 1, label: "1:1" },
  { w: 5, h: 4, label: "5:4" },
];

/** A readable ratio label for a size: "16:9", "1.91:1", "7:5", else "1.78:1". */
export function ratioLabel(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return "—";
  const v = width / height;
  for (const n of NAMED_RATIOS) {
    if (Math.abs(v / (n.w / n.h) - 1) < 0.006) return n.label;
  }
  const g = gcd(Math.round(width), Math.round(height));
  const rw = Math.round(width) / g;
  const rh = Math.round(height) / g;
  if (rw <= 40 && rh <= 40) return `${rw}:${rh}`;
  return v >= 1 ? `${v.toFixed(2)}:1` : `1:${(1 / v).toFixed(2)}`;
}

/** Swap orientation (portrait ⇄ landscape). */
export function swapOrientation(width: number, height: number): { width: number; height: number } {
  return { width: height, height: width };
}

/**
 * Parse a ratio: "21:9", "1.91:1", "7:5", "16/9", "2.39" (a bare number is W:1),
 * "1.5x1". Returns null when it is not a sane ratio (each side positive, ratio within
 * 1:8..8:1 — beyond that no platform exists and the frame is unusable).
 */
export function parseRatio(text: string): { w: number; h: number } | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  let m = /^(\d+(?:\.\d+)?)[:/](\d+(?:\.\d+)?)$/.exec(t);
  let w: number;
  let h: number;
  if (m) {
    w = Number(m[1]);
    h = Number(m[2]);
  } else {
    m = /^(\d+(?:\.\d+)?)$/.exec(t);
    if (!m) return null;
    w = Number(m[1]);
    h = 1;
  }
  if (!(w > 0) || !(h > 0)) return null;
  const v = w / h;
  if (v > 8 || v < 1 / 8) return null;
  return { w, h };
}

/** The size for a ratio at a chosen edge (long edge by default; 1080 ≈ HD-class). */
export function sizeForRatio(
  ratio: { w: number; h: number },
  opts: { longEdge?: number; width?: number; height?: number } = {},
): { width: number; height: number } {
  const v = ratio.w / ratio.h;
  let w: number;
  let h: number;
  if (opts.width && opts.width > 0) {
    w = opts.width;
    h = w / v;
  } else if (opts.height && opts.height > 0) {
    h = opts.height;
    w = h * v;
  } else {
    // Default: short edge 1080 (so 21:9 → 2520×1080, 9:16 → 1080×1920, 4:5 → 1080×1350).
    const shortEdge = opts.longEdge ? opts.longEdge / Math.max(v, 1 / v) : 1080;
    if (v >= 1) {
      h = shortEdge;
      w = h * v;
    } else {
      w = shortEdge;
      h = w / v;
    }
  }
  const c = validateCanvasSize(w, h);
  return { width: c.width, height: c.height };
}

/** Keep a ratio while one dimension changes (the UI's link-lock). */
export function linkedSize(
  current: { width: number; height: number },
  edit: { width?: number; height?: number },
): { width: number; height: number } {
  const v = current.width / current.height;
  if (edit.width !== undefined) return { width: edit.width, height: edit.width / v };
  if (edit.height !== undefined) return { width: edit.height * v, height: edit.height };
  return current;
}

export type ParsedSizeRequest =
  | { kind: "size"; width: number; height: number }
  | { kind: "ratio"; w: number; h: number };

/**
 * Parse free text into a size or a ratio: "1080x1350", "1080 × 1350 px", "1080 by 1350",
 * "21:9", "1.91:1". Null when nothing usable is found.
 */
export function parseSizeText(text: string): ParsedSizeRequest | null {
  const t = text.trim().toLowerCase();
  const wh = /(\d{2,5})\s*(?:x|×|by|\*)\s*(\d{2,5})/.exec(t);
  if (wh) return { kind: "size", width: Number(wh[1]), height: Number(wh[2]) };
  const ratio = /(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)/.exec(t);
  if (ratio) {
    const r = parseRatio(`${ratio[1]}:${ratio[2]}`);
    if (r) return { kind: "ratio", ...r };
  }
  return null;
}

// ---- Presets ---------------------------------------------------------------

export interface CanvasPreset {
  id: string;
  platform: string;
  name: string;
  width: number;
  height: number;
  note?: string;
}

/** Platform display order for the grouped list. */
export const CANVAS_PLATFORMS = [
  "YouTube",
  "Shorts · TikTok · Reels",
  "Instagram",
  "Facebook",
  "X (Twitter)",
  "LinkedIn",
  "Pinterest",
  "Snapchat",
  "Twitch",
  "Print",
  "Cinema & classic",
  "Square-ish & GIF",
] as const;

export const CANVAS_PRESETS: readonly CanvasPreset[] = [
  { id: "yt-video", platform: "YouTube", name: "Video", width: 1920, height: 1080 },
  { id: "yt-4k", platform: "YouTube", name: "Video 4K", width: 3840, height: 2160 },
  { id: "yt-banner", platform: "YouTube", name: "Channel banner", width: 2560, height: 1440 },
  { id: "yt-thumb", platform: "YouTube", name: "Thumbnail", width: 1280, height: 720 },
  { id: "shorts", platform: "Shorts · TikTok · Reels", name: "YouTube Shorts", width: 1080, height: 1920 },
  { id: "tiktok", platform: "Shorts · TikTok · Reels", name: "TikTok", width: 1080, height: 1920 },
  { id: "reels", platform: "Shorts · TikTok · Reels", name: "Instagram Reels", width: 1080, height: 1920 },
  { id: "ig-post-sq", platform: "Instagram", name: "Post (square)", width: 1080, height: 1080 },
  { id: "ig-post-pt", platform: "Instagram", name: "Post (portrait)", width: 1080, height: 1350 },
  { id: "ig-post-ls", platform: "Instagram", name: "Post (landscape)", width: 1080, height: 566, note: "1.91:1" },
  { id: "ig-story", platform: "Instagram", name: "Story", width: 1080, height: 1920 },
  { id: "ig-carousel", platform: "Instagram", name: "Carousel slide", width: 1080, height: 1350 },
  { id: "fb-feed", platform: "Facebook", name: "Feed video", width: 1280, height: 720 },
  { id: "fb-sq", platform: "Facebook", name: "Square post", width: 1080, height: 1080 },
  { id: "fb-story", platform: "Facebook", name: "Story", width: 1080, height: 1920 },
  { id: "fb-cover", platform: "Facebook", name: "Cover", width: 1640, height: 624 },
  { id: "x-video", platform: "X (Twitter)", name: "Video", width: 1280, height: 720 },
  { id: "x-sq", platform: "X (Twitter)", name: "Square video", width: 1080, height: 1080 },
  { id: "x-header", platform: "X (Twitter)", name: "Header", width: 1500, height: 500 },
  { id: "li-video", platform: "LinkedIn", name: "Video", width: 1920, height: 1080 },
  { id: "li-sq", platform: "LinkedIn", name: "Square video", width: 1080, height: 1080 },
  { id: "li-vert", platform: "LinkedIn", name: "Vertical video", width: 1080, height: 1350 },
  { id: "li-banner", platform: "LinkedIn", name: "Banner", width: 1584, height: 396 },
  { id: "pin-pin", platform: "Pinterest", name: "Pin (2:3)", width: 1000, height: 1500 },
  { id: "pin-sq", platform: "Pinterest", name: "Square pin", width: 1000, height: 1000 },
  { id: "snap", platform: "Snapchat", name: "Snap / Spotlight", width: 1080, height: 1920 },
  { id: "twitch-clip", platform: "Twitch", name: "Stream / clip", width: 1920, height: 1080 },
  { id: "twitch-banner", platform: "Twitch", name: "Profile banner", width: 1200, height: 480 },
  { id: "a4-portrait", platform: "Print", name: "A4 portrait", width: 2480, height: 3508, note: "300 dpi" },
  { id: "a4-landscape", platform: "Print", name: "A4 landscape", width: 3508, height: 2480, note: "300 dpi" },
  { id: "poster-18x24", platform: "Print", name: "Poster 18×24 in", width: 5400, height: 7200, note: "300 dpi" },
  { id: "ultrawide", platform: "Cinema & classic", name: "Ultrawide 21:9", width: 2560, height: 1080 },
  { id: "scope", platform: "Cinema & classic", name: "Cinema scope 2.39:1", width: 2048, height: 858 },
  { id: "flat", platform: "Cinema & classic", name: "Cinema flat 1.85:1", width: 1998, height: 1080 },
  { id: "classic-43", platform: "Cinema & classic", name: "Classic 4:3", width: 1440, height: 1080 },
  { id: "photo-32", platform: "Cinema & classic", name: "Photo 3:2", width: 1620, height: 1080 },
  { id: "gif-sq", platform: "Square-ish & GIF", name: "GIF square", width: 480, height: 480 },
  { id: "gif-wide", platform: "Square-ish & GIF", name: "GIF wide", width: 640, height: 360 },
  { id: "sq-54", platform: "Square-ish & GIF", name: "5:4 classic", width: 1350, height: 1080 },
  { id: "sq-75", platform: "Square-ish & GIF", name: "7:5 frame", width: 1512, height: 1080 },
];

/** Presets grouped in display order. */
export function groupedPresets(): { platform: string; presets: CanvasPreset[] }[] {
  return CANVAS_PLATFORMS.map((platform) => ({
    platform,
    presets: CANVAS_PRESETS.filter((p) => p.platform === platform),
  })).filter((g) => g.presets.length > 0);
}

/** The "resize for all social platforms" set — one size per distinct frame. */
export const SOCIAL_MAGIC_SET: readonly string[] = [
  "yt-video",
  "tiktok",
  "ig-post-pt",
  "ig-post-sq",
  "li-video",
  "pin-pin",
];

export function findPreset(id: string): CanvasPreset | undefined {
  return CANVAS_PRESETS.find((p) => p.id === id);
}

/** The preset a size equals exactly, if any (first match in catalogue order). */
export function presetForSize(width: number, height: number): CanvasPreset | undefined {
  return CANVAS_PRESETS.find((p) => p.width === width && p.height === height);
}

// ---- Safe zones ------------------------------------------------------------

export type SafeZoneId = "off" | "title" | "tiktok" | "reels" | "shorts";

export interface SafeZoneGuide {
  id: SafeZoneId;
  label: string;
  note: string;
  /** Insets as FRACTIONS of the frame (0..1) of the area clear of platform UI. */
  insets: { top: number; bottom: number; left: number; right: number };
}

/**
 * Approximate UI-safe areas, as fractions of the frame (so they scale to any size).
 * Platform UIs shift over time, so these are conservative guides, not guarantees.
 */
export const SAFE_ZONES: readonly SafeZoneGuide[] = [
  { id: "title", label: "Title safe (90%)", note: "Broadcast title-safe: keep text inside 90% of the frame.", insets: { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 } },
  { id: "tiktok", label: "TikTok UI", note: "Keep clear of the top search bar, right-hand buttons and the caption/sound area.", insets: { top: 0.09, bottom: 0.22, left: 0.05, right: 0.14 } },
  { id: "reels", label: "Reels UI", note: "Keep clear of the top bar, right-hand buttons and the caption area.", insets: { top: 0.12, bottom: 0.22, left: 0.05, right: 0.12 } },
  { id: "shorts", label: "Shorts UI", note: "Keep clear of the right-hand buttons and the title/channel strip.", insets: { top: 0.07, bottom: 0.2, left: 0.05, right: 0.13 } },
];

export function safeZoneRect(
  id: SafeZoneId,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | null {
  const g = SAFE_ZONES.find((z) => z.id === id);
  if (!g) return null;
  const x = g.insets.left * width;
  const y = g.insets.top * height;
  return { x, y, w: width - x - g.insets.right * width, h: height - y - g.insets.bottom * height };
}

// ---- Fit / Fill ------------------------------------------------------------

/** The doc's fit mode ("fill" when unset — the legacy cover behavior). */
export function canvasFitMode(doc: Pick<EditDoc, "meta">): "fill" | "fit" {
  return doc.meta.canvas?.fit === "fit" ? "fit" : "fill";
}

export interface MediaFitRect {
  x: number;
  y: number;
  w: number;
  h: number;
  mode: "fill" | "fit";
}

/**
 * Where a picture of `srcW`×`srcH` lands in a `frameW`×`frameH` frame: cover (Fill) or
 * contain (Fit), always centered, never stretched (uniform scale). A missing/zero source
 * size is treated as the frame's own aspect (⇒ no bars).
 */
export function mediaFitRect(
  mode: "fill" | "fit",
  srcW: number | undefined,
  srcH: number | undefined,
  frameW: number,
  frameH: number,
): MediaFitRect {
  const sw = srcW && srcW > 0 ? srcW : frameW;
  const sh = srcH && srcH > 0 ? srcH : frameH;
  const k = mode === "fit" ? Math.min(frameW / sw, frameH / sh) : Math.max(frameW / sw, frameH / sh);
  const w = sw * k;
  const h = sh * k;
  return { x: (frameW - w) / 2, y: (frameH - h) / 2, w, h, mode };
}

/** Blur radius (px) for the blurred-background fill at a frame size. */
export function blurRadiusFor(canvas: Pick<CanvasSettings, "blur"> | undefined, frameW: number, frameH: number): number {
  const s = canvas?.blur ?? 0.6;
  return Math.max(2, Math.round(Math.min(frameW, frameH) * 0.025 * (0.4 + s * 1.2)));
}
