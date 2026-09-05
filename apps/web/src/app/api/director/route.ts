import { NextResponse, type NextRequest } from "next/server";
import { parseEditDoc } from "@cadence/core";
import { ProjectState, StubDirector } from "@cadence/director";

export const runtime = "nodejs";

/**
 * Director service. Rebuilds the working set from the posted project, runs the
 * (stub) Director on the plain-language request, and returns the new edit-doc.
 * Stateless by construction so it can scale horizontally; the DB will version
 * the doc in a later slice.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const request: string = String(body?.request ?? "");
    const project = new ProjectState({
      media: body?.media ?? [],
      transcripts: body?.transcripts ?? [],
      doc: body?.doc ? parseEditDoc(body.doc) : undefined,
    });
    const result = await new StubDirector().interpret(request, project);
    return NextResponse.json({
      doc: result.doc,
      summary: result.summary,
      toolCalls: result.toolCalls,
      durationSec: result.durationSec,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "bad request" },
      { status: 400 },
    );
  }
}
