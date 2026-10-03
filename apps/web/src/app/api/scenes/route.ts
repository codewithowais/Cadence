import { NextResponse, type NextRequest } from "next/server";
import { detectSceneFfmpeg, ffmpegPresent } from "@cadence/understanding";

export const runtime = "nodejs";

/**
 * Server-side scene detection (upgrade path). The browser detector in
 * `lib/scene-detect.ts` needs nothing; when ffmpeg is installed this route runs
 * `select='gt(scene,X)'` on an already-uploaded file for frame-accurate cuts.
 *
 *   GET  → { ffmpeg: boolean }           (is the upgrade available?)
 *   POST { src, sensitivity } → { cuts }  (501 + hint when ffmpeg is absent)
 */
export async function GET() {
  return NextResponse.json({ ffmpeg: await ffmpegPresent() });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const res = await detectSceneFfmpeg(String(body?.src ?? ""), { sensitivity: Number(body?.sensitivity ?? 0.5) });
    if (!res.available) {
      return NextResponse.json(
        { error: res.reason, hint: "Scene detection runs in your browser with no install; ffmpeg only makes it more precise." },
        { status: 501 },
      );
    }
    return NextResponse.json({ cuts: res.cuts, threshold: res.threshold });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "bad request" }, { status: 400 });
  }
}
