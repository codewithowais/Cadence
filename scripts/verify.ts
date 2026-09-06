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
 *   55 per-cut transition: setTransition({clipId}/{atSec}) retargets ONE cut only
 *      (renders + xfade on that boundary, others unchanged); clearTransition → hard cut
 *   56 manual keyframes: setKeyframe upsert · moveKeyframe re-sort · removeKeyframe
 *      delete · valueAt reflects each · keyframed proof frame
 *   60 transition library: TransitionType is a 50+ SUPERSET (legacy 7 unchanged);
 *      every value maps to its xfade name on export + a distinct/valid preview
 *      (transitionStyle) grouped by family; TRANSITION_TYPES/TRANSITION_GROUPS
 *      cover every type; no-transition fast path emits no xfade
 */
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseEditDoc,
  activeClipsAt,
  docDurationSec,
  emphasisScale,
  sourceTimeAt,
  speedRampIntegral,
  textKinetic,
  typewriterText,
  cursorPositionAt,
  cursorRipples,
  calloutScreenRect,
  calloutTransform,
  blendCompositeOperation,
  transitionStyle,
  TRANSITION_TYPES,
  TRANSITION_GROUPS,
  valueAt,
  toSrt,
  toVtt,
  formatTimestamp,
  type CalloutClip,
  type CursorClip,
  type EditDoc,
  type Keyframe,
  type KeyframeProp,
  type MediaAsset,
  type TextClip,
  type VideoClip,
} from "@cadence/core";
import { CanvasRenderEngine, renderTextClipPng } from "@cadence/render-node";
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
  DIRECTOR_TOOLS,
  runDirectorLoop,
  adjustColor,
  adjustCurves,
  adjustHsl,
  applyLut,
  addAdjustment,
  addCaptions,
  addMarker,
  addMusic,
  addVoiceover,
  animate,
  applyVfx,
  audioFade,
  autoReframe,
  clearTransition,
  setFadeOut,
  clearFadeOut,
  clipKeyframes,
  editByTranscript,
  freezeFrame,
  generateVoiceoverTool,
  moveKeyframe,
  normalizeLoudness,
  reframe,
  reframeTo,
  removeKeyframe,
  setCleanAudio,
  removeSilence,
  reverseClip,
  rollEdit,
  slipEdit,
  slideEdit,
  MIN_CLIP_SEC,
  setKeyframe,
  setPan,
  setPlatform,
  setQuality,
  setSpeed,
  setSpeedRamp,
  SPEED_RAMP_PRESETS,
  setTransition,
  styleCaptions,
  positionCaptions,
  setKaraoke,
  buildDemo,
  addCursor,
  addCallout,
  typeText,
  addTrack,
  removeTrack,
  setTrack,
  reorderTrack,
  moveClipToTrack,
  ASPECTS,
  type DirectorLike,
} from "@cadence/director";
import { allProviders, buildCliArgs, configFromEnv, selectProvider } from "@cadence/enhance";
import {
  atempoChain,
  buildExportPlan,
  detectFfmpeg,
  detectMediaAudio,
  ffBlendMode,
  keyframeTransformExpr,
  probeHasAudio,
  renderTextOverlays,
  renderKaraokeOverlays,
  resolveFfmpegBin,
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

/**
 * A synthetic textOverlays map (clipId → placeholder PNG path) for PURE plan tests
 * that only assert on the filtergraph STRING: text/caption/title/kinetic clips and
 * callout LABELS become transparent-PNG overlays on export (drawtext is gone — the
 * bundled ffmpeg has no libfreetype), so the pure builder needs a path per such clip.
 * The real PNGs are rendered (via the canvas engine) only in the real-encode check.
 */
function fakeTextOverlays(doc: EditDoc): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      if (c.kind === "text") m.set(c.id, `/ov/${c.id}.png`);
      else if (c.kind === "callout" && c.label) m.set(c.id, `/ov/${c.id}.png`);
    }
  }
  return m;
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

  // (b) captions → transparent PNG overlay (time-gated), NOT drawtext (the bundled
  //     ffmpeg has no libfreetype). The PNG is rasterized by the canvas engine, so
  //     text/pill/outline all match the preview exactly.
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
  const cp = buildExportPlan(captioned, resolve, "/out/cap.mp4", fakeTextOverlays(captioned));
  assert(!cp.filterComplex.includes("drawtext="), "captions: text must be a PNG overlay, not drawtext");
  assert(cp.inputs.includes("/ov/cap0.png"), "captions: expected the rasterized caption PNG as an input");
  assert(cp.filterComplex.includes("overlay=0:0:enable='between(t\\,0.2\\,2.2)'"), "captions: expected a time-gated PNG overlay");
  assert(cp.filterComplex.includes("format=rgba"), "captions: PNG overlay should preserve alpha (format=rgba)");

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

  console.log(`  [32m✔[0m check 7 (export plan): 2-cut concat + captions/PNG-overlay (no drawtext) + ultra lanczos/unsharp + slideshow xfade`);
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

  // Export renders the kinetic title as a resting-state transparent PNG overlay
  // (animated text is captured at rest; the preview still slides/scales). No drawtext.
  const plan = buildExportPlan(r.doc, (id) => `/media/${id}.mp4`, "/out/kinetic.mp4", fakeTextOverlays(r.doc));
  assert(!plan.filterComplex.includes("drawtext="), "kinetic: title must be a PNG overlay, not drawtext");
  assert(plan.inputs.includes(`/ov/${kt!.id}.png`), "kinetic: expected the rasterized title PNG as an input");
  assert(plan.filterComplex.includes("overlay=0:0:enable='between(t\\,"), "kinetic: expected a time-gated PNG overlay");
  console.log(`  [32m✔[0m check 13 (kinetic title): mid-animation frame (${n}b) — sliding+scaling in preview; resting-state PNG overlay on export`);
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

