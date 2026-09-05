import { NextResponse, type NextRequest } from "next/server";
import { MediaAsset } from "@cadence/core";
import { StubTranscriber } from "@cadence/understanding";

export const runtime = "nodejs";

/** Understanding service (stub): media → transcript. Drop-in for local Whisper later. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const media = MediaAsset.parse(body?.media);
    const transcript = await new StubTranscriber().transcribe(media);
    return NextResponse.json({ transcript });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "bad request" },
      { status: 400 },
    );
  }
}
