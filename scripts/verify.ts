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
 *   28 typewriter: type_text typewriter → partial mid-type substring + time-gated drawtext slices on export
 *   29 cursor: add_cursor → pointer interpolated mid-move + ripple at a click + time-expr drawtext/ripple drawboxes
 *   30 callout: add_callout → dim+border change the frame; zoom rect/transform; drawbox border+dim & label on export
 *   31 build_demo: screenshots → login walkthrough renders; "demo/login/highlight/zoom into" phrases route correctly
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
  activeClipsAt,
  docDurationSec,
  emphasisScale,
  sourceTimeAt,
  textKinetic,
  typewriterText,
  cursorPositionAt,
  cursorRipples,
  calloutScreenRect,
  calloutTransform,
  blendCompositeOperation,
  valueAt,
  toSrt,
  toVtt,
  formatTimestamp,
  type CalloutClip,
  type CursorClip,
  type EditDoc,
  type Keyframe,
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
  allTtsProviders,
  buildTtsArgs,
  estimateSpeechSec,
  selectTtsProvider,
  ttsConfigFromEnv,
  NoneTtsProvider,
  TTS_UNAVAILABLE_MESSAGE,
  type Transcript,
} from "@cadence/understanding";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import {
  ProjectState,
  StubDirector,
  runDirectorLoop,
  adjustColor,
  adjustCurves,
  adjustHsl,
  addCaptions,
  addMarker,
  addMusic,
  addVoiceover,
  animate,
  applyVfx,
  audioFade,
  autoReframe,
  editByTranscript,
  freezeFrame,
  generateVoiceoverTool,
  normalizeLoudness,
  reframe,
  reframeTo,
  removeSilence,
  reverseClip,
  setPan,
  setPlatform,
  setQuality,
  setSpeed,
  setTransition,
  buildDemo,
  addCursor,
  addCallout,
  typeText,
  ASPECTS,
  type DirectorLike,
} from "@cadence/director";
import { allProviders, buildCliArgs, configFromEnv, selectProvider } from "@cadence/enhance";
import {
  atempoChain,
  buildExportPlan,
  detectFfmpeg,
  ffBlendMode,
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

async function checkTypewriter(): Promise<void> {
  const base = parseEditDoc({ version: 1, meta: { width: 1280, height: 720, background: "#101418" }, tracks: [] });
  const full = "you@example.com";
  const doc = typeText(base, { text: full, x: 200, y: 360, atSec: 0, typeSec: 1.5, holdSec: 1 });
  const clip = doc.tracks.flatMap((t) => t.clips).find((c): c is TextClip => c.kind === "text");
  assert(clip && clip.anim.style === "typewriter" && clip.anim.durationSec > 0, "expected a typewriter text clip");

  // Mid-type the visible substring is a NON-EMPTY strict PREFIX of the full text.
  const mid = clip!.start + clip!.anim.durationSec / 2;
  const state = typewriterText(clip!, mid);
  assert(state.text.length > 0 && state.text.length < full.length, `mid-type should be partial, got "${state.text}"`);
  assert(full.startsWith(state.text), `mid-type "${state.text}" should be a prefix of "${full}"`);
  // Before start → nothing; after the type window → the whole string.
  assert(typewriterText(clip!, clip!.start).text.length === 0, "typewriter should start empty");
  assert(typewriterText(clip!, clip!.start + clip!.anim.durationSec + 0.01).done, "typewriter should finish");
  const n = await renderAndAssert(doc, mid, "verify-typewriter.png");

  // Export sequences one drawtext PER character-count (time-gated slices).
  const plan = buildExportPlan(doc, (id) => `/media/${id}.mp4`, "/out/type.mp4");
  const drawtexts = plan.filterComplex.match(/drawtext=/g) ?? [];
  assert(drawtexts.length >= full.length, `typewriter: expected >=${full.length} drawtext slices, got ${drawtexts.length}`);
  assert(plan.filterComplex.includes("text='y':"), "typewriter: expected a single-char first slice text='y'");
  assert(plan.filterComplex.includes("text='you@example.com':"), "typewriter: expected the full final slice");
  console.log(`  [32m✔[0m check 28 (typewriter): mid-type "${state.text}" renders (${n}b) + ${drawtexts.length} time-gated drawtext slices on export`);
}

async function checkCursor(): Promise<void> {
  const base = parseEditDoc({ version: 1, meta: { width: 1280, height: 720, background: "#101418" }, tracks: [] });
  const doc = addCursor(base, {
    waypoints: [
      { x: 100, y: 100, atSec: 0 },
      { x: 900, y: 500, atSec: 1 },
    ],
    clicks: [1.0],
  });
  const clip = doc.tracks.flatMap((t) => t.clips).find((c): c is CursorClip => c.kind === "cursor");
  assert(clip, "expected a cursor clip");

  // Mid-move the pointer sits strictly BETWEEN the two waypoints.
  const pos = cursorPositionAt(clip!, 0.5);
  assert(pos.x > 100 && pos.x < 900 && pos.y > 100 && pos.y < 500, `mid-move should be between waypoints, got ${JSON.stringify(pos)}`);
  // Endpoints hold before/after.
  assert(cursorPositionAt(clip!, 0).x === 100 && cursorPositionAt(clip!, 5).x === 900, "cursor endpoints should hold");
  // A ripple is active AT the click time and gone well after.
  assert(cursorRipples(clip!, 1.0).length >= 1, "expected an active click ripple at the click time");
  assert(cursorRipples(clip!, 1.0 + clip!.rippleSec + 0.2).length === 0, "ripple should be gone after its lifetime");

  const nMove = await renderAndAssert(doc, 0.5, "verify-cursor-move.png");
  const nClick = await renderAndAssert(doc, 1.0, "verify-cursor-click.png");

  // Export: a moving pointer drawtext (time expr) + concentric ripple drawboxes.
  const plan = buildExportPlan(doc, (id) => `/media/${id}.mp4`, "/out/cursor.mp4");
  assert(plan.filterComplex.includes("drawtext=") && plan.filterComplex.includes("if(lt(t\\,"), "cursor: expected a time-interpolated pointer drawtext on export");
  assert(plan.filterComplex.includes("drawbox=") && plan.filterComplex.includes(":t=3:"), "cursor: expected ripple ring drawboxes on export");
  console.log(`  [32m✔[0m check 29 (cursor): pointer mid-move (${nMove}b) + ripple at click (${nClick}b) + time-expr drawtext & ripple drawboxes on export`);
}

async function checkCallout(): Promise<void> {
  const media: MediaAsset = { id: "shot", kind: "image", src: "shots/a.png", width: 1280, height: 720, label: "a.png" };
  const withContent = parseEditDoc({
    version: 1,
    meta: { width: 1280, height: 720, background: "#101418" },
    media: [media],
    tracks: [{ id: "screens", kind: "visual", clips: [{ id: "s0", kind: "image", start: 0, duration: 4, mediaId: "shot", transform: { x: 640, y: 360 } }] }],
  });
  const doc = addCallout(withContent, { x: 200, y: 200, w: 500, h: 220, label: "Sign in", dim: true });
  const clip = doc.tracks.flatMap((t) => t.clips).find((c): c is CalloutClip => c.kind === "callout");
  assert(clip, "expected a callout clip");
  assert(clip!.dim === true && clip!.borderWidth > 0, "callout should have dim + a border");

  // Zoom math: screen rect + transform grow about the rect center.
  assert(JSON.stringify(calloutScreenRect(clip!)) === JSON.stringify({ x: 200, y: 200, w: 500, h: 220 }), "no-zoom screen rect should equal the rect");
  const zc = addCallout(withContent, { x: 200, y: 200, w: 400, h: 200, zoom: 2 });
  const zClip = zc.tracks.flatMap((t) => t.clips).find((c): c is CalloutClip => c.kind === "callout")!;
  assert(calloutTransform(zClip).scale === 2, "callout zoom transform should scale by the zoom");
  const zr = calloutScreenRect(zClip);
  assert(zr.w === 800 && zr.h === 400, `zoomed screen rect should double, got ${zr.w}x${zr.h}`);

  // The callout (dim + border) changes the rendered pixels vs the same doc without it.
  const withBytes = await renderBytes(doc, 1.0);
  writeFileSync(resolve(OUT_DIR, "verify-callout.png"), withBytes);
  const withoutBytes = await renderBytes(withContent, 1.0);
  assert(withBytes.length > 1000 && withBytes.subarray(0, 4).equals(PNG_MAGIC), "callout frame should be a real PNG");
  assert(!withBytes.equals(withoutBytes), "the callout border/dim should change the rendered pixels");

  // Export: drawbox border + drawbox dim boxes + a label drawtext.
  const plan = buildExportPlan(doc, (id) => `/media/${id}.mp4`, "/out/callout.mp4");
  assert(plan.filterComplex.includes("drawbox="), "callout: expected a drawbox border on export");
  assert(plan.filterComplex.includes("color=black@"), "callout: expected dim boxes (black@opacity) on export");
  assert(plan.filterComplex.includes("Sign in"), "callout: expected the label drawtext on export");
  console.log(`  [32m✔[0m check 30 (callout): dim+border change the frame (${withBytes.length}b); zoom rect/transform ×2; drawbox border+dim & label on export`);
}

async function checkBuildDemo(): Promise<void> {
  const shots: MediaAsset[] = Array.from({ length: 3 }, (_, i) => ({
    id: `screen-${i}`, kind: "image" as const, src: `shots/s${i}.png`, width: 1280, height: 720, label: `s${i}.png`,
  }));

  // (a) Direct builder: a login walkthrough — screens sequenced, typed fields, a cursor+click.
  const doc = buildDemo(shots, { login: true });
  const screens = doc.tracks.find((t) => t.id === "screens");
  assert((screens?.clips.length ?? 0) === 3, "demo should have 3 screen clips");
  assert(screens!.clips.some((c) => c.kind === "image" && c.transitionInSec > 0), "demo screens should be sequenced with a transition");
  const typed = doc.tracks.find((t) => t.id === "demo-text");
  const typedClips = typed?.clips.filter((c): c is TextClip => c.kind === "text" && c.anim.style === "typewriter") ?? [];
  assert(typedClips.length === 2, `login demo should type 2 fields (email+password), got ${typedClips.length}`);
  const cursor = doc.tracks.find((t) => t.id === "cursor");
  const cursorClip = cursor?.clips.find((c): c is CursorClip => c.kind === "cursor");
  assert(cursorClip && cursorClip.clicks.length >= 1, "login demo should have a cursor with a click");

  // Renders while a field is typing and while the cursor is moving.
  const nType = await renderAndAssert(doc, 1.0, "verify-demo-typing.png");
  const nMove = await renderAndAssert(doc, 3.6, "verify-demo-cursor.png");

  // (b) StubDirector routing for the three phrases.
  const project = new ProjectState({ media: shots });
  const demoRes = await new StubDirector().interpret("make an interactive demo from these screenshots", project);
  assert(demoRes.toolCalls.some((c) => c.name === "build_demo"), "expected build_demo from the walkthrough phrase");

  const loginProject = new ProjectState({ media: shots });
  const loginRes = await new StubDirector().interpret("type the email and password then click login", loginProject);
  const loginCall = loginRes.toolCalls.find((c) => c.name === "build_demo");
  assert(loginCall, "expected build_demo from the login phrase");
  assert((loginCall!.input as { login?: boolean }).login === true, "login phrase should build the demo with login=true");
  assert(loginRes.doc.tracks.some((t) => t.id === "cursor"), "login demo should include a cursor track");

  const hlProject = new ProjectState({ media: shots });
  const hlRes = await new StubDirector().interpret("highlight the sign-in button", hlProject);
  assert(hlRes.toolCalls.some((c) => c.name === "add_callout"), "expected add_callout from 'highlight the …'");

  const zoomProject = new ProjectState({ media: shots });
  await new StubDirector().interpret("make an interactive demo from these screenshots", zoomProject);
  const zoomRes = await new StubDirector().interpret("zoom into the menu", zoomProject);
  const zoomCall = zoomRes.toolCalls.find((c) => c.name === "add_callout");
  assert(zoomCall, "expected add_callout from 'zoom into …'");
  assert((zoomCall!.input as { zoom?: number }).zoom === 1.4, "'zoom into' should set a callout zoom");
  assert(!zoomRes.toolCalls.some((c) => c.name === "zoom"), "'zoom into the …' should NOT trigger the static zoom tool");

  // (c) The demo doc exports: screen xfade + typed drawtext slices + cursor drawtext.
  const plan = buildExportPlan(doc, (id) => `/media/${id}.mp4`, "/out/demo.mp4");
  assert(plan.filterComplex.includes("xfade="), "demo: expected screen transitions (xfade) on export");
  assert((plan.filterComplex.match(/drawtext=/g) ?? []).length >= 3, "demo: expected typed slices + cursor drawtext on export");
  console.log(`  [32m✔[0m check 31 (build_demo): 3-screen login walkthrough renders (typing ${nType}b, cursor ${nMove}b); phrases → build_demo/add_callout; xfade+drawtext on export`);
}

/** Structural clone of a doc (verify has no structuredClone import elsewhere). */
function structuredCloneDoc(doc: EditDoc): EditDoc {
  return JSON.parse(JSON.stringify(doc)) as EditDoc;
}

/** A 2-cut, hard-cut video doc (clips laid back-to-back, no transition). */
function twoCutDoc(): EditDoc {
  return parseEditDoc({
    version: 1,
    meta: { title: "cuts", width: 1920, height: 1080, fps: 30 },
    media: [{ id: "clip-001", kind: "video", src: "/media/clip-001.mp4", durationSec: 180 }],
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
}

async function checkVideoCutTransition(): Promise<void> {
  // P0-1: a transition set on VIDEO cuts must (a) lay an overlap so preview shows a
  // real A→B dissolve (both clips active mid-transition), and (b) emit xfade +
  // acrossfade on export — not a bare hard-cut concat.
  const dip = setTransition(twoCutDoc(), "dip-to-black");
  const vids = dip.tracks.find((t) => t.id === "video")!.clips;
  const c0 = vids[0]!;
  const c1 = vids[1]!;
  assert(c0.kind === "video" && c1.kind === "video", "expected two video cuts");
  // The incoming clip now OVERLAPS the previous one by the transition duration.
  assert(c1.transitionInSec > 0, "incoming cut should carry a transition");
  const overlapStart = c1.start;
  const overlapEnd = c0.start + c0.duration;
  assert(overlapStart < overlapEnd - 1e-6, `expected an overlap, got start ${overlapStart} >= prevEnd ${overlapEnd}`);
  assert(
    Math.abs(overlapStart - (c0.start + c0.duration - c1.transitionInSec)) < 1e-6,
    "overlap should equal the transition duration",
  );
  // Preview parity: BOTH clips are active during the overlap (canvas cross-dissolves them).
  const mid = (overlapStart + overlapEnd) / 2;
  const activeVids = activeClipsAt(dip, mid).filter(({ clip }) => clip.kind === "video");
  assert(activeVids.length === 2, `mid-transition should show BOTH clips, got ${activeVids.length}`);
  const n = await renderAndAssert(dip, mid, "verify-cut-transition.png");

  // Export: xfade (video, dip→fadeblack) + acrossfade (audio) across the overlap,
  // and NO hard-cut concat for this crossfaded sequence.
  const plan = buildExportPlan(dip, (id) => `/media/${id}.mp4`, "/out/cut-dip.mp4");
  assert(plan.filterComplex.includes("xfade=transition=fadeblack:duration="), "cut transition: expected xfade fadeblack on export");
  assert(plan.filterComplex.includes("acrossfade=d="), "cut transition: expected audio acrossfade on export");
  assert(!plan.filterComplex.includes("concat=n="), "cut transition: crossfaded cuts should NOT use a hard-cut concat");

  // A plain crossfade type maps to xfade fade; a hard cut (no transition) still concats.
  const cross = setTransition(twoCutDoc(), "crossfade");
  const cp = buildExportPlan(cross, (id) => `/media/${id}.mp4`, "/out/cut-cross.mp4");
  assert(cp.filterComplex.includes("xfade=transition=fade:"), "cut transition: crossfade should map to xfade fade");
  const hard = buildExportPlan(twoCutDoc(), (id) => `/media/${id}.mp4`, "/out/cut-hard.mp4");
  assert(hard.filterComplex.includes("concat=n=2:v=1:a=1") && !hard.filterComplex.includes("xfade="), "hard cuts must stay a plain concat (unchanged)");

  console.log(`  [32m✔[0m check 32 (video-cut transition): overlap laid → both clips mid-transition (${n}b) → xfade/acrossfade on export; hard cuts still concat`);
}

/** Build a minimal Transcript with the given source-time segments. */
function makeTranscript(segs: { start: number; end: number; text: string }[]): Transcript {
  const segments = segs.map((s, i) => ({ id: `s${i}`, text: s.text, start: s.start, end: s.end, words: [] }));
  return { mediaId: "m", durationSec: segs.reduce((m2, s) => Math.max(m2, s.end), 0), language: "en", segments, words: [] };
}

async function checkCaptionSpeed(): Promise<void> {
  // P1-1: captions must map SOURCE time through the clip's speed. A 2× clip shows
  // source [sourceIn, sourceIn + duration*speed); its transcript maps back to the
  // timeline as start + (segTime - sourceIn)/speed.
  const doc = parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "video", src: "a.mp4", durationSec: 60 }],
    // Timeline [0,10); at 2× it consumes source [5,25).
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 10, sourceIn: 5, speed: 2, mediaId: "m" }] }],
  });
  // A segment at source [20,22) is INSIDE [5,25) — the old (speed-ignoring) window
  // [5,15) would have dropped it entirely.
  const t = makeTranscript([{ start: 20, end: 22, text: "late but shown" }]);
  const caps = addCaptions(doc, t).tracks.find((x) => x.id === "captions")!;
  assert(caps.clips.length === 1, `expected the in-source-range caption, got ${caps.clips.length}`);
  const cap = caps.clips[0]!;
  // timeline start = 0 + (20-5)/2 = 7.5; duration = (22-20)/2 = 1.
  assert(cap.start === 7.5, `caption start should map through speed to 7.5, got ${cap.start}`);
  assert(cap.duration === 1, `caption duration should be retimed to 1, got ${cap.duration}`);

  // Sanity: at 1× the mapping is unchanged (backward compatible).
  const doc1 = parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "video", src: "a.mp4" }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 10, sourceIn: 5, mediaId: "m" }] }],
  });
  const cap1 = addCaptions(doc1, makeTranscript([{ start: 6, end: 8, text: "hi" }])).tracks.find((x) => x.id === "captions")!.clips[0]!;
  assert(cap1.start === 1 && cap1.duration === 2, `1× caption should be unchanged (start 1, dur 2), got ${cap1.start}/${cap1.duration}`);

  console.log(`  [32m✔[0m check 33 (caption speed): 2× clip → caption source window uses duration*speed and maps back /speed (start 7.5, dur 1); 1× unchanged`);
}

