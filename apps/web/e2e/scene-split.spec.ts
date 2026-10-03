import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, FIXTURE_DIR } from "./fixtures";

/**
 * Already-built video → divided into clips. A REAL multi-shot .webm is generated
 * in the browser (canvas colour changes every 3s → 4 shots), uploaded through the
 * real <input type=file>, and the scene detector + splitter run for real:
 *  banner offer → Media room scan (progress) → live cut markers → Apply → N clips
 *  with labels/offsets → Undo → the same via the Director chat ("chop every 4
 *  seconds", "split this video into scenes").
 */

let videoPath = "";

const SHOT_SEC = 3;
const COLORS = ["#d92b2b", "#2bd94a", "#2b3fd9", "#d9d12b"];

test.beforeAll(async ({ browser }) => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const page = await browser.newPage();
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  const b64 = await page.evaluate(
    async ({ colors, shotSec }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d")!;
      const t0 = performance.now();
      let frame = 0;
      const total = colors.length * shotSec * 1000;
      const paint = () => {
        const shot = Math.min(colors.length - 1, Math.floor((performance.now() - t0) / (shotSec * 1000)));
        ctx.fillStyle = colors[shot]!;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        // A small moving box: real motion inside a shot must NOT read as a cut.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect((frame * 6) % (canvas.width - 40), 150, 40, 40);
        frame++;
      };
      paint();
      const iv = setInterval(paint, 1000 / 30);
      const stream = canvas.captureStream(30);
      const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
      const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? "video/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
      rec.start();
      await new Promise((r) => setTimeout(r, total + 300));
      rec.stop();
      clearInterval(iv);
      await stopped;
      const bytes = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      return btoa(bin);
    },
    { colors: COLORS, shotSec: SHOT_SEC },
  );
  videoPath = resolve(FIXTURE_DIR, "multishot.webm");
  writeFileSync(videoPath, Buffer.from(b64, "base64"));
  await page.close();
});

interface DocClip {
  id: string;
  kind: string;
  start: number;
  duration: number;
  sourceIn?: number;
  label?: string;
}
const readClips = async (page: Page): Promise<DocClip[]> => {
  const doc = JSON.parse((await page.locator("pre code").textContent()) ?? "{}") as { tracks: { clips: DocClip[] }[] };
  return doc.tracks.flatMap((t) => t.clips).filter((c) => c.kind === "video");
};
const composer = (page: Page) => page.getByPlaceholder("Describe the edit…");
async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await page.getByText("Director is editing…").waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
  await page.getByText("Director is editing…").waitFor({ state: "hidden", timeout: 120_000 });
}
async function dismissToast(page: Page): Promise<void> {
  const d = page.getByRole("button", { name: "Dismiss" });
  if (await d.isVisible().catch(() => false)) await d.click().catch(() => {});
}

test("scene split: banner → scan → live markers → apply (N labelled clips) → undo → Director chat", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(videoPath);
  await expect(page.getByText(/Loaded .*spoken segments/i)).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "{ } code" }).click();
  await expect(page.locator("pre code")).toBeVisible();

  // One long clip to begin with.
  await expect.poll(async () => (await readClips(page)).length).toBe(1);

  // ---- the auto-offer ----
  const offer = page.getByTestId("scene-offer");
  await expect(offer).toBeVisible();
  await page.screenshot({ path: resolve(ARTIFACT_DIR, "scene-1-offer.png"), fullPage: true });
  // It is dismissible…
  await offer.getByRole("button", { name: /Dismiss/ }).click();
  await expect(offer).toHaveCount(0);

  // ---- …and the Media room section does the same job ----
  await page.getByRole("button", { name: "Media", exact: true }).click();
  const section = page.getByTestId("scene-split");
  await expect(section).toBeVisible();
  await page.getByTestId("scene-detect").click();
  // Progress shows while scanning (it can be quick on a short clip — tolerate missing it).
  await page.getByRole("progressbar").waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  await expect(page.getByTestId("scene-count")).toContainText("4 clips", { timeout: 90_000 });
  await expect(page.getByTestId("scene-cut")).toHaveCount(3);

  // Cut points land on the colour changes (≈3s, 6s, 9s) and show as timeline markers.
  const cutLabels = await page.getByTestId("scene-cut").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
  const secs = cutLabels.map((l) => {
    const m = l.match(/(\d+):(\d+\.\d)/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  });
  secs.forEach((s, i) => expect(Math.abs(s - (i + 1) * SHOT_SEC)).toBeLessThan(0.6));
  await expect(page.getByRole("button", { name: /^Marker at / })).toHaveCount(3);
  await page.screenshot({ path: resolve(ARTIFACT_DIR, "scene-2-preview.png"), fullPage: true });

  // Sensitivity moves the preview live without re-scanning (the scan is cached).
  const slider = page.getByTestId("scene-sensitivity");
  await slider.fill("0");
  await slider.fill("0.5");
  await expect(page.getByTestId("scene-count")).toContainText("4 clips");

  // ---- apply ----
  await dismissToast(page);
  const before = await readClips(page);
  const total = before[0]!.duration;
  await page.getByTestId("scene-apply").click();
  await expect.poll(async () => (await readClips(page)).length).toBe(4);
  const clips = (await readClips(page)).sort((a, b) => a.start - b.start);
  expect(clips.map((c) => c.label)).toEqual(["Scene 1", "Scene 2", "Scene 3", "Scene 4"]);
  clips.forEach((c, i) => {
    expect(Math.abs((c.sourceIn ?? 0) - i * SHOT_SEC)).toBeLessThan(0.6);
    expect(Math.abs(c.start - (c.sourceIn ?? 0))).toBeLessThan(0.01); // pieces stay in place
  });
  expect(Math.abs(clips.reduce((s, c) => s + c.duration, 0) - total)).toBeLessThan(0.01);
  await expect(page.getByTestId("scene-applied")).toBeVisible();
  await expect(page.getByRole("button", { name: /video clip,/i })).toHaveCount(4);
  await page.screenshot({ path: resolve(ARTIFACT_DIR, "scene-3-applied.png"), fullPage: true });

  // ---- undo ----
  await page.getByTestId("scene-undo").click();
  await expect.poll(async () => (await readClips(page)).length).toBe(1);

  // ---- Director chat: fixed interval ----
  await dismissToast(page);
  await send(page, "chop every 4 seconds");
  await expect.poll(async () => (await readClips(page)).length).toBeGreaterThanOrEqual(3);
  const chopped = (await readClips(page)).sort((a, b) => a.start - b.start);
  expect(chopped[0]!.duration).toBeCloseTo(4, 1);
  await page.getByRole("button", { name: "Undo", exact: false }).first().click().catch(() => {});
  await page.keyboard.press("Control+z");

  // ---- Director chat: scenes (scan happens in the browser, cuts ride along) ----
  await expect.poll(async () => (await readClips(page)).length, { timeout: 10_000 }).toBe(1);
  await send(page, "split this video into scenes");
  await expect.poll(async () => (await readClips(page)).length, { timeout: 30_000 }).toBe(4);

  expect(errors, errors.join("\n")).toEqual([]);
});