async function checkSpeedRampCurve(): Promise<void> {
  const project = videoProject();
  project.setTranscript(await new StubTranscriber().transcribe(project.media[0]!));
  await new StubDirector().interpret("cut a 20 second highlight", project);

  const plain = project.doc;
  const baseClip = plain.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video");
  assert(baseClip && baseClip.speedRamp === undefined, "baseline clip should have no ramp");

  // Tool registered for the AI side.
  assert("set_speed_ramp" in DIRECTOR_TOOLS, "set_speed_ramp must be in DIRECTOR_TOOLS");

  // Apply the "bullet-time" preset via the pure op (fast→slow→fast).
  const ramped = setSpeedRamp(plain, { preset: "bullet-time" });
  const rc = ramped.tracks.flatMap((t) => t.clips).find((c): c is VideoClip => c.kind === "video")!;
  assert(rc.speedRamp && rc.speedRamp.length >= 2, "speed ramp should be set on the clip");
  assert(
    JSON.stringify(rc.speedRamp) === JSON.stringify(SPEED_RAMP_PRESETS["bullet-time"]),
    "preset points should be stored verbatim",
  );

  // (a) The shared helper maps source time NON-LINEARLY vs the constant-speed baseline.
  const dur = rc.duration;
  const span = speedRampIntegral(rc.speedRamp!, 1) * dur; // total source consumed
  // End maps to the full integral; a constant-speed clip of the same avg would too.
  // Sample at p=0.3 (inside bullet-time's fast opening): a constant speed lands at
  // sourceIn+span*0.3, but the fast start has consumed MORE source, so the ramp is
  // strictly ahead — proving the mapping is non-linear (the midpoint of a symmetric
  // ramp coincides with the constant baseline, so 0.3 is the discriminating sample).
  const pTest = 0.3;
  const stMid = sourceTimeAt(rc, rc.start + dur * pTest);
  const constMid = rc.sourceIn + span * pTest; // where a constant-speed clip would be
  assert(stMid > constMid + 1e-3, `ramp must be non-linear (ramp ${stMid} > const ${constMid} at p=${pTest})`);
  // A slower sample near the (slow) middle vs a faster one near the (fast) start:
  // over equal timeline steps the fast region advances MORE source than the slow region.
  const dStart = sourceTimeAt(rc, rc.start + dur * 0.1) - sourceTimeAt(rc, rc.start);
  const dMiddle = sourceTimeAt(rc, rc.start + dur * 0.55) - sourceTimeAt(rc, rc.start + dur * 0.45);
  assert(dStart > dMiddle + 1e-3, `fast region should consume more source than the slow middle (${dStart} vs ${dMiddle})`);
  // Monotonic forward (playback never rewinds).
  let prev = -Infinity;
  for (let k = 0; k <= 8; k++) {
    const s = sourceTimeAt(rc, rc.start + (dur * k) / 8);
    assert(s >= prev - 1e-9, "ramped source-time mapping must be monotonic");
    prev = s;
  }
  // End of clip consumes exactly the integrated span.
  assert(Math.abs(sourceTimeAt(rc, rc.start + dur) - (rc.sourceIn + span)) < 1e-4, "ramp end should equal integral(1)*dur");

  // (b) Renders a real frame at the ramped midpoint.
  const n = await renderAndAssert(ramped, rc.start + dur / 2, "verify-speed-ramp.png");

  // (c) The export SEGMENTS the ramp into multiple setpts pieces + concats them.
  const plan = buildExportPlan(ramped, (id) => `/media/${id}.mp4`, "/out/ramp.mp4");
  const setptsSegments = (plan.filterComplex.match(/setpts=\(PTS-STARTPTS\)\//g) || []).length;
  assert(setptsSegments >= 2, `ramp export must segment into multiple setpts (got ${setptsSegments})`);
  assert(/\bconcat=n=\d+:v=1:a=0\[v0\]/.test(plan.filterComplex), "ramp export must concat the video segments into [v0]");
  assert(plan.filterComplex.includes("[vr0_0]"), "ramp export should emit per-segment labels (vr0_0)");
  assert(plan.filterComplex.includes("atempo="), "ramp export should retime segment audio (atempo)");

  // A non-ramped clip stays single-speed: no ramp segments, historical fast path.
  const planPlain = buildExportPlan(plain, (id) => `/media/${id}.mp4`, "/out/plain.mp4");
  assert(!planPlain.filterComplex.includes("vr0_"), "non-ramped clip must NOT emit ramp segments");
  assert(!/setpts=\(PTS-STARTPTS\)\//.test(planPlain.filterComplex), "non-ramped 1× clip stays setpts=PTS-STARTPTS (byte-identical fast path)");

  console.log(
    `  [32m✔[0m check 58 (speed ramp curve): bullet-time preset → non-linear sourceTimeAt (mid ${stMid.toFixed(2)} vs const ${constMid.toFixed(2)}, fast/slow ${dStart.toFixed(2)}>${dMiddle.toFixed(2)}), monotonic, frame (${n}b), export segmented into ${setptsSegments} setpts + concat; non-ramped clip byte-identical single-speed`,
  );
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

  // Export bakes the outline into the caption PNG (rendered by the canvas engine),
  // then overlays it — no drawtext (the outline changing the frame is asserted above).
  const plan = buildExportPlan(r.doc, (id) => `/media/${id}.mp4`, "/out/caps.mp4", fakeTextOverlays(r.doc));
  assert(!plan.filterComplex.includes("drawtext="), "captions: outlined text must be a PNG overlay, not drawtext");
  assert(plan.inputs.includes(`/ov/${cap!.id}.png`), "captions: expected the rasterized outlined-caption PNG as an input");
  assert(plan.filterComplex.includes("overlay=0:0:enable='between(t\\,"), "captions: expected a time-gated PNG overlay");

  console.log(`  [32m✔[0m check 27 (caption style): white/bold/outline/top → outline changes the frame (${withOutline.length}b) + baked into the PNG overlay on export`);
}

async function checkCaptionCustomStyle(): Promise<void> {
  // A captioned doc with a single, long caption clip on the "captions" track.
  const base = parseEditDoc({
    version: 1,
    meta: { width: 1280, height: 720, background: "#101418" },
    tracks: [
      {
        id: "captions",
        kind: "visual",
        clips: [
          {
            id: "capA",
            kind: "text",
            start: 0,
            duration: 3,
            text: "hello there this is a customizable caption",
            fontSize: 44,
            color: "#ffffff",
            background: "#0a0d12cc",
            align: "center",
            transform: { x: 640, y: 620 },
          },
        ],
      },
    ],
  });
  const at = 1.5;
  const baseBytes = await renderBytes(base, at);

  // (a) A full custom restyle takes effect in the rendered frame.
  const styled = styleCaptions(base, {
    fontWeight: "bold",
    italic: true,
    uppercase: true,
    letterSpacing: 6,
    color: "#ffe08a",
    align: "left",
    lineHeight: 1.3,
    maxWidth: 700,
    shadow: { blur: 14, offsetX: 0, offsetY: 4 },
    box: { style: "box", color: "#301428", opacity: 0.85, radius: 24, padX: 40, padY: 24 },
  });
  const cap = styled.tracks
    .find((t) => t.id === "captions")!
    .clips.find((c): c is TextClip => c.kind === "text")!;
  assert(cap.fontWeight === "bold", "styled caption should be bold");
  assert(cap.italic === true, "styled caption should be italic");
  assert(cap.uppercase === true, "styled caption should be uppercase");
  assert(cap.letterSpacing === 6, "styled caption should carry letter spacing");
  assert(cap.maxWidth === 700, "styled caption should carry a wrap width");
  assert(!!cap.shadow && cap.shadow.blur > 0, "styled caption should have a shadow");
  assert(cap.box?.style === "box" && cap.box.opacity === 0.85, "styled caption should have a box panel");
  const styledBytes = await renderBytes(styled, at);
  assert(styledBytes.subarray(0, 4).equals(PNG_MAGIC), "styled caption frame should be a real PNG");
  assert(!styledBytes.equals(baseBytes), "the caption style fields should change the rendered pixels");

  // (b) Position presets move the caption (metadata + resolved transform.y + pixels).
  const bottom = positionCaptions(base, { anchor: "bottom" });
  const top = positionCaptions(base, { anchor: "top" });
  const yBottom = bottom.tracks.find((t) => t.id === "captions")!.clips[0] as TextClip;
  const yTop = top.tracks.find((t) => t.id === "captions")!.clips[0] as TextClip;
  assert(yTop.position === "top" && yBottom.position === "bottom", "position preset should be recorded");
  assert(yTop.transform.y < yBottom.transform.y, "top caption should sit above the bottom one");
  const topBytes = await renderBytes(top, at);
  const bottomBytes = await renderBytes(bottom, at);
  assert(!topBytes.equals(bottomBytes), "moving the caption position should change the frame");

  // A vertical offset nudges the resolved y further.
  const bottomUp = positionCaptions(base, { anchor: "bottom", offset: -120 });
  const yUp = bottomUp.tracks.find((t) => t.id === "captions")!.clips[0] as TextClip;
  assert(yUp.transform.y < yBottom.transform.y, "a negative offset should raise the bottom caption");

  // (c) Targeting ONE clip by id; a bad id throws.
  const oneRed = styleCaptions(base, { clipId: "capA", color: "#ff0000" });
  assert((oneRed.tracks[0]!.clips[0] as TextClip).color === "#ff0000", "clipId styling should apply");
  let threw = false;
  try {
    styleCaptions(base, { clipId: "nope", color: "#ff0000" });
  } catch {
    threw = true;
  }
  assert(threw, "styling a missing clipId should throw");

  // (d) The EXPORT PNG-overlay path (renderTextClipPng — the SAME canvas drawText)
  // picks up the styles: the styled caption PNG differs from the default one.
  const basePng = renderTextClipPng(base, base.tracks[0]!.clips[0] as TextClip);
  const styledPng = renderTextClipPng(styled, cap);
  assert(styledPng.subarray(0, 4).equals(PNG_MAGIC), "styled caption overlay should be a real PNG");
  assert(!styledPng.equals(basePng), "the export PNG overlay should pick up the caption styles");

  console.log(
    `  [32m✔[0m check 27b (caption custom style): weight/italic/uppercase/spacing/wrap/shadow/box + position presets change the frame (${styledBytes.length}b) and the export PNG overlay`,
  );
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

  // Export renders the typewriter at its resting state — the FULL text as one
  // transparent PNG overlay (the preview still types character-by-character). No
  // drawtext (the bundled ffmpeg has no libfreetype).
  const plan = buildExportPlan(doc, (id) => `/media/${id}.mp4`, "/out/type.mp4", fakeTextOverlays(doc));
  assert(!plan.filterComplex.includes("drawtext="), "typewriter: text must be a PNG overlay, not drawtext");
  assert(plan.inputs.includes(`/ov/${clip!.id}.png`), "typewriter: expected the rasterized (full-text) PNG as an input");
  const overlays = plan.filterComplex.match(/overlay=0:0:enable=/g) ?? [];
  assert(overlays.length === 1, `typewriter: expected exactly ONE resting-state overlay, got ${overlays.length}`);
  console.log(`  [32m✔[0m check 28 (typewriter): mid-type "${state.text}" renders (${n}b); export overlays ONE resting-state PNG with the full text (preview still types)`);
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

  // Export: drawbox border + drawbox dim boxes (no font needed) STAY in the graph;
  // the label (a real font) becomes a transparent PNG overlay, not drawtext.
  const plan = buildExportPlan(doc, (id) => `/media/${id}.mp4`, "/out/callout.mp4", fakeTextOverlays(doc));
  assert(plan.filterComplex.includes("drawbox="), "callout: expected a drawbox border on export");
  assert(plan.filterComplex.includes("color=black@"), "callout: expected dim boxes (black@opacity) on export");
  assert(!plan.filterComplex.includes("drawtext="), "callout: the label must be a PNG overlay, not drawtext");
  assert(!plan.filterComplex.includes("Sign in"), "callout: label text should live in the PNG, not the filtergraph");
  assert(plan.inputs.includes(`/ov/${clip!.id}.png`), "callout: expected the rasterized label PNG as an input");
  assert(plan.filterComplex.includes("overlay=0:0:enable='between(t\\,"), "callout: expected a time-gated label PNG overlay");
  console.log(`  [32m✔[0m check 30 (callout): dim+border change the frame (${withBytes.length}b); zoom rect/transform ×2; drawbox border+dim + label PNG overlay on export`);
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

  // (c) The demo doc exports: screen xfade + typed-field PNG overlays + a cursor.
  //     Typed fields are rasterized to resting-state PNGs (no drawtext); the cursor
  //     pointer glyph is the one remaining drawtext (a moving marker, out of scope
  //     for this pass).
  const plan = buildExportPlan(doc, (id) => `/media/${id}.mp4`, "/out/demo.mp4", fakeTextOverlays(doc));
  assert(plan.filterComplex.includes("xfade="), "demo: expected screen transitions (xfade) on export");
  const textOverlayCount = (plan.filterComplex.match(/overlay=0:0:enable=/g) ?? []).length;
  assert(textOverlayCount >= 2, `demo: expected >=2 typed-field PNG overlays on export, got ${textOverlayCount}`);
  console.log(`  [32m✔[0m check 31 (build_demo): 3-screen login walkthrough renders (typing ${nType}b, cursor ${nMove}b); phrases → build_demo/add_callout; xfade + ${textOverlayCount} typed-field PNG overlays on export`);
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

async function checkKaraoke(): Promise<void> {
  // A caption with per-word timing, made karaoke (word-by-word highlight).
  const base = parseEditDoc({
    version: 1,
    meta: { width: 1280, height: 720, background: "#101418" },
    media: [{ id: "m", kind: "video", src: "a.mp4", durationSec: 30 }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c", kind: "video", start: 0, duration: 6, sourceIn: 0, mediaId: "m", transform: { x: 640, y: 360 } }] }],
  });
  const transcript: Transcript = {
    mediaId: "m", durationSec: 6, language: "en",
    segments: [{
      id: "s0", start: 0, end: 3, text: "one two three",
      words: [
        { text: "one", start: 0, end: 1 },
        { text: "two", start: 1, end: 2 },
        { text: "three", start: 2, end: 3 },
      ],
    }],
    words: [],
  };
  const doc = addCaptions(base, transcript, { karaoke: true, karaokeStyle: "fill" });
  const cap = doc.tracks.find((t) => t.id === "captions")!.clips[0] as TextClip;
  assert(cap.karaoke?.enabled === true, "karaoke should be enabled on the caption");
  assert((cap.words?.length ?? 0) === 3, `expected 3 word timings, got ${cap.words?.length}`);
  // Words carry ABSOLUTE timeline seconds (here clip.start=0 so == source times).
  assert(cap.words![1]!.start === 1 && cap.words![1]!.end === 2, "word 'two' should map to [1,2]");

  // (a) Different words active at different times → DISTINCT rendered pixels.
  const fOne = Buffer.from((await engine.renderFrame(doc, 0.5)).data); // "one" active
  const fThree = Buffer.from((await engine.renderFrame(doc, 2.5)).data); // "three" active
  assert(fOne.subarray(0, 4).equals(PNG_MAGIC) && fThree.subarray(0, 4).equals(PNG_MAGIC), "karaoke frames should be PNGs");
  assert(!fOne.equals(fThree), "karaoke: different active words must render distinct pixels");
  writeFileSync(resolve(OUT_DIR, "verify-karaoke-one.png"), fOne);
  writeFileSync(resolve(OUT_DIR, "verify-karaoke-three.png"), fThree);

  // Disabling karaoke makes the same times render identically (static caption).
  const plainDoc = setKaraoke(doc, { enabled: false });
  const pOne = Buffer.from((await engine.renderFrame(plainDoc, 0.5)).data);
  const pThree = Buffer.from((await engine.renderFrame(plainDoc, 2.5)).data);
  assert(pOne.equals(pThree), "a non-karaoke caption should render identically at both times (no per-word highlight)");

  // (b) The export plan emits MULTIPLE per-word overlays, each gated by between(t,.
  const kmap = new Map<string, string[]>();
  for (const c of doc.tracks.find((t) => t.id === "captions")!.clips) {
    if (c.kind === "text" && c.words) kmap.set(c.id, c.words.map((_, i) => `/ov/${c.id}-${i}.png`));
  }
  const plan = buildExportPlan(doc, (id) => `/media/${id}.mp4`, "/out/karaoke.mp4", undefined, undefined, kmap);
  assert(!plan.filterComplex.includes("drawtext="), "karaoke: text must be PNG overlays, not drawtext");
  const gated = plan.filterComplex.match(/overlay=0:0:enable='between\(t\\,/g) ?? [];
  assert(gated.length >= 3, `karaoke: expected >=3 per-word gated overlays, got ${gated.length}`);
  // Each word's PNG is a looped input, gated to its own [start,end].
  assert(plan.inputs.includes(`/ov/${cap.id}-1.png`), "karaoke: expected the per-word PNG inputs");
  assert(plan.filterComplex.includes("between(t\\,1\\,2)"), "karaoke: word 'two' should be gated to [1,2]");
  assert(plan.filterComplex.includes("between(t\\,2\\,3)"), "karaoke: word 'three' should be gated to [2,3]");

  console.log(
    `  [32m✔[0m check 33b (karaoke): per-word timing mapped to timeline; active word differs by frame (distinct pixels); export emits ${gated.length} per-word PNG overlays gated by between(t,·) — no drawtext`,
  );
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

async function checkMultiTrackLayers(): Promise<void> {
  const resolve = (id: string) => `/media/${id}.mp4`;

  // A base video track + a SECOND visual layer above it (array order = z-order).
  // The upper clip is a PiP (scale 0.5) with a screen blend — a real second layer.
  const layered = parseEditDoc({
    version: 1,
    meta: { title: "layers", width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "base", kind: "video", src: "/media/base.mp4" },
      { id: "top", kind: "video", src: "/media/top.mp4" },
    ],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "b0", kind: "video", start: 0, duration: 6, mediaId: "base", transform: { x: 960, y: 540 } }] },
      { id: "layer2", kind: "visual", clips: [{ id: "u0", kind: "video", start: 0, duration: 6, mediaId: "top", transform: { x: 960, y: 540, scale: 0.5 } }] },
    ],
  });

  // (a) Paint order (bottom→top) exposes BOTH layers; the upper is painted last.
  const active = activeClipsAt(layered, 3).map((c) => c.clip.id);
  assert(JSON.stringify(active) === JSON.stringify(["b0", "u0"]), `layers: paint order should be [b0,u0], got ${JSON.stringify(active)}`);
  const n = await renderAndAssert(layered, 3, "verify-layers.png");

  // (b) Export composites the upper layer OVER the base (z-order): the base is the
  // single-clip fast path (v0), and the upper layer overlays onto it → [v0][bov0].
  const lp = buildExportPlan(layered, resolve, "/out/layers.mp4");
  assert(lp.filterComplex.includes("[v0][bov0]overlay="), `layers: upper layer must overlay OVER the base (v0), got: ${lp.filterComplex.slice(0, 300)}`);
  assert(lp.inputs.includes("/media/base.mp4") && lp.inputs.includes("/media/top.mp4"), "layers: both layer sources must be inputs");

  // A blend-mode upper layer composites via blend=all_mode= over the base (v0).
  const blended = parseEditDoc({
    version: 1,
    meta: { title: "blend-layer", width: 1920, height: 1080, fps: 30 },
    media: [{ id: "base", kind: "video", src: "/media/base.mp4" }, { id: "top", kind: "video", src: "/media/top.mp4" }],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "b0", kind: "video", start: 0, duration: 6, mediaId: "base", transform: { x: 960, y: 540 } }] },
      { id: "grade", kind: "visual", clips: [{ id: "u0", kind: "video", start: 0, duration: 6, mediaId: "top", transform: { x: 960, y: 540 }, blendMode: "screen" }] },
    ],
  });
  const bp = buildExportPlan(blended, resolve, "/out/blend.mp4");
  assert(bp.filterComplex.includes("[v0][bov0]blend=all_mode=screen"), "layers: blend upper layer must blend over the base (v0)");

  // (c) A HIDDEN visual track is excluded from BOTH canvas (activeClipsAt) and export.
  const hidden = setTrack(layered, "layer2", { hidden: true });
  assert(hidden.tracks.find((t) => t.id === "layer2")!.hidden === true, "layers: setTrack should hide the track");
  const hiddenActive = activeClipsAt(hidden, 3).map((c) => c.clip.id);
  assert(JSON.stringify(hiddenActive) === JSON.stringify(["b0"]), `layers: hidden track must be skipped by activeClipsAt, got ${JSON.stringify(hiddenActive)}`);
  const hp = buildExportPlan(hidden, resolve, "/out/hidden.mp4");
  assert(!hp.filterComplex.includes("overlay="), "layers: a hidden upper track must NOT be composited on export");
  assert(!hp.inputs.includes("/media/top.mp4"), "layers: a hidden track's media must not be an input");

  // (d) Audio mute / solo in the export mix.
  const audioDoc = parseEditDoc({
    version: 1,
    meta: { title: "audio-layers", width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "base", kind: "video", src: "/media/base.mp4" },
      { id: "songA", kind: "audio", src: "/media/songA.mp4", durationSec: 30 },
      { id: "songB", kind: "audio", src: "/media/songB.mp4", durationSec: 30 },
    ],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "b0", kind: "video", start: 0, duration: 6, mediaId: "base", transform: { x: 960, y: 540 } }] },
      { id: "music", kind: "audio", clips: [{ id: "mA", kind: "audio", start: 0, duration: 6, mediaId: "songA" }] },
      { id: "music2", kind: "audio", clips: [{ id: "mB", kind: "audio", start: 0, duration: 6, mediaId: "songB" }] },
    ],
  });
  // Baseline: base audio + both music → 3-way amix.
  const allAudio = buildExportPlan(audioDoc, resolve, "/out/a.mp4");
  assert(allAudio.filterComplex.includes("amix=inputs=3"), `audio: base + 2 music should be a 3-way amix, got: ${allAudio.filterComplex.match(/amix=inputs=\d+/)?.[0]}`);

  // Mute music2 → dropped from the mix (base + songA = 2-way amix; songB not an input).
  const muted = setTrack(audioDoc, "music2", { muted: true });
  const mp = buildExportPlan(muted, resolve, "/out/muted.mp4");
  assert(mp.filterComplex.includes("amix=inputs=2"), `audio: muting a track should drop it (2-way amix), got: ${mp.filterComplex.match(/amix=inputs=\d+/)?.[0]}`);
  assert(mp.inputs.includes("/media/songA.mp4") && !mp.inputs.includes("/media/songB.mp4"), "audio: a muted track's media must not be an input");

  // Solo music (songA) → ONLY soloed audio plays: songB dropped AND the base video
  // audio dropped (sunk with anullsink so the graph has no dangling output).
  const soloed = setTrack(audioDoc, "music", { solo: true });
  const solp = buildExportPlan(soloed, resolve, "/out/solo.mp4");
  assert(solp.inputs.includes("/media/songA.mp4"), "audio(solo): the soloed track must play");
  assert(!solp.inputs.includes("/media/songB.mp4"), "audio(solo): a non-soloed track must be dropped");
  assert(solp.filterComplex.includes("anullsink"), "audio(solo): the non-soloed base audio must be sunk (no dangling output)");

  // Pure track ops: add / reorder / remove / cross-lane move + lock guard.
  const added = addTrack(layered, { kind: "visual", name: "Overlay", afterTrackId: "video" });
  assert(added.tracks.length === 3 && added.tracks[1]!.id === "layer-1" && added.tracks[1]!.name === "Overlay", "tracks: addTrack should insert a named layer above 'video'");
  // Reorder the new layer to the bottom (z-index 0).
  const reordered = reorderTrack(added, "layer-1", 0);
  assert(reordered.tracks[0]!.id === "layer-1", "tracks: reorderTrack should move the layer to the bottom");
  // Move the base clip onto the free overlay lane → keeps the given start (no reflow).
  const moved = moveClipToTrack(added, "b0", "layer-1", 2.5);
  const movedClip = moved.tracks.find((t) => t.id === "layer-1")!.clips.find((c) => c.id === "b0")!;
  assert(movedClip.start === 2.5, `tracks: a free-lane drop should keep start 2.5, got ${movedClip.start}`);
  assert(moved.tracks.find((t) => t.id === "video")!.clips.length === 0, "tracks: the clip should have left its source lane");
  // removeTrack respects a lock (clear error, no-op).
  const locked = setTrack(added, "layer-1", { locked: true });
  let threw = false;
  try { removeTrack(locked, "layer-1"); } catch { threw = true; }
  assert(threw, "tracks: removeTrack must refuse a locked track");
  // Unlocked removal drops the track.
  const removed = removeTrack(added, "layer-1");
  assert(!removed.tracks.some((t) => t.id === "layer-1"), "tracks: removeTrack should drop the track");

  console.log(`  [32m✔[0m check 54 (multi-track layers): 2-layer doc paints bottom→top (${n}b) + upper overlays/blends OVER base (v0) on export; hidden track skipped in canvas+export; mute/solo drop audio (anullsink); addTrack/reorder/move(free start)/lock-guarded remove`);
}

