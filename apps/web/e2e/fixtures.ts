import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** repo-root/test-artifacts (gitignored). */
export const ARTIFACT_DIR = resolve(__dirname, "../../../test-artifacts");
export const FIXTURE_DIR = resolve(ARTIFACT_DIR, "fixtures");

export interface Fixtures {
  videoPath: string;
  photoPaths: string[];
}

/**
 * Generate REAL media in the browser (this Mac has no ffmpeg to author a clip):
 *  - a ~2.5s .webm by drawing an animated <canvas>, capturing captureStream(30)
 *    into a MediaRecorder, and collecting the chunks into a Blob;
 *  - four solid-colour .png photos via canvas.toDataURL.
 * The bytes are handed back to Node (base64) and written to FIXTURE_DIR so the
 * spec can upload them through the app's real <input type=file> with setInputFiles.
 */
export async function generateFixtures(page: Page): Promise<Fixtures> {
  mkdirSync(FIXTURE_DIR, { recursive: true });

  // ---- video ----
  const video = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d")!;
    let frame = 0;
    const paint = () => {
      ctx.fillStyle = `hsl(${(frame * 4) % 360}, 65%, 45%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 120px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`Cadence ${frame}`, canvas.width / 2, canvas.height / 2);
      // A moving box gives the highlight/scene detector real motion to chew on.
      ctx.fillStyle = "#0a0d12";
      const x = (frame * 12) % canvas.width;
      ctx.fillRect(x, 40, 80, 80);
      frame++;
    };
    paint();
    const iv = setInterval(paint, 1000 / 30);

    const stream = canvas.captureStream(30);
    const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? "video/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.start();
    await new Promise((r) => setTimeout(r, 2500));
    rec.stop();
    clearInterval(iv);
    await stopped;

    const blob = new Blob(chunks, { type: "video/webm" });
    const buf = await blob.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return { base64: btoa(binary), mime };
  });

  const videoPath = resolve(FIXTURE_DIR, "clip.webm");
  writeFileSync(videoPath, Buffer.from(video.base64, "base64"));

  // ---- photos ----
  const photos = await page.evaluate(async () => {
    const palette = ["#e0563b", "#3b82e0", "#2fae7a", "#e0b93b"];
    const out: string[] = [];
    for (let i = 0; i < palette.length; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 1200;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = palette[i]!;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 200px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`Photo ${i + 1}`, canvas.width / 2, canvas.height / 2);
      out.push(canvas.toDataURL("image/png").split(",")[1]!);
    }
    return out;
  });

  const photoPaths = photos.map((b64, i) => {
    const p = resolve(FIXTURE_DIR, `photo-${i + 1}.png`);
    writeFileSync(p, Buffer.from(b64, "base64"));
    return p;
  });

  return { videoPath, photoPaths };
}
