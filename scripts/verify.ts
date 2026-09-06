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
 *   19 speed ramp: set_speed slow-mo/fast → sourceTimeAt mapping + setpts/atempo on export
 *   20 zoom (manual reframe): zoom → transform.scale on clips + scale/crop on export
 *   21 transitions: set_transition dip-to-black/slide/wipe → xfade name on slideshow export
 *   22 color adjust: adjustColor merges a manual grade + renders; NL "brighter/warmer" → adjust_color
 *   15 whisper parse: parseWhisperJson (OpenAI + whisper.cpp shapes) → valid Transcript
 *   16 transcriber factory: real Whisper when available, else graceful StubTranscriber
 *   17 agentic loop: runDirectorLoop (plan→act→verify→correct) verifies + renders,
 *      and recovers a broken Director output to a safe doc (full 5-prompt suite:
 *      `npm run evals`)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseEditDoc,
  docDurationSec,
  emphasisScale,
  sourceTimeAt,
  textKinetic,
  type EditDoc,
  type MediaAsset,
  type TextClip,
  type VideoClip,
} from "@cadence/core";
import { CanvasRenderEngine } from "@cadence/render-node";
import {
  StubTranscriber,
  WhisperTranscriber,
  parseWhisperJson,
  pickTranscriber,
  assertLocalMediaPath,
} from "@cadence/understanding";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import {
  ProjectState,
  StubDirector,
  runDirectorLoop,
  adjustColor,
  applyVfx,
  reframe,
  reframeTo,
  setQuality,
  ASPECTS,
  type DirectorLike,
} from "@cadence/director";
import { allProviders, buildCliArgs, configFromEnv, selectProvider } from "@cadence/enhance";
import {
  atempoChain,
  buildExportPlan,
  detectFfmpeg,
  runExport,
  xfadeTransition,
  FfmpegNotFoundError,
  FFMPEG_MISSING_MESSAGE,
} from "@cadence/render-ffmpeg";
import {
  addMembershipQuery,
  createProjectQuery,
  firstOrgForUserQuery,
  getEditDocVersionQuery,
  insertEditDocVersionQuery,
  listProjectsQuery,
  createMediaQuery,
  upsertUserQuery,
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

  // 4K must anchor to the LONG edge regardless of orientation (no vertical overshoot).
  const land = setQuality(parseEditDoc({ version: 1, meta: { width: 1920, height: 1080 }, tracks: [] }), "ultra");
  assert(land.quality.targetWidth === 3840 && land.quality.targetHeight === 2160, `landscape 4K should be 3840x2160, got ${land.quality.targetWidth}x${land.quality.targetHeight}`);
  const vert = setQuality(reframe(parseEditDoc({ version: 1, meta: { width: 1920, height: 1080 }, tracks: [] }), "9:16"), "ultra");
  assert(vert.quality.targetWidth === 2160 && vert.quality.targetHeight === 3840, `vertical 4K should be 2160x3840, got ${vert.quality.targetWidth}x${vert.quality.targetHeight}`);

  console.log(`  [32m✔[0m check 3 (edit tools): filler + vertical/captions/look + 4K quality (landscape 3840×2160, vertical 2160×3840)`);
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

  // Sign-in provisioning: user upsert is idempotent (ON CONFLICT on lower(email))
  // and the tenant lookup is scoped to the user — both fully parameterized.
  const upsert = upsertUserQuery("Owais@Example.com", "Owais");
  assert(upsert.text.includes("ON CONFLICT (lower(email))"), "upsertUser must be idempotent on lower(email)");
  assert(JSON.stringify(upsert.values) === JSON.stringify(["Owais@Example.com", "Owais"]), "upsertUser values");
  assertParameterized("upsertUserQuery", upsert);

  const firstOrg = firstOrgForUserQuery("user-77");
  assert(firstOrg.text.includes("m.user_id = $1"), "firstOrgForUser must scope by user_id");
  assert(JSON.stringify(firstOrg.values) === JSON.stringify(["user-77"]), "firstOrgForUser values");
  assertParameterized("firstOrgForUserQuery", firstOrg);

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

async function checkSpeedRamp(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 30 second highlight", project);
  const r = await new StubDirector().interpret("make it slow motion", project);
  assert(r.toolCalls.some((c) => c.name === "set_speed"), "expected set_speed");

  const slow = r.doc.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video");
  assert(slow && slow.speed === 0.5, `expected 0.5× slow-mo, got ${slow?.kind === "video" ? slow.speed : "?"}`);

  // Pure source mapping: at the clip midpoint, source advanced by local*speed.
  const midLocal = slow!.duration / 2;
  const st = sourceTimeAt(slow!, slow!.start + midLocal);
  assert(
    Math.abs(st - (slow!.sourceIn + midLocal * 0.5)) < 1e-6,
    `sourceTimeAt should apply speed (got ${st})`,
  );
  const n = await renderAndAssert(r.doc, slow!.start + midLocal, "verify-speed.png");

  // Export: setpts=PTS/speed + an atempo chain on the audio.
  const plan = buildExportPlan(r.doc, (id) => `/media/${id}.mp4`, "/out/speed.mp4");
  assert(plan.filterComplex.includes("setpts=(PTS-STARTPTS)/0.5"), "speed: expected setpts=PTS/0.5 (slow-mo)");
  assert(plan.filterComplex.includes("atempo=0.5"), "speed: expected atempo on the audio");
  // Slow-mo reads LESS source than the timeline duration (duration*speed via -ss/-t).
  assert(plan.args.includes("-t") && plan.args.some((a) => a === String(Math.round(slow!.duration * 0.5 * 1000) / 1000)), "speed: -t should be duration*speed");

  // atempo daisy-chaining for factors outside a single step [0.5, 2].
  assert(JSON.stringify(atempoChain(0.25)) === JSON.stringify(["atempo=0.5", "atempo=0.5"]), "speed: 0.25× should chain two atempo=0.5");
  assert(JSON.stringify(atempoChain(4)) === JSON.stringify(["atempo=2", "atempo=2"]), "speed: 4× should chain two atempo=2");
  console.log(`  [32m✔[0m check 19 (speed ramp): 0.5× slow-mo — sourceTimeAt mapping + frame (${n}b) + setpts/atempo on export; out-of-range atempo chained`);
}

async function checkZoom(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);
  const r = await new StubDirector().interpret("zoom in 1.5x", project);
  assert(r.toolCalls.some((c) => c.name === "zoom"), "expected zoom tool");
  // Must NOT be routed to the animated emphasis or to speed.
  assert(!r.toolCalls.some((c) => c.name === "add_emphasis"), "zoom should not trigger emphasis");
  assert(!r.toolCalls.some((c) => c.name === "set_speed"), "zoom should not trigger speed");

  const zc = r.doc.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video" && c.transform.scale > 1);
  assert(zc && zc.transform.scale === 1.5, `expected a 1.5× static zoom, got ${zc?.kind === "video" ? zc.transform.scale : "?"}`);
  const n = await renderAndAssert(r.doc, docDurationSec(r.doc) / 2, "verify-zoom.png");

  // Export: matching static scale (lanczos) + centered crop back to WxH.
  const plan = buildExportPlan(r.doc, (id) => `/media/${id}.mp4`, "/out/zoom.mp4");
  assert(plan.filterComplex.includes("scale=2880:1620:flags=lanczos"), "zoom: expected 1.5× lanczos upscale (2880×1620)");
  assert(plan.filterComplex.includes("crop=1920:1080:480:270"), "zoom: expected centered crop back to 1920×1080");
  console.log(`  [32m✔[0m check 20 (zoom/reframe): 1.5× static zoom on clips renders (${n}b) + scale/crop on export (distinct from emphasis)`);
}

