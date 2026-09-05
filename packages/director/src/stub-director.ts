/**
 * StubDirector — a deterministic, offline, free stand-in for the real Claude
 * Director. It parses a plain-language request, picks a skill, builds an
 * edit-doc, and COMMITS it through the typed `set_timeline` tool (never by
 * mutating state directly). The real Director will swap this rules brain for an
 * LLM while keeping the exact same tool-calling contract.
 */
import { docDurationSec, type EditDoc } from "@cadence/core";
import type { ProjectState } from "./project";
import { setTimelineTool, type ToolCall } from "./tools";
import { buildHighlightDoc } from "./highlight";

export interface DirectorResult {
  /** The edit-doc now current on the project. */
  doc: EditDoc;
  /** Human-readable summary of what the Director did. */
  summary: string;
  /** The tool calls the Director made (for the trail / UI). */
  toolCalls: ToolCall[];
  durationSec: number;
}

/** Parse a target duration (seconds) out of the request; default 60. */
function parseTargetSeconds(request: string): number {
  const min = request.match(/(\d+(?:\.\d+)?)\s*(?:m|min|minute)/i);
  if (min) return Math.round(parseFloat(min[1]!) * 60);
  const sec = request.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|second)/i);
  if (sec) return Math.round(parseFloat(sec[1]!));
  return 60;
}

export class StubDirector {
  readonly mode = "stub" as const;

  async interpret(request: string, project: ProjectState): Promise<DirectorResult> {
    const req = request.toLowerCase();

    const sourceVideo = project.media.find((m) => m.kind === "video");
    if (!sourceVideo) {
      return {
        doc: project.doc,
        summary: "No source video in the project yet. Upload a video first.",
        toolCalls: [],
        durationSec: docDurationSec(project.doc),
      };
    }
    const transcript = project.getTranscript(sourceVideo.id);
    if (!transcript) {
      return {
        doc: project.doc,
        summary: `No transcript for "${sourceVideo.label ?? sourceVideo.src}" yet. Run understanding first.`,
        toolCalls: [],
        durationSec: docDurationSec(project.doc),
      };
    }

    // Skill routing. Highlight cut is the one skill the spike ships; other verbs
    // are recognized but deferred to their own tool slices (Ask 2).
    const wantsHighlight =
      /highlight|best (?:parts|bits|moments)|cut.*\d|short(?:en)?|trim to|make it \d/.test(req) ||
      !/caption|reframe|filler|grade|color|mix|music/.test(req);

    if (wantsHighlight) {
      const targetSec = parseTargetSeconds(request);
      const candidate = buildHighlightDoc(sourceVideo, transcript, {
        targetSec,
        title: "Highlights",
      });
      const out = await setTimelineTool.execute({ doc: candidate }, { project });
      const clipCount = candidate.tracks[0]?.clips.length ?? 0;
      return {
        doc: project.doc,
        summary:
          `Cut a ${Math.round(out.durationSec)}s highlight from ` +
          `"${sourceVideo.label ?? sourceVideo.src}" — selected ${clipCount} of ` +
          `${transcript.segments.length} segments (target ${targetSec}s).`,
        toolCalls: [{ name: setTimelineTool.name, input: { doc: candidate } }],
        durationSec: out.durationSec,
      };
    }

    return {
      doc: project.doc,
      summary: `That edit ("${request}") isn't wired yet — it lands in a later slice (Ask 2).`,
      toolCalls: [],
      durationSec: docDurationSec(project.doc),
    };
  }
}
