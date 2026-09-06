import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures } from "./fixtures";

/**
 * End-to-end tests that drive the REAL running Cadence app: a browser-generated
 * .webm video and .png photos are uploaded through the actual file input, real
 * Director requests are sent, and the live preview / edit-doc / applied-status
 * are asserted after each step. Every step is screenshotted to test-artifacts/.
 */

let fixtures: Fixtures;

const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(ARTIFACT_DIR, `${name}.png`), fullPage: true });

/** Locators reused across tests. */
const composer = (page: Page) => page.getByPlaceholder("Describe the edit…");
const editing = (page: Page) => page.getByText("Director is editing…");
const applied = (page: Page) => page.getByLabel("Applied edits");
const drawerCode = (page: Page) => page.locator("pre code");

/** Send a Director request through the composer and wait for the edit to land. */
async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
  // The busy indicator may flash by on a fast response; tolerate not catching it.
  await editing(page)
    .waitFor({ state: "visible", timeout: 4000 })
    .catch(() => {});
  await editing(page).waitFor({ state: "hidden", timeout: 90_000 });
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const page = await browser.newPage();
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.close();
});

test("video flow: upload → edits → rooms → mute → applied-status → export-graceful", async ({
  page,
}) => {
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");

  // ---- upload the generated video ----
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.videoPath);

  // Director confirms load + a transcript segment count.
  const loaded = page.getByText(/Loaded .*spoken segments/i);
  await expect(loaded).toBeVisible({ timeout: 60_000 });
  const loadedText = (await loaded.textContent()) ?? "";
  const segMatch = loadedText.match(/(\d+)\s+spoken segments/i);
  expect(segMatch, `expected a segment count in "${loadedText}"`).not.toBeNull();
  expect(Number(segMatch![1])).toBeGreaterThanOrEqual(1);
  await shot(page, "01-video-loaded");

  // Applied strip shows at least the aspect once media is present.
  await expect(applied(page)).toBeVisible();

  // Open the code drawer so we can read the live edit-doc after each edit.
  await page.getByRole("button", { name: "{ } code" }).click();
  await expect(drawerCode(page)).toBeVisible();

  // ---- 1) highlight ----
  await send(page, "cut a 15-second highlight");
  // Clip is only ~2.5s, but the tool must still run and leave a valid video clip.
  await expect(drawerCode(page)).toContainText('"kind": "video"');
  await shot(page, "02-highlight");

  // ---- 2) vertical + captions ----
  await send(page, "make it vertical with captions");
  await expect(applied(page)).toContainText("9:16");
  await expect(applied(page)).toContainText("Captions");
  await expect(drawerCode(page)).toContainText('"captions"');
  await shot(page, "03-vertical-captions");

  // ---- 3) cinematic look ----
  await send(page, "give it a cinematic look");
  await expect(applied(page)).toContainText("Cinematic");
  await shot(page, "04-cinematic");

  // ---- 4) fade in and out ----
  await send(page, "add a fade in and out");
  await expect(drawerCode(page)).toContainText('"fades"');
  await shot(page, "05-fades");

  // ---- 5) punch-in at 1s ----
  await send(page, "punch in at 1s");
  await expect(drawerCode(page)).toContainText('"emphasis"');
  await shot(page, "06-punch-in");

  // ---- 6) make it 4K ----
  await send(page, "make it 4K");
  await expect(applied(page)).toContainText("4K");
  await expect(drawerCode(page)).toContainText('"ultra"');
  // The doc is vertical (9:16) here, so ultra 4K must be exactly 2160×3840 —
  // the upscale is anchored to the LONG edge (3840), not the width. (Regression
  // guard for the vertical-overshoot bug that anchored scale to width.)
  const qText = (await applied(page).textContent()) ?? "";
  const qDims = qText.match(/4K\s+(\d+)×(\d+)/);
  expect(qDims, `expected a 4K target size in "${qText}"`).not.toBeNull();
  const [qw, qh] = [Number(qDims![1]), Number(qDims![2])];
  expect(Math.max(qw, qh)).toBe(3840); // long edge is exactly 4K, no overshoot
  expect(Math.min(qw, qh)).toBe(2160); // short edge is 2160 → standard vertical 4K
  await shot(page, "07-4k");

  // ---- applied-status: full strip assertions (task's explicit checks) ----
  await expect(applied(page)).toContainText("9:16"); // aspect
  await expect(applied(page)).toContainText("Cinematic"); // a look
  await expect(applied(page)).toContainText("4K"); // quality (4K-class upscale)
  await expect(applied(page)).toContainText("Captions"); // captions on

  // Close the drawer to de-clutter the rooms assertions.
  await page.getByRole("button", { name: "Close code" }).click();

  // ---- rooms rail: each room opens its own panel ----
  const rooms = page.getByRole("navigation", { name: "Rooms" });
  await rooms.getByRole("button", { name: "Media" }).click();
  await expect(page.getByRole("button", { name: "+ Add media" })).toBeVisible();

  await rooms.getByRole("button", { name: "Color" }).click();
  await expect(page.getByRole("button", { name: "Cinematic" })).toBeVisible();

  await rooms.getByRole("button", { name: "VFX" }).click();
  await expect(page.getByRole("button", { name: "+ B-roll" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Kinetic title" })).toBeVisible();

  await rooms.getByRole("button", { name: "Deliver" }).click();
  await expect(page.getByRole("button", { name: "Ultra · 4K" })).toBeVisible();
  await shot(page, "08-rooms");

  // ---- Audio room: toggle mute → the preview <video>.muted flips ----
  await rooms.getByRole("button", { name: "Audio" }).click();
  const video = page.locator("video").first();
  await expect(video).toBeVisible();
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
  await page.getByRole("button", { name: /Preview sound on/i }).click();
  await expect
    .poll(async () => video.evaluate((v: HTMLVideoElement) => v.muted))
    .toBe(true);
  await expect(page.getByRole("button", { name: /Preview muted/i })).toBeVisible();
  await shot(page, "09-muted");

  // ---- export: ffmpeg absent → graceful message + JSON edit-doc download ----
  // The top-bar "Export" button opens the ExportMenu popover; the actual export
  // is the "Export .mp4" button inside it.
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const exportDialog = page.getByRole("dialog", { name: "Export options" });
  await expect(exportDialog).toBeVisible();
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await exportDialog.getByRole("button", { name: "Export .mp4" }).click();
  // The graceful message names both the missing ffmpeg AND the JSON fallback.
  const ffmpegMsg = page.getByText(/ffmpeg not found/i);
  await expect(ffmpegMsg).toBeVisible({ timeout: 60_000 });
  await expect(ffmpegMsg).toContainText(/edit-doc \(JSON\)/i);
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.editdoc\.json$/);
  await shot(page, "10-export-graceful");
});

test("photo flow: upload photos → slideshow → vertical + warm look", async ({ page }) => {
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");

  // Upload all 4 generated photos at once → auto slideshow.
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.photoPaths);

  // A slideshow is built (image clips) — the Director reports it and the applied
  // strip shows 4 cuts.
  await expect(applied(page)).toBeVisible({ timeout: 60_000 });
  await expect(applied(page)).toContainText("Cuts");
  await expect(applied(page)).toContainText("4");
  await shot(page, "11-slideshow");

  await send(page, "make it vertical");
  await expect(applied(page)).toContainText("9:16");
  await shot(page, "12-photos-vertical");

  await send(page, "warm look");
  await expect(applied(page)).toContainText("Warm");
  await shot(page, "13-photos-warm");
});