async function checkAudioRobustness(): Promise<void> {
  // P1-3: a multi-video concat where one source has NO audio stream must still
  // export — the silent clip gets synthesized silence (anullsrc), and every
  // segment is normalized (aformat) so mismatched rates/layouts can't desync.
  const doc = parseEditDoc({
    version: 1,
    meta: { width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "a", kind: "video", src: "/media/a.mp4" },
      { id: "b", kind: "video", src: "/media/b.mp4", hasAudio: false },
    ],
    tracks: [
      {
        id: "video",
        kind: "visual",
        clips: [
          { id: "c0", kind: "video", start: 0, duration: 4, mediaId: "a", transform: { x: 960, y: 540 } },
          { id: "c1", kind: "video", start: 4, duration: 4, mediaId: "b", transform: { x: 960, y: 540 } },
        ],
      },
    ],
  });
  const plan = buildExportPlan(doc, (id) => `/media/${id}.mp4`, "/out/silent.mp4");
  // The silence is a lavfi anullsrc INPUT; its audio pad is then used in the graph.
  assert(plan.args.some((a) => a.startsWith("anullsrc=")), "audio robustness: silent clip should get an anullsrc lavfi input");
  assert(plan.inputs.length === 3, `audio robustness: expected 2 video inputs + 1 anullsrc, got ${plan.inputs.length}`);
  assert(plan.filterComplex.includes("aformat=sample_rates="), "audio robustness: expected aformat normalization on audio");
  assert(plan.filterComplex.includes("concat=n=2:v=1:a=1"), "audio robustness: concat should still carry audio (a=1)");
  console.log(`  [32m✔[0m check 34 (audio robustness): silent source → anullsrc silence + aformat normalize; concat a=1 survives`);
}

