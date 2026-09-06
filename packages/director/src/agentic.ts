/**
 * The agentic loop — PLAN → ACT → VERIFY → CORRECT (AGENTS.md, Ask 4).
 *
 * This is the seam the real Claude Director will self-correct through. It is
 * ENGINE-AGNOSTIC by construction: the caller injects a `RenderEngine` (the
 * interface from @cadence/core), so this module never imports @cadence/render-node.
 * Scripts / evals supply the concrete CanvasRenderEngine.
 *
 *   PLAN / ACT : call the Director's `interpret` (StubDirector today, Claude later).
 *   VERIFY     : `parseEditDoc` the produced doc (schema) THEN render one or more
 *                probe frames (e.g. t=0 and mid-duration) and assert real PNGs.
 *   CORRECT    : if validation OR render throws, capture the error, record a
 *                correction, and retry. The error is fed FORWARD to the Director
 *                (a real LLM re-plans with it in context); the deterministic stub
 *                can't self-revise, so the loop falls back to the last known-good
 *                doc (or a minimal valid doc) so the caller never ends up broken.
 *
 * Returns `{ result, verified, attempts, corrections }`.
 */
import {
  docDurationSec,
  parseEditDoc,
  type EditDoc,
  type RenderEngine,
} from "@cadence/core";
import type { ProjectState } from "./project";
import { StubDirector, type DirectorResult } from "./stub-director";

/** Feedback fed forward to the Director on a corrective retry. */
export interface DirectorFeedback {
  /** The error that made the previous attempt fail verification. */
  previousError: string;
  /** 1-based attempt number this feedback is for (>= 2 on a retry). */
  attempt: number;
}

/**
 * Anything that turns a request into a candidate edit-doc. `StubDirector`
 * satisfies this (its `interpret` ignores the optional `feedback`); the real
 * Claude Director will use `feedback.previousError` to re-plan.
 */
export interface DirectorLike {
  interpret(
    request: string,
    project: ProjectState,
    feedback?: DirectorFeedback,
  ): Promise<DirectorResult>;
}

export interface RunDirectorLoopOptions {
  /** Injected render backend (CanvasRenderEngine in scripts/evals). */
  engine: RenderEngine;
  /**
   * Timeline times (seconds) to render as verification probes. Defaults to
   * `[0, duration/2]` computed from the produced doc.
   */
  probeTimes?: number[];
  /** How many Director attempts before falling back. Default 2. */
  maxAttempts?: number;
  /** Director to drive; defaults to a fresh `StubDirector`. */
  director?: DirectorLike;
}

export interface DirectorLoopResult {
  /** The verified (or best-effort fallback) Director result. */
  result: DirectorResult;
  /** True iff a valid doc rendered non-empty PNGs at every probe time. */
  verified: boolean;
  /** How many Director attempts were made (>= 1). */
  attempts: number;
  /** Human-readable corrections applied along the way (empty on a clean pass). */
  corrections: string[];
}

const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The probe times for a doc: caller-supplied, else t=0 and mid-duration. */
function probeTimesFor(doc: EditDoc, requested?: number[]): number[] {
  if (requested && requested.length > 0) return requested;
  const dur = docDurationSec(doc);
  const times = dur > 0 ? [0, dur / 2] : [0];
  return Array.from(new Set(times));
}

