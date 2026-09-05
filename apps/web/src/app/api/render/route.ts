import { type NextRequest } from "next/server";
import { parseEditDoc } from "@cadence/core";
import { CanvasRenderEngine } from "@cadence/render-node";

export const runtime = "nodejs";

/** Server render (canvas engine): edit-doc + time → PNG. Poster frames / export-frame. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const doc = parseEditDoc(body?.doc);
    const timeSec = Number(body?.timeSec ?? 0);
    const frame = await new CanvasRenderEngine().renderFrame(doc, timeSec);
    return new Response(Buffer.from(frame.data), {
      headers: { "content-type": "image/png", "cache-control": "no-store" },
    });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "bad request", { status: 400 });
  }
}
