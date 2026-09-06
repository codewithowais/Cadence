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
  brollTool,
  captionsTool,
  createHighlightTool,
  emphasisTool,
  fadesTool,
  fillerCutTool,
  kineticTitleTool,
  lookTool,
  musicTool,
  qualityTool,
  reframeTool,
  slideshowTool,
  titleTool,
  type ToolCall,
} from "./tools";
import type { BrollCorner, TitleStyle } from "./edits";
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
  // Allow a hyphen or space between the number and its unit ("45-second", "2 min").
  const min = req.match(/(\d+(?:\.\d+)?)[-\s]*(?:m|min|minute)/i);
  if (min) return Math.round(parseFloat(min[1]!) * 60);
  const sec = req.match(/(\d+(?:\.\d+)?)[-\s]*(?:s|sec|second)/i);
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

function parseKineticTitle(req: string, original: string): { text: string } | null {
  const wantsKinetic =
    /\bkinetic\b|animated title|title that (slides|animates|pops|moves|flies)|slide.?in title|animate (the )?title/.test(req);
  if (!wantsKinetic) return null;
  const quoted = original.match(/["“'“”]([^"“”']{1,60})["“”']/);
  let text = quoted?.[1] ?? null;
  if (!text) {
    const m = original.match(/(?:titled|that says|called|saying|title:?)\s+(.+)$/i);
    if (m) text = m[1]!.trim().replace(/[.]+$/, "");
  }
  return { text: text ?? "Title" };
}

function parseBrollCorner(req: string): BrollCorner | undefined {
  if (/top.?left/.test(req)) return "top-left";
  if (/top.?right/.test(req)) return "top-right";
  if (/bottom.?left/.test(req)) return "bottom-left";
  if (/bottom.?right|corner/.test(req)) return "bottom-right";
  if (/cent(er|re)/.test(req)) return "center";
  return undefined;
}

/** Parse an "at Ns" / "at N seconds" timeline offset, if present. */
function parseAtSeconds(req: string): number | undefined {
  const m = req.match(/(?:\bat|from|around)\s+(\d+(?:\.\d+)?)\s*(?:s|sec|second)/i);
  if (m) return parseFloat(m[1]!);
  return undefined;
}

/** Parse a zoom factor like "1.4x", "1.4 x", or "30%" (→ 1.3). */
function parseZoom(req: string): number | undefined {
  const x = req.match(/(\d+(?:\.\d+)?)\s*x\b/);
  if (x) return parseFloat(x[1]!);
  const pct = req.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return 1 + parseFloat(pct[1]!) / 100;
  return undefined;
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
    // "make it <n> seconds/minutes" means a highlight; "make it 4K/1080p" does
    // NOT (that's a quality change), so the duration unit is required here.
    const wantsHighlight =
      /highlight|best (parts|bits|moments)|shorten|make it [\d.]+[-\s]*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b|trim to|\bcut\b.*\d/.test(req);
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

    // B-roll / picture-in-picture overlay.
    if (/b.?roll|overlay|picture.?in.?picture|\bpip\b|cutaway|inset/.test(req)) {
      const corner = parseBrollCorner(req);
      const atSec = parseAtSeconds(req);
      const input = { corner, atSec };
      steps.push({
        run: (p) => brollTool.execute(input, { project: p }),
        call: { name: brollTool.name, input },
      });
    }

    // Kinetic (animated) title takes precedence over a plain title card.
    const kinetic = parseKineticTitle(req, request);
    if (kinetic) {
      steps.push({
        run: (p) => kineticTitleTool.execute(kinetic, { project: p }),
        call: { name: kineticTitleTool.name, input: kinetic },
      });
    }

    const title = !kinetic ? parseTitle(req, request) : null;
    if (title) {
      steps.push({
        run: (p) => titleTool.execute(title, { project: p }),
        call: { name: titleTool.name, input: title },
      });
    }

    // Punch-in emphasis (scale pulse on the video).
    if (/punch.?in|\bpunch\b|emphasi[sz]|zoom in|push in/.test(req)) {
      const input = { atSec: parseAtSeconds(req), zoom: parseZoom(req) };
      steps.push({
        run: (p) => emphasisTool.execute(input, { project: p }),
        call: { name: emphasisTool.name, input },
      });
    }

    // Background music (added before auto-mix so ducking applies to it).
    if (/\bmusic\b|background (track|music|song)|soundtrack|\bsong\b|add (a )?track|score it/.test(req)) {
      steps.push({
        run: (p) => musicTool.execute({}, { project: p }),
        call: { name: musicTool.name, input: {} },
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
    return 'Try: "cut a 60-second highlight", "remove filler words", "make it vertical with captions", "cinematic look", "punch in at 5s", "add b-roll", "an animated title that says …", "add background music", or "make it 4K".';
  }
}
