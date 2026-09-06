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
 *   … 5–10 titles/fades · enhance · export plan · ffmpeg graceful · db · migrations
 *   11 background music: add_music + auto-mix duck → valid doc, renders, amix on export
 *   12 b-roll: add_broll picture-in-picture → overlay clip renders + overlay on export
 *   13 kinetic title: add_kinetic_title → mid-animation frame + slide expr on export
 *   14 punch-in emphasis: add_emphasis → increased scale in-window + zoompan on export
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseEditDoc,
  docDurationSec,
  emphasisScale,
  textKinetic,
  type EditDoc,
  type MediaAsset,
  type TextClip,
  type VideoClip,
} from "@cadence/core";
import { CanvasRenderEngine } from "@cadence/render-node";
import { StubTranscriber } from "@cadence/understanding";
import { ProjectState, StubDirector } from "@cadence/director";
import { allProviders, buildCliArgs, configFromEnv, selectProvider } from "@cadence/enhance";
import {
  buildExportPlan,
  detectFfmpeg,
  runExport,
  FfmpegNotFoundError,
  FFMPEG_MISSING_MESSAGE,
} from "@cadence/render-ffmpeg";
import {
  addMembershipQuery,
  createProjectQuery,
  getEditDocVersionQuery,
  insertEditDocVersionQuery,
  listProjectsQuery,
  createMediaQuery,
  type SqlQuery,
} from "@cadence/db/queries";
import { orderMigrations, listMigrations } from "@cadence/db";

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

async function checkTitlesFades(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  const r = await new StubDirector().interpret(
    'cut a 30 second highlight, add a title that says "My Video", give it a vintage look, and fade in and out',
    project,
  );
  const names = r.toolCalls.map((c) => c.name);
  for (const need of ["create_highlight", "add_title", "apply_look", "add_fades"]) {
    assert(names.includes(need), `titles/fades chain missing ${need}`);
  }
  assert(r.doc.tracks.some((t) => t.id === "titles" && t.clips.length > 0), "expected a titles track");
  assert(r.doc.tracks.some((t) => t.id === "fades" && t.clips.some((c) => c.kind === "solid")), "expected fade solids");
  const firstVid = r.doc.tracks.flatMap((t) => t.clips).find((c) => c.kind === "video");
  assert(firstVid && firstVid.kind === "video" && firstVid.look.saturation < 1, "vintage look not applied");
  // render very near the start so the fade-from-black solid is visible
  await renderAndAssert(r.doc, 0.2, "verify-title-fade.png");
  console.log(`  [32m✔[0m check 5 (titles/fades/looks): ${r.summary}`);
}

async function checkEnhance(): Promise<void> {
  // CLI arg templating is pure + testable.
  const args = buildCliArgs("esrgan -i {input} -o {output} -s {scale}", {
    input: "a.png", output: "b.png", scale: 4,
  });
  assert(
    JSON.stringify(args) === JSON.stringify(["esrgan", "-i", "a.png", "-o", "b.png", "-s", "4"]),
    `buildCliArgs wrong: ${JSON.stringify(args)}`,
  );

  // Provider selection by config.
  assert(selectProvider(configFromEnv({})).id === "free", "default provider should be free");
  assert(selectProvider(configFromEnv({ ENHANCE_PROVIDER: "cli", ENHANCE_CLI_COMMAND: "x {input}" })).id === "cli", "cli not selected");
  assert(selectProvider(configFromEnv({ ENHANCE_PROVIDER: "local" })).id === "local", "local not selected");

  // Faithfulness contract: EVERY provider preserves identity (no face changes).
  const providers = allProviders(configFromEnv({}));
  assert(providers.every((p) => p.preservesIdentity === true), "a provider is not identity-preserving");
  assert(providers.some((p) => !p.usesAI) && providers.some((p) => p.usesAI), "need both AI and non-AI options");

  console.log(`  [32m✔[0m check 6 (enhance): ${providers.length} providers, all faithful; free default + AI options (local/api/cli)`);
}

