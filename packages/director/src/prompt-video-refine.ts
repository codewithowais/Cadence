/**
 * `refine_video` — the "Regenerate / punchier / shorter / different style" chips as a Director
 * tool. Reads the Storyboard stored on the doc (`doc.textVideo.storyboard`), folds in the user's
 * own text edits, refines it (pure, deterministic) and realises it again.
 */
import { docDurationSec } from "@cadence/core";
import { z } from "zod";
import type { DirectorTool } from "./tools";
import { realiseStoryboard, storyboardOf, syncStoryboardWithDoc } from "./prompt-video";
import { refineStoryboard, type RefineKind } from "./storyboard-stub";
import { GENRE_LABELS, storyboardDuration, type Storyboard } from "./storyboard";

export const REFINE_KINDS = ["regenerate", "punchier", "shorter", "longer", "different-style"] as const;

const describe = (sb: Storyboard): string => `${Math.round(storyboardDuration(sb))}s ${GENRE_LABELS[sb.genre].toLowerCase()} · ${sb.scenes.length} scenes · ${sb.aspect} · ${sb.mood}`;

export const refineVideoTool: DirectorTool<{ kind: RefineKind }> = {
  name: "refine_video",
  description:
    "Refine a video that was made from a prompt (make_video_from_prompt): `regenerate` (fresh copy + visuals, same brief), `punchier` (tighter wording, faster pace, bolder look), `shorter` / `longer` (re-plan at ~70% / ~140% of the length) or `different-style` (next theme, palette and music, same words). Your edits to scene text are kept by punchier / different-style.",
  inputSchema: z.object({ kind: z.enum(REFINE_KINDS) }),
  async execute(input, ctx) {
    const stored = storyboardOf(ctx.project.doc);
    if (!stored) {
      throw new Error("This project wasn't made from a prompt yet — describe a video first (for example “30s promo for my coffee shop”).");
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