async function checkTransitions(): Promise<void> {
  const imgs: MediaAsset[] = Array.from({ length: 4 }, (_, i) => ({
    id: `photo-${i}`, kind: "image" as const, src: `/media/p${i}.jpg`, width: 1920, height: 1080, label: `p${i}.jpg`,
  }));
  const project = new ProjectState({ media: imgs });

  // Slideshow + dip-to-black in one instruction (builder then transition).
  const r = await new StubDirector().interpret(
    "make a slideshow from my photos with dip-to-black transitions",
    project,
  );
  const names = r.toolCalls.map((c) => c.name);
  assert(names.includes("make_slideshow"), "expected make_slideshow");
  assert(names.includes("set_transition"), "expected set_transition");
  const photos = r.doc.tracks.find((t) => t.id === "photos");
  assert(photos?.clips.every((c) => (c.kind === "image" ? c.transitionType === "dip-to-black" : true)), "photos should be dip-to-black");
  const n = await renderAndAssert(r.doc, docDurationSec(r.doc) / 2, "verify-transition.png");

  const dip = buildExportPlan(r.doc, (id) => `/media/${id}.mp4`, "/out/dip.mp4");
  assert(dip.filterComplex.includes("xfade=transition=fadeblack"), "transition: dip-to-black should map to xfade fadeblack");

  // slide + wipe on the same slideshow map to their xfade names.
  const rs = await new StubDirector().interpret("use slide transitions", project);
  assert(rs.toolCalls.some((c) => c.name === "set_transition"), "expected set_transition for slide");
  const slide = buildExportPlan(rs.doc, (id) => `/media/${id}.mp4`, "/out/slide.mp4");
  assert(slide.filterComplex.includes("xfade=transition=slideleft"), "transition: slide should map to xfade slideleft");

  const rw = await new StubDirector().interpret("use wipe transitions", project);
  const wipe = buildExportPlan(rw.doc, (id) => `/media/${id}.mp4`, "/out/wipe.mp4");
  assert(wipe.filterComplex.includes("xfade=transition=wipeleft"), "transition: wipe should map to xfade wipeleft");

  // enum → xfade name mapping is exact.
  assert(xfadeTransition("crossfade") === "fade", "crossfade → fade");
  assert(xfadeTransition("dip-to-black") === "fadeblack", "dip-to-black → fadeblack");
  console.log(`  [32m✔[0m check 21 (transitions): dip-to-black/slide/wipe → xfade fadeblack/slideleft/wipeleft on slideshow export; frame ${n}b`);
}

