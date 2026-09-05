/**
 * VERIFY GATE — the keystone of Cadence's agentic loop.
 *
 * Contract (AGENTS.md §DONE): typecheck passes AND one frame of a composition
 * renders headlessly. This script does the render half: it builds a trivial
 * edit-doc, validates it against the schema, renders frame 0 with the Node
 * RenderEngine, and ASSERTS a real PNG came out. It fails loudly (exit 1) on any
 * problem so the loop never proceeds while red.
 *
 * Run: `npm run verify`  (typecheck is a separate script: `npm run typecheck`)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEditDoc, docDurationSec, type EditDoc } from "@cadence/core";
import { CanvasRenderEngine } from "@cadence/render-node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", ".cadence", "verify-frame.png");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG

function fail(msg: string): never {
  console.error(`\n[31m✖ VERIFY FAILED:[0m ${msg}\n`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

/** A trivial-but-real composition: a title over a colored background. */
function trivialDoc(): EditDoc {
  return parseEditDoc({
    version: 1,
    meta: { title: "verify", fps: 30, width: 1280, height: 720, background: "#101418" },
    media: [],
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
            align: "center",
            transform: { x: 640, y: 360 },
          },
        ],
      },
    ],
  });
}

async function main(): Promise<void> {
  const doc = trivialDoc();
  assert(docDurationSec(doc) === 3, "expected 3s timeline duration");

  const engine = new CanvasRenderEngine();
  const frame = await engine.renderFrame(doc, 0);

  assert(frame.width === 1280 && frame.height === 720, `unexpected frame size ${frame.width}x${frame.height}`);
  assert(frame.format === "png", `unexpected format ${frame.format}`);
  const bytes = Buffer.from(frame.data);
  assert(bytes.length > 1000, `frame too small (${bytes.length} bytes) — likely blank`);
  assert(bytes.subarray(0, 4).equals(PNG_MAGIC), "output is not a valid PNG (bad magic bytes)");

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, bytes);

  console.log(`[32m✔ VERIFY PASSED[0m — rendered ${frame.width}x${frame.height} PNG (${bytes.length} bytes)`);
  console.log(`  frame written to ${OUT}`);
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
