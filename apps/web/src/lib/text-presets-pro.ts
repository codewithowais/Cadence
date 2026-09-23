/**
 * Animated, effect-rich TEXT STYLE presets (Canva "text styles"): each is a font
 * from the bundled library + colors + an effect + an intro/loop/exit animation.
 * One click drops a fully-styled text clip at the playhead; it stays editable in
 * Style / Animate. Pure: built from insertTextOverlay + patchText.
 */
import { FONT_LIBRARY, fontStack, parseEditDoc, type EditDoc, type TextClip } from "@cadence/core";
import { insertTextOverlay } from "./text-presets";
import { lastTitleId, patchText } from "./text-edit";

const f = (family: string): string => {
  const face = FONT_LIBRARY.find((x) => x.family === family);
  return face ? fontStack(face) : `${family}, sans-serif`;
};

type Patch = Parameters<typeof patchText>[2];

export interface ProTextPreset {
  key: string;
  label: string;
  sample: string;
  /** Font size as a fraction of the frame's short edge. */
  size: number;
  /** Placement (fractions of the frame). */
  x?: number;
  y?: number;
  patch: Patch;
}

export const PRO_TEXT_PRESETS: ProTextPreset[] = [
  { key: "neon-sign", label: "Neon sign", sample: "Open late", size: 0.1, patch: { fontFamily: f("Righteous"), color: "#ff3df2", effect: { style: "neon", intensity: 0.7, offset: 0.5, direction: -45 }, anim: { style: "neon", durationSec: 0.9, loop: { style: "flicker", speed: 0.6, amount: 0.25 } } } },
  { key: "retro-shadow", label: "Retro shadow", sample: "Groovy", size: 0.12, patch: { fontFamily: f("Abril Fatface"), color: "#fffaf0", effect: { style: "echo", color: "#2b1208", intensity: 1, offset: 0.45, direction: -45 }, anim: { style: "drop", unit: "word", durationSec: 0.8 } } },
  { key: "glitch", label: "Glitch", sample: "SYSTEM ERROR", size: 0.09, patch: { fontFamily: f("Space Grotesk"), fontWeight: "bold", color: "#ffffff", effect: { style: "glitch", intensity: 0.6, offset: 0.5, direction: -45 }, anim: { style: "glitch", durationSec: 0.8 } } },
  { key: "hollow", label: "Hollow outline", sample: "OUTLINE", size: 0.12, patch: { fontFamily: f("Montserrat"), fontWeight: "bold", uppercase: true, color: "#ffffff", effect: { style: "hollow", intensity: 0.5, offset: 0.5, direction: -45 }, anim: { style: "zoom-in", durationSec: 0.6 } } },
  { key: "gradient-pop", label: "Gradient pop", sample: "Hello!", size: 0.13, patch: { fontFamily: f("Poppins"), fontWeight: "bold", fillGradient: { stops: ["#ff7a18", "#af002d"], angle: 0 }, effect: { style: "lift", intensity: 0.4, offset: 0.5, direction: -45 }, anim: { style: "pop", unit: "letter", durationSec: 0.9 } } },
  { key: "marker", label: "Marker highlight", sample: "Key point", size: 0.08, patch: { fontFamily: f("Inter"), fontWeight: "bold", color: "#111111", effect: { style: "highlight", color: "#ffd54a", intensity: 0.8, offset: 0.25, direction: -45 }, anim: { style: "wipe", unit: "line", durationSec: 0.7 } } },
  { key: "cinematic", label: "Cinematic caps", sample: "THE BEGINNING", size: 0.08, patch: { fontFamily: f("Bebas Neue"), letterSpacing: 14, uppercase: true, color: "#f4efe6", anim: { style: "baseline", unit: "line", durationSec: 1.1, exit: { style: "fade", durationSec: 0.6 } } } },
  { key: "handwritten", label: "Handwritten", sample: "Dear diary…", size: 0.09, patch: { fontFamily: f("Caveat"), fontWeight: "bold", color: "#ffffff", anim: { style: "wipe", unit: "letter", durationSec: 1.2 } } },
  { key: "scramble", label: "Scramble reveal", sample: "DECODED", size: 0.1, patch: { fontFamily: f("Space Grotesk"), fontWeight: "bold", color: "#7df9ff", anim: { style: "scramble", unit: "letter", durationSec: 1.2 } } },
  { key: "word-rise", label: "Word rise", sample: "One word at a time", size: 0.075, patch: { fontFamily: f("Inter"), fontWeight: "bold", color: "#ffffff", effect: { style: "lift", intensity: 0.35, offset: 0.5, direction: -45 }, anim: { style: "rise", unit: "word", durationSec: 0.9, exit: { style: "rise", durationSec: 0.4 } } } },
  { key: "letter-wave", label: "Letter wave", sample: "Wavy!", size: 0.12, patch: { fontFamily: f("Poppins"), fontWeight: "bold", color: "#ffd54a", anim: { style: "pop", unit: "letter", durationSec: 0.8, loop: { style: "wave", speed: 0.8, amount: 0.4 } } } },
  { key: "stomp", label: "Stomp impact", sample: "BOOM", size: 0.16, patch: { fontFamily: f("Anton"), uppercase: true, color: "#ffffff", effect: { style: "lift", intensity: 0.6, offset: 0.5, direction: -45 }, anim: { style: "stomp", durationSec: 0.5, exit: { style: "blow-up", durationSec: 0.35 } } } },
  { key: "blur-focus", label: "Blur focus", sample: "Come into focus", size: 0.08, patch: { fontFamily: f("Playfair Display"), italic: true, color: "#f1d9a0", anim: { style: "blur-in", unit: "word", durationSec: 1.1, exit: { style: "blur-out", durationSec: 0.5 } } } },
  { key: "big-number", label: "Big number", sample: "01", size: 0.3, patch: { fontFamily: f("Montserrat"), fontWeight: "bold", color: "#ffffff66", anim: { style: "rise", durationSec: 0.6 } } },
  { key: "elegant-quote", label: "Elegant quote", sample: "“Less is more.”", size: 0.09, patch: { fontFamily: f("DM Serif Display"), italic: true, color: "#e8c77a", anim: { style: "fade", unit: "word", durationSec: 1 } } },
  { key: "comic", label: "Comic pow", sample: "POW!", size: 0.16, patch: { fontFamily: f("Bangers"), color: "#ffe14d", effect: { style: "splice", color: "#e11d48", intensity: 0.7, offset: 0.6, direction: -45 }, anim: { style: "pop", durationSec: 0.5, loop: { style: "shake", speed: 1, amount: 0.3 } } } },
  { key: "lower-third-bar", label: "Lower third", sample: "Jane Doe · Founder", size: 0.05, x: 0.08, y: 0.84, patch: { fontFamily: f("Poppins"), fontWeight: "semibold", color: "#ffffff", align: "left", box: { style: "box", color: "#0b2545", opacity: 0.9, radius: 6 }, anim: { style: "slide-right", unit: "line", durationSec: 0.6, exit: { style: "slide-left", durationSec: 0.4 } } } },
  { key: "tumble", label: "Tumble in", sample: "Tumble", size: 0.12, patch: { fontFamily: f("Righteous"), color: "#ffffff", anim: { style: "tumble", unit: "word", durationSec: 0.9 } } },
  { key: "chrome", label: "Chrome", sample: "PREMIUM", size: 0.12, patch: { fontFamily: f("Archivo Black"), uppercase: true, fillGradient: { stops: ["#ffffff", "#9aa5b1", "#ffffff"], angle: 90 }, effect: { style: "lift", intensity: 0.5, offset: 0.5, direction: -45 }, anim: { style: "flip", durationSec: 0.7 } } },
  { key: "marker-scrawl", label: "Marker scrawl", sample: "Note to self", size: 0.09, patch: { fontFamily: f("Permanent Marker"), color: "#ffffff", anim: { style: "typewriter", durationSec: 1.2, caret: false } } },
];