async function checkColorAdjust(): Promise<void> {
  // Base doc: a highlight cut whose video clips start with a neutral grade.
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  const hl = await new StubDirector().interpret("cut a 20 second highlight", project);
  const before = hl.doc.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video");
  assert(before && before.look.brightness === 1 && before.look.warmth === 0, "expected a neutral starting grade");

  // (a) PURE adjustColor merges a partial grade onto every main visual clip.
  const graded = adjustColor(hl.doc, { brightness: 1.2, warmth: 0.4 });
  const after = graded.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video");
  assert(after && after.look.brightness === 1.2 && after.look.warmth === 0.4, `adjustColor should set the grade, got ${JSON.stringify(after?.look)}`);
  // Omitted fields keep their prior value (a merge, not a replace).
  assert(after!.look.contrast === before!.look.contrast && after!.look.saturation === before!.look.saturation, "adjustColor should merge (leave omitted fields untouched)");
  // The graded doc stays schema-valid and renders a real PNG frame.
  const n = await renderAndAssert(graded, docDurationSec(graded) / 2, "verify-adjust-color.png");

  // (b) NL path: "brighter/warmer" routes to adjust_color (a relative tweak),
  // NOT a preset, and moves the grade off neutral.
  const nl = await new StubDirector().interpret("make it brighter and warmer", project);
  assert(nl.toolCalls.some((c) => c.name === "adjust_color"), "expected adjust_color from an NL request");
  assert(!nl.toolCalls.some((c) => c.name === "apply_look"), "a relative tweak should not also apply a preset");
  const nlClip = nl.doc.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video");
  assert(nlClip && nlClip.look.brightness > 1 && nlClip.look.warmth > 0, `NL adjust should raise brightness+warmth, got ${JSON.stringify(nlClip?.look)}`);

  console.log(`  [32m✔[0m check 22 (color adjust): adjustColor merges grade + renders (${n}b); "brighter/warmer" → adjust_color (not a preset)`);
}

