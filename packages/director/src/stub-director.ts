/**
 * StubDirector — deterministic, offline, free stand-in for the real Claude
 * Director. It parses a plain-language request, detects one or more intents,
 * and runs the matching typed tools IN ORDER (builders first, then transforms),
 * so custom multi-step scenarios work, e.g.:
 *   "cut a 30s highlight, make it vertical with captions and a warm look"
 * The real Director swaps this rules brain for an LLM but calls the same tools.
 */
import { docDurationSec, type EditDoc } from "@cadence/core";
import type { ProjectState } from "./project";
import {
  autoMixTool,
  captionsTool,
  createHighlightTool,
  fadesTool,
  fillerCutTool,
  lookTool,
  qualityTool,
  reframeTool,
  slideshowTool,
  titleTool,
  type ToolCall,
} from "./tools";
import type { TitleStyle } from "./edits";
import type { AspectKey, LookKey, QualityKey } from "./edits";

export interface DirectorResult {
  doc: EditDoc;
  summary: string;
  toolCalls: ToolCall[];
  durationSec: number;
}

interface PlannedStep {
  run: (project: ProjectState) => Promise<{ summary: string; durationSec: number }>;
  call: ToolCall;
}

function parseTargetSeconds(req: string): number {
  const min = req.match(/(\d+(?:\.\d+)?)\s*(?:m|min|minute)/i);
  if (min) return Math.round(parseFloat(min[1]!) * 60);
  const sec = req.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|second)/i);
  if (sec) return Math.round(parseFloat(sec[1]!));
  return 60;
}

function parseAspect(req: string): AspectKey | null {
  if (/9:16|vertical|reels?|shorts|tik ?tok|story|stories/.test(req)) return "9:16";
  if (/1:1|square/.test(req)) return "1:1";
  if (/4:5|portrait/.test(req)) return "4:5";
  if (/16:9|widescreen|landscape|horizontal/.test(req)) return "16:9";
  if (/reframe|resize|aspect/.test(req)) return "9:16";
  return null;
}

function parseLook(req: string): LookKey | null {
  if (/\b(no|remove|reset)\s+(look|grade|colou?r|filter)\b/.test(req)) return "none";
  if (/noir/.test(req)) return "noir";
  if (/black.?and.?white|b\s?&\s?w|grayscale|greyscale|monochrome/.test(req)) return "bw";
  if (/vintage|retro|old ?film|film ?grain|nostalg/.test(req)) return "vintage";
  if (/cinematic|film(ic)?|movie/.test(req)) return "cinematic";
  if (/vibrant/.test(req)) return "vibrant";
  if (/vivid|punchy|pop|saturat/.test(req)) return "vivid";
  if (/warm|golden|cozy|cosy/.test(req)) return "warm";
  if (/cool|cold|blue/.test(req)) return "cool";
  if (/look|grade|colou?r|filter/.test(req)) return "warm";
  return null;
}

function parseTitle(req: string, original: string): { text: string; style: TitleStyle } | null {
  if (!/\btitle\b|title card|lower.?third|name card|intro text/.test(req)) return null;
  const style: TitleStyle = /lower.?third/.test(req) ? "lower-third" : "card";
  const quoted = original.match(/["“'“”]([^"“”']{1,60})["“”']/);
  let text = quoted?.[1] ?? null;
  if (!text) {
    const m = original.match(/(?:titled|that says|called|saying|title:?)\s+(.+)$/i);
    if (m) text = m[1]!.trim().replace(/[.]+$/, "");
  }
  return { text: text ?? "Title", style };
}

function parseQuality(req: string): { preset: QualityKey; aiUpscale: boolean } | null {
  const aiUpscale = /\bai\b.*upscal|upscale.*\bai\b|super.?resolution|super.?res/.test(req);
  if (/4k|ultra|2160/.test(req)) return { preset: "ultra", aiUpscale };
  if (/high.?quality|\bhd\b|1440|sharpen|enhance|crisp|1080p?\+|better quality|improve quality/.test(req))
    return { preset: "high", aiUpscale };
  if (/\bupscale\b|higher quality|more quality|quality/.test(req)) return { preset: "high", aiUpscale };
  return null;
}

export class StubDirector {
  readonly mode = "stub" as const;

