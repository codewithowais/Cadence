import type { ColorGrade, EditDoc } from "@cadence/core";

/** The looks the Color room offers, mirrored from @cadence/director's presets. */
export const LOOKS = [
  { key: "warm", label: "Warm" },
  { key: "cool", label: "Cool" },
  { key: "vivid", label: "Vivid" },
  { key: "cinematic", label: "Cinematic" },
  { key: "vintage", label: "Vintage" },
  { key: "noir", label: "Noir" },
  { key: "vibrant", label: "Vibrant" },
  { key: "bw", label: "B & W" },
  { key: "none", label: "None" },
] as const;

export type LookKey = (typeof LOOKS)[number]["key"];

/**
 * Grade signatures (brightness/contrast/saturation/warmth), mirrored from
 * @cadence/director's LOOK_PRESETS so we can name the look a clip carries. Kept
 * here (not imported) so the web app doesn't take a dependency on the director.
 */
const LOOK_SIGNATURES: { key: Exclude<LookKey, "none">; label: string; g: ColorGrade }[] = [
  { key: "warm", label: "Warm", g: { brightness: 1.03, contrast: 1.05, saturation: 1.08, warmth: 0.5 } },
  { key: "cool", label: "Cool", g: { brightness: 1.0, contrast: 1.06, saturation: 1.04, warmth: 0.0 } },
  { key: "vivid", label: "Vivid", g: { brightness: 1.02, contrast: 1.1, saturation: 1.35, warmth: 0.1 } },
  { key: "bw", label: "B & W", g: { brightness: 1.02, contrast: 1.12, saturation: 0, warmth: 0 } },
  { key: "cinematic", label: "Cinematic", g: { brightness: 0.98, contrast: 1.14, saturation: 0.95, warmth: 0.22 } },
  { key: "vintage", label: "Vintage", g: { brightness: 1.02, contrast: 0.95, saturation: 0.82, warmth: 0.55 } },
  { key: "noir", label: "Noir", g: { brightness: 0.96, contrast: 1.22, saturation: 0, warmth: 0 } },
  { key: "vibrant", label: "Vibrant", g: { brightness: 1.04, contrast: 1.08, saturation: 1.45, warmth: 0.12 } },
];

const isNeutral = (g: ColorGrade): boolean =>
  g.brightness === 1 && g.contrast === 1 && g.saturation === 1 && g.warmth === 0;

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.02;

const matchLook = (g: ColorGrade): string | null => {
  for (const s of LOOK_SIGNATURES) {
    if (near(g.brightness, s.g.brightness) && near(g.contrast, s.g.contrast) && near(g.saturation, s.g.saturation) && near(g.warmth, s.g.warmth))
      return s.label;
  }
  return "Graded";
};

/** Greatest-common-divisor aspect label, e.g. "9:16", "16:9", "1:1". */
function aspectLabel(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(w, h) || 1;
  return `${w / d}:${h / d}`;
}

export interface DocStatus {
  aspect: string;
  /** Human look name if any visual clip carries a non-neutral grade, else null. */
  look: string | null;
  /** Quality label when preset !== "standard", else null. */
  quality: string | null;
  /** True when a captions track is present. */
  captions: boolean;
  /** True when a music track or any audio clip is present. */
  music: boolean;
  /** Number of visual (video/image) clips. */
  cuts: number;
}

/** Read the current doc into a compact "what's applied" summary for the UI. */
export function describeDoc(doc: EditDoc): DocStatus {
  let look: string | null = null;
  let cuts = 0;
  let music = false;
  let captions = false;

  for (const track of doc.tracks) {
    if (track.id === "captions") captions = true;
    if (track.id === "music") music = true;
    for (const clip of track.clips) {
      if (clip.kind === "video" || clip.kind === "image") {
        cuts += 1;
        if (!look && !isNeutral(clip.look)) look = matchLook(clip.look);
      }
      if (clip.kind === "audio") music = true;
    }
  }

  const preset = doc.quality.preset;
  let quality: string | null = null;
  if (preset !== "standard") {
    const w = doc.quality.targetWidth;
    const h = doc.quality.targetHeight;
    const dims = w && h ? ` ${w}×${h}` : "";
    const is4k = (w ?? 0) >= 3840 || preset === "ultra";
    quality = `${is4k ? "4K" : "High"}${dims}`;
  }

  return {
    aspect: aspectLabel(doc.meta.width, doc.meta.height),
    look,
    quality,
    captions,
    music,
    cuts,
  };
}