/** True if `data` starts with the PNG signature. */
function isPng(data: Uint8Array): boolean {
  if (data.length < PNG_MAGIC.length) return false;
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (data[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Render every probe frame and assert each is a real, non-empty PNG of the
 * doc's declared size. Throws on the first failure (drives the CORRECT step).
 */
async function verifyRenders(
  engine: RenderEngine,
  doc: EditDoc,
  probeTimes: number[],
): Promise<void> {
  for (const t of probeTimes) {
    const frame = await engine.renderFrame(doc, t);
    if (frame.width !== doc.meta.width || frame.height !== doc.meta.height) {
      throw new Error(
        `probe frame @${t}s size ${frame.width}x${frame.height} != doc ${doc.meta.width}x${doc.meta.height}`,
      );
    }
    if (!frame.data || frame.data.length === 0) {
      throw new Error(`probe frame @${t}s is empty (0 bytes)`);
    }
    if (!isPng(frame.data)) {
      throw new Error(`probe frame @${t}s is not a PNG`);
    }
  }
}

/** A minimal, always-renderable valid edit-doc used as a last-resort fallback. */
function minimalValidDoc(reference?: EditDoc): EditDoc {
  return parseEditDoc({
    version: 1,
    meta: {
      title: reference?.meta.title ?? "Recovered",
      fps: reference?.meta.fps ?? 30,
      width: reference?.meta.width ?? 1920,
      height: reference?.meta.height ?? 1080,
      background: "#101418",
    },
    tracks: [
      {
        id: "safe",
        kind: "visual",
        clips: [
          {
            id: "safe-title",
            kind: "text",
            start: 0,
            duration: 3,
            text: "Recovered timeline",
            fontSize: 64,
            color: "#ffcf70",
            transform: {
              x: (reference?.meta.width ?? 1920) / 2,
              y: (reference?.meta.height ?? 1080) / 2,
            },
          },
        ],
      },
    ],
  });
}

/**
 * Run the plan→act→verify→correct loop for a single request.
 *
 * The Director (stub or real) proposes an edit-doc; we validate it against the
 * schema and render probe frames through the injected engine. On failure we
 * record the error, feed it forward, and retry; if the Director can't produce a
 * verifiable doc within `maxAttempts`, we recover to the last known-good doc (or
 * a minimal valid doc) so the caller is never left with a broken timeline.
 */
export async function runDirectorLoop(
  request: string,
  project: ProjectState,
  options: RunDirectorLoopOptions,
): Promise<DirectorLoopResult> {
  const engine = options.engine;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const director: DirectorLike = options.director ?? new StubDirector();
  const corrections: string[] = [];

  // The doc the project starts on is valid by construction (setDoc/parseEditDoc),
  // so it is our first known-good fallback.
  let lastGoodDoc: EditDoc = parseEditDoc(project.doc);
  let lastError: string | undefined;
  let lastResult: DirectorResult | undefined;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      // PLAN / ACT — feed the previous error forward on a corrective retry.
      const feedback: DirectorFeedback | undefined =
        attempts > 1 && lastError ? { previousError: lastError, attempt: attempts } : undefined;
      const result = await director.interpret(request, project, feedback);
      lastResult = result;

      // VERIFY — schema first (throws on invalid), then render probes.
      const doc = parseEditDoc(result.doc);
      await verifyRenders(engine, doc, probeTimesFor(doc, options.probeTimes));

      lastGoodDoc = doc;
      return { result: { ...result, doc }, verified: true, attempts, corrections };
    } catch (err) {
      // CORRECT — capture the error so the next attempt (or a real LLM) can use it.
      lastError = errMsg(err);
      corrections.push(`attempt ${attempts} failed verification: ${lastError}`);
    }
  }

  // Director exhausted its attempts. CORRECT by committing the last known-good
  // doc; if that can't render either, fall back to a minimal valid doc.
  for (const [label, candidate] of [
    ["last known-good doc", lastGoodDoc],
    ["minimal valid doc", minimalValidDoc(lastGoodDoc)],
  ] as const) {
    try {
      const doc = parseEditDoc(candidate);
      await verifyRenders(engine, doc, probeTimesFor(doc, options.probeTimes));
      project.setDoc(doc);
      corrections.push(`recovered with ${label} after ${attempts} failed attempt(s)`);
      const result: DirectorResult = {
        doc,
        summary:
          lastResult?.summary ??
          "Recovered to a safe timeline after the Director produced an invalid edit.",
        toolCalls: lastResult?.toolCalls ?? [],
        durationSec: docDurationSec(doc),
      };
      return { result, verified: true, attempts, corrections };
    } catch (err) {
      corrections.push(`${label} render failed: ${errMsg(err)}`);
    }
  }

  // Truly unrecoverable (should not happen — a minimal doc always renders).
  return {
    result: lastResult ?? {
      doc: lastGoodDoc,
      summary: "Unverified — no renderable doc could be produced.",
      toolCalls: [],
      durationSec: docDurationSec(lastGoodDoc),
    },
    verified: false,
    attempts,
    corrections,
  };
}
