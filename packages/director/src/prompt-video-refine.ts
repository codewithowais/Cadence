/**
 * `refine_video` — the "Regenerate / punchier / shorter / different style" chips as a Director
 * tool. For a video made from a prompt it reads the Storyboard stored on the doc
 * (`doc.textVideo.storyboard`), folds in the user's own text edits, refines it (pure,
 * deterministic) and realises it again. For any OTHER text video (no storyboard) punchier /
 * shorter / different-style still work, directly on the scenes.
 */
import { docDurationSec, type EditDoc } from "@cadence/core";
import { z } from "zod";
import type { DirectorTool } from "./tools";
import { realiseStoryboard, storyboardOf, syncStoryboardWithDoc } from "./prompt-video";
import { punchy, refineStoryboard, type RefineKind } from "./storyboard-stub";
import { GENRE_LABELS, storyboardDuration, type Storyboard } from "./storyboard";
import {
  buildTextVideo,
  isTextVideo,
  restyleTextVideo,
  textVideoScenes,
  TEXT_VIDEO_THEMES,
  type TextVideoTheme,
} from "./textvideo";

export const REFINE_KINDS = ["regenerate", "punchier", "shorter", "longer", "different-style"] as const;

const describe = (sb: Storyboard): string => `${Math.round(storyboardDuration(sb))}s ${GENRE_LABELS[sb.genre].toLowerCase()} · ${sb.scenes.length} scenes · ${sb.aspect} · ${sb.mood}`;

/** A text video that has no stored storyboard: refine its scenes directly. */
function refineTextVideo(doc: EditDoc, kind: RefineKind): { doc: EditDoc; summary: string } {
  const size = { width: doc.meta.width, height: doc.meta.height };
  const scenes = textVideoScenes(doc);
  switch (kind) {
    case "punchier": {
      const tighter = scenes.map((s) => ({
        ...s,
        head: s.kind === "quote" || s.num ? s.head : punchy(s.head),
        ...(s.durationSec ? { durationSec: Math.max(1.5, Math.round(s.durationSec * 0.82 * 10) / 10) } : {}),
      }));
      return { doc: buildTextVideo(doc, { scenes: tighter, size, pace: "fast" }), summary: "Made it punchier: tighter wording and a faster pace." };
    }
    case "shorter": {
      if (scenes.length <= 3) {
        // Too few scenes to drop any: tighten every scene's timing instead.
        const quick = scenes.map((s) => ({ ...s, ...(s.durationSec ? { durationSec: Math.max(1.5, Math.round(s.durationSec * 0.75 * 10) / 10) } : {}) }));
        return { doc: buildTextVideo(doc, { scenes: quick, size }), summary: "Made it shorter: every scene is about 25% quicker (there were too few scenes to drop any)." };
      }
      // Drop ~30% of the middle scenes, evenly spread; the opener and the closer always stay.
      const interior = scenes.length - 2;
      const drop = Math.min(interior - 1, Math.max(1, Math.round(scenes.length * 0.3)));
      const dropSet = new Set<number>();
      for (let k = 0; k < drop; k++) dropSet.add(1 + Math.min(interior - 1, Math.floor(((k + 0.5) * interior) / drop)));
      const trimmed = scenes.filter((_, i) => !dropSet.has(i));
      return { doc: buildTextVideo(doc, { scenes: trimmed, size }), summary: `Made it shorter: ${scenes.length} → ${trimmed.length} scenes.` };
    }
    case "different-style": {
      const cur = TEXT_VIDEO_THEMES.indexOf((doc.textVideo?.theme ?? "bold") as TextVideoTheme);
      const next = TEXT_VIDEO_THEMES[(cur + 1) % TEXT_VIDEO_THEMES.length]!;
      return { doc: restyleTextVideo(doc, next), summary: `Gave it a different style: the ${next} theme.` };
    }
    default:
      throw new Error("That needs the original description — describe a video first (for example “30s promo for my coffee shop”), then I can write a fresh version.");
  }
}

export const refineVideoTool: DirectorTool<{ kind: RefineKind }> = {
  name: "refine_video",
  description:
    "Refine a video that was made from a prompt (make_video_from_prompt): `regenerate` (fresh copy + visuals, same brief), `punchier` (tighter wording, faster pace, bolder look), `shorter` / `longer` (re-plan at ~70% / ~140% of the length) or `different-style` (next theme, palette and music, same words). Your edits to scene text are kept by punchier / different-style. punchier / shorter / different-style also work on any text video.",
  inputSchema: z.object({ kind: z.enum(REFINE_KINDS) }),
  async execute(input, ctx) {
    const stored = storyboardOf(ctx.project.doc);
    if (!stored) {
      if (!isTextVideo(ctx.project.doc)) {
        throw new Error("There's no video to refine yet — describe one first (for example “30s promo for my coffee shop”).");
      }
      const r = refineTextVideo(ctx.project.doc, input.kind);
      ctx.project.setDoc(r.doc);
      return { summary: r.summary, durationSec: docDurationSec(ctx.project.doc) };
    }
    const synced = syncStoryboardWithDoc(stored, ctx.project.doc);
    const next = refineStoryboard(synced, input.kind, ctx.project.media);
    const r = await realiseStoryboard(ctx.project, next);
    const label: Record<RefineKind, string> = {
      regenerate: "Wrote a fresh version",
      punchier: "Made it punchier",
      shorter: "Made it shorter",
      longer: "Made it longer",
      "different-style": "Gave it a different style",
    };
    return {
      summary: `${label[input.kind]}: ${describe(next)}.${r.warnings.length ? ` Note: ${r.warnings.join(" ")}` : ""}`,
      durationSec: docDurationSec(ctx.project.doc),
    };
  },
};