async function checkExportPlan(): Promise<void> {
  const resolve = (id: string) => `/media/${id}.mp4`;

  // (a) 2-cut highlight → per-clip source trim (-ss/-t) + concat + setpts.
  const highlight = parseEditDoc({
    version: 1,
    meta: { title: "hl", width: 1920, height: 1080, fps: 30 },
    media: [{ id: "clip-001", kind: "video", src: "/media/clip-001.mp4" }],
    tracks: [
      {
        id: "video",
        kind: "visual",
        clips: [
          { id: "c0", kind: "video", start: 0, duration: 4, mediaId: "clip-001", sourceIn: 12, transform: { x: 960, y: 540 } },
          { id: "c1", kind: "video", start: 4, duration: 5, mediaId: "clip-001", sourceIn: 40, transform: { x: 960, y: 540 } },
        ],
      },
    ],
  });
  const hp = buildExportPlan(highlight, resolve, "/out/hl.mp4");
  const ha = hp.args.join(" ");
  assert(hp.filterComplex.includes("concat=n=2:v=1:a=1"), "highlight: expected 2-way concat");
  assert(hp.filterComplex.includes("setpts=PTS-STARTPTS"), "highlight: expected setpts");
  assert((ha.match(/-ss /g) ?? []).length >= 2, "highlight: expected per-clip -ss source trims");
  assert(hp.filterComplex.includes("crop=1920:1080"), "highlight: expected scale/crop to WxH");
  assert(ha.includes("-map [vcat]") && ha.includes("-map [acat]"), "highlight: expected video+audio maps");
  assert(ha.endsWith("/out/hl.mp4"), "highlight: outFile should be last arg");

  // (b) captions → drawtext (time-gated) with a pill box + escaped text.
  const captioned = parseEditDoc({
    version: 1,
    meta: { title: "cap", width: 1080, height: 1920, fps: 30 },
    media: [{ id: "v", kind: "video", src: "/media/v.mp4" }],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 6, mediaId: "v", transform: { x: 540, y: 960 } }] },
      {
        id: "captions",
        kind: "visual",
        clips: [
          { id: "cap0", kind: "text", start: 0.2, duration: 2, text: "It's 100% real: a, b; c", background: "#0a0d12cc", transform: { x: 540, y: 1700 } },
        ],
      },
    ],
  });
  const cp = buildExportPlan(captioned, resolve, "/out/cap.mp4");
  assert(cp.filterComplex.includes("drawtext="), "captions: expected drawtext");
  assert(cp.filterComplex.includes("enable='between(t\\,0.2\\,2.2)'"), "captions: expected time-gated enable");
  assert(cp.filterComplex.includes("box=1"), "captions: expected pill box");
  assert(cp.filterComplex.includes("It\\'s 100\\%") && cp.filterComplex.includes("a\\, b\\; c"), "captions: expected escaped special chars");

  // (c) quality ultra → lanczos upscale + unsharp (+ hqdn3d denoise).
  const ultra = parseEditDoc({
    version: 1,
    meta: { title: "q", width: 1920, height: 1080, fps: 30 },
    media: [{ id: "v", kind: "video", src: "/media/v.mp4" }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 5, mediaId: "v", transform: { x: 960, y: 540 } }] }],
    quality: { preset: "ultra", targetWidth: 3840, targetHeight: 2160, sharpen: 0.5, denoise: 0.35, aiUpscale: false, faithful: true },
  });
  const qp = buildExportPlan(ultra, resolve, "/out/q.mp4");
  assert(qp.filterComplex.includes("scale=3840:2160:flags=lanczos"), "quality: expected lanczos upscale");
  assert(qp.filterComplex.includes("unsharp="), "quality: expected unsharp sharpen");
  assert(qp.filterComplex.includes("hqdn3d="), "quality: expected hqdn3d denoise");
  assert(qp.args.includes("-crf") && qp.args[qp.args.indexOf("-crf") + 1] === "18", "quality: ultra should use crf 18");

  // (d) slideshow → images looped + Ken Burns zoompan + xfade crossfades.
  const imgs: MediaAsset[] = Array.from({ length: 4 }, (_, i) => ({
    id: `photo-${i}`, kind: "image" as const, src: `/media/p${i}.jpg`, width: 1920, height: 1080, label: `p${i}.jpg`,
  }));
  const slideProject = new ProjectState({ media: imgs });
  const slideRes = await new StubDirector().interpret("make a slideshow from my photos with a warm look", slideProject);
  const sp = buildExportPlan(slideRes.doc, resolve, "/out/slide.mp4");
  assert(sp.filterComplex.includes("xfade=transition=fade"), "slideshow: expected xfade crossfades");
  assert(sp.filterComplex.includes("zoompan="), "slideshow: expected Ken Burns zoompan");
  assert((sp.args.filter((a) => a === "-loop").length) >= 4, "slideshow: each still should be looped");
  assert(sp.filterComplex.includes("colorbalance="), "slideshow: expected warm colorbalance from the look");

  console.log(`  [32m✔[0m check 7 (export plan): 2-cut concat + captions/drawtext + ultra lanczos/unsharp + slideshow xfade`);
}

