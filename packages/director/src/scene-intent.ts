/**
 * Plain-language → `split_into_scenes` input. Pure + deterministic (the stub
 * Director's rules; the real Claude Director calls the tool directly).
 *
 *   "split this video into scenes"            → { method: "scenes" }
 *   "divide into clips" / "cut at every scene change"
 *   "chop every 5 seconds" / "split into 10 second clips"  → { method: "interval", every }
 *   "split by sentence"                        → { method: "sentences" }
 *   "split at the pauses" / "divide on silences" → { method: "silence" }
 *   "split on every beat" / "chop to the beat" → { method: "beats" }
 *
 * `rest` is the request with the matched phrase removed, so the other parsers
 * never double-read it ("cut every 5 seconds" must not also look like a
 * highlight request).
 */
import type { SplitIntoScenesToolInput } from "./tools";

export interface SceneIntent {
  input: SplitIntoScenesToolInput;
  rest: string;
}

const SPLIT_VERB = String.raw`(?:split|divide|break|chop|separate|slice|cut)`;
const UNIT = String.raw`(?:scenes?|shots?|clips?|parts?|pieces?|sections?|segments?|chunks?)`;
const NUM = String.raw`(\d+(?:\.\d+)?)`;
const SECS = String.raw`(?:-|\s)?\s*(?:seconds?|secs?|s)\b`;

function sensitivityOf(req: string): number | undefined {
  if (/\b(?:very|more|highly|super|extra)\s+sensitive|high(?:er)? sensitivity|catch (?:every|all|more)|every (?:little|small|tiny)|fine[- ]grained/.test(req)) return 0.8;
  if (/\bless sensitive|low(?:er)? sensitivity|only (?:the )?(?:major|big|obvious|main|clear)|just (?:the )?(?:major|big|obvious|main)|\bfewer\b/.test(req)) return 0.25;
  return undefined;
}

function minShotOf(req: string): number | undefined {
  const m = req.match(new RegExp(String.raw`(?:at least|no shorter than|minimum(?: of)?|min(?:imum)? shot)\s+${NUM}\s*(?:seconds?|secs?|s)\b`));
  return m ? Number(m[1]) : undefined;
}

/** `null` when the request isn't about dividing a video into clips. */
export function parseSceneSplit(req: string): SceneIntent | null {
  const r = req.toLowerCase();
  const mk = (m: RegExpMatchArray, input: SplitIntoScenesToolInput): SceneIntent => ({
    input: { ...input, ...(sensitivityOf(r) !== undefined ? { sensitivity: sensitivityOf(r) } : {}), ...(minShotOf(r) !== undefined ? { minShotSec: minShotOf(r) } : {}) },
    rest: r.replace(m[0], " "),
  });

  // Fixed interval: "chop every 5 seconds", "split into 10 second clips".
  let m = r.match(new RegExp(String.raw`\b${SPLIT_VERB}\b[^.,;]*?\bevery\s+${NUM}${SECS}`)) ?? r.match(new RegExp(String.raw`\b${SPLIT_VERB}\b[^.,;]*?\binto\s+${NUM}${SECS}\s+${UNIT}`));
  if (m) return mk(m, { method: "interval", every: Number(m[1]) });
  m = r.match(new RegExp(String.raw`\b${SPLIT_VERB}\b[^.,;]*?\bevery\s+minute\b`));
  if (m) return mk(m, { method: "interval", every: 60 });

  // By sentence.
  m = r.match(new RegExp(String.raw`\b${SPLIT_VERB}\b[^.,;]*?\b(?:by|per|at|into|on)\s+(?:each\s+|every\s+|the\s+)?sentences?\b`)) ?? r.match(/\bone clip (?:per|for each|for every) sentence\b/);
  if (m) return mk(m, { method: "sentences" });

  // By silence / pauses (split-type verbs only — "cut the silence" means REMOVE it).
  m = r.match(/\b(?:split|divide|break|chop|separate|slice)\b[^.,;]*?\b(?:at|on|by|wherever there(?:'s| is)(?: a)?|where there(?:'s| is)(?: a)?)\s+(?:each\s+|every\s+|the\s+|long\s+)?(?:silences?|pauses?|gaps?|dead ?air)\b/);
  if (m) return mk(m, { method: "silence" });

  // By beat.
  m = r.match(/\b(?:split|divide|chop|slice|separate)\b[^.,;]*?\b(?:on|at|to|by)\s+(?:each\s+|every\s+|the\s+)?beats?\b/);
  if (m) return mk(m, { method: "beats" });

  // By scene: "cut at every scene change", "detect scenes", "split into scenes", "divide into clips".
  m =
    r.match(/\bcut\b[^.,;]*?\b(?:at|on)\s+(?:each\s+|every\s+|the\s+)?(?:scene|shot)\s*(?:change|cut|transition|boundar(?:y|ies))s?\b/) ??
    r.match(new RegExp(String.raw`\b${SPLIT_VERB}\b[^.,;]*?\b(?:into|by|at|on|up)\s+(?:its\s+|the\s+|each\s+|every\s+|separate\s+|individual\s+|different\s+|distinct\s+|multiple\s+|several\s+)*${UNIT}\b`)) ??
    r.match(/\b(?:detect|find|auto[- ]?detect)\s+(?:the\s+|all\s+)?(?:scenes?|shots?|scene changes?|scene cuts?)\b/) ??
    r.match(/\bscene (?:detection|split|splitting)\b/);
  if (m) {
    // "cut it into N parts" is a count, not scenes — leave that to other parsers.
    if (/\b(?:into|in)\s+\d+\s+(?:parts?|pieces?|chunks?|sections?|segments?)\b/.test(m[0]) && !/scene|shot/.test(m[0])) return null;
    return mk(m, { method: "scenes" });
  }
  return null;
}

/** True when the request needs frame analysis (scene detection) before the Director runs. */
export function wantsSceneDetection(request: string): boolean {
  return parseSceneSplit(request)?.input.method === "scenes";
}
