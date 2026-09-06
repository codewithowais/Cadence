import { parseEditDoc, type EditDoc, type QualityPreset } from "@cadence/core";

/**
 * Client-side export presets. These map a friendly quality choice to concrete
 * `doc.quality` fields (preset + target resolution) so the ffmpeg export path
 * up/down-scales exactly as the Deliver room's NL prompts already do — but as a
 * direct, undoable doc mutation instead of a Director round-trip.
 *
 * Container is UI-only for now: the export route renders .mp4. There is no
 * container/format field in the edit-doc schema, so a webm choice is surfaced
 * as a note and still renders mp4. (See report: would need `meta.container`.)
 */

export type ExportContainer = "mp4" | "webm";

export interface ExportSettings {
  container: ExportContainer;
  preset: QualityPreset;
  fps: number;
}

/** Long-edge target heights per preset (width derived from the doc's aspect). */
const PRESET_TARGET_H: Record<QualityPreset, number> = {
  standard: 1080,
  high: 1440,
  ultra: 2160,
};

export const QUALITY_OPTIONS: { key: QualityPreset; label: string; note: string }[] = [
  { key: "standard", label: "Standard", note: "1080p" },
  { key: "high", label: "High", note: "1440p" },
  { key: "ultra", label: "Ultra", note: "4K" },
];

export const FPS_OPTIONS = [24, 30, 60] as const;

const evenRound = (n: number): number => {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r + 1;
};

/** Target output resolution for a preset, preserving the doc's aspect ratio. */
export function targetResolution(
  doc: EditDoc,
  preset: QualityPreset,
): { width: number; height: number } {
  const aspect = doc.meta.width / doc.meta.height;
  const targetH = PRESET_TARGET_H[preset];
  // Don't downscale below the source for "standard" — keep native if larger.
  const height = preset === "standard" ? Math.min(targetH, doc.meta.height) : targetH;
  return { width: evenRound(height * aspect), height: evenRound(height) };
}

/**
 * Return a new, valid doc with the chosen quality preset, target resolution and
 * fps applied. Standard leaves the native resolution (clears the upscale
 * target); High/Ultra set an explicit target so export up-scales faithfully.
 */
export function applyExportSettings(doc: EditDoc, s: ExportSettings): EditDoc {
  const clone = structuredClone(doc);
  clone.quality.preset = s.preset;
  clone.quality.fps = s.fps;
  if (s.preset === "standard") {
    delete clone.quality.targetWidth;
    delete clone.quality.targetHeight;
  } else {
    const { width, height } = targetResolution(doc, s.preset);
    clone.quality.targetWidth = width;
    clone.quality.targetHeight = height;
  }
  return parseEditDoc(clone);
}

/** Read the doc's current settings back into the popover's initial state. */
export function currentExportSettings(doc: EditDoc): ExportSettings {
  return {
    container: "mp4",
    preset: doc.quality.preset,
    fps: doc.quality.fps ?? doc.meta.fps,
  };
}