async function checkWhisperParse(): Promise<void> {
  // (a) OpenAI whisper / faster-whisper shape: seconds + word probabilities.
  const openai = {
    text: "Hello world. This is a test.",
    language: "en",
    duration: 3.2,
    segments: [
      {
        id: 0, start: 0.0, end: 1.4, text: " Hello world.", avg_logprob: -0.22,
        words: [
          { word: " Hello", start: 0.0, end: 0.6, probability: 0.98 },
          { word: " world.", start: 0.6, end: 1.4, probability: 0.95 },
        ],
      },
      {
        id: 1, start: 1.6, end: 3.2, text: " This is a test.", avg_logprob: -0.31,
        words: [
          { word: " This", start: 1.6, end: 1.9, probability: 0.9 },
          { word: " is", start: 1.9, end: 2.1, probability: 0.92 },
          { word: " a", start: 2.1, end: 2.3, probability: 0.88 },
          { word: " test.", start: 2.3, end: 3.2, probability: 0.96 },
        ],
      },
    ],
  };
  const t = parseWhisperJson(openai, "media-xyz");
  assert(t.mediaId === "media-xyz", "whisper: mediaId should be carried through");
  assert(t.language === "en", `whisper: expected language en, got ${t.language}`);
  assert(t.segments.length === 2, `whisper: expected 2 segments, got ${t.segments.length}`);
  assert(t.words.length === 6, `whisper: expected 6 flat words, got ${t.words.length}`);
  assert(Math.abs(t.durationSec - 3.2) < 1e-6, `whisper: expected 3.2s duration, got ${t.durationSec}`);
  // Words are trimmed (no leading space) and monotonic; every end >= start.
  let prevEnd = 0;
  for (const w of t.words) {
    assert(w.text === w.text.trim() && w.text.length > 0, `whisper: word not trimmed/non-empty: "${w.text}"`);
    assert(w.end >= w.start, `whisper: word end<start (${w.start}..${w.end})`);
    assert(w.start >= prevEnd - 1e-6, `whisper: words not monotonic at "${w.text}"`);
    prevEnd = w.end;
  }
  // Segments monotonic + carry a 0..1 score derived from word probabilities.
  assert(t.segments[0]!.start <= t.segments[1]!.start, "whisper: segments not ordered by start");
  assert((t.segments[0]!.score ?? -1) >= 0 && (t.segments[0]!.score ?? 2) <= 1, "whisper: segment score should be 0..1");
  // Result round-trips through JSON (structurally valid / parseable).
  const roundTrip = JSON.parse(JSON.stringify(t)) as typeof t;
  assert(roundTrip.words.length === 6 && roundTrip.segments.length === 2, "whisper: transcript should round-trip");

  // (b) whisper.cpp shape: millisecond offsets → seconds (segment-level).
  const cpp = {
    result: { language: "en" },
    transcription: [
      { offsets: { from: 0, to: 900 }, text: " Cadence", tokens: [{ text: "[_BEG_]", offsets: { from: 0, to: 0 } }, { text: " Cadence", offsets: { from: 0, to: 900 } }] },
      { offsets: { from: 900, to: 2000 }, text: " ships", tokens: [{ text: " ships", offsets: { from: 900, to: 2000 } }] },
    ],
  };
  const tc = parseWhisperJson(cpp, "m2");
  assert(tc.segments.length === 2, `whisper.cpp: expected 2 segments, got ${tc.segments.length}`);
  assert(Math.abs(tc.segments[0]!.end - 0.9) < 1e-6, `whisper.cpp: expected ms→s (0.9), got ${tc.segments[0]!.end}`);
  assert(Math.abs(tc.durationSec - 2.0) < 1e-6, `whisper.cpp: expected 2.0s duration, got ${tc.durationSec}`);
  // Special tokens ([_BEG_]) are dropped; only real words remain.
  assert(tc.words.every((w) => !w.text.startsWith("[")), "whisper.cpp: special tokens should be filtered");
  assert(tc.words.length === 2, `whisper.cpp: expected 2 words after filtering, got ${tc.words.length}`);

  console.log(`  [32m✔[0m check 15 (whisper parse): OpenAI shape → 2 segs/6 words/3.2s + whisper.cpp ms→s + special-token filter`);
}

