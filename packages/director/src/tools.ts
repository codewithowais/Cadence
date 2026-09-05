/**
 * Director tools — the ONLY way the Director changes a project. Each tool is
 * typed (Zod input), self-describing, and operates on ProjectState. Every new
 * capability (filler cut, reframe, captions, …) is added here as a new tool;
 * the Director's shape never changes. This is what keeps the system scalable.
 */
import { z } from "zod";
import { docDurationSec, EditDoc, type EditDoc as EditDocT } from "@cadence/core";
import type { ProjectState } from "./project";

export interface ToolContext {
  project: ProjectState;
}

export interface DirectorTool<I, O> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  execute(input: I, ctx: ToolContext): Promise<O>;
}

/** Record of a tool the Director invoked, for the trail / UI. */
export interface ToolCall {
  name: string;
  input: unknown;
}

// --- set_timeline: the keystone tool ---------------------------------------

export const SetTimelineInput = z.object({
  /** The full edit-doc to make current. Validated against the schema. */
  doc: EditDoc,
});
export type SetTimelineInput = { doc: EditDocT };
export interface SetTimelineOutput {
  ok: true;
  durationSec: number;
}

export const setTimelineTool: DirectorTool<SetTimelineInput, SetTimelineOutput> = {
  name: "set_timeline",
  description:
    "Replace the project's timeline with a complete edit-doc. This is how the " +
    "Director commits an edit. The doc is validated against the schema before it lands.",
  inputSchema: SetTimelineInput,
  async execute(input, ctx) {
    const doc = ctx.project.setDoc(input.doc);
    return { ok: true, durationSec: docDurationSec(doc) };
  },
};

/** The registry the Director draws from. Grows one entry per capability. */
export const DIRECTOR_TOOLS = {
  set_timeline: setTimelineTool,
} as const;