  async interpret(request: string, project: ProjectState): Promise<DirectorResult> {
    const req = request.toLowerCase();
    const steps: PlannedStep[] = [];

    // ---- builders (replace the doc); pick at most one ----
    const wantsSlideshow = /slide ?show|photo montage|from (my |these |the )?(photos|pictures|images)|make.*(video|clip).*(photos|pictures|images)/.test(req);
    const wantsHighlight = /highlight|best (parts|bits|moments)|shorten|make it \d|trim to|\bcut\b.*\d/.test(req);
    const wantsFiller = /filler|remove (the )?(um|uh|ums|uhs|pauses|silence|dead ?air)|tighten|clean ?up|remove pauses/.test(req);

    if (wantsSlideshow && project.media.some((m) => m.kind === "image")) {
      const look = parseLook(req) ?? undefined;
      steps.push({
        run: (p) => slideshowTool.execute({ look }, { project: p }),
        call: { name: slideshowTool.name, input: { look } },
      });
    } else if (wantsHighlight) {
      const targetSec = parseTargetSeconds(req);
      steps.push({
        run: (p) => createHighlightTool.execute({ targetSec }, { project: p }),
        call: { name: createHighlightTool.name, input: { targetSec } },
      });
    } else if (wantsFiller) {
      steps.push({
        run: (p) => fillerCutTool.execute({}, { project: p }),
        call: { name: fillerCutTool.name, input: {} },
      });
    }

    // ---- transforms (apply on the current doc, in a sensible order) ----
    const aspect = parseAspect(req);
    if (aspect) {
      steps.push({
        run: (p) => reframeTool.execute({ aspect }, { project: p }),
        call: { name: reframeTool.name, input: { aspect } },
      });
    }

    const look = parseLook(req);
    if (look && !wantsSlideshow) {
      steps.push({
        run: (p) => lookTool.execute({ look }, { project: p }),
        call: { name: lookTool.name, input: { look } },
      });
    }

    if (/caption|subtitle|add text|burn.?in|words on screen/.test(req)) {
      steps.push({
        run: (p) => captionsTool.execute({}, { project: p }),
        call: { name: captionsTool.name, input: {} },
      });
    }

    const title = parseTitle(req, request);
    if (title) {
      steps.push({
        run: (p) => titleTool.execute(title, { project: p }),
        call: { name: titleTool.name, input: title },
      });
    }

    if (/\bfades?\b|fade in|fade out|from black|to black|intro and outro/.test(req)) {
      steps.push({
        run: (p) => fadesTool.execute({}, { project: p }),
        call: { name: fadesTool.name, input: {} },
      });
    }

    if (/auto.?mix|\bmix\b|level (the )?audio|balance (the )?audio|duck|louder|quieter|sound/.test(req)) {
      steps.push({
        run: (p) => autoMixTool.execute({}, { project: p }),
        call: { name: autoMixTool.name, input: {} },
      });
    }

    const quality = parseQuality(req);
    if (quality) {
      steps.push({
        run: (p) => qualityTool.execute(quality, { project: p }),
        call: { name: qualityTool.name, input: quality },
      });
    }

    if (steps.length === 0) {
      return {
        doc: project.doc,
        summary: this.helpMessage(project),
        toolCalls: [],
        durationSec: docDurationSec(project.doc),
      };
    }

    const summaries: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const step of steps) {
      try {
        const res = await step.run(project);
        summaries.push(res.summary);
        toolCalls.push(step.call);
      } catch (err) {
        summaries.push(err instanceof Error ? err.message : "One step couldn't run.");
      }
    }

    return {
      doc: project.doc,
      summary: summaries.join(" "),
      toolCalls,
      durationSec: docDurationSec(project.doc),
    };
  }

  private helpMessage(project: ProjectState): string {
    const hasVideo = project.media.some((m) => m.kind === "video");
    const hasImages = project.media.some((m) => m.kind === "image");
    if (!hasVideo && !hasImages) return "Add a video or some photos to begin.";
    if (hasImages && !hasVideo)
      return 'Try: "make a slideshow", "make it vertical", "warm look", or "make it high quality".';
    return 'Try: "cut a 60-second highlight", "remove filler words", "make it vertical with captions", "cinematic look", "auto-mix audio", or "make it 4K".';
  }
}