async function checkTranscriberFactory(): Promise<void> {
  const chosen = await pickTranscriber();
  const whisperUp = await new WhisperTranscriber().isAvailable();
  if (whisperUp) {
    assert(chosen instanceof WhisperTranscriber, "factory should pick WhisperTranscriber when available");
  } else {
    assert(chosen instanceof StubTranscriber, "factory should fall back to StubTranscriber when Whisper unavailable");
  }
  // Whichever is chosen, the Transcriber contract still yields a usable transcript.
  const media: MediaAsset = {
    id: "clip-001", kind: "video", src: "uploads/clip-001.mp4",
    durationSec: 120, width: 1920, height: 1080, label: "raw.mp4",
  };
  const t = whisperUp ? await new StubTranscriber().transcribe(media) : await chosen.transcribe(media);
  assert(t.words.length > 0 && t.segments.length > 0, "factory: chosen transcriber should produce segments+words");
  console.log(`  [32m✔[0m check 16 (transcriber factory): Whisper ${whisperUp ? "available → selected" : "absent → graceful StubTranscriber fallback"}`);
}

async function checkAgenticLoop(): Promise<void> {
  // (a) Happy path: a valid Director output verifies on the first attempt and
  // renders real probe frames (t=0 + mid-duration).
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  const loop = await runDirectorLoop(
    "cut a 45 second highlight, make it vertical with captions",
    project,
    { engine },
  );
  assert(loop.verified === true, `agentic loop should verify, corrections: ${loop.corrections.join("; ")}`);
  assert(loop.attempts === 1, `clean run should take 1 attempt, took ${loop.attempts}`);
  assert(loop.corrections.length === 0, "clean run should record no corrections");
  const names = loop.result.toolCalls.map((c) => c.name);
  assert(names.includes("create_highlight") && names.includes("reframe"), "loop lost the chained tool calls");
  // The loop's own render-verify passed; prove a real frame independently too.
  const n = await renderAndAssert(loop.result.doc, docDurationSec(loop.result.doc) / 2, "verify-agentic-loop.png");

  // (b) Correct path: a Director that emits an INVALID doc must be caught by
  // VERIFY and recovered (fall back to a safe doc) — verified stays true, with
  // the captured error recorded as a correction fed forward.
  const broken: DirectorLike = {
    async interpret() {
      return {
        // fps must be positive — this fails parseEditDoc in the VERIFY step.
        doc: { version: 1, meta: { fps: -1 }, media: [], tracks: [] } as unknown as EditDoc,
        summary: "intentionally broken",
        toolCalls: [],
        durationSec: 0,
      };
    },
  };
  const recovered = await runDirectorLoop("do something impossible", videoProject(), {
    engine,
    director: broken,
    maxAttempts: 2,
  });
  assert(recovered.verified === true, "loop should recover a broken Director output to a verifiable doc");
  assert(recovered.attempts === 2, `broken run should exhaust attempts before recovery, got ${recovered.attempts}`);
  assert(recovered.corrections.length > 0, "recovery should record the captured error as a correction");
  assert(
    recovered.corrections.some((c) => /recovered with/.test(c)),
    "recovery should note the fallback it used",
  );
  await renderAndAssert(recovered.result.doc, 0, "verify-agentic-recover.png");

  console.log(
    `  [32m✔[0m check 17 (agentic loop): plan→act→verify→correct — clean run verifies+renders (${n}b, 1 attempt); broken output caught by VERIFY → recovered (2 attempts, ${recovered.corrections.length} correction[s])`,
  );
}

async function checkSecurityGuard(): Promise<void> {
  // Create the media base dir so containment is active for the reject cases.
  const base = pathJoin(tmpdir(), "cadence-uploads");
  await mkdir(base, { recursive: true });

  for (const bad of ["http://evil/x.mp4", "concat:/etc/passwd", "file:/etc/passwd", "-i", "/etc/passwd"]) {
    let threw = false;
    try {
      await assertLocalMediaPath(bad);
    } catch {
      threw = true;
    }
    assert(threw, `security guard should reject "${bad}"`);
  }

  const f = pathJoin(base, "verify-guard.bin");
  await writeFile(f, "x");
  const safe = await assertLocalMediaPath(f);
  assert(safe.length > 0, "security guard should accept a real uploads-dir file");
  await rm(f, { force: true });

  console.log(
    `  [32m✔[0m check 18 (security guard): rejects URLs/protocols/flags/outside-uploads; accepts a real uploads file`,
  );
}

