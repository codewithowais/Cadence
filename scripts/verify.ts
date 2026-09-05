/**
 * VERIFY GATE — the keystone of Cadence's agentic loop.
 *
 * Contract (AGENTS.md §DONE): typecheck passes AND a real frame renders
 * headlessly. This script runs a sequence of render-verify checks; each fails
 * loudly (exit 1) so the loop never proceeds while red.
 *
 *   check 1  trivial composition renders (schema → frame)
 *   check 2  full loop: media → transcript → stub Director → edit-doc → frame
 *
 * Run: `npm run verify`  (typecheck is separate: `npm run typecheck`)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEditDoc, docDurationSec, type EditDoc, type MediaAsset } from "@cadence/core";
import { CanvasRenderEngine } from "@cadence/render-node";
import { StubTranscriber } from "@cadence/understanding";
import { ProjectState, StubDirector } from "@cadence/director";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "..", ".cadence");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG
const engine = new CanvasRenderEngine();

function fail(msg: string): never {
  console.error(`\n[31m✖ VERIFY FAILED:[0m ${msg}\n`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

/** Render a frame, assert it is a real PNG of the expected size, write it out. */
async function renderAndAssert(doc: EditDoc, timeSec: number, outName: string): Promise<number> {
  const frame = await engine.renderFrame(doc, timeSec);
  assert(
    frame.width === doc.meta.width && frame.height === doc.meta.height,
    `frame size ${frame.width}x${frame.height} != doc ${doc.meta.width}x${doc.meta.height}`,
  );
  const bytes = Buffer.from(frame.data);
  assert(bytes.length > 1000, `frame ${outName} too small (${bytes.length} bytes) — likely blank`);
  assert(bytes.subarray(0, 4).equals(PNG_MAGIC), `frame ${outName} is not a valid PNG`);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, outName), bytes);
  return bytes.length;
}

async function checkTrivial(): Promise<void> {
  const doc = parseEditDoc({
    version: 1,
    meta: { title: "verify", fps: 30, width: 1280, height: 720, background: "#101418" },
    tracks: [
      {
        id: "t1",
        kind: "visual",
        clips: [
          {
            id: "title",
            kind: "text",
            start: 0,
            duration: 3,
            text: "Cadence render-verify OK",
            fontSize: 72,
            color: "#ffcf70",
            transform: { x: 640, y: 360 },
          },
        ],
      },
    ],
  });
  assert(docDurationSec(doc) === 3, "expected 3s timeline");
  const n = await renderAndAssert(doc, 0, "verify-frame.png");
  console.log(`  [32m✔[0m check 1 (trivial): rendered ${doc.meta.width}x${doc.meta.height} PNG (${n} bytes)`);
}

async function checkDirectorLoop(): Promise<void> {
  // 1. ingest a source video (3 min).
  const media: MediaAsset = {
    id: "clip-001",
    kind: "video",
    src: "uploads/clip-001.mp4",
    durationSec: 180,
    width: 1920,
    height: 1080,
    label: "raw-podcast.mp4",
  };
  // 2. understand it (stub transcriber; drop-in for local Whisper).
  const transcript = await new StubTranscriber().transcribe(media);
  assert(transcript.segments.length > 5, "stub transcript should have several segments");

  // 3. build the project + ask the Director in plain language.
  const project = new ProjectState({ media: [media], transcripts: [transcript] });
  const director = new StubDirector();
  const result = await director.interpret("Cut a 60-second highlight of the best parts.", project);

  // 4. assert the Director produced a real, sensible edit.
  assert(result.toolCalls.some((c) => c.name === "set_timeline"), "Director must call set_timeline");
  assert(result.durationSec >= 55 && result.durationSec <= 95, `highlight ~60s expected, got ${result.durationSec}s`);
  const videoClips = result.doc.tracks[0]?.clips ?? [];
  assert(videoClips.length >= 1, "highlight should contain video clips");
  assert(videoClips.some((c) => c.kind === "video" && c.sourceIn > 0), "cuts should reference source offsets");

  // 5. render a frame from the produced doc (mid-highlight so a video tile shows).
  const n = await renderAndAssert(result.doc, result.durationSec / 2, "verify-highlight.png");
  console.log(`  [32m✔[0m check 2 (director loop): ${result.summary}`);
  console.log(`     rendered ${result.doc.meta.width}x${result.doc.meta.height} PNG (${n} bytes) from ${videoClips.length} cuts`);
}

async function main(): Promise<void> {
  console.log("running verify gate…");
  await checkTrivial();
  await checkDirectorLoop();
  console.log(`\n[32m✔ VERIFY PASSED[0m — frames in ${OUT_DIR}`);
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