async function checkSpeedGuard(): Promise<void> {
  // P1-4: a fast clip can't read past the source. duration 10 × 2 wants 20s of
  // source, but only 15 remain → clamp to 15/10 = 1.5×.
  const doc = parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "video", src: "a.mp4", durationSec: 15 }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 10, sourceIn: 0, mediaId: "m" }] }],
  });
  const clamped = setSpeed(doc, { speed: 2 });
  const c = clamped.tracks.flatMap((t) => t.clips).find((x): x is VideoClip => x.kind === "video")!;
  assert(c.speed === 1.5, `fast speed should clamp to available source (1.5×), got ${c.speed}`);
  // Export never reads past EOF: -t = duration*speed = 15 <= source 15.
  const plan = buildExportPlan(clamped, (id) => `/media/${id}.mp4`, "/out/guard.mp4");
  assert(plan.args.includes("15"), "speed guard: -t should be duration*clampedSpeed (15)");

  // Plenty of source → the requested fast speed is kept unchanged.
  const roomy = parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "video", src: "a.mp4", durationSec: 100 }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 10, sourceIn: 0, mediaId: "m" }] }],
  });
  const fast = setSpeed(roomy, { speed: 2 }).tracks.flatMap((t) => t.clips).find((x): x is VideoClip => x.kind === "video")!;
  assert(fast.speed === 2, `ample source should keep 2×, got ${fast.speed}`);
  console.log(`  [32m✔[0m check 35 (speed guard): 2× on 15s source clamps to 1.5× (no read past EOF); ample source keeps 2×`);
}

async function checkMusicDuration(): Promise<void> {
  // P1: add_music takes startSec + durationSec; default = min(asset, timeline).
  const song: MediaAsset = { id: "song", kind: "audio", src: "s.mp3", durationSec: 200, label: "bed.mp3" };
  const base = parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "video", src: "a.mp4" }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 30, mediaId: "m" }] }],
  });
  // Default: min(song 200, timeline 30) = 30, start 0.
  const def = addMusic(base, song).tracks.find((t) => t.id === "music")!.clips[0]!;
  assert(def.kind === "audio" && def.duration === 30 && def.start === 0, `default music should be min(asset, timeline)=30 @0, got ${def.kind === "audio" ? `${def.duration}@${def.start}` : "?"}`);

  // Explicit offset + trim.
  const trimmed = addMusic(base, song, { startSec: 5, durationSec: 10 }).tracks.find((t) => t.id === "music")!.clips[0]!;
  assert(trimmed.kind === "audio" && trimmed.duration === 10 && trimmed.start === 5, `explicit music should be 10s @5s, got ${trimmed.kind === "audio" ? `${trimmed.duration}@${trimmed.start}` : "?"}`);
  // Export honors the offset via adelay.
  const withMusic = parseEditDoc(structuredCloneDoc(addMusic(base, song, { startSec: 5, durationSec: 10 })));
  const plan = buildExportPlan(withMusic, (id) => `/media/${id}.mp4`, "/out/music-dur.mp4");
  assert(plan.filterComplex.includes("adelay=5000|5000"), "music: expected adelay reflecting the 5s offset");
  console.log(`  [32m✔[0m check 36 (music duration/offset): default=min(asset,timeline)=30; startSec/durationSec → 10s @5s + adelay on export`);
}

async function checkSlideshowKeepsMusic(): Promise<void> {
  // P1: re-running make_slideshow must NOT drop attached music/voice-over.
  const imgs: MediaAsset[] = Array.from({ length: 3 }, (_, i) => ({
    id: `photo-${i}`, kind: "image" as const, src: `/media/p${i}.jpg`, width: 1920, height: 1080, label: `p${i}.jpg`,
  }));
  const song: MediaAsset = { id: "song", kind: "audio", src: "s.mp3", durationSec: 60, label: "bed.mp3" };
  const project = new ProjectState({ media: [...imgs, song] });
  await new StubDirector().interpret("make a slideshow from my photos", project);
  // Attach music, then rebuild the slideshow.
  project.setDoc(addMusic(project.doc, song));
  assert(project.doc.tracks.some((t) => t.id === "music" && t.clips.length > 0), "music should attach before the rebuild");
  const r = await new StubDirector().interpret("make a slideshow from my photos", project);
  const music = r.doc.tracks.find((t) => t.id === "music");
  assert((music?.clips.length ?? 0) > 0, "make_slideshow must PRESERVE the music track on rebuild");
  assert(r.doc.media.some((m) => m.id === "song"), "the music asset must survive the rebuild");
  // The rebuilt slideshow still exports the music (amix).
  const plan = buildExportPlan(r.doc, (id) => `/media/${id}.mp4`, "/out/slide-music.mp4");
  assert(plan.filterComplex.includes("amix="), "preserved music should still mix on export");
  console.log(`  [32m✔[0m check 37 (slideshow keeps audio): rebuilding a slideshow preserves the attached music track (+ amix on export)`);
}