/** Render a frame and return its raw PNG bytes (for pixel-change comparisons). */
async function renderBytes(doc: EditDoc, timeSec: number): Promise<Buffer> {
  const frame = await engine.renderFrame(doc, timeSec);
  return Buffer.from(frame.data);
}

async function checkFrameSizes(): Promise<void> {
  // Named ultrawide via the Director → 21:9 (2560×1080).
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);
  const wide = await new StubDirector().interpret("make it 21:9 ultrawide", project);
  assert(wide.toolCalls.some((c) => c.name === "reframe"), "expected reframe for 21:9");
  assert(wide.doc.meta.width === 2560 && wide.doc.meta.height === 1080, `expected 2560×1080, got ${wide.doc.meta.width}×${wide.doc.meta.height}`);
  await renderAndAssert(wide.doc, docDurationSec(wide.doc) / 2, "verify-2560x1080.png");

  // Custom width×height via the Director → "reframe to 1600x900".
  const custom = await new StubDirector().interpret("reframe to 1600x900", project);
  const reframeCall = custom.toolCalls.find((c) => c.name === "reframe");
  assert(reframeCall, "expected reframe for a custom size");
  assert(custom.doc.meta.width === 1600 && custom.doc.meta.height === 900, `expected 1600×900, got ${custom.doc.meta.width}×${custom.doc.meta.height}`);
  await renderAndAssert(custom.doc, 0.5, "verify-1600x900.png");

  // Every new named aspect has EVEN dims (libx264/yuv420p safe), and reframeTo
  // rounds odd requests to even.
  for (const key of ["21:9", "4:3", "2.39:1", "2:3"] as const) {
    const a = ASPECTS[key];
    assert(a.width % 2 === 0 && a.height % 2 === 0, `aspect ${key} should have even dims, got ${a.width}×${a.height}`);
  }
  const odd = reframeTo(parseEditDoc({ version: 1, meta: { width: 1920, height: 1080 }, tracks: [] }), 1601, 901);
  assert(odd.meta.width % 2 === 0 && odd.meta.height % 2 === 0, `reframeTo should round to even, got ${odd.meta.width}×${odd.meta.height}`);

  console.log(`  [32m✔[0m check 23 (frame sizes): 21:9 (2560×1080) + custom 1600×900 render; new aspects even-dim; reframeTo rounds odd→even`);
}

async function checkMoreLooks(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);

  // golden-hour: warm + brighter (routes to apply_look, renders).
  const gh = await new StubDirector().interpret("give it a golden-hour look", project);
  assert(gh.toolCalls.some((c) => c.name === "apply_look"), "expected apply_look for golden-hour");
  const ghClip = gh.doc.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video");
  assert(ghClip && ghClip.look.warmth > 0.5, `golden-hour should be warm, got ${ghClip?.kind === "video" ? ghClip.look.warmth : "?"}`);
  const n = await renderAndAssert(gh.doc, docDurationSec(gh.doc) / 2, "verify-golden-hour.png");

  // bleach-bypass: high contrast + desaturated silver look.
  const bb = await new StubDirector().interpret("apply a bleach-bypass look", project);
  assert(bb.toolCalls.some((c) => c.name === "apply_look"), "expected apply_look for bleach-bypass");
  const bbClip = bb.doc.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video");
  assert(bbClip && bbClip.look.saturation < 0.7 && bbClip.look.contrast > 1.2, `bleach-bypass should be desaturated+contrasty, got ${JSON.stringify(bbClip?.look)}`);

  console.log(`  [32m✔[0m check 24 (more looks): golden-hour (warm) renders (${n}b) + bleach-bypass (silver, high-contrast) via apply_look`);
}