/** A 3-cut, hard-cut video doc (clips laid back-to-back, no transition). */
function threeCutDoc(): EditDoc {
  return parseEditDoc({
    version: 1,
    meta: { title: "cuts3", width: 1920, height: 1080, fps: 30 },
    media: [{ id: "clip-001", kind: "video", src: "/media/clip-001.mp4", durationSec: 180 }],
    tracks: [
      {
        id: "video",
        kind: "visual",
        clips: [
          { id: "c0", kind: "video", start: 0, duration: 4, mediaId: "clip-001", sourceIn: 6, transform: { x: 960, y: 540 } },
          { id: "c1", kind: "video", start: 4, duration: 5, mediaId: "clip-001", sourceIn: 40, transform: { x: 960, y: 540 } },
          { id: "c2", kind: "video", start: 9, duration: 4, mediaId: "clip-001", sourceIn: 80, transform: { x: 960, y: 540 } },
        ],
      },
    ],
  });
}

function videoClips(doc: EditDoc): VideoClip[] {
  return doc.tracks.find((t) => t.id === "video")!.clips.filter((c): c is VideoClip => c.kind === "video");
}

async function checkTransitionPreview(): Promise<void> {
  // The browser preview must HONOR the transition type — not just crossfade
  // everything. `transitionStyle` is the one pure helper the Stage consumes; it
  // is built on the same `transitionMotion` + `transitionOpacity` the canvas +
  // export use, so verifying it here proves preview ↔ canvas ↔ xfade stay aligned.
  const FW = 1920;
  const FH = 1080;
  const mk = (type: string) =>
    parseEditDoc({
      version: 1,
      media: [{ id: "m", kind: "image", src: "a.jpg" }],
      tracks: [
        {
          id: "video",
          kind: "visual",
          clips: [{ id: "i", kind: "image", start: 0, duration: 4, mediaId: "m", transitionInSec: 1, transitionType: type }],
        },
      ],
    }).tracks[0]!.clips[0]!;

  // Fade family ramps opacity; slide translates; wipe clips; zoom scales — each
  // DISTINCT, so the preview visibly differs by type (the reported bug).
  const cross = transitionStyle(mk("crossfade") as never, 0.5, FW, FH);
  assert(Math.abs(cross.opacity - 0.5) < 1e-6 && cross.translateXPct === 0 && cross.clipPath === "none", "preview: crossfade is an opacity ramp");
  const slide = transitionStyle(mk("slide") as never, 0.5, FW, FH);
  assert(slide.opacity === 1 && slide.translateXPct > 0 && slide.translateXPct < 100, "preview: slide translates in from the right, no fade");
  const wipe = transitionStyle(mk("wipe") as never, 0.5, FW, FH);
  assert(wipe.opacity === 1 && wipe.clipPath === "inset(0 50% 0 0)", "preview: wipe reveals via clip-path inset");
  const zoom = transitionStyle(mk("zoom") as never, 0, FW, FH);
  assert(zoom.scaleMul > 1 && zoom.opacity === 0, "preview: zoom scales in while it fades");
  // A distinct data-attribute value per type + an `active` flag only inside the ramp.
  assert(cross.type === "crossfade" && slide.type === "slide" && wipe.type === "wipe", "preview: type surfaced for the data-attribute");
  assert(transitionStyle(mk("wipe") as never, 2, FW, FH).active === false, "preview: not active outside the ramp window");

  // Last-clip fade-out-to-black (setFadeOut): a transition where there is NO cut.
  // Single-image doc, then fade its out edge — the ONLY visual clip fades to black.
  const single = parseEditDoc({
    version: 1,
    media: [{ id: "m", kind: "image", src: "a.jpg" }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "solo", kind: "image", start: 0, duration: 4, mediaId: "m" }] }],
  });
  const faded = setFadeOut(single, "solo", 0.6);
  const fc = faded.tracks[0]!.clips[0]!;
  assert(fc.kind === "image" && fc.transitionOutSec === 0.6, "fade-out: transitionOutSec set on the sole clip");
  // Its preview opacity ramps DOWN toward the end (fade to black), 1 in the middle.
  const outStyle = transitionStyle(fc as never, 3.7, FW, FH); // 0.3s before the 4s end → ~half faded
  assert(outStyle.opacity > 0 && outStyle.opacity < 1 && outStyle.active, "fade-out: opacity ramps down near the end");
  assert(transitionStyle(fc as never, 2, FW, FH).opacity === 1, "fade-out: fully opaque in the middle");
  const cleared = clearFadeOut(faded, "solo");
  assert(cleared.tracks[0]!.clips[0]!.kind === "image" && (cleared.tracks[0]!.clips[0]! as { transitionOutSec: number }).transitionOutSec === 0, "fade-out: cleared back to a hard end");

  console.log(`  [32m✔[0m check 59 (transition preview): transitionStyle honors each type (fade=opacity, slide=translate, wipe=clip-path, zoom=scale) — distinct per type; setFadeOut/clearFadeOut fade the last clip to black with no cut`);
}

async function checkPerCutTransition(): Promise<void> {
  // Wave C P1-1: setTransition can target ONE cut's incoming boundary via clipId
  // (or atSec), leaving every other cut as it is — while the global path is
  // unchanged. Start from an all-crossfade 3-cut sequence, then re-target the
  // middle boundary (c1) to dip-to-black.
  const base = setTransition(threeCutDoc(), "crossfade");
  const b = videoClips(base);
  assert(b.every((c) => c.transitionType === "crossfade"), "global path: every cut should be crossfade");
  assert(b[1]!.transitionInSec > 0 && b[2]!.transitionInSec > 0, "global path: non-first cuts overlap");

  const perCut = setTransition(base, "dip-to-black", 0.6, { clipId: "c1" });
  const p = videoClips(perCut);
  // ONLY c1's incoming boundary changed.
  assert(p[1]!.transitionType === "dip-to-black", "per-cut: c1 should become dip-to-black");
  assert(p[2]!.transitionType === "crossfade", "per-cut: c2 (other cut) must be UNAFFECTED");
  assert(p[0]!.transitionType === "crossfade", "per-cut: c0 must be UNAFFECTED");
  // Geometry of the untouched boundary is byte-identical (c2 keeps its overlap/start).
  assert(p[2]!.start === b[2]!.start && p[2]!.transitionInSec === b[2]!.transitionInSec, "per-cut: c2's overlap must be untouched");
  // c1 still carries a transition and still overlaps c0 (real A→B dissolve).
  assert(p[1]!.transitionInSec > 0, "per-cut: c1 should still carry a transition");
  const overlapStart = p[1]!.start;
  const overlapEnd = p[0]!.start + p[0]!.duration;
  assert(overlapStart < overlapEnd - 1e-6, "per-cut: c1 should overlap c0");
  const activeVids = activeClipsAt(perCut, (overlapStart + overlapEnd) / 2).filter(({ clip }) => clip.kind === "video");
  assert(activeVids.length === 2, `per-cut: both clips active mid-transition, got ${activeVids.length}`);
  const n = await renderAndAssert(perCut, (overlapStart + overlapEnd) / 2, "verify-percut-transition.png");

  // Export: the c1 boundary is fadeblack, the c2 boundary is still fade — both
  // present, proving only the targeted cut changed on export too.
  const plan = buildExportPlan(perCut, (id) => `/media/${id}.mp4`, "/out/percut.mp4");
  assert(plan.filterComplex.includes("xfade=transition=fadeblack:"), "per-cut: c1 boundary should be xfade fadeblack on export");
  assert(plan.filterComplex.includes("xfade=transition=fade:"), "per-cut: c2 boundary should stay xfade fade on export");

  // atSec targeting hits the cut active at that time. Pick a time past c1's end
  // (clips overlap by the transition, so only c2 is active there — first match wins).
  const atSec = p[1]!.start + p[1]!.duration + 1;
  assert(atSec >= p[2]!.start && atSec < p[2]!.start + p[2]!.duration, "atSec should fall inside c2 only");
  const byAt = setTransition(base, "wipe", 0.6, { atSec });
  const a = videoClips(byAt);
  assert(a[2]!.transitionType === "wipe", "atSec: the cut active at atSec should become wipe");
  assert(a[1]!.transitionType === "crossfade", "atSec: c1 (other cut) must be UNAFFECTED");
  const aplan = buildExportPlan(byAt, (id) => `/media/${id}.mp4`, "/out/percut-at.mp4");
  assert(aplan.filterComplex.includes("xfade=transition=wipeleft:"), "atSec: c2 boundary should be xfade wipeleft on export");

  // clearTransition turns one cut back into a hard cut (transitionInSec → 0) and
  // closes the neighbour back-to-back.
  const cleared = clearTransition(base, "c1");
  const cc = videoClips(cleared);
  assert(cc[1]!.transitionInSec === 0, "clear: c1 should become a hard cut (transitionInSec 0)");
  assert(Math.abs(cc[1]!.start - (cc[0]!.start + cc[0]!.duration)) < 1e-6, "clear: c1 should lay back-to-back after c0");
  assert(cc[2]!.transitionInSec > 0, "clear: c2 (other cut) must keep its transition");

  console.log(`  [32m✔[0m check 55 (per-cut transition): setTransition({clipId}) sets only c1 (dip→fadeblack) with c2 untouched (still fade) on export (${n}b); atSec targets the active cut (wipe→wipeleft); clearTransition → hard cut; global path unchanged`);
}