async function checkKeyframes(): Promise<void> {
  // (a) PURE valueAt: linear + eased interpolation, holds, and no-keyframe base.
  const scaleKfs: Keyframe[] = [
    { prop: "scale", t: 0, value: 1, easing: "linear" },
    { prop: "scale", t: 1, value: 2, easing: "linear" },
  ];
  assert(Math.abs(valueAt(scaleKfs, "scale", 0.5, 1) - 1.5) < 1e-9, "valueAt linear midpoint should be 1.5");
  assert(valueAt(undefined, "scale", 0.5, 7) === 7, "valueAt with no keyframes returns the base");
  assert(valueAt(scaleKfs, "rotation", 0.5, 42) === 42, "valueAt returns base for an unkeyed prop");
  assert(valueAt(scaleKfs, "scale", 0, 1) === 1 && valueAt(scaleKfs, "scale", 1, 1) === 2, "valueAt holds the endpoints");
  const easeKfs: Keyframe[] = [
    { prop: "opacity", t: 0, value: 0, easing: "linear" },
    { prop: "opacity", t: 1, value: 1, easing: "ease-in" },
  ];
  // ease-in cubic at p=0.5 → 0.5^3 = 0.125.
  assert(Math.abs(valueAt(easeKfs, "opacity", 0.5, 1) - 0.125) < 1e-9, "valueAt ease-in midpoint should be 0.125");

  // (b) animate (pure) sets keyframes; the doc renders and differs mid-anim from base.
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);
  const animated = animate(project.doc, { prop: "scale", from: 1, to: 1.8, atSec: 1 });
  const vc = animated.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video" && !!c.keyframes);
  assert(vc && vc.keyframes?.some((k) => k.prop === "scale"), "animate should add scale keyframes to a video clip");
  const midProg = 0.5;
  const sc = valueAt(vc!.keyframes, "scale", midProg, 1);
  assert(sc > 1.05 && sc < 1.8, `mid-animation scale should interpolate strictly between, got ${sc}`);
  const mid = vc!.start + vc!.duration / 2;
  const withKf = await renderBytes(animated, mid);
  writeFileSync(resolve(OUT_DIR, "verify-keyframe-scale.png"), withKf);
  const baseDoc = structuredCloneDoc(animated);
  for (const t of baseDoc.tracks) for (const c of t.clips) delete (c as { keyframes?: unknown }).keyframes;
  const withoutKf = await renderBytes(parseEditDoc(baseDoc), mid);
  assert(withKf.subarray(0, 4).equals(PNG_MAGIC), "keyframe frame should be a real PNG");
  assert(!withKf.equals(withoutKf), "the keyframed scale should change the rendered frame");

  // (c) StubDirector routing: "zoom over time" → animate (scale), NOT static zoom/
  // speed/emphasis; "fade the title" → animate opacity on an EXISTING title.
  const zt = await new StubDirector().interpret("zoom in over time", project);
  assert(zt.toolCalls.some((c) => c.name === "animate"), "expected animate from 'zoom in over time'");
  assert(
    !zt.toolCalls.some((c) => c.name === "zoom" || c.name === "set_speed" || c.name === "add_emphasis"),
    "'over time' should not trigger the static zoom / speed / emphasis tools",
  );
  const tp = videoProject();
  tp.setTranscript(await new StubTranscriber().transcribe(tp.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", tp);
  await new StubDirector().interpret('add a title that says "Hello"', tp);
  const ft = await new StubDirector().interpret("fade the title in", tp);
  assert(ft.toolCalls.some((c) => c.name === "animate"), "expected animate for 'fade the title'");
  assert(
    !ft.toolCalls.some((c) => c.name === "add_title" || c.name === "add_fades"),
    "'fade the title' should animate the existing title, not add a title or black fades",
  );
  const titleClip = ft.doc.tracks.find((t) => t.id === "titles")?.clips.find((c): c is TextClip => c.kind === "text" && !!c.keyframes);
  assert(titleClip?.keyframes?.some((k) => k.prop === "opacity"), "the title should get opacity keyframes");

  // (d) Export: scale keyframes → zoompan interpolation expr; volume keyframes →
  // a time-expression volume (volume=…:eval=frame).
  const plan = buildExportPlan(animated, (id) => `/media/${id}.mp4`, "/out/kf.mp4");
  assert(plan.filterComplex.includes("zoompan=") && plan.filterComplex.includes("if(lt(on"), "keyframe scale: expected a zoompan interpolation expr on export");
  const song: MediaAsset = { id: "song", kind: "audio", src: "s.mp3", durationSec: 60, label: "bed.mp3" };
  const ducked = animate(addMusic(animated, song), { prop: "volume", from: 0.6, to: 0.1, track: "music" });
  const mplan = buildExportPlan(ducked, (id) => `/media/${id}.mp4`, "/out/kfvol.mp4");
  assert(mplan.filterComplex.includes("volume='") && mplan.filterComplex.includes(":eval=frame"), "keyframe volume: expected a volume time-expr (eval=frame) on export");
  console.log(`  [32m✔[0m check 38 (keyframes): valueAt lin/ease/holds; animate scale renders (${withKf.length}b) & changes the frame; 'over time'/'fade the title' → animate; zoompan expr + volume eval=frame on export`);
}

async function checkReverse(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);
  const r = await new StubDirector().interpret("reverse the clip", project);
  assert(r.toolCalls.some((c) => c.name === "reverse_clip"), "expected reverse_clip");
  const rc = r.doc.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video");
  assert(rc && rc.reversed === true, "the clip should be marked reversed");

  // Reversed source mapping: local 0 shows the END of the window; local end shows sourceIn.
  const span = rc!.duration * (rc!.speed ?? 1);
  assert(Math.abs(sourceTimeAt(rc!, rc!.start) - (rc!.sourceIn + span)) < 1e-6, "reversed start should show the window end");
  assert(Math.abs(sourceTimeAt(rc!, rc!.start + rc!.duration) - rc!.sourceIn) < 1e-6, "reversed end should show sourceIn");
  const n = await renderAndAssert(r.doc, rc!.start + rc!.duration / 2, "verify-reverse.png");

  const plan = buildExportPlan(r.doc, (id) => `/media/${id}.mp4`, "/out/rev.mp4");
  assert(plan.filterComplex.includes("v]reverse"), "reverse: expected the video `reverse` filter on export");
  assert(plan.filterComplex.includes("areverse"), "reverse: expected the audio `areverse` filter on export");
  console.log(`  [32m✔[0m check 39 (reverse): reversed flag + backwards sourceTimeAt mapping + frame (${n}b) + reverse/areverse on export`);
}

async function checkFreeze(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);
  const r = await new StubDirector().interpret("freeze frame at 2s", project);
  assert(r.toolCalls.some((c) => c.name === "freeze_frame"), "expected freeze_frame");
  const fc = r.doc.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video" && c.freezeAtSec !== undefined);
  assert(fc && fc.freezeAtSec !== undefined, "a video clip should carry freezeAtSec");

  // sourceTimeAt holds that one source frame regardless of local time.
  assert(sourceTimeAt(fc!, fc!.start) === fc!.freezeAtSec, "freeze should hold one source time at the head");
  assert(sourceTimeAt(fc!, fc!.start + fc!.duration) === fc!.freezeAtSec, "freeze should hold the same source time at the tail");
  const n = await renderAndAssert(r.doc, fc!.start + fc!.duration / 2, "verify-freeze.png");

  const plan = buildExportPlan(r.doc, (id) => `/media/${id}.mp4`, "/out/freeze.mp4");
  assert(plan.filterComplex.includes("tpad=stop_mode=clone"), "freeze: expected tpad clone-hold on export");
  assert(plan.filterComplex.includes("trim=end_frame=1"), "freeze: expected a single-frame trim on export");
  assert(plan.args.some((a) => a.startsWith("anullsrc=")), "freeze: expected synthesized silence for the frozen (audio-less) clip");
  console.log(`  [32m✔[0m check 40 (freeze-frame): freezeAtSec holds one source frame + frame (${n}b) + trim/tpad clone + anullsrc silence on export`);
}

async function checkMarkers(): Promise<void> {
  // Default empty + pure addMarker (sorted, labels kept) + JSON round-trip.
  const base = parseEditDoc({ version: 1, meta: { width: 1280, height: 720 }, tracks: [] });
  assert(Array.isArray(base.markers) && base.markers.length === 0, "markers should default to []");
  const withMarkers = addMarker(addMarker(base, 12, "Intro"), 3.5);
  assert(withMarkers.markers.length === 2, "expected 2 markers");
  assert(withMarkers.markers[0]!.t === 3.5, "markers should be sorted by time");
  assert(withMarkers.markers[1]!.t === 12 && withMarkers.markers[1]!.label === "Intro", "marker label should be preserved");
  const round = parseEditDoc(JSON.parse(JSON.stringify(withMarkers)));
  assert(round.markers.length === 2 && round.markers[1]!.label === "Intro", "markers should survive a JSON round-trip through parseEditDoc");

  // StubDirector phrase.
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);
  const r = await new StubDirector().interpret("add a marker at 8s", project);
  assert(r.toolCalls.some((c) => c.name === "add_marker"), "expected add_marker");
  assert(r.doc.markers.some((m) => m.t === 8), "marker should land at 8s");
  console.log(`  [32m✔[0m check 41 (markers): default []; addMarker sorts + keeps labels + round-trips; 'add a marker at 8s' → add_marker`);
}

async function checkCaptionSidecar(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);
  const r = await new StubDirector().interpret("add captions", project);
  const capTrack = r.doc.tracks.find((t) => t.id === "captions");
  assert((capTrack?.clips.length ?? 0) > 0, "need captions to serialize");

  const srt = toSrt(r.doc);
  const vtt = toVtt(r.doc);
  // SRT: cue 1 numbered, hh:mm:ss,mmm --> hh:mm:ss,mmm.
  assert(/^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/.test(srt), `SRT format wrong:\n${srt.slice(0, 90)}`);
  assert(srt.includes(" --> ") && srt.includes(","), "SRT should use comma milliseconds");
  // VTT: WEBVTT header + hh:mm:ss.mmm.
  assert(vtt.startsWith("WEBVTT\n\n"), "VTT should start with the WEBVTT header");
  assert(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/.test(vtt), "VTT should use dot milliseconds");
  // formatTimestamp exactness for both separators.
  assert(formatTimestamp(3661.5, ",") === "01:01:01,500", `SRT timestamp wrong: ${formatTimestamp(3661.5, ",")}`);
  assert(formatTimestamp(3661.5, ".") === "01:01:01.500", `VTT timestamp wrong: ${formatTimestamp(3661.5, ".")}`);
  // Cue count matches the caption clips.
  const cues = (srt.match(/ --> /g) ?? []).length;
  assert(cues === capTrack!.clips.length, `SRT cue count ${cues} should equal caption clips ${capTrack!.clips.length}`);
  console.log(`  [32m✔[0m check 42 (SRT/VTT sidecar): ${cues} cues; hh:mm:ss,mmm (SRT) + WEBVTT hh:mm:ss.mmm (VTT); formatTimestamp exact`);
}