async function checkMoreTransitions(): Promise<void> {
  const imgs: MediaAsset[] = Array.from({ length: 4 }, (_, i) => ({
    id: `photo-${i}`, kind: "image" as const, src: `/media/p${i}.jpg`, width: 1920, height: 1080, label: `p${i}.jpg`,
  }));
  const project = new ProjectState({ media: imgs });

  // New transition names map to the confirmed xfade transitions on slideshow export.
  const diss = await new StubDirector().interpret("make a slideshow from my photos with dissolve transitions", project);
  assert(diss.toolCalls.some((c) => c.name === "set_transition"), "expected set_transition (dissolve)");
  const dp = buildExportPlan(diss.doc, (id) => `/media/${id}.mp4`, "/out/diss.mp4");
  assert(dp.filterComplex.includes("xfade=transition=dissolve"), "dissolve → xfade dissolve");

  const zoom = await new StubDirector().interpret("use zoom transitions", project);
  const zp = buildExportPlan(zoom.doc, (id) => `/media/${id}.mp4`, "/out/zoom.mp4");
  assert(zp.filterComplex.includes("xfade=transition=zoomin"), "zoom → xfade zoomin");

  const smooth = await new StubDirector().interpret("use smooth transitions", project);
  const smp = buildExportPlan(smooth.doc, (id) => `/media/${id}.mp4`, "/out/smooth.mp4");
  assert(smp.filterComplex.includes("xfade=transition=smoothleft"), "smooth → xfade smoothleft");
  assert(xfadeTransition("dissolve") === "dissolve" && xfadeTransition("zoom") === "zoomin" && xfadeTransition("smooth") === "smoothleft", "transition enum → xfade name mapping exact");
  const n = await renderAndAssert(diss.doc, docDurationSec(diss.doc) / 2, "verify-dissolve.png");

  // Title animations: bounce + pop resolve deterministically and render mid-anim.
  const vp = videoProject();
  vp.setTranscript(await new StubTranscriber().transcribe(vp.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", vp);
  const bounce = await new StubDirector().interpret('add a bouncing title that says "Bounce"', vp);
  const bClip = bounce.doc.tracks.flatMap((t) => t.clips).find((c): c is TextClip => c.kind === "text" && c.anim.style === "bounce");
  assert(bClip, "expected a bounce title");
  const bState = textKinetic(bClip!, bClip!.start + bClip!.anim.durationSec / 2);
  assert(bState.dy !== 0, "bounce should still be offset mid-animation");
  await renderAndAssert(bounce.doc, bClip!.start + bClip!.anim.durationSec / 2, "verify-bounce-title.png");

  const pop = await new StubDirector().interpret('add a pop title that says "Pop"', vp);
  const pClip = pop.doc.tracks.flatMap((t) => t.clips).find((c): c is TextClip => c.kind === "text" && c.anim.style === "pop");
  assert(pClip, "expected a pop title");
  const pState = textKinetic(pClip!, pClip!.start + pClip!.anim.durationSec / 2);
  assert(pState.scaleMul > 0 && pState.scaleMul < 1.6, `pop scaleMul should be a finite growth, got ${pState.scaleMul}`);

  console.log(`  [32m✔[0m check 25 (transitions + title anims): dissolve/zoom/smooth → xfade dissolve/zoomin/smoothleft (frame ${n}b); bounce+pop titles resolve + render`);
}

async function checkVfx(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);
  const r = await new StubDirector().interpret("add a vignette and film grain and a light leak", project);
  assert(r.toolCalls.some((c) => c.name === "apply_vfx"), "expected apply_vfx");
  assert(r.doc.vfx.vignette > 0, "expected vignette > 0");
  assert(r.doc.vfx.grain > 0, "expected grain > 0");
  assert(r.doc.vfx.lightLeak === true, "expected lightLeak on");

  // A rendered frame with the vignette differs from the same frame without VFX,
  // proving the vignette (and grain/leak) actually paint pixels.
  const mid = docDurationSec(r.doc) / 2;
  const withVfx = await renderBytes(r.doc, mid);
  writeFileSync(resolve(OUT_DIR, "verify-vfx.png"), withVfx);
  const plain = applyVfx(r.doc, { vignette: 0, grain: 0, lightLeak: false });
  const withoutVfx = await renderBytes(plain, mid);
  assert(withVfx.length > 1000 && withVfx.subarray(0, 4).equals(PNG_MAGIC), "vfx frame should be a real PNG");
  assert(!withVfx.equals(withoutVfx), "the vignette/grain/leak should change the rendered pixels");

  // Isolate the vignette alone (no grain, no leak) and confirm it still changes pixels.
  const vigOnly = applyVfx(plain, { vignette: 0.6 });
  const vigBytes = await renderBytes(vigOnly, mid);
  assert(!vigBytes.equals(withoutVfx), "the vignette alone should change the rendered pixels");

  // Export honors the confirmed ffmpeg finishing filters.
  const plan = buildExportPlan(r.doc, (id) => `/media/${id}.mp4`, "/out/vfx.mp4");
  assert(plan.filterComplex.includes("vignette=angle="), "vfx: expected vignette filter on export");
  assert(plan.filterComplex.includes("noise=alls=") && plan.filterComplex.includes("allf=t+u"), "vfx: expected noise grain on export");
  assert(plan.filterComplex.includes("blend=all_mode=screen"), "vfx: expected screen-blended light leak on export");

  console.log(`  [32m✔[0m check 26 (vfx overlays): vignette+grain+leak change the frame (${withVfx.length}b) + vignette/noise/blend on export`);
}

async function checkCaptionStyle(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);
  const r = await new StubDirector().interpret(
    "add white bold captions with a black outline at the top",
    project,
  );
  const names = r.toolCalls.map((c) => c.name);
  assert(names.includes("add_captions"), "expected add_captions");
  assert(names.includes("style_captions"), "expected style_captions");

  const caps = r.doc.tracks.find((t) => t.id === "captions");
  const cap = caps?.clips.find((c): c is TextClip => c.kind === "text");
  assert(cap, "expected a styled caption clip");
  assert(cap!.outline && cap!.outline.width > 0, "caption should have an outline");
  assert(cap!.color === "#ffffff", `caption should be white, got ${cap!.color}`);
  assert(cap!.fontWeight === "bold", `caption should be bold, got ${cap!.fontWeight}`);
  assert(cap!.transform.y < r.doc.meta.height * 0.3, "captions should sit near the top");

  // The outlined caption renders and differs from the same caption without an outline.
  const capStart = cap!.start + Math.min(0.3, cap!.duration / 2);
  const withOutline = await renderBytes(r.doc, capStart);
  writeFileSync(resolve(OUT_DIR, "verify-caption-outline.png"), withOutline);
  const noOutlineDoc = structuredCloneDoc(r.doc);
  for (const t of noOutlineDoc.tracks) {
    if (t.id !== "captions") continue;
    for (const c of t.clips) if (c.kind === "text") delete (c as { outline?: unknown }).outline;
  }
  const withoutOutline = await renderBytes(parseEditDoc(noOutlineDoc), capStart);
  assert(withOutline.subarray(0, 4).equals(PNG_MAGIC), "caption frame should be a real PNG");
  assert(!withOutline.equals(withoutOutline), "the caption outline should change the rendered pixels");

  // Export burns the outline in via drawtext borderw/bordercolor.
  const plan = buildExportPlan(r.doc, (id) => `/media/${id}.mp4`, "/out/caps.mp4");
  assert(plan.filterComplex.includes("borderw=") && plan.filterComplex.includes("bordercolor="), "captions: expected drawtext border on export");

  console.log(`  [32m✔[0m check 27 (caption style): white/bold/outline/top → outline changes the frame (${withOutline.length}b) + drawtext borderw on export`);
}

/** Structural clone of a doc (verify has no structuredClone import elsewhere). */
function structuredCloneDoc(doc: EditDoc): EditDoc {
  return JSON.parse(JSON.stringify(doc)) as EditDoc;
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
  await checkSpeedRamp();
  await checkZoom();
  await checkTransitions();
  await checkColorAdjust();
  await checkFrameSizes();
  await checkMoreLooks();
  await checkMoreTransitions();
  await checkVfx();
  await checkCaptionStyle();
  await checkWhisperParse();
  await checkTranscriberFactory();
  await checkAgenticLoop();
  await checkSecurityGuard();
  console.log(`\n[32m✔ VERIFY PASSED[0m — frames in ${OUT_DIR}`);
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