/** Insert a pro preset at `startSec` (centered unless the preset places itself). */
export function insertProPreset(doc: EditDoc, preset: ProTextPreset, startSec: number, text?: string): { doc: EditDoc; id: string | null } {
  const short = Math.min(doc.meta.width, doc.meta.height);
  const base = insertTextOverlay(doc, {
    text: (text && text.trim()) || preset.sample,
    startSec,
    durationSec: 4,
    fontSize: Math.round(short * preset.size),
    background: null,
    xFrac: preset.x,
    yFrac: preset.y,
  });
  const id = lastTitleId(base);
  if (!id) return { doc: base, id: null };
  const next = patchText(base, id, {
    transitionInSec: 0,
    transitionOutSec: 0,
    maxWidth: Math.round(doc.meta.width * 0.84),
    ...preset.patch,
    anim: { fromX: 0, fromY: 0, fromScale: 1, unit: "whole", ...(preset.patch.anim ?? {}), exit: { style: "fade", durationSec: 0.35, ...(preset.patch.anim?.exit ?? {}) } },
  });
  return { doc: next, id };
}

/** The preset's text clip on a 240×120 composition, for gallery previews. */
export function presetPreviewClip(preset: ProTextPreset): TextClip {
  const doc = parseEditDoc({ version: 1, meta: { width: 240, height: 120 } });
  const { doc: out, id } = insertProPreset(doc, preset, 0);
  const clip = out.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
  return { ...(clip as TextClip), duration: 2.4, transform: { ...(clip as TextClip).transform, x: preset.x ? 16 : 120 } };
}