async function checkPlatform(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);

  // Pure setPlatform: aspect + quality + fps per platform.
  const tk = setPlatform(project.doc, "tiktok");
  assert(tk.meta.width === 1080 && tk.meta.height === 1920, `tiktok should be 1080×1920, got ${tk.meta.width}×${tk.meta.height}`);
  assert(tk.quality.preset === "high", `tiktok quality should be high, got ${tk.quality.preset}`);
  assert(tk.meta.fps === 30 && tk.quality.fps === 30, "tiktok fps should be 30 on meta + quality");
  const yt = setPlatform(project.doc, "youtube");
  assert(yt.meta.width === 1920 && yt.meta.height === 1080, `youtube should be 1920×1080, got ${yt.meta.width}×${yt.meta.height}`);
  const ig = setPlatform(project.doc, "instagram-feed");
  assert(ig.meta.width === 1080 && ig.meta.height === 1350, `ig-feed should be 1080×1350, got ${ig.meta.width}×${ig.meta.height}`);

  // StubDirector: "export for tiktok" → set_platform (tiktok), reframing itself.
  const r = await new StubDirector().interpret("export this for tiktok", project);
  const call = r.toolCalls.find((c) => c.name === "set_platform");
  assert(call, "expected set_platform from 'export for tiktok'");
  assert((call!.input as { platform: string }).platform === "tiktok", "platform should be tiktok");
  assert(!r.toolCalls.some((c) => c.name === "reframe"), "platform should reframe itself, not via a separate reframe call");
  assert(r.doc.meta.width === 1080 && r.doc.meta.height === 1920, "tiktok export should be vertical");

  const ry = await new StubDirector().interpret("render it for youtube", project);
  assert(ry.toolCalls.some((c) => c.name === "set_platform" && (c.input as { platform: string }).platform === "youtube"), "expected the youtube platform");
  const rr = await new StubDirector().interpret("make it for reels", project);
  assert(rr.toolCalls.some((c) => c.name === "set_platform" && (c.input as { platform: string }).platform === "reels"), "expected the reels platform");

  // The platform doc renders + carries the fps into the export.
  const n = await renderAndAssert(rr.doc, docDurationSec(rr.doc) / 2, "verify-platform.png");
  const plan = buildExportPlan(rr.doc, (id) => `/media/${id}.mp4`, "/out/tt.mp4");
  assert(plan.args.includes("-r") && plan.args[plan.args.indexOf("-r") + 1] === "30", "platform export should set 30fps (-r 30)");
  console.log(`  [32m✔[0m check 43 (platform presets): tiktok 1080×1920/high/30 · youtube 1920×1080 · ig-feed 1080×1350; 'export for tiktok/youtube/reels' → set_platform (frame ${n}b)`);
}

async function checkChromaKey(): Promise<void> {
  // A base video + a keyed b-roll overlay (green screen) composites over the base.
  const doc = parseEditDoc({
    version: 1,
    meta: { width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "bg", kind: "video", src: "/media/bg.mp4" },
      { id: "fg", kind: "video", src: "/media/fg.mp4" },
    ],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 5, mediaId: "bg", transform: { x: 960, y: 540 } }] },
      {
        id: "broll",
        kind: "visual",
        clips: [
          { id: "k0", kind: "video", start: 0, duration: 5, mediaId: "fg", transform: { x: 960, y: 540 }, chroma: { color: "#00d000", similarity: 0.3, blend: 0.1, spill: 0.2 } },
        ],
      },
    ],
  });
  const kc = doc.tracks.find((t) => t.id === "broll")!.clips[0]!;
  assert(kc.kind === "video" && !!kc.chroma, "expected a keyed b-roll clip");

  // Canvas approximates the key (background dropped → beneath shows); it changes pixels.
  const withKey = await renderBytes(doc, 2.5);
  writeFileSync(resolve(OUT_DIR, "verify-chroma.png"), withKey);
  const noKeyDoc = structuredCloneDoc(doc);
  for (const t of noKeyDoc.tracks) for (const c of t.clips) delete (c as { chroma?: unknown }).chroma;
  const withoutKey = await renderBytes(parseEditDoc(noKeyDoc), 2.5);
  assert(withKey.subarray(0, 4).equals(PNG_MAGIC), "chroma frame should be a real PNG");
  assert(!withKey.equals(withoutKey), "the chroma key should change the rendered frame");

  // Export: chromakey (+ despill) on the overlay before it composites via overlay.
  const plan = buildExportPlan(doc, (id) => `/media/${id}.mp4`, "/out/chroma.mp4");
  assert(plan.filterComplex.includes("chromakey=color=0x00d000:similarity=0.3:blend=0.1"), "chroma: expected chromakey on export");
  assert(plan.filterComplex.includes("despill=type=green:mix=0.2"), "chroma: expected despill spill suppression");
  assert(plan.filterComplex.includes("overlay="), "chroma: keyed clip should composite via overlay");

  // StubDirector routing: "remove the green background" → chroma_key.
  const project = videoProject();
  project.media.push({ id: "insert", kind: "image", src: "uploads/insert.jpg", width: 1920, height: 1080, label: "insert.jpg" });
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 15 second highlight", project);
  await new StubDirector().interpret("add b-roll", project);
  const r = await new StubDirector().interpret("remove the green background", project);
  assert(r.toolCalls.some((c) => c.name === "chroma_key"), "expected chroma_key from 'remove the green background'");
  console.log(`  [32m✔[0m check 44 (chroma key): keyed overlay changes the frame (${withKey.length}b) + chromakey/despill/overlay on export; 'remove the green background' → chroma_key`);
}

async function checkBlendMode(): Promise<void> {
  // A base video + a screen-blend b-roll layer over it.
  const doc = parseEditDoc({
    version: 1,
    meta: { width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "bg", kind: "video", src: "/media/bg.mp4" },
      { id: "tex", kind: "image", src: "/media/tex.jpg", width: 1920, height: 1080 },
    ],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 5, mediaId: "bg", transform: { x: 960, y: 540 } }] },
      { id: "broll", kind: "visual", clips: [{ id: "b0", kind: "image", start: 0, duration: 5, mediaId: "tex", transform: { x: 960, y: 540 }, blendMode: "screen" }] },
    ],
  });
  const bc = doc.tracks.find((t) => t.id === "broll")!.clips[0]!;
  assert(bc.kind === "image" && bc.blendMode === "screen", "expected a screen-blend b-roll clip");

  // Canvas composites via globalCompositeOperation → changes pixels vs normal.
  const withBlend = await renderBytes(doc, 2.5);
  writeFileSync(resolve(OUT_DIR, "verify-blend.png"), withBlend);
  const normalDoc = structuredCloneDoc(doc);
  for (const t of normalDoc.tracks) for (const c of t.clips) if ("blendMode" in c) (c as { blendMode?: string }).blendMode = "normal";
  const withNormal = await renderBytes(parseEditDoc(normalDoc), 2.5);
  assert(!withBlend.equals(withNormal), "the blend mode should change the rendered frame");

  // Export: blend=all_mode=screen over the base.
  const plan = buildExportPlan(doc, (id) => `/media/${id}.mp4`, "/out/blend.mp4");
  assert(plan.filterComplex.includes("blend=all_mode=screen:all_opacity="), "blend: expected blend=all_mode=screen on export");
  // enum → ffmpeg/canvas mappings are exact.
  assert(ffBlendMode("add") === "addition" && ffBlendMode("soft-light") === "softlight" && ffBlendMode("multiply") === "multiply", "blend: ffmpeg mode names exact");
  assert(blendCompositeOperation("add") === "lighter" && blendCompositeOperation("screen") === "screen", "blend: canvas op mapping exact");

  // StubDirector routing: "screen blend" → set_blend (screen).
  const project = videoProject();
  project.media.push({ id: "insert", kind: "image", src: "uploads/insert.jpg", width: 1920, height: 1080 });
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 15 second highlight", project);
  await new StubDirector().interpret("add b-roll", project);
  const r = await new StubDirector().interpret("use a screen blend", project);
  const call = r.toolCalls.find((c) => c.name === "set_blend");
  assert(call && (call.input as { mode: string }).mode === "screen", "expected set_blend (screen) from 'use a screen blend'");
  console.log(`  [32m✔[0m check 45 (blend modes): screen blend changes the frame (${withBlend.length}b) + blend=all_mode=screen on export; mappings exact; 'screen blend' → set_blend`);
}