/** A single-video-clip doc with a known clip id, for manual keyframe ops. */
function keyframeDoc(): EditDoc {
  return parseEditDoc({
    version: 1,
    meta: { title: "kf", width: 1920, height: 1080, fps: 30 },
    media: [{ id: "m", kind: "video", src: "/media/m.mp4", durationSec: 60 }],
    tracks: [
      {
        id: "video",
        kind: "visual",
        clips: [{ id: "kf", kind: "video", start: 0, duration: 6, mediaId: "m", sourceIn: 0, transform: { x: 960, y: 540 } }],
      },
    ],
  });
}

function kfClip(doc: EditDoc): VideoClip {
  return doc.tracks[0]!.clips.find((c): c is VideoClip => c.id === "kf")!;
}

async function checkManualKeyframes(): Promise<void> {
  // Wave C P1-2: the timeline diamond editor's pure ops. t is CLIP-PROGRESS 0..1
  // (the unit valueAt uses), NOT clip-relative seconds.

  // (a) setKeyframe INSERTS, sorted.
  let doc = setKeyframe(keyframeDoc(), "kf", { prop: "scale", t: 1, value: 2 });
  doc = setKeyframe(doc, "kf", { prop: "scale", t: 0, value: 1 });
  doc = setKeyframe(doc, "kf", { prop: "scale", t: 0.5, value: 1.5 });
  let kfs = clipKeyframes(kfClip(doc), "scale");
  assert(kfs.length === 3, `setKeyframe should have inserted 3 keyframes, got ${kfs.length}`);
  assert(kfs[0]!.t === 0 && kfs[1]!.t === 0.5 && kfs[2]!.t === 1, "setKeyframe should keep the array sorted by t");
  assert(Math.abs(valueAt(kfClip(doc).keyframes, "scale", 0.5, 1) - 1.5) < 1e-9, "valueAt should read the inserted midpoint (1.5)");

  // (b) setKeyframe REPLACES at ~t (upsert), not inserting a duplicate.
  doc = setKeyframe(doc, "kf", { prop: "scale", t: 0.5, value: 1.75, easing: "ease-in" });
  kfs = clipKeyframes(kfClip(doc), "scale");
  assert(kfs.length === 3, `setKeyframe upsert should NOT add a duplicate at ~t, got ${kfs.length}`);
  assert(kfs[1]!.value === 1.75 && kfs[1]!.easing === "ease-in", "setKeyframe upsert should replace value + easing at ~t");
  assert(Math.abs(valueAt(kfClip(doc).keyframes, "scale", 0.5, 1) - 1.75) < 1e-9, "valueAt should reflect the replaced value (1.75)");

  // (c) moveKeyframe re-times (and re-sorts); optional new value applies.
  doc = moveKeyframe(doc, "kf", "scale", 0.5, 0.9);
  kfs = clipKeyframes(kfClip(doc), "scale");
  assert(kfs.map((k) => k.t).join(",") === "0,0.9,1", `moveKeyframe should re-sort to 0,0.9,1, got ${kfs.map((k) => k.t).join(",")}`);
  assert(!kfs.some((k) => Math.abs(k.t - 0.5) < 1e-6), "moveKeyframe should leave nothing at the old t");
  assert(kfs.find((k) => k.t === 0.9)!.value === 1.75, "moveKeyframe without a value keeps the old value");
  doc = moveKeyframe(doc, "kf", "scale", 0.9, 0.8, 1.9);
  kfs = clipKeyframes(kfClip(doc), "scale");
  assert(kfs.find((k) => k.t === 0.8)!.value === 1.9, "moveKeyframe with a value updates it");

  // (d) removeKeyframe deletes at ~t; last removal drops the array entirely.
  doc = removeKeyframe(doc, "kf", "scale", 0.8);
  kfs = clipKeyframes(kfClip(doc), "scale");
  assert(kfs.length === 2 && !kfs.some((k) => Math.abs(k.t - 0.8) < 1e-6), "removeKeyframe should delete the keyframe at ~t");
  // Surviving keyframes are t=0(v1,linear) and t=1(v2,linear); valueAt at p=0.8
  // now interpolates linearly to 1.8 (the deleted midpoint no longer bends it).
  assert(Math.abs(valueAt(kfClip(doc).keyframes, "scale", 0.8, 1) - 1.8) < 1e-9, "valueAt after removal should interpolate the surviving endpoints (1.8)");

  // Proof frame: a keyframed doc renders and differs from the same doc with no
  // keyframes (the diamonds actually drive the picture).
  const proof = setKeyframe(setKeyframe(keyframeDoc(), "kf", { prop: "scale", t: 0, value: 1 }), "kf", { prop: "scale", t: 1, value: 2 });
  const n = await renderAndAssert(proof, 3, "verify-manual-keyframe.png");
  const withKf = await renderBytes(proof, 3);
  const noKf = await renderBytes(keyframeDoc(), 3);
  assert(!withKf.equals(noKf), "the keyframed scale should change the rendered frame");

  // Full removal → keyframes gone, clip back to its static value.
  let bare = removeKeyframe(proof, "kf", "scale", 0);
  bare = removeKeyframe(bare, "kf", "scale", 1);
  assert(kfClip(bare).keyframes === undefined, "removing the last keyframe should drop the keyframes array");

  // Guards: unknown clipId + missing keyframe throw.
  let threw = false;
  try { setKeyframe(keyframeDoc(), "nope", { prop: "scale", t: 0, value: 1 }); } catch { threw = true; }
  assert(threw, "setKeyframe on an unknown clipId should throw");
  threw = false;
  try { moveKeyframe(keyframeDoc(), "kf", "scale", 0.5, 0.6); } catch { threw = true; }
  assert(threw, "moveKeyframe with no matching keyframe should throw");

  console.log(`  [32m✔[0m check 56 (manual keyframes): setKeyframe insert(3, sorted)+upsert-at-t; moveKeyframe re-sorts (0,0.9,1)+value; removeKeyframe deletes & drops the array; valueAt reflects each; keyframed frame differs (${n}b); guards throw`);
}

async function checkRollSlipSlide(): Promise<void> {
  // Wave E: roll / slip / slide pure trim ops on a 3-clip main track.
  // threeCutDoc: c0(start0,dur4,srcIn6) · c1(start4,dur5,srcIn40) · c2(start9,dur4,srcIn80),
  // speed 1, media durationSec 180 → total 13s.
  const base = setTransition(threeCutDoc(), "crossfade", 0); // hard cuts, no overlaps
  const b = videoClips(base);
  assert(b.length === 3, "roll/slip/slide: expected a 3-cut base");
  const total0 = docDurationSec(base);
  assert(total0 === 13, `expected 13s total, got ${total0}`);

  // (a) ROLL the cut between c1 and c2 by +1s: only the shared boundary moves.
  const rolled = rollEdit(base, "c1", 1);
  const r = videoClips(rolled);
  // Both neighbours' durations changed by ±delta; outer edges + total fixed.
  assert(r[1]!.duration === 6 && r[2]!.duration === 3, `roll: durations should be 6/3, got ${r[1]!.duration}/${r[2]!.duration}`);
  assert(r[0]!.start === 0 && r[0]!.duration === 4 && r[0]!.sourceIn === 6, "roll: c0 (outer, before the cut) must be untouched");
  assert(r[1]!.start === 4, "roll: c1's outer-left edge (start) must stay fixed");
  assert(r[1]!.sourceIn === 40, "roll: outgoing clip keeps its sourceIn (shows more of its tail)");
  assert(r[2]!.sourceIn === 81, `roll: incoming head moves by +delta (sourceIn 80→81), got ${r[2]!.sourceIn}`);
  assert(r[2]!.start === 10 && r[2]!.start + r[2]!.duration === 13, "roll: c2's outer-right edge + total length must stay fixed");
  assert(docDurationSec(rolled) === 13, `roll: total length must stay 13s, got ${docDurationSec(rolled)}`);
  const nRoll = await renderAndAssert(rolled, r[1]!.start + r[1]!.duration / 2, "verify-roll.png");

  // Roll clamps: huge +delta pins the incoming clip to MIN_CLIP_SEC (never below);
  // huge -delta pins the outgoing clip to MIN and keeps the incoming head at/after 0.
  const rollMax = videoClips(rollEdit(base, "c1", 100));
  assert(rollMax[2]!.duration >= MIN_CLIP_SEC - 1e-9, `roll clamp: incoming must stay >= MIN, got ${rollMax[2]!.duration}`);
  assert(Math.abs(rollMax[2]!.duration - MIN_CLIP_SEC) < 1e-6, "roll clamp: +100 should pin incoming to MIN_CLIP_SEC");
  assert(docDurationSec(rollEdit(base, "c1", 100)) === 13, "roll clamp: total length still fixed at the clamp");
  const rollMin = videoClips(rollEdit(base, "c1", -100));
  assert(rollMin[1]!.duration >= MIN_CLIP_SEC - 1e-9 && rollMin[2]!.sourceIn >= 0, "roll clamp: outgoing >= MIN and incoming sourceIn >= 0");
  // Last clip has no next neighbour → roll is a safe no-op.
  const noNext = videoClips(rollEdit(base, "c2", 1));
  assert(noNext[2]!.duration === 4 && noNext[2]!.start === 9, "roll: last clip (no next) must be an unchanged no-op");

  // Outgoing source cap: a clip near the end of its media can't grow past EOF.
  const capDoc = parseEditDoc({
    version: 1,
    meta: { title: "cap", width: 1920, height: 1080, fps: 30 },
    media: [{ id: "m", kind: "video", src: "/media/m.mp4", durationSec: 10 }],
    tracks: [{ id: "video", kind: "visual", clips: [
      { id: "a", kind: "video", start: 0, duration: 1.5, mediaId: "m", sourceIn: 8, transform: { x: 960, y: 540 } },
      { id: "b", kind: "video", start: 1.5, duration: 5, mediaId: "m", sourceIn: 0, transform: { x: 960, y: 540 } },
    ] }],
  });
  const capped = videoClips(rollEdit(capDoc, "a", 100));
  assert(capped[0]!.sourceIn + capped[0]!.duration <= 10 + 1e-6, `roll source cap: outgoing must not overrun media (got ${capped[0]!.sourceIn + capped[0]!.duration} > 10)`);
  assert(Math.abs(capped[0]!.duration - 2) < 1e-6, `roll source cap: c "a" should grow to exactly the remaining 2s (got ${capped[0]!.duration})`);

  // (b) SLIP c1 by +2 source seconds: start + duration fixed, only sourceIn moves.
  const slipped = slipEdit(base, "c1", 2);
  const s = videoClips(slipped);
  assert(s[1]!.start === 4 && s[1]!.duration === 5, "slip: timeline start + duration must stay fixed");
  assert(s[1]!.sourceIn === 42, `slip: sourceIn should shift by +2 (40→42), got ${s[1]!.sourceIn}`);
  assert(s[0]!.sourceIn === 6 && s[2]!.sourceIn === 80 && s[2]!.start === 9, "slip: neighbours must be untouched");
  assert(docDurationSec(slipped) === 13, "slip: total length unchanged");
  const nSlip = await renderAndAssert(slipped, s[1]!.start + s[1]!.duration / 2, "verify-slip.png");
  // Slip clamps to the source bounds: window [sourceIn, sourceIn+duration] ⊆ [0, media].
  const slipHi = videoClips(slipEdit(base, "c1", 1000));
  assert(slipHi[1]!.sourceIn === 175, `slip clamp: +1000 should pin sourceIn to media(180)-duration(5)=175, got ${slipHi[1]!.sourceIn}`);
  assert(slipHi[1]!.sourceIn + slipHi[1]!.duration <= 180 + 1e-6, "slip clamp: window must stay inside the source");
  const slipLo = videoClips(slipEdit(base, "c1", -1000));
  assert(slipLo[1]!.sourceIn === 0, `slip clamp: -1000 should pin sourceIn to 0, got ${slipLo[1]!.sourceIn}`);

  // (c) SLIDE c1 by +1s: the clip's start moves, its duration/content are fixed,
  // and the neighbours absorb the move (total length fixed).
  const slid = slideEdit(base, "c1", 1);
  const d = videoClips(slid);
  assert(d[1]!.start === 5, `slide: c1 start should move +1 (4→5), got ${d[1]!.start}`);
  assert(d[1]!.duration === 5 && d[1]!.sourceIn === 40, "slide: the slid clip's own duration + content (sourceIn) stay fixed");
  assert(d[0]!.duration === 5 && d[0]!.sourceIn === 6, "slide: previous neighbour grows by +delta (sourceIn fixed)");
  assert(d[2]!.duration === 3 && d[2]!.sourceIn === 81, "slide: next neighbour shrinks by delta + head moves (sourceIn 80→81)");
  assert(docDurationSec(slid) === 13, `slide: total length must stay 13s, got ${docDurationSec(slid)}`);
  const nSlide = await renderAndAssert(slid, d[1]!.start + d[1]!.duration / 2, "verify-slide.png");
  // Slide clamps: huge -delta pins the previous clip to MIN and keeps the next head >= 0.
  const slideMin = videoClips(slideEdit(base, "c1", -100));
  assert(slideMin[0]!.duration >= MIN_CLIP_SEC - 1e-9 && slideMin[2]!.sourceIn >= 0, "slide clamp: prev >= MIN and next sourceIn >= 0");
  assert(docDurationSec(slideEdit(base, "c1", -100)) === 13, "slide clamp: total length still fixed");
  // Edge clip (no previous OR next neighbour) → slide is a safe no-op.
  const slideEdge = videoClips(slideEdit(base, "c0", 1));
  assert(slideEdge[0]!.start === 0 && slideEdge[0]!.duration === 4, "slide: first clip (no prev) must be an unchanged no-op");

  console.log(`  [32m✔[0m check 57 (roll/slip/slide): roll moves only the shared boundary (neighbours' outer edges + 13s total fixed, ±delta durations, incoming head 80→81, ${nRoll}b); slip keeps start+duration, only sourceIn 40→42 (clamped to source, ${nSlip}b); slide moves the clip's start with neighbours absorbing + total fixed (${nSlide}b); every clamp holds (no clip < MIN_CLIP_SEC, no source overrun); no-neighbour ⇒ no-op`);
}

