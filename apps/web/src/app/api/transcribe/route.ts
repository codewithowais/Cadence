import { NextResponse, type NextRequest } from "next/server";
import { MediaAsset } from "@cadence/core";
import { pickTranscriber } from "@cadence/understanding";

export const runtime = "nodejs";

/**
 * Understanding service: media → transcript. Uses real local Whisper when a
 * Whisper CLI + ffmpeg are present (see @cadence/understanding), else the
 * deterministic offline StubTranscriber. Response shape is identical either way.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const media = MediaAsset.parse(body?.media);
    const transcriber = await pickTranscriber();
    const transcript = await transcriber.transcribe(media);
    return NextResponse.json({ transcript });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "bad request" },
      { status: 400 },
    );
  }
}