async function checkFfmpegGraceful(): Promise<void> {
  // detect never throws; reports availability + (when present) a version.
  const info = await detectFfmpeg();
  if (!info.available) {
    // Missing-binary path: runExport must throw a clear, actionable error.
    let threw = false;
    try {
      await runExport(
        parseEditDoc({ version: 1, meta: { title: "x" }, tracks: [] }),
        { resolveMediaPath: (id) => `/media/${id}.mp4`, outFile: "/out/x.mp4" },
      );
    } catch (err) {
      threw = true;
      assert(err instanceof FfmpegNotFoundError, "missing ffmpeg should throw FfmpegNotFoundError");
      assert((err as Error).message === FFMPEG_MISSING_MESSAGE, "error should carry the install hint");
    }
    assert(threw, "runExport should throw when ffmpeg is missing");
    console.log(`  [32m✔[0m check 8 (ffmpeg graceful): absent → clear "${FFMPEG_MISSING_MESSAGE}" (install to produce real .mp4)`);
  } else {
    console.log(`  [32m✔[0m check 8 (ffmpeg graceful): ffmpeg present (${info.version ?? "unknown"}) — real .mp4 export available`);
  }
}

/**
 * Count positional placeholders and assert a query is fully parameterized:
 * every value has a matching $N ($1..$N present), value count == placeholder
 * count, and NONE of the values appears as a literal inside the SQL text.
 */
function assertParameterized(label: string, q: SqlQuery): void {
  const n = q.values.length;
  for (let i = 1; i <= n; i++) {
    assert(q.text.includes(`$${i}`), `${label}: missing placeholder $${i}`);
  }
  assert(!q.text.includes(`$${n + 1}`), `${label}: more placeholders than values`);
  // No raw value may be interpolated into the SQL string (injection guard).
  for (const v of q.values) {
    if (typeof v === "string" && v.length >= 3) {
      assert(!q.text.includes(v), `${label}: value "${v}" leaked into SQL text (must be a $N bind)`);
    }
  }
}

async function checkDbQueries(): Promise<void> {
  // Tenant scoping: reads/writes always pin org_id (and project_id where relevant).
  const projects = listProjectsQuery("org-ABC");
  assert(projects.text.includes("WHERE org_id = $1"), "listProjects must scope by org_id");
  assert(JSON.stringify(projects.values) === JSON.stringify(["org-ABC"]), "listProjects values");
  assertParameterized("listProjectsQuery", projects);

  const create = createProjectQuery("org-1", "My Project");
  assert(JSON.stringify(create.values) === JSON.stringify(["org-1", "My Project"]), "createProject values order");
  assertParameterized("createProjectQuery", create);

  const membership = addMembershipQuery("user-1", "org-1", "admin");
  assert(membership.text.includes("ON CONFLICT (user_id, org_id)"), "addMembership should upsert");
  assertParameterized("addMembershipQuery", membership);

  // Cross-tenant reads impossible: version fetch pins org_id AND project_id AND version.
  const ver = getEditDocVersionQuery("org-9", "proj-9", 3);
  assert(
    ver.text.includes("org_id = $1 AND project_id = $2 AND version = $3"),
    "getEditDocVersion must scope by org + project + version",
  );
  assert(JSON.stringify(ver.values) === JSON.stringify(["org-9", "proj-9", 3]), "getEditDocVersion values");
  assertParameterized("getEditDocVersionQuery", ver);

  // jsonb doc is bound as a serialized string, never interpolated.
  const doc = { version: 1 as const, meta: { title: "x" } };
  const ins = insertEditDocVersionQuery("org-1", "proj-1", 2, doc, "user-1");
  assert(ins.text.includes("$4::jsonb"), "insertEditDocVersion should cast $4 to jsonb");
  assert(ins.values[3] === JSON.stringify(doc), "insertEditDocVersion should bind serialized doc");
  assertParameterized("insertEditDocVersionQuery", ins);

  // Injection guard: a malicious value stays in values[], out of the SQL text.
  const evil = createMediaQuery("org-1", "proj-1", { kind: "video", src: "'; DROP TABLE media;--" });
  assert(!evil.text.includes("DROP TABLE media"), "createMedia must not interpolate src into SQL");
  assert(evil.values.includes("'; DROP TABLE media;--"), "createMedia must bind src as a value");
  assertParameterized("createMediaQuery", evil);

  console.log(`  [32m✔[0m check 9 (db query builders): tenant-scoped + fully parameterized (no interpolation)`);
}