async function checkTransitionLibrary(): Promise<void> {
  // Wave: the transition library is now a SUPERSET of the original 7 styles plus
  // the full useful ffmpeg xfade set (50+ total), backward-compatible end-to-end
  // (schema enum + export xfade map + preview transitionStyle + UI helpers).
  const resolve = (id: string) => `/media/${id}.mp4`;

  // (0) The enum has grown to 50+ values, and every value carries UI metadata.
  assert(TRANSITION_TYPES.length >= 50, `expected >=50 transition types, got ${TRANSITION_TYPES.length}`);
  const groups = new Set<string>();
  for (const t of TRANSITION_TYPES) {
    const meta = TRANSITION_GROUPS[t];
    assert(!!meta && !!meta.label && !!meta.group, `TRANSITION_GROUPS missing label/group for "${t}"`);
    groups.add(meta.group);
  }
  // Every metadata key is a real type (no orphans).
  assert(
    Object.keys(TRANSITION_GROUPS).length === TRANSITION_TYPES.length,
    "TRANSITION_GROUPS must have exactly one entry per transition type",
  );

  // (1) The original 7 legacy values still PARSE and map to the SAME xfade name
  // as before (byte-for-byte backward compatibility).
  const legacy: Record<string, string> = {
    crossfade: "fade",
    "dip-to-black": "fadeblack",
    slide: "slideleft",
    wipe: "wipeleft",
    dissolve: "dissolve",
    zoom: "zoomin",
    smooth: "smoothleft",
  };
  for (const [type, xf] of Object.entries(legacy)) {
    assert(TRANSITION_TYPES.includes(type as never), `legacy value "${type}" must remain a valid transition`);
    const doc = parseEditDoc({
      version: 1,
      media: [{ id: "m", kind: "image", src: "a.jpg" }],
      tracks: [{ id: "video", kind: "visual", clips: [{ id: "i", kind: "image", start: 0, duration: 3, mediaId: "m", transitionType: type }] }],
    });
    assert(doc.tracks[0]!.clips[0]!.kind === "image", `legacy "${type}" doc should parse`);
    assert(xfadeTransition(type as never) === xf, `legacy mapping changed: ${type} should map to ${xf}, got ${xfadeTransition(type as never)}`);
  }

  // (2) A sampling of NEW types each (a) produce the correct xfade name on export
  // and (b) return a distinct/valid preview style from the right family.
  const FW = 1920;
  const FH = 1080;
  // Build a 2-image slideshow whose SECOND photo carries the transition, so the
  // slideshow xfade branch emits xfade=transition=<name> for that type.
  const exportName = (type: string): string => {
    const doc = parseEditDoc({
      version: 1,
      meta: { width: FW, height: FH, fps: 30 },
      media: [
        { id: "p0", kind: "image", src: "/media/p0.jpg", width: FW, height: FH },
        { id: "p1", kind: "image", src: "/media/p1.jpg", width: FW, height: FH },
      ],
      tracks: [
        {
          id: "photos",
          kind: "visual",
          clips: [
            { id: "c0", kind: "image", start: 0, duration: 3, mediaId: "p0" },
            { id: "c1", kind: "image", start: 2.5, duration: 3, mediaId: "p1", transitionInSec: 0.5, transitionType: type },
          ],
        },
      ],
    });
    return buildExportPlan(doc, resolve, "/out/t.mp4").filterComplex;
  };
  const previewStyle = (type: string) => {
    const clip = parseEditDoc({
      version: 1,
      media: [{ id: "m", kind: "image", src: "a.jpg" }],
      tracks: [{ id: "video", kind: "visual", clips: [{ id: "i", kind: "image", start: 0, duration: 4, mediaId: "m", transitionInSec: 1, transitionType: type }] }],
    }).tracks[0]!.clips[0]!;
    return transitionStyle(clip as never, 0.5, FW, FH);
  };

  // wipeup → xfade wipeup + a VERTICAL clip-path inset (no fade, no translate).
  assert(exportName("wipeup").includes("xfade=transition=wipeup:"), "wipeup should export xfade=transition=wipeup");
  const up = previewStyle("wipeup");
  assert(up.clipPath === "inset(0 0 50% 0)" && up.opacity === 1 && up.translateXPct === 0, `wipeup preview should be a vertical clip-path reveal, got ${JSON.stringify(up)}`);

  // slideright → xfade slideright + a NEGATIVE horizontal translate (enters from left), no clip.
  assert(exportName("slideright").includes("xfade=transition=slideright:"), "slideright should export xfade=transition=slideright");
  const sr = previewStyle("slideright");
  assert(sr.opacity === 1 && sr.translateXPct < 0 && sr.clipPath === "none", `slideright preview should translate in from the left, got ${JSON.stringify(sr)}`);

  // circleopen → xfade circleopen + a circle() clip-path.
  assert(exportName("circleopen").includes("xfade=transition=circleopen:"), "circleopen should export xfade=transition=circleopen");
  const co = previewStyle("circleopen");
  assert(co.clipPath.startsWith("circle(") && co.opacity === 1, `circleopen preview should use a circle clip-path, got ${JSON.stringify(co)}`);

  // pixelize → xfade pixelize + an OPACITY crossfade (no translate, no clip).
  assert(exportName("pixelize").includes("xfade=transition=pixelize:"), "pixelize should export xfade=transition=pixelize");
  const px = previewStyle("pixelize");
  assert(Math.abs(px.opacity - 0.5) < 1e-6 && px.translateXPct === 0 && px.clipPath === "none", `pixelize preview should be an opacity crossfade, got ${JSON.stringify(px)}`);

  // zoomin → xfade zoomin + a SCALE-in (>1).
  assert(exportName("zoomin").includes("xfade=transition=zoomin:"), "zoomin should export xfade=transition=zoomin");
  const zi = transitionStyle(
    parseEditDoc({
      version: 1,
      media: [{ id: "m", kind: "image", src: "a.jpg" }],
      tracks: [{ id: "video", kind: "visual", clips: [{ id: "i", kind: "image", start: 0, duration: 4, mediaId: "m", transitionInSec: 1, transitionType: "zoomin" }] }],
    }).tracks[0]!.clips[0]! as never,
    0,
    FW,
    FH,
  );
  assert(zi.scaleMul > 1 && zi.clipPath === "none", `zoomin preview should scale in, got ${JSON.stringify(zi)}`);

  // (3) EVERY type returns a valid, finite preview style (the fallback never breaks).
  for (const t of TRANSITION_TYPES) {
    const s = previewStyle(t);
    assert(
      Number.isFinite(s.opacity) && Number.isFinite(s.translateXPct) && Number.isFinite(s.translateYPct) && Number.isFinite(s.scaleMul) && typeof s.clipPath === "string" && s.type === t,
      `transitionStyle("${t}") returned an invalid style: ${JSON.stringify(s)}`,
    );
    // And every type maps to a non-empty xfade name on export.
    assert(xfadeTransition(t as never).length > 0, `xfadeTransition("${t}") should return a name`);
  }

  // (4) The no-transition FAST PATH is unchanged: a single clip with no transition
  // emits NO xfade (concat/single-clip path is byte-identical to before).
  const fast = parseEditDoc({
    version: 1,
    meta: { width: FW, height: FH, fps: 30 },
    media: [{ id: "v", kind: "video", src: "/media/v.mp4" }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 4, mediaId: "v", transform: { x: 960, y: 540 } }] }],
  });
  const fastFc = buildExportPlan(fast, resolve, "/out/fast.mp4").filterComplex;
  assert(!fastFc.includes("xfade"), "no-transition single-clip export must not emit any xfade (fast path unchanged)");

  console.log(
    `  [32m✔[0m check 60 (transition library): ${TRANSITION_TYPES.length} types in ${groups.size} groups; legacy 7 map unchanged (crossfade→fade…smooth→smoothleft); new types wipeup/slideright/circleopen/pixelize/zoomin → correct xfade + distinct preview (clip-path/translate/circle/opacity/scale); every type has a valid style; no-transition fast path emits no xfade`,
  );
}

async function checkLutImport(): Promise<void> {
  const resolve = (id: string) => `/media/${id}`;

  // A single-video doc with a neutral look (no eq/curves) → the LUT is the ONLY
  // added filter, so we can prove additivity byte-for-byte.
  const base = parseEditDoc({
    version: 1,
    meta: { title: "lut", width: 1920, height: 1080, fps: 30 },
    media: [{ id: "v.mp4", kind: "video", src: "/media/v.mp4" }],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 4, mediaId: "v.mp4", transform: { x: 960, y: 540 } }] },
    ],
  });

  // (a) applyLut sets look.lut on the main visual clip (merged, non-destructive).
  const withLut = applyLut(base, { lut: "teal.cube" });
  const clip = withLut.tracks[0]!.clips[0]!;
  assert(clip.kind === "video" && clip.look.lut === "teal.cube", `applyLut should set look.lut, got ${JSON.stringify(clip.kind === "video" ? clip.look : {})}`);

  // (b) Export plan with a LUT emits lut3d=file=<resolved path> (resolved through
  // the SAME resolver as media → same whitelist).
  const lutPlan = buildExportPlan(withLut, resolve, "/out/lut.mp4");
  assert(lutPlan.filterComplex.includes("lut3d=file=/media/teal.cube"), `LUT export must contain lut3d=file=, got: ${lutPlan.filterComplex.slice(0, 300)}`);

  // (c) Without a LUT → no lut3d AND byte-identical to the same doc's plan (the LUT
  // is purely additive: removing the appended lut3d segment yields the base graph).
  const basePlan = buildExportPlan(base, resolve, "/out/lut.mp4");
  assert(!basePlan.filterComplex.includes("lut3d"), "a doc without a LUT must not emit lut3d");
  assert(
    lutPlan.filterComplex.replace("lut3d=file=/media/teal.cube,", "") === basePlan.filterComplex,
    "LUT must be additive — removing lut3d should reproduce the no-LUT graph byte-for-byte",
  );

  // (d) Clearing the LUT (empty string) removes the field again.
  const cleared = applyLut(withLut, { lut: "" });
  const cc = cleared.tracks[0]!.clips[0]!;
  assert(cc.kind === "video" && cc.look.lut === undefined, "applyLut('') should clear the LUT");

  // (e) The apply_lut Director tool sets the field via the same pure fn.
  const project = new ProjectState({ media: [{ id: "v.mp4", kind: "video", src: "/media/v.mp4", durationSec: 10 }] });
  project.setDoc(base);
  await DIRECTOR_TOOLS.apply_lut.execute({ lut: "warm.cube" }, { project });
  const toolClip = project.doc.tracks[0]!.clips[0]!;
  assert(toolClip.kind === "video" && toolClip.look.lut === "warm.cube", "apply_lut tool should set look.lut");

  // The canvas still renders (LUT is export-only; canvas skips it gracefully).
  const n = await renderAndAssert(withLut, 2, "verify-lut.png");
  console.log(`  [32m✔[0m check 61 (LUT import): applyLut sets look.lut → ffmpeg lut3d=file= (resolved+escaped, export-only); additive (no LUT ⇒ byte-identical, no lut3d); clears on ''; apply_lut tool; canvas renders (${n}b)`);
}