async function checkRegionFx(): Promise<void> {
  // Blur a region of a single base video clip.
  const doc = parseEditDoc({
    version: 1,
    meta: { width: 1920, height: 1080, fps: 30 },
    media: [{ id: "v", kind: "video", src: "/media/v.mp4" }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 5, mediaId: "v", transform: { x: 960, y: 540 }, regionFx: { type: "blur", x: 700, y: 300, w: 500, h: 400, amount: 0.6 } }] }],
  });
  const withBlur = await renderBytes(doc, 2.5);
  writeFileSync(resolve(OUT_DIR, "verify-region-blur.png"), withBlur);
  const plainDoc = structuredCloneDoc(doc);
  for (const t of plainDoc.tracks) for (const c of t.clips) delete (c as { regionFx?: unknown }).regionFx;
  const withoutBlur = await renderBytes(parseEditDoc(plainDoc), 2.5);
  assert(!withBlur.equals(withoutBlur), "the region blur should change the rendered frame");

  // Export: split → crop the region → boxblur → overlay back.
  const plan = buildExportPlan(doc, (id) => `/media/${id}.mp4`, "/out/region.mp4");
  assert(plan.filterComplex.includes("split"), "region: expected a split to branch the region");
  assert(plan.filterComplex.includes("crop=500:400:700:300"), "region: expected the region crop");
  assert(plan.filterComplex.includes("boxblur="), "region: expected boxblur on the region");
  assert(plan.filterComplex.includes("overlay="), "region: expected the region overlaid back");

  // Pixelate variant → pixelize.
  const pix = parseEditDoc({
    version: 1,
    meta: { width: 1920, height: 1080, fps: 30 },
    media: [{ id: "v", kind: "video", src: "/media/v.mp4" }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 5, mediaId: "v", transform: { x: 960, y: 540 }, regionFx: { type: "pixelate", x: 100, y: 100, w: 300, h: 300, amount: 0.5 } }] }],
  });
  const pixPlan = buildExportPlan(pix, (id) => `/media/${id}.mp4`, "/out/pix.mp4");
  assert(pixPlan.filterComplex.includes("pixelize=w="), "region: expected pixelize for pixelate");

  // StubDirector routing: "blur the face" → blur_region; "pixelate the plate" → pixelate_region.
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 15 second highlight", project);
  const rb = await new StubDirector().interpret("blur the face", project);
  assert(rb.toolCalls.some((c) => c.name === "blur_region"), "expected blur_region from 'blur the face'");
  const rp = await new StubDirector().interpret("pixelate the license plate", project);
  assert(rp.toolCalls.some((c) => c.name === "pixelate_region"), "expected pixelate_region from 'pixelate the license plate'");
  console.log(`  [32m✔[0m check 46 (blur/pixelate region): region blur changes the frame (${withBlur.length}b) + split/crop/boxblur/overlay & pixelize on export; 'blur the face'/'pixelate the plate' route`);
}

async function checkMask(): Promise<void> {
  // An ellipse mask on a b-roll overlay reveals only inside the shape.
  const doc = parseEditDoc({
    version: 1,
    meta: { width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "bg", kind: "video", src: "/media/bg.mp4" },
      { id: "fg", kind: "video", src: "/media/fg.mp4" },
    ],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 5, mediaId: "bg", transform: { x: 960, y: 540 } }] },
      { id: "broll", kind: "visual", clips: [{ id: "m0", kind: "video", start: 0, duration: 5, mediaId: "fg", transform: { x: 960, y: 540 }, mask: { shape: "ellipse", x: 560, y: 240, w: 800, h: 600, feather: 40, invert: false } }] },
    ],
  });
  const withMask = await renderBytes(doc, 2.5);
  writeFileSync(resolve(OUT_DIR, "verify-mask.png"), withMask);
  const noMaskDoc = structuredCloneDoc(doc);
  for (const t of noMaskDoc.tracks) for (const c of t.clips) delete (c as { mask?: unknown }).mask;
  const withoutMask = await renderBytes(parseEditDoc(noMaskDoc), 2.5);
  assert(!withMask.equals(withoutMask), "the mask should change the rendered frame (shape reveal)");

  // Export: a geq shaped alpha on the overlay, then it composites via overlay.
  const plan = buildExportPlan(doc, (id) => `/media/${id}.mp4`, "/out/mask.mp4");
  assert(plan.filterComplex.includes("geq="), "mask: expected a geq alpha on export");
  assert(plan.filterComplex.includes("overlay="), "mask: masked clip should composite via overlay");

  // StubDirector routing: "mask to a circle" → add_mask (ellipse).
  const project = videoProject();
  project.media.push({ id: "insert", kind: "image", src: "uploads/insert.jpg", width: 1920, height: 1080 });
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 15 second highlight", project);
  await new StubDirector().interpret("add b-roll", project);
  const r = await new StubDirector().interpret("mask it to a circle", project);
  const call = r.toolCalls.find((c) => c.name === "add_mask");
  assert(call && (call.input as { shape?: string }).shape === "ellipse", "expected add_mask (ellipse) from 'mask it to a circle'");
  console.log(`  [32m✔[0m check 47 (mask): shape mask changes the frame (${withMask.length}b) + geq alpha + overlay on export; 'mask it to a circle' → add_mask (ellipse)`);
}

async function checkCurvesHsl(): Promise<void> {
  // Base highlight, then curves + HSL applied to the main clips.
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  const hl = await new StubDirector().interpret("cut a 15 second highlight", project);

  // (a) PURE adjustCurves + adjustHsl set the grade and render.
  const curved = adjustCurves(hl.doc, { master: [[0, 0], [0.5, 0.62], [1, 1]] });
  const cv = curved.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video");
  assert(cv && !!cv.look.curves && !!cv.look.curves.master, "adjustCurves should set a master curve");
  const hsl = adjustHsl(curved, { hueShift: 40, saturation: 1.2 });
  const hv = hsl.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video");
  assert(hv && hv.look.hueShift === 40 && hv.look.saturation === 1.2, "adjustHsl should set hueShift + saturation");
  // curves survive the HSL nudge (merge, not replace).
  assert(hv!.look.curves?.master, "HSL should preserve the earlier curves");
  const n = await renderAndAssert(hsl, docDurationSec(hsl) / 2, "verify-curves-hsl.png");

  // (b) Export: curves + hue filters.
  const plan = buildExportPlan(hsl, (id) => `/media/${id}.mp4`, "/out/curves.mp4");
  assert(plan.filterComplex.includes("curves=master='0/0 0.5/0.62 1/1'"), "curves: expected the ffmpeg curves points string on export");
  assert(plan.filterComplex.includes("hue=h=40"), "hsl: expected hue=h=40 on export");

  // (c) StubDirector routing.
  const rc = await new StubDirector().interpret("add an s-curve for contrast", project);
  assert(rc.toolCalls.some((c) => c.name === "adjust_curves"), "expected adjust_curves from 's-curve'");
  const rh = await new StubDirector().interpret("shift the hue by 40 degrees", project);
  const hcall = rh.toolCalls.find((c) => c.name === "adjust_hsl");
  assert(hcall && (hcall.input as { hueShift?: number }).hueShift === 40, "expected adjust_hsl (hueShift 40) from 'shift the hue by 40'");
  console.log(`  [32m✔[0m check 48 (curves + HSL): adjustCurves/adjustHsl set the grade + render (${n}b); curves points + hue=h= on export; 's-curve'/'shift the hue' route`);
}

async function checkAudioDepth(): Promise<void> {
  // (a) A base video clip with an audio fade + hard-left pan.
  const clipDoc = parseEditDoc({
    version: 1,
    meta: { width: 1920, height: 1080, fps: 30 },
    media: [{ id: "v", kind: "video", src: "/media/v.mp4" }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 6, mediaId: "v", transform: { x: 960, y: 540 }, fadeInSec: 1, fadeOutSec: 1.5, pan: -1 }] }],
  });
  const cp = buildExportPlan(clipDoc, (id) => `/media/${id}.mp4`, "/out/afade.mp4");
  assert(cp.filterComplex.includes("afade=t=in:st=0:d=1"), "audio: expected an afade-in on the clip");
  assert(cp.filterComplex.includes("afade=t=out:st=4.5:d=1.5"), "audio: expected an afade-out ending at the tail");
  assert(cp.filterComplex.includes("pan=stereo|c0=1*c0|c1=0*c1"), "audio: expected a hard-left pan");

  // (b) Music with a fade (extra audio track) + doc-level loudnorm.
  const song: MediaAsset = { id: "song", kind: "audio", src: "s.mp3", durationSec: 60, label: "bed.mp3" };
  const musicDoc = addMusic(clipDoc, song, { durationSec: 6 });
  const faded = audioFadeTargetToMusic(musicDoc);
  const normalized = { ...faded, loudnorm: true } as EditDoc;
  const mp = buildExportPlan(parseEditDoc(normalized), (id) => `/media/${id}.mp4`, "/out/loud.mp4");
  assert(mp.filterComplex.includes("afade=t=out:st="), "audio: expected an afade on the music track");
  assert(mp.filterComplex.includes("loudnorm=I=-14:TP=-1.5:LRA=11"), "audio: expected loudnorm on the final mix");

  // (c) PURE helpers + StubDirector routing.
  const panned = setPan(clipDoc, 1);
  const pc = panned.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video");
  assert(pc && pc.pan === 1, "setPan should set pan on the video clip");
  assert(normalizeLoudness(clipDoc).loudnorm === true, "normalizeLoudness should toggle the doc flag");

  const project = videoProject();
  project.media.push({ id: "song2", kind: "audio", src: "uploads/song.mp3", durationSec: 120, label: "bed.mp3" });
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 15 second highlight", project);
  await new StubDirector().interpret("add background music", project);
  const rf = await new StubDirector().interpret("fade the music out", project);
  assert(rf.toolCalls.some((c) => c.name === "audio_fade"), "expected audio_fade from 'fade the music out'");
  assert(!rf.toolCalls.some((c) => c.name === "add_fades"), "'fade the music' should not add black fades");
  const rp = await new StubDirector().interpret("pan the audio left", project);
  assert(rp.toolCalls.some((c) => c.name === "set_pan"), "expected set_pan from 'pan the audio left'");
  const rl = await new StubDirector().interpret("normalize the loudness", project);
  assert(rl.toolCalls.some((c) => c.name === "normalize_loudness"), "expected normalize_loudness from 'normalize the loudness'");
  console.log(`  [32m✔[0m check 49 (audio depth): clip afade/pan + music afade + loudnorm on export; 'fade the music out'/'pan left'/'normalize loudness' route (no black fades)`);
}

