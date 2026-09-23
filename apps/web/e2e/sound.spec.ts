import { mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, EDITOR_URL } from "./fixtures";

/**
 * Sound made easy — on a text video (no uploads at all):
 *  1. compose a royalty-free music bed → it's on the timeline as a generated
 *     recipe AND a real, playable <audio> element in the preview;
 *  2. add a whoosh at the playhead + Auto-SFX → SFX clips with audio elements;
 *  3. cut to the beat, voice enhance toggle, live level meters;
 *  4. export a real .mp4 that carries an audio stream.
 * Screens → test-artifacts/sound/.
 */

const DIR = resolve(ARTIFACT_DIR, "sound");
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(DIR, `${name}.png`) });
const drawerCode = (page: Page) => page.locator("pre code");

async function seek(page: Page, t: number) {
  await page.evaluate((v) => {
    const r = document.querySelector<HTMLInputElement>('input[aria-label="Scrubber"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(r, String(v));
    r.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await page.waitForTimeout(250);
}

/** Duration (s) + byte size of the blob behind an <audio> element, once loaded. */
async function audioInfo(page: Page, selector: string): Promise<{ duration: number; bytes: number }> {
  return page.evaluate(async (sel) => {
    const a = document.querySelector<HTMLAudioElement>(sel)!;
    if (!(a.duration > 0)) await new Promise<void>((r) => a.addEventListener("loadedmetadata", () => r(), { once: true }));
    const blob = await (await fetch(a.src)).blob();
    return { duration: a.duration, bytes: blob.size };
  }, selector);
}

test.beforeAll(() => mkdirSync(DIR, { recursive: true }));

test("sound: compose music, add SFX, beat sync, meters, export with audio", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");

  // A text video — nothing uploaded.
  await page.getByRole("button", { name: "Start with text" }).click();
  await page.getByRole("button", { name: "Tips", exact: true }).click();
  await page.getByRole("button", { name: "Create text video" }).click();
  await expect(page.getByLabel("Scene 1 text")).toHaveValue("3 tips for better sleep");

  // 1. Audio room → compose an upbeat bed.
  await page.getByRole("navigation", { name: "Rooms" }).getByRole("button", { name: "Audio" }).click();
  const panel = page.getByLabel("Sound made easy");
  await expect(panel).toBeVisible();
  await panel.getByRole("radio", { name: "Upbeat pop" }).click();
  await expect(panel.getByRole("radio", { name: "Upbeat pop" })).toHaveAttribute("aria-checked", "true");
  await panel.getByRole("button", { name: "Compose music" }).click();
  await expect(panel.getByRole("status")).toContainText(/Composed upbeat pop/);

  // The generated bed is materialized into a real, playable audio element.
  const music = 'audio[data-clip^="music-"]';
  await expect(page.locator(music)).toHaveAttribute("src", /^blob:/, { timeout: 60_000 });
  const info = await audioInfo(page, music);
  expect(info.duration).toBeGreaterThan(5);
  expect(info.bytes).toBeGreaterThan(100_000); // real 16-bit stereo PCM, not a stub
  await expect(panel).toContainText(/BPM · \d+ bars/);
  await page.getByRole("button", { name: "{ } code" }).click();
  await expect(drawerCode(page)).toContainText("synth:music?mood=upbeat");
  await page.getByRole("button", { name: "{ } code" }).click();
  await shot(page, "01-music-composed");

  // 2. A whoosh at the playhead, then Auto-SFX on every scene change.
  await seek(page, 1.2);
  await panel.getByRole("button", { name: "Add whoosh at playhead" }).click();
  await expect(page.locator('audio[data-clip^="sfx-whoosh"]').first()).toHaveAttribute("src", /^blob:/, { timeout: 30_000 });
  await panel.getByRole("button", { name: "Auto sound effects" }).click();
  await expect(panel.getByRole("status")).toContainText(/Added \d+ sound effects?/);
  const sfxCount = await page.locator('audio[data-clip^="sfx-"]').count();
  expect(sfxCount).toBeGreaterThan(1);
  await shot(page, "02-sfx");

  // 3. Exact beats from the generated grid → markers; cut to the beat, voice enhance, meters.
  await page.getByRole("button", { name: "Detect beats" }).click();
  await expect(page.getByText(/Found \d+ beats \(~\d+ BPM/).first()).toBeVisible({ timeout: 30_000 });
  await panel.getByRole("button", { name: "Cut to the beat" }).click();
  await expect(panel.getByRole("status")).toContainText(/lands on the beat/);
  await panel.getByRole("button", { name: "Enhance voice" }).click();
  await expect(panel.getByRole("button", { name: "Enhance voice: on" })).toHaveAttribute("aria-pressed", "true");
  await seek(page, 3);
  const mix = panel.getByRole("meter", { name: "Mix level" });
  await expect(mix).toBeVisible();
  await expect
    .poll(async () => Number(await mix.getAttribute("aria-valuenow")), { timeout: 30_000 })
    .toBeGreaterThan(-40);
  await shot(page, "03-mix-meters");

  // 4. Export a real .mp4 — with an audio stream.
  await page.getByRole("button", { name: /^Export/ }).first().click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 180_000 }),
    page.getByRole("button", { name: /Export \.mp4/ }).click(),
  ]);
  const out = resolve(DIR, "sound.mp4");
  await download.saveAs(out);
  expect(statSync(out).size).toBeGreaterThan(50_000);
  const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;
  const probe = spawnSync(ffmpeg, ["-hide_banner", "-i", out], { encoding: "utf8" });
  expect(probe.stderr).toMatch(/Audio: aac/);
});

test("sound: the Director composes music + sound effects from a prompt", async ({ page }) => {
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  const rail = page.getByRole("button", { name: "Open the chat panel" });
  if (await rail.isVisible()) await rail.click();
  await page.getByPlaceholder(/Describe a video/).fill("make a text video with chill lo-fi music and sound effects: Slow down. Breathe. You've got this.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Composed a chill lo-fi bed/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('audio[data-clip^="music-"]')).toHaveAttribute("src", /^blob:/, { timeout: 60_000 });
  await expect(page.locator('audio[data-clip^="sfx-"]').first()).toHaveAttribute("src", /^blob:/, { timeout: 30_000 });
  await shot(page, "04-director-sound");
});