async function checkAdjustmentLayer(): Promise<void> {
  const resolve = (id: string) => `/media/${id}.mp4`;

  const base = parseEditDoc({
    version: 1,
    meta: { title: "adjustment", width: 1920, height: 1080, fps: 30 },
    media: [{ id: "v", kind: "video", src: "/media/v.mp4" }],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 8, mediaId: "v", transform: { x: 960, y: 540 } }] },
    ],
  });

  // (a) addAdjustment creates an "adjustments" track (topmost = last) with one
  // adjustment clip over the window.
  const adj = addAdjustment(base, { atSec: 2, durationSec: 4, look: "noir" });
  const track = adj.tracks.find((t) => t.id === "adjustments");
  assert(track && track.clips.length === 1 && track.clips[0]!.kind === "adjustment", "addAdjustment should add an adjustment clip on its own track");
  assert(adj.tracks[adj.tracks.length - 1]!.id === "adjustments", "the adjustments track must be topmost (last in array = highest z)");
  const adjClip = track!.clips[0]!;
  assert(adjClip.start === 2 && adjClip.duration === 4, `adjustment window should be [2,6], got start=${adjClip.start} dur=${adjClip.duration}`);

  // (b) Renders a real frame INSIDE the window.
  const nIn = await renderAndAssert(adj, 4, "verify-adjustment.png");

  // (c) Export plan applies the grade to the composite, GATED by
  // enable='between(t,2,6)' (noir → eq with saturation=0).
  const ap = buildExportPlan(adj, resolve, "/out/adj.mp4");
  assert(ap.filterComplex.includes("enable='between(t\\,2\\,6)'"), `adjustment grade must be gated to its window, got: ${ap.filterComplex.slice(-300)}`);
  assert(/\[v0\][^;]*eq=[^;]*enable='between\(t\\,2\\,6\)'[^;]*\[vadj0\]/.test(ap.filterComplex), `adjustment must grade the composite (v0) into vadj0, got: ${ap.filterComplex.slice(-300)}`);
  assert(ap.args.includes("[vadj0]"), "the graded stream (vadj0) must be the mapped video output");

  // (d) A frame INSIDE the window differs from one OUTSIDE it (grade only applies
  // within [2,6]).
  const inside = await renderBytes(adj, 4);
  const outside = await renderBytes(adj, 0.5);
  assert(!inside.equals(outside), "an in-window adjustment frame must differ from an out-of-window frame");

  // (e) No adjustment → the composite is byte-identical (the adjustment is appended
  // as a post-composite pass, leaving the base graph unchanged).
  const basePlan = buildExportPlan(base, resolve, "/out/base.mp4");
  assert(!basePlan.filterComplex.includes("vadj") && !basePlan.filterComplex.includes("between(t\\,2\\,6)"), "a doc with no adjustment must not emit any adjustment grade");
  assert(ap.filterComplex.startsWith(basePlan.filterComplex + ";[v0]"), "adjustment must be additive — the base composite graph stays byte-identical, with the grade appended");

  // (f) The add_adjustment Director tool creates the layer via the same pure fn.
  const project = new ProjectState({ media: [{ id: "v", kind: "video", src: "/media/v.mp4", durationSec: 10 }] });
  project.setDoc(base);
  await DIRECTOR_TOOLS.add_adjustment.execute({ atSec: 1, durationSec: 3, brightness: 1.3 }, { project });
  const toolTrack = project.doc.tracks.find((t) => t.id === "adjustments");
  assert(toolTrack && toolTrack.clips.length === 1 && toolTrack.clips[0]!.kind === "adjustment", "add_adjustment tool should create an adjustment layer");

  console.log(`  [32m✔[0m check 62 (adjustment layer): addAdjustment → own topmost track + real frame (${nIn}b); ffmpeg grades the composite gated by enable='between(t,2,6)'; in-window frame differs from out; additive (no adjustment ⇒ base graph byte-identical); add_adjustment tool`);
}

/**
 * Evaluate the SUBSET of ffmpeg expression syntax that keyframeTransformExpr emits
 * (numbers, `t`/`T`, + - * /, parentheses, PI, and if/lt/pow/clip), so the gate can
 * assert the emitted expression agrees with the PURE valueAt. NOT a general ffmpeg
 * evaluator — only the constructs this codebase generates.
 */
function evalFfExpr(expr: string, tVal: number): number {
  const js = expr
    .replace(/\\,/g, ",") // un-escape filtergraph commas
    .replace(/\bif\(/g, "iff(") // if() → helper (if is reserved)
    .replace(/\bclip\(/g, "clipf(")
    .replace(/\bpow\(/g, "Math.pow(")
    .replace(/\bPI\b/g, "Math.PI");
  const iff = (c: number, a: number, b: number): number => (c ? a : b);
  const lt = (a: number, b: number): number => (a < b ? 1 : 0);
  const clipf = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);
  // t and T both map to the timeline sample (overlay/rotate read t; geq reads T).
  const fn = new Function("t", "T", "iff", "lt", "clipf", `return (${js});`);
  return fn(tVal, tVal, iff, lt, clipf) as number;
}

async function checkTransformKeyframes(): Promise<void> {
  const resolveP = (id: string) => `/media/${id}.mp4`;
  const dur = 6;
  const startSec = 0;

  // A base video track + an UPPER visual layer (a plain PiP) that animates x/y,
  // rotation AND opacity via keyframes — the common animated-layer case. The base is
  // the single-clip fast path (v0); the PiP composites over it as [v0][bov0].
  const kfDoc = (): EditDoc =>
    parseEditDoc({
      version: 1,
      meta: { title: "xform-kf", width: 1920, height: 1080, fps: 30 },
      media: [
        { id: "base", kind: "video", src: "/media/base.mp4" },
        { id: "top", kind: "video", src: "/media/top.mp4" },
      ],
      tracks: [
        { id: "video", kind: "visual", clips: [{ id: "b0", kind: "video", start: 0, duration: dur, mediaId: "base", transform: { x: 960, y: 540 } }] },
        {
          id: "layer2",
          kind: "visual",
          clips: [
            {
              id: "u0", kind: "video", start: startSec, duration: dur, mediaId: "top",
              transform: { x: 200, y: 200, scale: 0.5 },
              keyframes: [
                { prop: "x", t: 0, value: 200, easing: "linear" },
                { prop: "x", t: 1, value: 1400, easing: "linear" },
                { prop: "y", t: 0, value: 200, easing: "linear" },
                { prop: "y", t: 1, value: 800, easing: "linear" },
                { prop: "rotation", t: 0, value: 0, easing: "linear" },
                { prop: "rotation", t: 1, value: 90, easing: "linear" },
                { prop: "opacity", t: 0, value: 0, easing: "linear" },
                { prop: "opacity", t: 1, value: 1, easing: "ease-in" },
              ],
            },
          ],
        },
      ],
    });

  const doc = kfDoc();
  const plan = buildExportPlan(doc, resolveP, "/out/xformkf.mp4");
  const fc = plan.filterComplex;

  // (a) x/y → a TIME-VARYING overlay position (overlay=x='…t…':y='…t…').
  const ovMatch = fc.match(/overlay=x='([^']*)':y='([^']*)':enable=/);
  assert(ovMatch, `x/y keyframes: expected overlay=x='…':y='…', got: ${fc.slice(0, 400)}`);
  assert(ovMatch![1]!.includes("t") && ovMatch![2]!.includes("t"), "x/y keyframes: overlay x/y must be t-dependent expressions");

  // (b) rotation → rotate=a='…t…' in radians (*PI/180), alpha-safe (c=none).
  const rotMatch = fc.match(/rotate=a='([^']*)':ow=\d+:oh=\d+:c=none/);
  assert(rotMatch, `rotation keyframes: expected rotate=a='…':ow=…:oh=…:c=none, got: ${fc.slice(0, 500)}`);
  assert(rotMatch![1]!.includes("t") && rotMatch![1]!.includes("PI/180"), "rotation keyframes: rotate angle must be a t-expr in radians");

  // (c) opacity → a per-frame alpha expr (geq …:a='…T…').
  const opMatch = fc.match(/geq=[^]*?:a='([^']*)'/);
  assert(opMatch, `opacity keyframes: expected a geq alpha expr, got: ${fc.slice(0, 600)}`);
  assert(opMatch![1]!.includes("T"), "opacity keyframes: the alpha expr must be a T-dependent expression");

  // (d) The animated PiP carries an alpha plane (rgba) so rotate/opacity composite.
  assert(fc.includes("format=rgba"), "transform keyframes: the animated PiP must run in rgba (alpha-safe)");

  // (e) A REAL frame renders mid-animation.
  const n = await renderAndAssert(doc, startSec + dur / 2, "verify-xform-keyframes.png");

  // (f) NO transform keyframes ⇒ byte-identical to the pre-existing STATIC overlay:
  // the emitted overlay is the plain `overlay=<ox>:<oy>:enable=` form (no x=/rotate/geq).
  const plain = kfDoc();
  for (const t of plain.tracks) for (const c of t.clips) delete (c as { keyframes?: unknown }).keyframes;
  const planPlain = buildExportPlan(plain, resolveP, "/out/xformkf-plain.mp4");
  assert(/\[v0\]\[bov0\]overlay=-?\d+:-?\d+:enable=/.test(planPlain.filterComplex), "no-keyframe fast path: expected the static overlay form");
  assert(
    !planPlain.filterComplex.includes("overlay=x=") && !planPlain.filterComplex.includes("rotate=a=") && !planPlain.filterComplex.includes("geq="),
    "no-keyframe fast path: must emit NO time-varying transform filters",
  );
  assert(planPlain.filterComplex !== fc, "keyframes must change the export graph vs the no-keyframe fast path");

  // (g) The emitted EXPRESSION agrees with the PURE valueAt at t=start/mid/end (the
  // parity contract) — evaluate the ffmpeg expr subset in JS and compare.
  const layerClip = doc.tracks[1]!.clips[0] as VideoClip;
  const samples: { prop: KeyframeProp; base: number }[] = [
    { prop: "x", base: 200 }, { prop: "y", base: 200 }, { prop: "rotation", base: 0 }, { prop: "opacity", base: 1 },
  ];
  for (const { prop, base } of samples) {
    const expr = keyframeTransformExpr(layerClip, prop, "t");
    assert(expr, `keyframeTransformExpr should emit for ${prop}`);
    for (const prog of [0, 0.5, 1]) {
      const timeline = startSec + prog * dur;
      const want = valueAt(layerClip.keyframes, prop, prog, base);
      const got = evalFfExpr(expr!, timeline);
      assert(Math.abs(got - want) < 1e-6, `${prop} @prog ${prog}: expr ${got} must match valueAt ${want}`);
    }
  }

  console.log(`  \x1b[32m✔\x1b[0m check 63 (transform keyframes): animated PiP exports x/y → overlay=x/y(t), rotation → rotate=a(t) rad (alpha-safe c=none), opacity → geq alpha(T); real frame (${n}b); no-keyframe overlay byte-identical (fast path); emitted expr matches valueAt at t=start/mid/end`);
}