function checkMigrations(): void {
  const migrations = listMigrations();
  assert(migrations.length >= 3, `expected >=3 migrations, got ${migrations.length}`);
  // Strictly increasing, contiguous 1,2,3… indices.
  migrations.forEach((m, i) => {
    assert(m.index === i + 1, `migration ${m.filename} out of order (expected index ${i + 1}, got ${m.index})`);
  });
  // orderMigrations rejects duplicate indices.
  let threw = false;
  try {
    orderMigrations(["001_a.sql", "001_b.sql"]);
  } catch {
    threw = true;
  }
  assert(threw, "orderMigrations must reject duplicate indices");
  const names = migrations.map((m) => m.name).join(", ");
  console.log(`  [32m✔[0m check 10 (migrations): ${migrations.length} ordered — ${names}`);
}

async function checkMusic(): Promise<void> {
  // A project with source video + a music/audio asset.
  const project = videoProject();
  project.media.push({ id: "song-001", kind: "audio", src: "uploads/song.mp3", durationSec: 200, label: "bed.mp3" });
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));

  await new StubDirector().interpret("cut a 30 second highlight", project);
  const r = await new StubDirector().interpret("add background music and auto-mix the audio", project);
  const names = r.toolCalls.map((c) => c.name);
  assert(names.includes("add_music"), "expected add_music");
  assert(names.includes("auto_mix"), "expected auto_mix (ducking)");

  const music = r.doc.tracks.find((t) => t.id === "music");
  assert(music?.kind === "audio", "expected an audio 'music' track");
  const clip = music!.clips[0];
  assert(clip?.kind === "audio" && clip.mediaId === "song-001", "music clip should reference the audio asset");
  assert(clip.kind === "audio" && clip.volume <= 0.35, `music should be ducked, got ${clip.kind === "audio" ? clip.volume : "?"}`);
  assert(r.doc.media.some((m) => m.id === "song-001"), "audio asset should be in doc.media");

  // Doc stays valid + renders (music is silent in the canvas preview).
  const n = await renderAndAssert(r.doc, docDurationSec(r.doc) / 2, "verify-music.png");

  // Export honors music through the amix path.
  const plan = buildExportPlan(r.doc, (id) => `/media/${id}.mp4`, "/out/music.mp4");
  assert(plan.filterComplex.includes("amix="), "music: expected amix in export");
  assert(plan.filterComplex.includes("adelay="), "music: expected adelay for the music track");
  console.log(`  [32m✔[0m check 11 (music): add_music + duck → valid doc renders (${n}b), amix on export (audio manifests at export only)`);
}

async function checkBroll(): Promise<void> {
  // Video + an image to overlay as b-roll.
  const project = videoProject();
  project.media.push({ id: "broll-img", kind: "image", src: "uploads/insert.jpg", width: 1920, height: 1080, label: "insert.jpg" });
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);
  const r = await new StubDirector().interpret("add b-roll as picture-in-picture at 2s", project);
  assert(r.toolCalls.some((c) => c.name === "add_broll"), "expected add_broll");

  const broll = r.doc.tracks.find((t) => t.id === "broll");
  assert((broll?.clips.length ?? 0) > 0, "expected a broll track with a clip");
  const pip = broll!.clips[0]!;
  assert(
    (pip.kind === "image" || pip.kind === "video") && pip.transform.scale < 1,
    `b-roll should be a scaled overlay, got scale ${"transform" in pip ? pip.transform.scale : "?"}`,
  );

  // Render a frame INSIDE the PiP window; the overlay tile is painted on top.
  const mid = pip.start + pip.duration / 2;
  const n = await renderAndAssert(r.doc, mid, "verify-broll.png");

  // Export overlays the b-roll (not concatenated into the base sequence).
  const plan = buildExportPlan(r.doc, (id) => `/media/${id}.mp4`, "/out/broll.mp4");
  assert(plan.filterComplex.includes("overlay="), "b-roll: expected overlay in export");
  console.log(`  [32m✔[0m check 12 (b-roll): picture-in-picture overlay renders mid-window (${n}b) + overlay on export`);
}

