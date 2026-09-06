/**
 * StubDirector — deterministic, offline, free stand-in for the real Claude
 * Director. It parses a plain-language request, detects one or more intents,
 * and runs the matching typed tools IN ORDER (builders first, then transforms),
 * so custom multi-step scenarios work, e.g.:
 *   "cut a 30s highlight, make it vertical with captions and a warm look"
 * The real Director swaps this rules brain for an LLM but calls the same tools.
 */
import { docDurationSec, type ColorGrade, type EditDoc } from "@cadence/core";
import type { ProjectState } from "./project";
import type { TransitionType } from "@cadence/core";
import {
  adjustColorTool,
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
  speedTool,
  styleCaptionsTool,
  titleTool,
  transitionTool,
  vfxTool,
  zoomTool,
  type ToolCall,
} from "./tools";
import { currentGrade } from "./edits";
import type { BrollCorner, CaptionStyleOpts, TitleAnimStyle, TitleStyle } from "./edits";
import type { AspectKey, LookKey, QualityKey } from "./edits";

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

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
  if (/2\.39|2\.40|2\.35|anamorphic|cinemascope|\bscope\b|letterbox/.test(req)) return "2.39:1";
  if (/21:9|ultra ?wide/.test(req)) return "21:9";
  if (/1:1|square/.test(req)) return "1:1";
  if (/2:3|tall portrait/.test(req)) return "2:3";
  if (/4:5|portrait/.test(req)) return "4:5";
  if (/4:3|fullscreen|full ?screen|\bclassic\b/.test(req)) return "4:3";
  if (/16:9|widescreen|landscape|horizontal/.test(req)) return "16:9";
  if (/reframe|resize|aspect/.test(req)) return "9:16";
  return null;
}

/**
 * Parse a custom width×height ("reframe to 1600x900", "make it 1200 by 675").
 * Requires both dimensions to be 3–5 digits so it never collides with a speed /
 * zoom factor like "1.5x". Returns null when no explicit WxH is present.
 */
function parseCustomReframe(req: string): { width: number; height: number } | null {
  const m = req.match(/(\d{3,5})\s*(?:[x×]|by)\s*(\d{3,5})/);
  if (!m) return null;
  return { width: parseInt(m[1]!, 10), height: parseInt(m[2]!, 10) };
}