/**
 * REAL ENCODE — the only check that actually SPAWNS ffmpeg on the export plan for a
 * battery of complex docs and asserts a real, non-empty .mp4 comes out (exit 0).
 * Every OTHER export check asserts on the filter_complex STRING, so a graph that
 * reads plausibly but is rejected by ffmpeg's parser (unbalanced/`\\,`-double-escaped
 * expressions, wrong function names, an illegally-fused filter) slips through them —
 * exactly the class of bug that made complex exports fail at runtime with
 * "Error parsing global options: Invalid argument".
 *
 * Inputs are synthesized here with lavfi (testsrc + sine → a short mp4 WITH audio,
 * plus two still PNGs) so the check is fully self-contained. If ffmpeg is
 * unavailable the check SKIPS gracefully (logs + passes).
 *
 * TEXT: `ffmpeg-static` ships WITHOUT libfreetype, so it has no `drawtext` filter —
 * captions/titles used to be omitted here (and exports with them failed). Now every
 * text-bearing clip is rasterized to a transparent PNG (renderTextOverlays, canvas
 * engine) and OVERLAID, so this check ALWAYS burns in captions AND a title and still
 * encodes cleanly on the bundled ffmpeg — the direct proof the user's captioned
 * export works. Text overlays are rendered per doc and threaded into buildExportPlan.
 */
