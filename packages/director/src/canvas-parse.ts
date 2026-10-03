/**
 * Plain-language parsing for the canvas tools (StubDirector). PURE.
 *
 * Covers what the named-aspect ("vertical", "square") and "WxH" parsers in the
 * StubDirector don't: any numeric ratio ("21:9", "3:2", "7:5", "1.91:1"), an explicit
 * "1080 by 1350" size, a fit mode ("fit the whole video with a blurred background"),
 * and Magic resize ("resize for all social platforms").
 */
import { parseRatio } from "@cadence/core";
import type { SetCanvasOptions } from "./canvas-ops";

export type CanvasRequest =
  | { kind: "size"; input: SetCanvasOptions }
  | { kind: "fit"; input: SetCanvasOptions };

const PLATFORM_WORDS: [RegExp, string[]][] = [
  [/tik ?tok/, ["tiktok"]],
  [/insta(?:gram)?|\big\b/, ["ig-post-pt", "ig-post-sq", "reels", "ig-story"]],
  [/you ?tube|\byt\b/, ["yt-video", "shorts"]],
  [/linked ?in/, ["li-video", "li-sq"]],
  [/pinterest/, ["pin-pin"]],
  [/facebook|\bfb\b/, ["fb-feed", "fb-sq"]],
  [/twitter|\bx\b/, ["x-video"]],
  [/snap(?:chat)?/, ["snap"]],
  [/twitch/, ["twitch-clip"]],
];

/** "resize for all social platforms" / "magic resize" / "resize for tiktok, instagram and youtube". */
export function parseMagicResize(req: string): { social?: boolean; targets?: string[] } | null {
  if (
    /\bmagic ?resize\b|(?:resize|reformat|adapt|convert|export|make)\b[^.]*\b(?:all|every|each)\s+(?:the\s+)?(?:social\s+)?(?:platforms?|sizes|formats|networks|channels)\b|all social (?:platforms?|sizes|formats|networks|media)/.test(
      req,
    )
  )
    return { social: true };
  if (/\b(?:resize|reformat|adapt)\b/.test(req)) {
    const hits = new Set<string>();
    let platforms = 0;
    for (const [re, ids] of PLATFORM_WORDS) {
      if (re.test(req)) {
        platforms++;
        ids.forEach((i) => hits.add(i));
      }
    }
    if (platforms >= 2) return { targets: [...hits] };
  }
  return null;
}

/** A custom size / ratio / fit-mode request, or null when the text isn't one. */
export function parseCanvasRequest(req: string): CanvasRequest | null {
  const out: SetCanvasOptions = {};
  let sized = false;

  const wh = /(\d{3,5})\s*(?:x|×|by|\*)\s*(\d{3,5})/.exec(req);
  if (wh) {
    out.width = Number(wh[1]);
    out.height = Number(wh[2]);
    sized = true;
  } else if (
    !/\b(?:at|from|until|after|before|between)\s+\d+:\d+/.test(req) &&
    /\b(?:make|set|turn|resize|reframe|change|switch|convert|crop|canvas|aspect|ratio|size|frame|custom)\b/.test(req)
  ) {
    const m = /(?<![\d:.])(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)(?![\d:])/.exec(req);
    if (m) {
      const key = `${m[1]}:${m[2]}`;
      if (parseRatio(key)) {
        out.ratio = key;
        sized = true;
      }
    }
  }

  // Fit / fill.
  const wantsBlur = /\bblur(?:red|ry)?\b/.test(req) && /(?:background|bars?|borders?|edges|fill|sides)/.test(req);
  const wantsFit =
    wantsBlur ||
    /\b(?:fit|keep|show) (?:the )?(?:whole|entire|full|all of the)\b|\bfit (?:it )?(?:to|in|inside|within) (?:the )?(?:frame|canvas)\b|\b(?:black|white|solid|colou?red) (?:bars|borders|background)\b|\bpillar ?box|(?:don'?t|do not|without|no) (?:crop|cropping)\b/.test(
      req,
    );
  const wantsFill = /\b(?:fill|cover) (?:the )?(?:frame|canvas|screen)\b|\bcrop to fill\b|\bzoom to fill\b/.test(req);
  if (wantsFit) {
    out.fit = "fit";
    if (wantsBlur) out.fill = "blur";
    else if (/\b(?:black|white|solid|colou?red)\b/.test(req)) {
      out.fill = "solid";
      out.fillColor = /\bwhite\b/.test(req) ? "#ffffff" : "#000000";
    }
  } else if (wantsFill) {
    out.fit = "fill";
  }

  if (sized) return { kind: "size", input: out };
  if (out.fit) return { kind: "fit", input: out };
  return null;
}