async function checkKineticTitle(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);
  const r = await new StubDirector().interpret('add an animated title that says "Kinetic"', project);
  assert(r.toolCalls.some((c) => c.name === "add_kinetic_title"), "expected add_kinetic_title");

  const kt = r.doc.tracks
    .flatMap((t) => t.clips)
    .find((c): c is TextClip => c.kind === "text" && c.anim.style === "kinetic");
  assert(kt, "expected a kinetic text clip");
  assert(kt!.anim.durationSec > 0, "kinetic anim should have a duration");

  // Mid-animation the title is still sliding + smaller than resting (scaleMul<1).
  const midAnim = kt!.start + kt!.anim.durationSec / 2;
  const state = textKinetic(kt!, midAnim);
  assert(state.scaleMul > 0 && state.scaleMul < 1, `mid-animation scaleMul should be <1, got ${state.scaleMul}`);
  assert(state.dy !== 0 || state.dx !== 0, "mid-animation should still be offset (sliding)");
  const n = await renderAndAssert(r.doc, midAnim, "verify-kinetic.png");

  // Export slides the title via a time-dependent drawtext expression.
  const plan = buildExportPlan(r.doc, (id) => `/media/${id}.mp4`, "/out/kinetic.mp4");
  assert(plan.filterComplex.includes("pow(1-"), "kinetic: expected an eased slide expression in export");
  console.log(`  [32m✔[0m check 13 (kinetic title): mid-animation frame (${n}b) — sliding+scaling; slide expr on export`);
}

async function checkEmphasis(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 30 second highlight", project);
  const r = await new StubDirector().interpret("punch in for emphasis at 4s with 1.4x zoom", project);
  assert(r.toolCalls.some((c) => c.name === "add_emphasis"), "expected add_emphasis");

  const emphClip = r.doc.tracks
    .flatMap((t) => t.clips)
    .find((c): c is VideoClip => c.kind === "video" && !!c.emphasis && c.emphasis.zoom > 1);
  assert(emphClip, "expected a video clip with a punch-in emphasis");
  const e = emphClip!.emphasis!;

  // At the center of the window the scale is meaningfully increased.
  const mid = e.atSec + e.durationSec / 2;
  const s = emphasisScale(emphClip!, mid);
  assert(s > 1.05, `emphasis scale mid-window should be >1, got ${s}`);
  // Outside the window it's back to 1 (identity).
  assert(emphasisScale(emphClip!, e.atSec + e.durationSec + 1) === 1, "emphasis should be identity outside the window");
  const n = await renderAndAssert(r.doc, mid, "verify-emphasis.png");

  // Export animates the punch-in via zoompan with the sine pulse.
  const plan = buildExportPlan(r.doc, (id) => `/media/${id}.mp4`, "/out/emphasis.mp4");
  assert(plan.filterComplex.includes("zoompan=") && plan.filterComplex.includes("sin("), "emphasis: expected zoompan sine pulse in export");
  console.log(`  [32m✔[0m check 14 (punch-in): mid-window scale ${Math.round(s * 100) / 100}× renders (${n}b) + zoompan pulse on export`);
}

async function main(): Promise<void> {
  console.log("running verify gate…");
  await checkTrivial();
  await checkHighlight();
  await checkEditTools();
  await checkSlideshow();
  await checkTitlesFades();
  await checkEnhance();
  await checkExportPlan();
  await checkFfmpegGraceful();
  await checkDbQueries();
  checkMigrations();
  await checkMusic();
  await checkBroll();
  await checkKineticTitle();
  await checkEmphasis();
  console.log(`\n[32m✔ VERIFY PASSED[0m — frames in ${OUT_DIR}`);
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