function parseLook(req: string): LookKey | null {
  if (/\b(no|remove|reset)\s+(look|grade|colou?r|filter)\b/.test(req)) return "none";
  if (/bleach.?bypass|silver.?retention/.test(req)) return "bleach-bypass";
  if (/golden.?hour|sunset|magic hour/.test(req)) return "golden-hour";
  if (/\bmatte\b|faded look|lifted blacks?|washed film/.test(req)) return "matte";
  if (/\bmoody\b|dark and? moody|somber|broody/.test(req)) return "moody";
  if (/noir/.test(req)) return "noir";
  if (/black.?and.?white|b\s?&\s?w|grayscale|greyscale|monochrome/.test(req)) return "bw";
  if (/vintage|retro|old ?film|nostalg/.test(req)) return "vintage";
  if (/cinematic|film(ic)?|movie/.test(req)) return "cinematic";
  if (/vibrant/.test(req)) return "vibrant";
  // "punch/punchy" as a LOOK only when it isn't a punch-IN emphasis request.
  if (/\bpunch(y)?\b/.test(req) && !/punch.?in|push in/.test(req)) return "punch";
  if (/vivid|saturat/.test(req)) return "vivid";
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

function parseKineticTitle(req: string, original: string): { text: string; style: TitleAnimStyle } | null {
  const wantsKinetic =
    /\bkinetic\b|animated title|title that (slides|animates|pops|bounces|moves|flies)|slide.?in title|pop.?in title|bounce.?in title|animate (the )?title|(pop|bounce|bouncing|bouncy)\s+title|title that pops/.test(
      req,
    );
  if (!wantsKinetic) return null;
  const style: TitleAnimStyle = /\bbounce|bouncing|bouncy\b/.test(req)
    ? "bounce"
    : /\bpops?\b|pop.?in/.test(req)
      ? "pop"
      : "kinetic";
  const quoted = original.match(/["“'“”]([^"“”']{1,60})["“”']/);
  let text = quoted?.[1] ?? null;
  if (!text) {
    const m = original.match(/(?:titled|that says|called|saying|title:?)\s+(.+)$/i);
    if (m) text = m[1]!.trim().replace(/[.]+$/, "");
  }
  return { text: text ?? "Title", style };
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

/** Parse a bare speed factor like "2x", "0.5 x", "0.25x". */
function parseSpeedFactor(req: string): number | undefined {
  const x = req.match(/(\d+(?:\.\d+)?)\s*x\b/);
  if (x) return parseFloat(x[1]!);
  if (/half speed/.test(req)) return 0.5;
  if (/double speed|twice as fast/.test(req)) return 2;
  return undefined;
}

/**
 * Parse a speed-ramp request → a multiplier. Handles "slow motion / slow it
 * down / speed up / 2x / 0.5x". Returns null when the request isn't about speed.
 * A bare "Nx" only counts as speed when no punch-in/zoom context is present
 * (those own the zoom factor).
 */
function parseSpeed(req: string): number | undefined {
  if (/slow ?mo(tion)?|slo-?mo|slow it down|slow down|half speed/.test(req)) {
    return parseSpeedFactor(req) ?? 0.5;
  }
  if (/speed (it |the )?up|speed up|fast ?forward|faster|double speed|twice as fast/.test(req)) {
    return parseSpeedFactor(req) ?? 2;
  }
  if (/\bspeed\b/.test(req)) {
    return parseSpeedFactor(req); // "set speed to 1.5x"; undefined ⇒ skip (ambiguous)
  }
  // A bare factor ("make it 2x", "0.5x") means speed only if not a zoom/punch cmd.
  if (!/punch|zoom|emphasi|reframe|crop/.test(req)) return parseSpeedFactor(req);
  return undefined;
}

/**
 * Parse a manual (static) zoom/reframe → { scale, pan }. Handles "zoom in 1.5x",
 * "zoom to 2x", "crop to the center", "reframe". Distinct from the animated
 * punch-in emphasis ("punch in"). Returns null when not a reframe request.
 */
function parseZoomReframe(req: string): { scale?: number; panXFrac?: number; panYFrac?: number } | null {
  // "zoom in/to" or "crop" (a static reframe). NOT bare "reframe"/"resize" —
  // those mean an aspect-ratio change (parseAspect owns them).
  const isReframe = /zoom (in|to)|\bcrop\b/.test(req);
  if (!isReframe) return null;
  const scale = parseZoom(req);
  let panXFrac = 0;
  let panYFrac = 0;
  if (/\bleft\b/.test(req)) panXFrac = -0.18;
  if (/\bright\b/.test(req)) panXFrac = 0.18;
  if (/\btop\b|\bup\b/.test(req)) panYFrac = -0.18;
  if (/\bbottom\b|\bdown\b/.test(req)) panYFrac = 0.18;
  return { scale, panXFrac: panXFrac || undefined, panYFrac: panYFrac || undefined };
}

/** Parse a transition style ("dip to black / slide / wipe / dissolve / zoom / smooth"). */
function parseTransition(req: string): TransitionType | null {
  if (/dip.?to.?black|dip to black|fade through black/.test(req)) return "dip-to-black";
  if (/wipe/.test(req)) return "wipe";
  if (/dissolve/.test(req)) return "dissolve";
  if (/zoom (transition|between)|zoom.?in transition|zooming transition/.test(req)) return "zoom";
  if (/smooth (transition|slide|between)|smooth transitions?/.test(req)) return "smooth";
  if (/slide (transition|between)|sliding transition|slide transitions?/.test(req)) return "slide";
  if (/cross.?fade/.test(req)) return "crossfade";
  if (/transition/.test(req)) return "crossfade";
  return null;
}

/**
 * Parse whole-frame VFX overlays ("add a vignette", "film grain", "light leak").
 * Returns null when the request mentions none. Strengths are sensible defaults.
 */
function parseVfx(req: string): { vignette?: number; grain?: number; lightLeak?: boolean } | null {
  const out: { vignette?: number; grain?: number; lightLeak?: boolean } = {};
  if (/vignette|darken (the )?edges|dark edges|edge darkening/.test(req)) out.vignette = 0.5;
  if (/grain|film.?grain|grainy|noise texture|add noise/.test(req)) out.grain = 0.35;
  if (/light.?leak|lens flare|leak of light|warm leak/.test(req)) out.lightLeak = true;
  return Object.keys(out).length ? out : null;
}

const CAPTION_COLORS: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  yellow: "#ffe14d",
  red: "#ff4d4d",
  green: "#4dff88",
  blue: "#4db4ff",
  orange: "#ff9f40",
  pink: "#ff6fb5",
};

/**
 * Parse a caption STYLE request ("white captions", "bold yellow captions with a
 * black outline", "captions at the top"). Returns null unless the request is
 * about captions AND names at least one style attribute (color / weight / outline
 * / position / font), so a plain "add captions" still routes to add_captions only.
 */
function parseCaptionStyle(req: string): CaptionStyleOpts | null {
  if (!/caption|subtitle/.test(req)) return null;
  const out: CaptionStyleOpts = {};
  for (const [name, hex] of Object.entries(CAPTION_COLORS)) {
    if (new RegExp(`\\b${name}\\b`).test(req)) {
      out.color = hex;
      break;
    }
  }
  if (/\bbold\b/.test(req)) out.fontWeight = "bold";
  else if (/semi.?bold/.test(req)) out.fontWeight = "semibold";
  else if (/\bmedium weight|medium captions?\b/.test(req)) out.fontWeight = "medium";
  if (/outline|stroke|border|outlined/.test(req)) {
    out.outlineWidth = 6;
    out.outlineColor = /white outline/.test(req) ? "#ffffff" : "#000000";
  }
  if (/at the top|on top|up top|top of (the )?(screen|frame)/.test(req)) out.position = "top";
  else if (/in the (middle|cent(er|re))|cent(er|re)ed captions?/.test(req)) out.position = "center";
  else if (/at the bottom|bottom of (the )?(screen|frame)/.test(req)) out.position = "bottom";
  if (/big(ger)? captions?|large captions?/.test(req)) out.fontSize = 84;
  else if (/small(er)? captions?|tiny captions?/.test(req)) out.fontSize = 40;
  return Object.keys(out).length ? out : null;
}

/**
 * Parse a RELATIVE color adjustment ("brighter", "more contrast", "warmer",
 * "less saturated") into absolute grade targets, computed from the doc's CURRENT
 * grade so repeated nudges accumulate. Returns null when the request isn't a
 * relative tweak (a named preset like "warm look" is handled by parseLook). The
 * comparative forms take precedence over the presets (see interpret()).
 */
function parseColorAdjust(req: string, doc: EditDoc): Partial<ColorGrade> | null {
  const g = currentGrade(doc);
  const out: Partial<ColorGrade> = {};
  const STEP = 0.12;
  if (/brighter|brighten|lighter|more (light|exposure)|raise exposure/.test(req))
    out.brightness = round(clamp(g.brightness + STEP, 0.2, 3));
  if (/darker|darken|dimmer|less (light|exposure|bright)/.test(req))
    out.brightness = round(clamp(g.brightness - STEP, 0.2, 3));
  if (/more contrast|punchier|higher contrast|add contrast|increase contrast/.test(req))
    out.contrast = round(clamp(g.contrast + STEP, 0.2, 3));
  if (/less contrast|flatter|lower contrast|reduce contrast|decrease contrast/.test(req))
    out.contrast = round(clamp(g.contrast - STEP, 0.2, 3));
  if (/more saturat|more colou?r|richer|boost colou?r|deeper colou?r/.test(req))
    out.saturation = round(clamp(g.saturation + 0.15, 0, 3));
  if (/less saturat|desaturat|muted|washed?.?out|reduce colou?r|drain (the )?colou?r/.test(req))
    out.saturation = round(clamp(g.saturation - 0.15, 0, 3));
  if (/warmer|warm it up|more warmth|add warmth/.test(req))
    out.warmth = round(clamp(g.warmth + 0.15, 0, 1));
  if (/cooler|cool it (down|off)|less warmth|more blue|colder/.test(req))
    out.warmth = round(clamp(g.warmth - 0.15, 0, 1));
  return Object.keys(out).length ? out : null;
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
    // A custom width×height ("reframe to 1600x900") wins over a named aspect.
    const custom = parseCustomReframe(req);
    const aspect = parseAspect(req);
    if (custom) {
      const input = { width: custom.width, height: custom.height };
      steps.push({
        run: (p) => reframeTool.execute(input, { project: p }),
        call: { name: reframeTool.name, input },
      });
    } else if (aspect) {
      steps.push({
        run: (p) => reframeTool.execute({ aspect }, { project: p }),
        call: { name: reframeTool.name, input: { aspect } },
      });
    }

    // A relative color tweak ("brighter", "warmer") takes precedence over a
    // preset so "make it warmer" nudges warmth instead of applying the warm look.
    const colorAdjust = parseColorAdjust(req, project.doc);

    const look = parseLook(req);
    if (look && !wantsSlideshow && !colorAdjust) {
      steps.push({
        run: (p) => lookTool.execute({ look }, { project: p }),
        call: { name: lookTool.name, input: { look } },
      });
    }

    if (colorAdjust) {
      steps.push({
        run: (p) => adjustColorTool.execute(colorAdjust, { project: p }),
        call: { name: adjustColorTool.name, input: colorAdjust },
      });
    }

    if (/caption|subtitle|add text|burn.?in|words on screen/.test(req)) {
      steps.push({
        run: (p) => captionsTool.execute({}, { project: p }),
        call: { name: captionsTool.name, input: {} },
      });
    }

    // Caption styling ("white bold captions with an outline", "captions at the top")
    // — runs after add_captions so it styles the freshly-generated caption clips.
    const captionStyle = parseCaptionStyle(req);
    if (captionStyle) {
      steps.push({
        run: (p) => styleCaptionsTool.execute(captionStyle, { project: p }),
        call: { name: styleCaptionsTool.name, input: captionStyle },
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

    // Manual static zoom / reframe (fixed punch-in) — checked before the
    // animated emphasis so "zoom in 1.5x" reframes instead of pulsing.
    const zoomReframe = parseZoomReframe(req);
    if (zoomReframe) {
      const input = { ...zoomReframe, atSec: parseAtSeconds(req) };
      steps.push({
        run: (p) => zoomTool.execute(input, { project: p }),
        call: { name: zoomTool.name, input },
      });
    }

    // Punch-in emphasis (animated scale pulse on the video).
    if (/punch.?in|\bpunch\b|emphasi[sz]|push in/.test(req) && !zoomReframe) {
      const input = { atSec: parseAtSeconds(req), zoom: parseZoom(req) };
      steps.push({
        run: (p) => emphasisTool.execute(input, { project: p }),
        call: { name: emphasisTool.name, input },
      });
    }

    // Speed ramp (slow motion / speed up).
    const speed = parseSpeed(req);
    if (speed !== undefined) {
      const input = { speed, atSec: parseAtSeconds(req) };
      steps.push({
        run: (p) => speedTool.execute(input, { project: p }),
        call: { name: speedTool.name, input },
      });
    }

    // Transition style between clips/photos (crossfade/dip-to-black/slide/wipe/
    // dissolve/zoom/smooth).
    const transition = parseTransition(req);
    if (transition) {
      const input = { type: transition };
      steps.push({
        run: (p) => transitionTool.execute(input, { project: p }),
        call: { name: transitionTool.name, input },
      });
    }

    // Whole-frame VFX overlays ("add a vignette", "film grain", "light leak").
    const vfx = parseVfx(req);
    if (vfx) {
      steps.push({
        run: (p) => vfxTool.execute(vfx, { project: p }),
        call: { name: vfxTool.name, input: vfx },
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
      return 'Try: "make a slideshow", "make it 21:9", "reframe to 1600x900", "golden-hour look", "use dissolve transitions", "add a vignette", or "make it high quality".';
    return 'Try: "cut a 60-second highlight", "remove filler words", "make it vertical with captions", "white bold captions with an outline", "captions at the top", "cinematic look", "bleach-bypass look", "make it 2.39:1", "reframe to 1600x900", "slow motion", "zoom in 1.5x", "punch in at 5s", "smooth transitions", "add a vignette and film grain", "a bouncing title that says …", "add background music", or "make it 4K".';
  }
}
