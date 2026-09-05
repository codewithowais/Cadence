import type { EditDoc, MediaAsset } from "@cadence/core";
import type { Transcript } from "@cadence/understanding";

export interface DirectorResponse {
  doc: EditDoc;
  summary: string;
  toolCalls: { name: string; input: unknown }[];
  durationSec: number;
}

export async function transcribe(media: MediaAsset): Promise<Transcript> {
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ media }),
  });
  if (!res.ok) throw new Error(`transcribe failed: ${res.status}`);
  const data = (await res.json()) as { transcript: Transcript };
  return data.transcript;
}

export async function askDirector(input: {
  request: string;
  media: MediaAsset[];
  transcripts: Transcript[];
  doc: EditDoc;
}): Promise<DirectorResponse> {
  const res = await fetch("/api/director", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`director failed: ${res.status}`);
  return (await res.json()) as DirectorResponse;
}

/** Server-rendered frame (canvas engine) as an object URL. Used for poster/export-frame. */
export async function renderFrame(doc: EditDoc, timeSec: number): Promise<string> {
  const res = await fetch("/api/render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc, timeSec }),
  });
  if (!res.ok) throw new Error(`render failed: ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