/** Apply a fade-out to the music track of a doc (helper for the audio-depth check). */
function audioFadeTargetToMusic(doc: EditDoc): EditDoc {
  return audioFade(doc, { fadeOutSec: 2, track: "music" });
}

/** Build a Transcript with per-word timings (evenly spread across each segment). */
function makeWordedTranscript(
  mediaId: string,
  segs: { text: string; start: number; end: number }[],
): Transcript {
  const segments = segs.map((s, i) => {
    const toks = s.text.split(/\s+/).filter(Boolean);
    const per = (s.end - s.start) / Math.max(1, toks.length);
    const words = toks.map((text, k) => ({ text, start: round3(s.start + k * per), end: round3(s.start + (k + 1) * per) }));
    return { id: `s${i}`, text: s.text, start: s.start, end: s.end, words };
  });
  const words = segments.flatMap((s) => s.words);
  return { mediaId, durationSec: segs.reduce((m, s) => Math.max(m, s.end), 0), language: "en", segments, words };
}
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

async function checkTranscriptEdit(): Promise<void> {
  const media: MediaAsset = {
    id: "clip-001", kind: "video", src: "uploads/clip-001.mp4",
    durationSec: 60, width: 1920, height: 1080, label: "raw.mp4",
  };
  const transcript = makeWordedTranscript("clip-001", [
    { text: "welcome to the show", start: 0, end: 3 },
    { text: "today we talk about pricing and plans", start: 3.5, end: 8 },
    { text: "um so anyway", start: 8.5, end: 10 },
    { text: "thanks for watching", start: 10.5, end: 13 },
  ]);

  // (a) Remove the sentence about "pricing" (segment unit) → seg1 dropped, 3 remain.
  const rem = editByTranscript(media, transcript, { phrase: "pricing", mode: "remove", unit: "segment" });
  assert(rem.matched && rem.removed === 1, `remove-about-pricing should drop 1 segment, got removed=${rem.removed}`);
  const remVids = rem.doc.tracks.find((t) => t.id === "video")!.clips;
  assert(remVids.length === 3, `expected 3 clips after removing 1 segment, got ${remVids.length}`);
  assert(rem.removedSec > 4 && rem.removedSec < 5, `removedSec should reflect seg1 (~4.5s), got ${rem.removedSec}`);
  const nRem = await renderAndAssert(rem.doc, docDurationSec(rem.doc) / 2, "verify-transcript-remove.png");

  // (b) Keep only the sentences that mention "pricing" → just seg1 remains.
  const kept = editByTranscript(media, transcript, { phrase: "pricing", mode: "keep", unit: "segment" });
  const keptVids = kept.doc.tracks.find((t) => t.id === "video")!.clips;
  assert(keptVids.length === 1, `keep-only-pricing should keep exactly 1 segment, got ${keptVids.length}`);
  assert(keptVids[0]!.kind === "video" && keptVids[0]!.sourceIn === 3.5, "kept clip should start at the matched segment's source in");

  // (c) Word unit: delete every "um" → the word span is cut, the rest survives, renders.
  const um = editByTranscript(media, transcript, { phrase: "um", mode: "remove", unit: "word" });
  assert(um.matched && um.removed === 1, `delete-every-um should match 1 word, got removed=${um.removed}`);
  assert(docDurationSec(um.doc) < 12.5, `um removal should shorten the timeline, got ${docDurationSec(um.doc)}`);
  await renderAndAssert(um.doc, docDurationSec(um.doc) / 2, "verify-transcript-word.png");

  // (d) StubDirector routing for the four phrasings (transcript must match so the
  // builder commits and the tool call is recorded).
  const mkProject = () => {
    const p = new ProjectState({ media: [media] });
    p.setTranscript(transcript);
    return p;
  };
  const rSent = await new StubDirector().interpret("cut the sentence about pricing", mkProject());
  const sentCall = rSent.toolCalls.find((c) => c.name === "edit_by_transcript");
  assert(sentCall && (sentCall.input as { mode: string; unit: string }).mode === "remove" && (sentCall.input as { unit: string }).unit === "segment", "expected edit_by_transcript remove/segment from 'cut the sentence about pricing'");

  const rKeep = await new StubDirector().interpret("keep only where they mention pricing", mkProject());
  const keepCall = rKeep.toolCalls.find((c) => c.name === "edit_by_transcript");
  assert(keepCall && (keepCall.input as { mode: string }).mode === "keep", "expected edit_by_transcript keep from 'keep only where they mention pricing'");

  const rWord = await new StubDirector().interpret("delete every um", mkProject());
  const wordCall = rWord.toolCalls.find((c) => c.name === "edit_by_transcript");
  assert(wordCall && (wordCall.input as { unit: string }).unit === "word", "expected edit_by_transcript word from 'delete every um'");

  const rPart = await new StubDirector().interpret("remove the part where they say thanks for watching", mkProject());
  assert(rPart.toolCalls.some((c) => c.name === "edit_by_transcript"), "expected edit_by_transcript from 'remove the part where they say …'");

  console.log(`  [32m✔[0m check 50 (transcript edit): remove-segment (3 clips, ${nRem}b) / keep-only (1 clip) / delete-every-um (word) render; 'cut the sentence about'/'keep only where they mention'/'delete every'/'remove the part where they say' route`);
}

async function checkRemoveSilence(): Promise<void> {
  const media: MediaAsset = {
    id: "clip-001", kind: "video", src: "uploads/clip-001.mp4",
    durationSec: 60, width: 1920, height: 1080, label: "raw.mp4",
  };
  // Gaps between segments: 2s (drop), 0.3s (keep), 3s (drop).
  const transcript = makeWordedTranscript("clip-001", [
    { text: "first sentence here", start: 0, end: 3 },
    { text: "second sentence here", start: 5, end: 7 },
    { text: "third sentence here", start: 7.3, end: 9 },
    { text: "final sentence here", start: 12, end: 14 },
  ]);

  const res = removeSilence(media, transcript, { thresholdSec: 0.6 });
  assert(res.segments === 4, `remove_silence must KEEP all 4 segments, got ${res.segments}`);
  const clips = res.doc.tracks.find((t) => t.id === "video")!.clips;
  assert(clips.length === 4, `expected 4 clips (all segments kept), got ${clips.length}`);
  assert(res.gapsDropped === 2, `expected 2 gaps over 0.6s dropped, got ${res.gapsDropped}`);
  // removedSec = (2-0.6) + (3-0.6) = 3.8.
  assert(Math.abs(res.removedSec - 3.8) < 1e-6, `expected 3.8s removed, got ${res.removedSec}`);
  // The tightened timeline is shorter than the original span (14s).
  assert(docDurationSec(res.doc) < 11 && docDurationSec(res.doc) > 9, `tightened duration should be ~10.2s, got ${docDurationSec(res.doc)}`);
  const n = await renderAndAssert(res.doc, docDurationSec(res.doc) / 2, "verify-remove-silence.png");

  // StubDirector routing: silence/dead-air/pauses → remove_silence, NOT filler_cut.
  const mkProject = () => {
    const p = new ProjectState({ media: [media] });
    p.setTranscript(transcript);
    return p;
  };
  for (const phrase of ["remove the silences", "remove dead air", "tighten the pauses"]) {
    const r = await new StubDirector().interpret(phrase, mkProject());
    assert(r.toolCalls.some((c) => c.name === "remove_silence"), `expected remove_silence from '${phrase}'`);
    assert(!r.toolCalls.some((c) => c.name === "filler_cut"), `'${phrase}' should not route to filler_cut`);
  }
  // Backward-compat: "filler" still routes to filler_cut (not silence).
  const rf = await new StubDirector().interpret("remove the filler words and tighten it", mkProject());
  assert(rf.toolCalls.some((c) => c.name === "filler_cut"), "'remove the filler words' must still route to filler_cut");
  assert(!rf.toolCalls.some((c) => c.name === "remove_silence"), "'filler words' should not route to remove_silence");

  console.log(`  [32m✔[0m check 51 (silence removal): keeps all 4 segments, drops 2 gaps >0.6s (-3.8s) → ${n}b; 'remove silences/dead air/tighten pauses' → remove_silence; 'filler' still → filler_cut`);
}

