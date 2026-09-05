/**
 * VERIFY GATE — the keystone of Cadence's agentic loop.
 *
 * typecheck (separate) + these render-verify checks must both be green. Each
 * check fails loudly (exit 1) so the loop never proceeds while red.
 *
 *   1 trivial composition renders
 *   2 highlight: media → transcript → Director → edit-doc → frame
 *   3 edit tools: filler cut · reframe 9:16 + captions + look · quality
 *   4 slideshow: photos → Director → video → frame
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
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const engine = new CanvasRenderEngine();

function fail(msg: string): never {
  console.error(`\n[31m✖ VERIFY FAILED:[0m ${msg}\n`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

async function renderAndAssert(doc: EditDoc, timeSec: number, outName: string): Promise<number> {
  const frame = await engine.renderFrame(doc, timeSec);
  assert(frame.width === doc.meta.width && frame.height === doc.meta.height, `frame size mismatch for ${outName}`);
  const bytes = Buffer.from(frame.data);
  assert(bytes.length > 1000, `frame ${outName} too small (${bytes.length}b)`);
  assert(bytes.subarray(0, 4).equals(PNG_MAGIC), `frame ${outName} not a PNG`);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, outName), bytes);
  return bytes.length;
}

function videoProject(): ProjectState {
  const media: MediaAsset = {
    id: "clip-001", kind: "video", src: "uploads/clip-001.mp4",
    durationSec: 180, width: 1920, height: 1080, label: "raw-podcast.mp4",
  };
  return new ProjectState({ media: [media] });
}

async function checkTrivial(): Promise<void> {
  const doc = parseEditDoc({
    version: 1,
    meta: { title: "verify", width: 1280, height: 720, background: "#101418" },
    tracks: [{ id: "t1", kind: "visual", clips: [{ id: "title", kind: "text", start: 0, duration: 3, text: "Cadence render-verify OK", fontSize: 72, color: "#ffcf70", transform: { x: 640, y: 360 } }] }],
  });
  const n = await renderAndAssert(doc, 0, "verify-frame.png");
  console.log(`  [32m✔[0m check 1 (trivial): ${n}b`);
}

async function checkHighlight(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  const r = await new StubDirector().interpret("Cut a 60-second highlight of the best parts.", project);
  assert(r.toolCalls.some((c) => c.name === "create_highlight"), "expected create_highlight");
  assert(r.durationSec >= 55 && r.durationSec <= 95, `highlight ~60s, got ${r.durationSec}`);
  const n = await renderAndAssert(r.doc, r.durationSec / 2, "verify-highlight.png");
  console.log(`  [32m✔[0m check 2 (highlight): ${r.summary} — ${n}b`);
}

async function checkEditTools(): Promise<void> {
  // filler cut
  let project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  let r = await new StubDirector().interpret("remove the filler words and tighten it", project);
  assert(r.toolCalls.some((c) => c.name === "filler_cut"), "expected filler_cut");
  assert(docDurationSec(r.doc) > 0, "filler cut produced empty doc");
  await renderAndAssert(r.doc, 0.5, "verify-filler.png");

  // chained: highlight → reframe 9:16 → captions → cinematic look
  project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  r = await new StubDirector().interpret(
    "cut a 40 second highlight, make it vertical with captions and a cinematic look",
    project,
  );
  const names = r.toolCalls.map((c) => c.name);
  assert(names.includes("create_highlight"), "chain missing highlight");
  assert(names.includes("reframe"), "chain missing reframe");
  assert(names.includes("add_captions"), "chain missing captions");
  assert(names.includes("apply_look"), "chain missing look");
  assert(r.doc.meta.width === 1080 && r.doc.meta.height === 1920, `expected 1080x1920, got ${r.doc.meta.width}x${r.doc.meta.height}`);
  const caps = r.doc.tracks.find((t) => t.id === "captions");
  assert((caps?.clips.length ?? 0) > 0, "expected caption clips");
  const firstVid = r.doc.tracks.flatMap((t) => t.clips).find((c) => c.kind === "video");
  assert(firstVid && firstVid.kind === "video" && firstVid.look.warmth > 0, "cinematic look not applied");
  await renderAndAssert(r.doc, docDurationSec(r.doc) / 2, "verify-vertical-captions.png");

  // quality
  r = await new StubDirector().interpret("make it 4k high quality", project);
  assert(r.doc.quality.preset === "ultra", `expected ultra, got ${r.doc.quality.preset}`);
  assert((r.doc.quality.targetWidth ?? 0) >= 2160, "expected upscaled target width");

  console.log(`  [32m✔[0m check 3 (edit tools): filler + vertical/captions/look + 4K quality`);
}

async function checkSlideshow(): Promise<void> {
  const imgs: MediaAsset[] = Array.from({ length: 5 }, (_, i) => ({
    id: `photo-${i}`, kind: "image" as const, src: `photos/p${i}.jpg`, width: 1920, height: 1080, label: `p${i}.jpg`,
  }));
  const project = new ProjectState({ media: imgs });
  const r = await new StubDirector().interpret("make a slideshow from my photos with a warm look", project);
  assert(r.toolCalls.some((c) => c.name === "make_slideshow"), "expected make_slideshow");
  const photoTrack = r.doc.tracks.find((t) => t.id === "photos");
  assert((photoTrack?.clips.length ?? 0) === 5, "expected 5 photo clips");
  assert(photoTrack!.clips.some((c) => c.kind === "image" && c.transitionInSec > 0), "expected crossfades");
  assert(photoTrack!.clips.some((c) => c.kind === "image" && c.look.warmth > 0), "expected warm look on photos");
  const n = await renderAndAssert(r.doc, docDurationSec(r.doc) / 2, "verify-slideshow.png");
  console.log(`  [32m✔[0m check 4 (slideshow): ${r.summary} — ${n}b`);
}

async function main(): Promise<void> {
  console.log("running verify gate…");
  await checkTrivial();
  await checkHighlight();
  await checkEditTools();
  await checkSlideshow();
  console.log(`\n[32m✔ VERIFY PASSED[0m — frames in ${OUT_DIR}`);
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
