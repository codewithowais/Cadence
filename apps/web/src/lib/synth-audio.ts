/**
 * Materialize GENERATED audio (a media asset whose `src` is a `synth:` recipe —
 * see @cadence/director's generate_music / add_sfx) into a real WAV `File`, so it
 * rides the exact same path as an uploaded audio file: an object URL for the
 * Stage's <audio> preview, and the File itself for the export upload.
 *
 * Rendering runs in a Web Worker (off the main thread); if workers are
 * unavailable it falls back to rendering inline. Results are cached per recipe,
 * so the same music bed / sound effect is only ever synthesized once per session.
 */
import type { MediaAsset } from "@cadence/core";
import { encodeWav, isSynthSrc, parseSynthSrc, renderSynthRecipe } from "@cadence/director/sound-synth";

const cache = new Map<string, Promise<File>>();

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./synth.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; wav?: ArrayBuffer; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.wav) p.resolve(e.data.wav);
      else p.reject(new Error(e.data.error ?? "Sound synthesis failed."));
    };
    worker.onerror = () => {
      // A worker that can't boot (bundling / CSP) → render inline from now on.
      workerBroken = true;
      for (const [, p] of pending) p.reject(new Error("worker failed"));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

function renderInWorker(src: string): Promise<ArrayBuffer> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("no worker"));
  const id = ++seq;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, src });
  });
}

async function renderInline(src: string): Promise<ArrayBuffer> {
  // Yield once so a "Composing…" state can paint before the CPU work.
  await new Promise((r) => setTimeout(r, 0));
  const recipe = parseSynthSrc(src);
  if (!recipe) throw new Error("That sound recipe isn't valid.");
  const wav = encodeWav(renderSynthRecipe(recipe));
  return wav.buffer as ArrayBuffer;
}

/** Whether a media asset is generated audio (a `synth:` recipe). */
export function isGeneratedAudio(m: Pick<MediaAsset, "src" | "kind">): boolean {
  return m.kind === "audio" && isSynthSrc(m.src);
}

/**
 * The WAV File for a generated audio asset (cached per recipe). Rejects for a
 * non-synth asset or an invalid recipe.
 */
export function materializeSynth(asset: MediaAsset): Promise<File> {
  if (!isGeneratedAudio(asset)) return Promise.reject(new Error("Not generated audio."));
  const hit = cache.get(asset.src);
  if (hit) return hit;
  const p = renderInWorker(asset.src)
    .catch(() => renderInline(asset.src))
    .then((buf) => new File([buf], `${asset.id}.wav`, { type: "audio/wav" }));
  p.catch(() => cache.delete(asset.src));
  cache.set(asset.src, p);
  return p;
}