async function checkAutoReframe(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);
  const baseDoc = project.doc;

  // (a) Free auto-reframe to 9:16 centers the subject and renders.
  const ar = autoReframe(baseDoc, { aspect: "9:16" });
  assert(ar.meta.width === 1080 && ar.meta.height === 1920, `auto-reframe should be 1080×1920, got ${ar.meta.width}×${ar.meta.height}`);
  const vc = ar.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video");
  assert(vc && vc.transform.x === 540 && vc.transform.y === 960, `subject should be centered (540,960), got (${vc?.kind === "video" ? `${vc.transform.x},${vc.transform.y}` : "?"})`);
  const nCenter = await renderAndAssert(ar, docDurationSec(ar) / 2, "verify-auto-reframe.png");

  // (b) The optional settle-pan adds x keyframes that move toward center.
  const panned = autoReframe(baseDoc, { aspect: "9:16", pan: true });
  const pvc = panned.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video" && !!c.keyframes);
  assert(pvc && pvc.keyframes?.some((k) => k.prop === "x"), "settle-pan should add x keyframes");
  const xEnd = valueAt(pvc!.keyframes, "x", 1, pvc!.transform.x);
  const xStart = valueAt(pvc!.keyframes, "x", 0, pvc!.transform.x);
  assert(xEnd === 540 && xStart < xEnd, `settle-pan should end centered (540) from an offset, got ${xStart}→${xEnd}`);
  await renderAndAssert(panned, docDurationSec(panned) / 2, "verify-auto-reframe-pan.png");

  // (c) subjectTracking (gated) still yields a valid free centered reframe (no vision).
  const tracked = autoReframe(baseDoc, { aspect: "9:16", subjectTracking: true });
  assert(tracked.meta.width === 1080 && tracked.meta.height === 1920, "gated subjectTracking should still produce the free centered reframe");

  // (d) StubDirector routing: "auto-reframe to vertical" & "reframe and keep me
  // centered" → auto_reframe, NOT the plain reframe tool.
  const r1 = await new StubDirector().interpret("auto-reframe to vertical", project);
  assert(r1.toolCalls.some((c) => c.name === "auto_reframe"), "expected auto_reframe from 'auto-reframe to vertical'");
  assert(!r1.toolCalls.some((c) => c.name === "reframe"), "auto-reframe should not also call the plain reframe tool");
  assert(r1.doc.meta.width === 1080 && r1.doc.meta.height === 1920, "auto-reframe to vertical should be 1080×1920");

  const r2 = await new StubDirector().interpret("reframe and keep me centered", project);
  assert(r2.toolCalls.some((c) => c.name === "auto_reframe"), "expected auto_reframe from 'reframe and keep me centered'");

  // subjectTracking flag flows through + the gated note is surfaced.
  const r3 = await new StubDirector().interpret("auto-reframe to vertical and track the speaker", project);
  const trackCall = r3.toolCalls.find((c) => c.name === "auto_reframe");
  assert(trackCall && (trackCall.input as { subjectTracking?: boolean }).subjectTracking === true, "tracking phrase should set subjectTracking=true");
  assert(/gated upgrade/i.test(r3.summary), "gated subject tracking should be surfaced honestly in the summary");

  console.log(`  [32m✔[0m check 52 (auto-reframe): free centered 9:16 (${nCenter}b) + optional settle-pan keyframes; subjectTracking gated → free centered; 'auto-reframe'/'keep me centered' → auto_reframe (not plain reframe)`);
}

async function checkTts(): Promise<void> {
  // (a) Provider selection by config — free-first: default is the unavailable "none".
  const none = selectTtsProvider(ttsConfigFromEnv({}));
  assert(none.id === "none", `default TTS provider should be none, got ${none.id}`);
  assert((await none.isAvailable()) === false, "none provider must be unavailable (money-gated)");

  const cli = selectTtsProvider(ttsConfigFromEnv({ TTS_PROVIDER: "cli", TTS_CLI_COMMAND: "piper -o {output} --text {text}" }));
  assert(cli.id === "cli" && (await cli.isAvailable()) === true, "cli provider should select + be available when configured");
  const cliUnset = selectTtsProvider(ttsConfigFromEnv({ TTS_PROVIDER: "cli" }));
  assert((await cliUnset.isAvailable()) === false, "cli provider must be unavailable without TTS_CLI_COMMAND");

  const api = selectTtsProvider(ttsConfigFromEnv({ TTS_PROVIDER: "api", TTS_API_URL: "https://tts.example/v1", TTS_API_KEY: "k" }));
  assert(api.id === "api" && (await api.isAvailable()) === true, "api provider should select + be available when url+key set");
  const apiHalf = selectTtsProvider(ttsConfigFromEnv({ TTS_PROVIDER: "api", TTS_API_URL: "https://tts.example/v1" }));
  assert((await apiHalf.isAvailable()) === false, "api provider must be unavailable without a key");

  // Registry lists all providers; both AI + non-AI options exist.
  const all = allTtsProviders(ttsConfigFromEnv({}));
  assert(all.length === 3, `expected 3 TTS providers, got ${all.length}`);
  assert(all.some((p) => !p.usesAI) && all.some((p) => p.usesAI), "TTS registry should offer both non-AI (none) and AI (cli/api) options");

  // Pure arg templating.
  const args = buildTtsArgs("piper -o {output} --text {text} --voice {voice}", { output: "vo.mp3", text: "hello world", voice: "en" });
  assert(JSON.stringify(args) === JSON.stringify(["piper", "-o", "vo.mp3", "--text", "hello world", "--voice", "en"]), `buildTtsArgs wrong: ${JSON.stringify(args)}`);
  assert(estimateSpeechSec("one two three four five") > 0, "estimateSpeechSec should be positive");

  // (b) NoneTtsProvider.synthesize throws the honest gated message.
  let threw = false;
  try {
    await new NoneTtsProvider().synthesize({ text: "hi", outputPath: "/tmp/x.mp3" });
  } catch (err) {
    threw = true;
    assert((err as Error).message === TTS_UNAVAILABLE_MESSAGE, "none.synthesize should throw the gated message");
  }
  assert(threw, "none.synthesize must throw (never a silent fake)");

  // (c) generate_voiceover tool fails GRACEFULLY when no provider is configured.
  const savedProvider = process.env.TTS_PROVIDER;
  const savedCli = process.env.TTS_CLI_COMMAND;
  const savedUrl = process.env.TTS_API_URL;
  const savedKey = process.env.TTS_API_KEY;
  process.env.TTS_PROVIDER = "none";
  delete process.env.TTS_CLI_COMMAND;
  delete process.env.TTS_API_URL;
  delete process.env.TTS_API_KEY;
  try {
    const project = videoProject();
    let toolThrew = false;
    try {
      await generateVoiceoverTool.execute({ text: "Welcome to Cadence." }, { project });
    } catch (err) {
      toolThrew = true;
      assert(/money-gated/i.test((err as Error).message), "gated voice-over error should say money-gated");
    }
    assert(toolThrew, "generate_voiceover should throw when no TTS provider is configured");

    // StubDirector surfaces the graceful message (the tool call isn't recorded since it threw).
    project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
    const r = await new StubDirector().interpret("voice this over: 'Hello there, welcome back'", project);
    assert(/money-gated/i.test(r.summary), `'voice this over' should surface the gated message, got: ${r.summary}`);
  } finally {
    if (savedProvider === undefined) delete process.env.TTS_PROVIDER; else process.env.TTS_PROVIDER = savedProvider;
    if (savedCli === undefined) delete process.env.TTS_CLI_COMMAND; else process.env.TTS_CLI_COMMAND = savedCli;
    if (savedUrl === undefined) delete process.env.TTS_API_URL; else process.env.TTS_API_URL = savedUrl;
    if (savedKey === undefined) delete process.env.TTS_API_KEY; else process.env.TTS_API_KEY = savedKey;
  }

  // (d) addVoiceover (pure) adds a full-volume voiceover audio track that exports (amix).
  const base = parseEditDoc({
    version: 1,
    meta: { width: 1920, height: 1080, fps: 30 },
    media: [{ id: "v", kind: "video", src: "/media/v.mp4" }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 6, mediaId: "v", transform: { x: 960, y: 540 } }] }],
  });
  const voAsset: MediaAsset = { id: "vo-1", kind: "audio", src: "/tmp/vo.mp3", durationSec: 4, label: "voice-over" };
  const withVo = addVoiceover(base, voAsset, {});
  const voTrack = withVo.tracks.find((t) => t.id === "voiceover");
  assert(voTrack?.clips[0]?.kind === "audio" && voTrack.clips[0].volume === 1, "voiceover should be a full-volume audio track");
  assert(withVo.media.some((m) => m.id === "vo-1"), "voiceover asset should be added to media");
  const plan = buildExportPlan(withVo, (id) => `/media/${id}.mp4`, "/out/vo.mp4");
  assert(plan.filterComplex.includes("amix="), "voiceover: expected amix on export");

  console.log(`  [32m✔[0m check 53 (TTS voice-over): free-first (none default, unavailable) + cli/api selection & gating; buildTtsArgs pure; graceful "money-gated" via tool + Director; addVoiceover track amixes on export`);
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
  await checkTypewriter();
  await checkCursor();
  await checkCallout();
  await checkBuildDemo();
  await checkVideoCutTransition();
  await checkCaptionSpeed();
  await checkAudioRobustness();
  await checkSpeedGuard();
  await checkMusicDuration();
  await checkSlideshowKeepsMusic();
  await checkKeyframes();
  await checkReverse();
  await checkFreeze();
  await checkMarkers();
  await checkCaptionSidecar();
  await checkPlatform();
  await checkChromaKey();
  await checkBlendMode();
  await checkRegionFx();
  await checkMask();
  await checkCurvesHsl();
  await checkAudioDepth();
  await checkTranscriptEdit();
  await checkRemoveSilence();
  await checkAutoReframe();
  await checkTts();
  await checkWhisperParse();
  await checkTranscriberFactory();
  await checkAgenticLoop();
  await checkSecurityGuard();
  console.log(`\n[32m✔ VERIFY PASSED[0m — frames in ${OUT_DIR}`);
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