async function checkRealEncode(): Promise<void> {
  const info = await detectFfmpeg();
  if (!info.available) {
    console.log(
      `  \x1b[32m✔\x1b[0m check 64 (real encode): ffmpeg unavailable — skipped gracefully (install ffmpeg to exercise real .mp4 encode of complex docs)`,
    );
    return;
  }
  const bin = resolveFfmpegBin();

  const encDir = resolve(OUT_DIR, "encode");
  mkdirSync(encDir, { recursive: true });
  const srcMp4 = resolve(encDir, "src.mp4");
  const srcNoAudio = resolve(encDir, "src-noaudio.mp4");
  const pngA = resolve(encDir, "photo-0.png");
  const pngB = resolve(encDir, "photo-1.png");
  const synth = (args: string[], what: string): void => {
    const r = spawnSync(bin, ["-hide_banner", "-y", ...args], { encoding: "utf8" });
    assert(r.status === 0, `real encode: could not synthesize ${what} (${(r.stderr || "").slice(-300)})`);
  };
  // A short source clip WITH an audio stream (so concat=…:a=1 has a stream to map).
  synth(
    ["-f", "lavfi", "-i", "testsrc=size=640x480:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", srcMp4],
    "source mp4",
  );
  // A short source clip with NO audio input at all — the exact shape of a
  // browser-captured `clip.webm` (canvas captureStream → video only) or any silent
  // user video. Referencing its `[idx:a]` used to abort the export (exit ~234); the
  // fix must synthesize silence instead. Self-contained via lavfi (no audio input).
  synth(
    ["-f", "lavfi", "-i", "testsrc=size=640x480:rate=30:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", srcNoAudio],
    "audioless source mp4",
  );
  synth(["-f", "lavfi", "-i", "testsrc=size=1280x720:duration=1", "-frames:v", "1", pngA], "photo-0");
  synth(["-f", "lavfi", "-i", "rgbtestsrc=size=1280x720:duration=1", "-frames:v", "1", pngB], "photo-1");

  // Prove the no-ffprobe audio detection: `probeHasAudio` (ffmpeg -i, stderr parse)
  // must see the audio stream in src.mp4 and NOT in the audioless clip.
  assert(
    (await probeHasAudio(bin, srcMp4)) === true,
    "real encode: probeHasAudio must detect the audio stream in src.mp4 (ffmpeg -i stderr parse)",
  );
  assert(
    (await probeHasAudio(bin, srcNoAudio)) === false,
    "real encode: probeHasAudio must report NO audio for the audioless source (the export bug)",
  );

  const resolveMedia = (id: string): string =>
    id.startsWith("photo")
      ? id === "photo-0"
        ? pngA
        : pngB
      : id.includes("noaudio")
        ? srcNoAudio
        : srcMp4;

  // A cinematic look + a caption track. Captions are ALWAYS burned in now (as a
  // rasterized PNG overlay), regardless of whether the ffmpeg build has drawtext.
  const look = { brightness: 1.06, contrast: 1.12, saturation: 1.15, warmth: 0.35 };
  const captions = (y: number): unknown[] => [
    { id: "captions", kind: "visual", clips: [{ id: "cap0", kind: "text", start: 0.2, duration: 1.2, text: "Big news, folks: 100% real!", background: "#0a0d12cc", transform: { x: 540, y } }] },
  ];
  // A bold title (also a PNG overlay on export). Distinct track/id from captions.
  const titles = (): unknown => ({
    id: "titles", kind: "visual", clips: [
      { id: "title0", kind: "text", start: 0, duration: 2, text: "The Big Reveal", fontSize: 96, fontWeight: "bold", color: "#ffcf70", transform: { x: 540, y: 500 } },
    ],
  });
  // Fade-from-black / fade-to-black solids spanning a `total`-second doc.
  const fades = (total: number): unknown => ({
    id: "fades", kind: "visual", clips: [
      { id: "f0", kind: "solid", start: 0, duration: 0.4, color: "#000000", transitionOutSec: 0.4 },
      { id: "f1", kind: "solid", start: total - 0.4, duration: 0.4, color: "#000000", transitionInSec: 0.4 },
    ],
  });

  let encoded = 0;
  const encode = async (label: string, rawDoc: unknown): Promise<void> => {
    const doc = parseEditDoc(rawDoc);
    const out = resolve(encDir, `enc-${label}.mp4`);
    // Rasterize any text-bearing clips (captions/titles/callout labels) to
    // transparent PNGs, then overlay them — NO drawtext, so it works on the bundled
    // freetype-less ffmpeg. This is the exact path the export route now takes.
    const overlays = await renderTextOverlays(doc, encDir);
    // Karaoke captions become a per-word PNG sequence (empty map for non-karaoke docs,
    // so their graph stays byte-identical). Overlaid gated word-by-word by the plan.
    const karaokeOverlays = await renderKaraokeOverlays(doc, encDir);
    // Detect audio the SAME way runExport does (no ffprobe — `ffmpeg -i` stderr
    // parse), then thread it into the pure plan so audioless inputs get synthesized
    // silence instead of a non-existent [idx:a] pad. For all-audio docs this map is
    // every-true, so the emitted graph is byte-identical to the pre-fix fast path.
    const mediaHasAudio = await detectMediaAudio(bin, doc, resolveMedia);
    const plan = buildExportPlan(doc, resolveMedia, out, overlays, mediaHasAudio, karaokeOverlays);
    // Guard the exact class of the fixed bug: a `\,` that got escaped twice.
    assert(!plan.filterComplex.includes("\\\\,"), `real encode [${label}]: double-escaped comma (\\\\,) in filtergraph — ffmpeg's eval will reject it`);
    // Text is PNG overlays now, never drawtext (which the bundled ffmpeg lacks).
    assert(!plan.filterComplex.includes("drawtext="), `real encode [${label}]: text must be PNG overlays, not drawtext (bundled ffmpeg has no libfreetype)`);
    const r = spawnSync(bin, plan.args, { encoding: "utf8" });
    assert(
      r.status === 0,
      `real encode [${label}]: ffmpeg exited ${r.status} — malformed filtergraph.\n  FC: ${plan.filterComplex.slice(0, 900)}\n  ERR: ${(r.stderr || "").split("\n").filter((l) => /error|invalid|no such|missing|unknown|parse/i.test(l)).slice(-4).join("\n       ")}`,
    );
    const size = statSync(out).size;
    assert(size > 0, `real encode [${label}]: ffmpeg exited 0 but produced an empty file`);
    encoded++;
  };

  // (a) THE reported failing combo: highlight cut + 9:16 reframe (1080x1920) + 4K
  //     quality (1216x2160) + cinematic look + burn-in captions + fade in/out +
  //     punch-in emphasis (the sine-pulse zoompan) — every ingredient at once.
  await encode("a_failing_combo", {
    version: 1, meta: { title: "a", width: 1080, height: 1920, fps: 30, background: "#000000" },
    media: [{ id: "clip-001", kind: "video", src: srcMp4 }],
    quality: { preset: "ultra", targetWidth: 1216, targetHeight: 2160, sharpen: 0.5, denoise: 0.3, aiUpscale: false, faithful: true },
    tracks: [
      { id: "video", kind: "visual", clips: [
        { id: "c0", kind: "video", start: 0, duration: 1.5, mediaId: "clip-001", sourceIn: 1, transform: { x: 540, y: 960 }, look, emphasis: { atSec: 0.6, durationSec: 0.6, zoom: 1.25 } },
        { id: "c1", kind: "video", start: 1.5, duration: 1.5, mediaId: "clip-001", sourceIn: 3, transform: { x: 540, y: 960 }, look, emphasis: { atSec: 2.0, durationSec: 0.6, zoom: 1.3 } },
      ] },
      ...captions(1600),
      fades(3),
    ],
  });

  // (b) reframe + 4K + look + captions + fades + emphasis on a single long clip,
  //     with a richer grade (hue + tone curve) to exercise the whole look chain.
  await encode("b_reframe_4k", {
    version: 1, meta: { title: "b", width: 1080, height: 1920, fps: 30, background: "#000000" },
    media: [{ id: "clip-001", kind: "video", src: srcMp4 }],
    quality: { preset: "high", targetWidth: 1216, targetHeight: 2160, sharpen: 0.4, denoise: 0.2, aiUpscale: false, faithful: true },
    tracks: [
      { id: "video", kind: "visual", clips: [
        { id: "c0", kind: "video", start: 0, duration: 3, mediaId: "clip-001", sourceIn: 0.5, transform: { x: 540, y: 960 },
          look: { ...look, hueShift: 8, curves: { master: [[0, 0], [0.5, 0.58], [1, 1]] } },
          emphasis: { atSec: 1.2, durationSec: 0.8, zoom: 1.35 } },
      ] },
      ...captions(1650),
      fades(3),
    ],
  });

  // (c) multi-clip highlight with real A→B transitions (xfade video + acrossfade audio).
  await encode("c_xfade_transitions", {
    version: 1, meta: { title: "c", width: 1080, height: 1920, fps: 30 },
    media: [{ id: "clip-001", kind: "video", src: srcMp4 }],
    tracks: [{ id: "video", kind: "visual", clips: [
      { id: "c0", kind: "video", start: 0, duration: 1.6, mediaId: "clip-001", sourceIn: 0, transform: { x: 540, y: 960 } },
      { id: "c1", kind: "video", start: 1.2, duration: 1.6, mediaId: "clip-001", sourceIn: 2, transform: { x: 540, y: 960 }, transitionInSec: 0.4, transitionType: "dip-to-black" },
      { id: "c2", kind: "video", start: 2.4, duration: 1.6, mediaId: "clip-001", sourceIn: 4, transform: { x: 540, y: 960 }, transitionInSec: 0.4, transitionType: "wipe" },
    ] }],
  });

  // (d) keyframed transform on an overlay/PiP (x + y + rotation + opacity → overlay
  //     x/y expr, rotate=a(t), geq alpha(T)) composited over a base clip.
  await encode("d_kf_overlay", {
    version: 1, meta: { title: "d", width: 1080, height: 1920, fps: 30 },
    media: [{ id: "clip-001", kind: "video", src: srcMp4 }],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 3, mediaId: "clip-001", sourceIn: 0, transform: { x: 540, y: 960 } }] },
      { id: "broll", kind: "visual", clips: [{ id: "p0", kind: "video", start: 0, duration: 3, mediaId: "clip-001", sourceIn: 2, transform: { x: 300, y: 500, scale: 0.4 },
        keyframes: [
          { prop: "x", t: 0, value: 300, easing: "ease-in-out" }, { prop: "x", t: 1, value: 780, easing: "ease-out" },
          { prop: "y", t: 0, value: 500, easing: "linear" }, { prop: "y", t: 1, value: 1400, easing: "ease-in" },
          { prop: "rotation", t: 0, value: 0, easing: "linear" }, { prop: "rotation", t: 1, value: 40, easing: "ease-out" },
          { prop: "opacity", t: 0, value: 0.25, easing: "linear" }, { prop: "opacity", t: 1, value: 1, easing: "ease-in" },
        ] }] },
    ],
  });

  // (e) adjustment layer + LUT-less grade (eq/curves/colorbalance/hue + grain/vignette,
  //     time-gated) over the whole composite.
  await encode("e_adjustment_grade", {
    version: 1, meta: { title: "e", width: 1080, height: 1920, fps: 30 },
    media: [{ id: "clip-001", kind: "video", src: srcMp4 }],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 3, mediaId: "clip-001", sourceIn: 0, transform: { x: 540, y: 960 } }] },
      { id: "adj", kind: "visual", clips: [{ id: "a0", kind: "adjustment", start: 0.5, duration: 2,
        grade: { brightness: 1.1, contrast: 1.2, saturation: 0.9, warmth: 0.4, hueShift: 10, curves: { master: [[0, 0], [0.5, 0.62], [1, 1]] } },
        vfx: { grain: 0.3, vignette: 0.5 } }] },
    ],
  });

  // (f) slideshow with crossfades (looped stills + Ken Burns zoompan + xfade). Small
  //     composition keeps the per-pixel zoompan cheap for the gate.
  await encode("f_slideshow_xfade", {
    version: 1, meta: { title: "f", width: 540, height: 960, fps: 30 },
    media: [{ id: "photo-0", kind: "image", src: pngA, width: 1280, height: 720 }, { id: "photo-1", kind: "image", src: pngB, width: 1280, height: 720 }],
    tracks: [{ id: "video", kind: "visual", clips: [
      { id: "i0", kind: "image", start: 0, duration: 1.6, mediaId: "photo-0", transform: { x: 270, y: 480 }, motion: { zoom: 1.2, panX: 0.05, panY: 0.02 } },
      { id: "i1", kind: "image", start: 1.2, duration: 1.6, mediaId: "photo-1", transform: { x: 270, y: 480 }, transitionInSec: 0.4, transitionType: "crossfade", motion: { zoom: 1.1, panX: -0.05, panY: 0 } },
    ] }],
  });

  // (g) shaped-reveal / green-screen overlay: chroma key + geq alpha mask over a base
  //     clip — the exact geq path the escaping bug (\\, ) and the alpha(x,y) fix live in.
  await encode("g_chroma_mask", {
    version: 1, meta: { title: "g", width: 1080, height: 1920, fps: 30 },
    media: [{ id: "clip-001", kind: "video", src: srcMp4 }],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 2.5, mediaId: "clip-001", sourceIn: 0, transform: { x: 540, y: 960 } }] },
      { id: "broll", kind: "visual", clips: [{ id: "p0", kind: "video", start: 0, duration: 2.5, mediaId: "clip-001", sourceIn: 2, transform: { x: 540, y: 960 },
        chroma: { color: "#00ff00", similarity: 0.3, blend: 0.1, spill: 0.2 },
        mask: { shape: "ellipse", x: 200, y: 500, w: 600, h: 800, feather: 40, invert: false } }] },
    ],
  });

  // (h) THE user's case, direct: burn-in captions AND a bold title over a real clip,
  //     encoded by the BUNDLED (freetype-less) ffmpeg via PNG overlays. This is the
  //     proof that a captioned/titled export now produces a real, non-empty .mp4.
  await encode("h_captions_title", {
    version: 1, meta: { title: "h", width: 1080, height: 1920, fps: 30, background: "#000000" },
    media: [{ id: "clip-001", kind: "video", src: srcMp4 }],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 3, mediaId: "clip-001", sourceIn: 0, transform: { x: 540, y: 960 } }] },
      titles(),
      ...captions(1600),
    ],
  });

  // ---- AUDIOLESS INPUTS (the reported export bug) -------------------------
  // A source with NO audio stream used to abort export: the filtergraph referenced
  // `[idx:a]`, and ffmpeg exited ~234 with "Stream specifier ':a' … matches no
  // streams". The fix probes audio (no ffprobe) and substitutes silence. These
  // three cases ENCODE audioless docs end-to-end and assert a real, non-empty mp4.
  // The media set `hasAudio` UNSET (like a browser `clip.webm`), so detectMediaAudio
  // must probe and report false, driving the anullsrc silence path.

  // detectMediaAudio (the exact production probe) must classify a mixed media set:
  // audioless video → false, audio-bearing video → true, image → false.
  const audioMap = await detectMediaAudio(
    bin,
    parseEditDoc({
      version: 1, meta: { title: "probe", width: 640, height: 480, fps: 30 },
      media: [
        { id: "clip-noaudio", kind: "video", src: srcNoAudio },
        { id: "clip-001", kind: "video", src: srcMp4 },
        { id: "photo-0", kind: "image", src: pngA, width: 1280, height: 720 },
      ],
      tracks: [{ id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 1, mediaId: "clip-noaudio", sourceIn: 0 }] }],
    }),
    resolveMedia,
  );
  assert(audioMap.get("clip-noaudio") === false, "detectMediaAudio: audioless video must be false");
  assert(audioMap.get("clip-001") === true, "detectMediaAudio: audio-bearing video must be true");
  assert(audioMap.get("photo-0") === false, "detectMediaAudio: image must be false (never probed)");

  // (i) THE exact e2e doc shape on an AUDIOLESS input: highlight cut (2-clip concat)
  //     + 9:16 reframe (1080x1920) + 4K (1216x2160) + cinematic look + burn-in
  //     captions + fade in/out + punch-in emphasis. Mirrors case (a), but the source
  //     has no audio — so each concat segment must get synthesized silence.
  await encode("i_audioless_e2e", {
    version: 1, meta: { title: "i", width: 1080, height: 1920, fps: 30, background: "#000000" },
    media: [{ id: "clip-noaudio", kind: "video", src: srcNoAudio }],
    quality: { preset: "ultra", targetWidth: 1216, targetHeight: 2160, sharpen: 0.5, denoise: 0.3, aiUpscale: false, faithful: true },
    tracks: [
      { id: "video", kind: "visual", clips: [
        { id: "c0", kind: "video", start: 0, duration: 1.5, mediaId: "clip-noaudio", sourceIn: 1, transform: { x: 540, y: 960 }, look, emphasis: { atSec: 0.6, durationSec: 0.6, zoom: 1.25 } },
        { id: "c1", kind: "video", start: 1.5, duration: 1.5, mediaId: "clip-noaudio", sourceIn: 3, transform: { x: 540, y: 960 }, look, emphasis: { atSec: 2.0, durationSec: 0.6, zoom: 1.3 } },
      ] },
      ...captions(1600),
      fades(3),
    ],
  });

  // (j) audioless base video + a MUSIC track: the base contributes silence, the
  //     music (a real audio-bearing source) must remain audible in the mix (amix).
  await encode("j_audioless_music", {
    version: 1, meta: { title: "j", width: 1080, height: 1920, fps: 30 },
    media: [
      { id: "clip-noaudio", kind: "video", src: srcNoAudio },
      { id: "music-1", kind: "audio", src: srcMp4 },
    ],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 3, mediaId: "clip-noaudio", sourceIn: 0, transform: { x: 540, y: 960 } }] },
      { id: "music", kind: "audio", clips: [{ id: "m0", kind: "audio", start: 0, duration: 3, mediaId: "music-1", sourceIn: 0, volume: 0.8, fadeInSec: 0.3, fadeOutSec: 0.5 }] },
    ],
  });

  // (k) multi-clip concat where SOME clips have audio and some don't: clip A (audio)
  //     then clip B (audioless). The audioless segment must be padded with silence so
  //     concat=…:a=1 lines up and the export still succeeds.
  await encode("k_audioless_mixed", {
    version: 1, meta: { title: "k", width: 1080, height: 1920, fps: 30 },
    media: [
      { id: "clip-001", kind: "video", src: srcMp4 },
      { id: "clip-noaudio", kind: "video", src: srcNoAudio },
    ],
    tracks: [{ id: "video", kind: "visual", clips: [
      { id: "c0", kind: "video", start: 0, duration: 1.5, mediaId: "clip-001", sourceIn: 0, transform: { x: 540, y: 960 } },
      { id: "c1", kind: "video", start: 1.5, duration: 1.5, mediaId: "clip-noaudio", sourceIn: 0, transform: { x: 540, y: 960 } },
    ] }],
  });

  // ---- CLEAN AUDIO (noise reduction) -------------------------------------
  // (l) doc.cleanAudio on a source WITH audio must insert an FFT denoise (afftdn)
  //     into the FINAL mixed-audio chain, placed BEFORE loudnorm (denoise → normalize),
  //     and still encode to a real, non-empty mp4. OFF ⇒ NO afftdn (byte-identical
  //     audio graph — the historical fast path). The pure `setCleanAudio` op toggles
  //     the doc flag. Denoise is EXPORT-ONLY (like loudnorm) — no preview change.
  const cleanBase = {
    version: 1 as const,
    meta: { title: "l", width: 1080, height: 1920, fps: 30 },
    media: [{ id: "clip-001", kind: "video" as const, src: srcMp4 }],
    tracks: [{ id: "video", kind: "visual" as const, clips: [
      { id: "c0", kind: "video" as const, start: 0, duration: 2, mediaId: "clip-001", sourceIn: 0, transform: { x: 540, y: 960 } },
    ] }],
  };
  const cleanOff = parseEditDoc(cleanBase);
  const cleanOn = setCleanAudio(cleanOff, true);
  assert(cleanOn.cleanAudio === true, "clean audio: setCleanAudio must toggle the doc flag on");
  assert(setCleanAudio(cleanOn, false).cleanAudio === false, "clean audio: setCleanAudio(false) must clear the flag");
  const cleanAudioMap = await detectMediaAudio(bin, cleanOn, resolveMedia);
  const cleanOnPlan = buildExportPlan(cleanOn, resolveMedia, resolve(encDir, "enc-l_clean_on.mp4"), undefined, cleanAudioMap);
  const cleanOffPlan = buildExportPlan(cleanOff, resolveMedia, resolve(encDir, "enc-l_clean_off.mp4"), undefined, cleanAudioMap);
  assert(cleanOnPlan.filterComplex.includes("afftdn="), "clean audio: ON must insert afftdn into the audio graph");
  assert(
    cleanOnPlan.filterComplex.indexOf("afftdn=") < cleanOnPlan.filterComplex.indexOf("[aden]") + 1 ||
      cleanOnPlan.filterComplex.includes("afftdn=nr=12:nt=w[aden]"),
    "clean audio: afftdn should feed the denoised [aden] label",
  );
  assert(!cleanOffPlan.filterComplex.includes("afftdn="), "clean audio: OFF must NOT emit afftdn (byte-identical audio graph)");
  await encode("l_clean_audio", { ...cleanBase, cleanAudio: true });

  // (m) KARAOKE captions: a caption with per-word timing + karaoke highlight must
  //     export as a per-word PNG SEQUENCE (one gated overlay per word) on the bundled
  //     freetype-less ffmpeg, producing a real, non-empty mp4. Proves the word-by-word
  //     highlight steps on export too (not just in preview).
  await encode("m_karaoke_captions", {
    version: 1, meta: { title: "m", width: 1080, height: 1920, fps: 30, background: "#000000" },
    media: [{ id: "clip-001", kind: "video", src: srcMp4 }],
    tracks: [
      { id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 3, mediaId: "clip-001", sourceIn: 0, transform: { x: 540, y: 960 } }] },
      { id: "captions", kind: "visual", clips: [
        { id: "kcap0", kind: "text", start: 0.2, duration: 2.4, text: "read along now", background: "#0a0d12cc", transform: { x: 540, y: 1600 },
          words: [
            { text: "read", start: 0.2, end: 1.0 },
            { text: "along", start: 1.0, end: 1.8 },
            { text: "now", start: 1.8, end: 2.6 },
          ],
          karaoke: { enabled: true, highlight: "#ffd54a", style: "fill" } },
      ] },
    ],
  });

  // (4) regression guard: a plain, simple single-clip export must still encode.
  await encode("plain_simple", {
    version: 1, meta: { title: "plain", width: 1080, height: 1920, fps: 30 },
    media: [{ id: "clip-001", kind: "video", src: srcMp4 }],
    tracks: [{ id: "video", kind: "visual", clips: [{ id: "c0", kind: "video", start: 0, duration: 2, mediaId: "clip-001", sourceIn: 0, transform: { x: 540, y: 960 } }] }],
  });

  console.log(
    `  \x1b[32m✔\x1b[0m check 64 (real encode): ffmpeg ${info.version ?? "?"} encoded ${encoded} complex docs to non-empty .mp4 (exit 0) — failing-combo (emphasis+4K+reframe+look+fades+CAPTIONS), captions+title (user's case), xfade transitions, kf overlay, adjustment grade, slideshow xfade, chroma+geq-mask, AUDIOLESS e2e (highlight+9:16+4K+look+captions+fades+emphasis on a no-audio source), audioless+music, audioless↔audio mix, CLEAN-AUDIO denoise (afftdn before loudnorm; OFF byte-identical), KARAOKE captions (per-word PNG sequence, gated word-by-word), plain; audio presence detected without ffprobe (ffmpeg -i stderr parse) and audioless inputs padded with anullsrc silence; all text burned in as PNG overlays (works on the bundled freetype-less ffmpeg)`,
  );
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
  await checkMultiTrackLayers();
  await checkFrameSizes();
  await checkMoreLooks();
  await checkMoreTransitions();
  await checkVfx();
  await checkCaptionStyle();
  await checkCaptionCustomStyle();
  await checkTypewriter();
  await checkCursor();
  await checkCallout();
  await checkBuildDemo();
  await checkVideoCutTransition();
  await checkCaptionSpeed();
  await checkKaraoke();
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
  await checkPerCutTransition();
  await checkTransitionPreview();
  await checkManualKeyframes();
  await checkRollSlipSlide();
  await checkSpeedRampCurve();
  await checkTransitionLibrary();
  await checkLutImport();
  await checkAdjustmentLayer();
  await checkTransformKeyframes();
  await checkRealEncode();
  console.log(`\n[32m✔ VERIFY PASSED[0m — frames in ${OUT_DIR}`);
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
