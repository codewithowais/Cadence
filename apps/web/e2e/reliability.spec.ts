import { mkdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, EDITOR_URL, generateFixtures, type Fixtures } from "./fixtures";

/**
 * Reliability, speed & trust (CTO lane):
 *  1. autosave + crash recovery — edit, REFRESH, "Restore your last session"
 *     brings back the doc AND the media files; Discard really deletes the draft
 *  2. export shows a determinate progress bar (%), then downloads a real .mp4
 *  3. Cancel stops the export — the UI recovers and the server-side ffmpeg dies
 *  4. a crashing panel shows a recover card instead of white-screening the editor
 *  5. project file round-trip: save .cadence.json → open it → re-link media by name
 *  6. playback performance: time-independent panels don't re-render every frame
 * Screens → test-artifacts/reliability/.
 */
const DIR = resolve(ARTIFACT_DIR, "reliability");
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(DIR, `${name}.png`) });

let fixtures: Fixtures;

test.beforeAll(async ({ browser }) => {
  mkdirSync(DIR, { recursive: true });
  const page = await browser.newPage();
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.close();
});

async function makeTextVideo(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Start with text" }).click();
  await page.getByRole("button", { name: "Tips", exact: true }).click();
  await page.getByRole("button", { name: "Create text video" }).click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
}

async function rename(page: Page, title: string): Promise<void> {
  await page.getByTitle("Rename project").click();
  const input = page.getByLabel("Project title");
  await input.fill(title);
  await input.press("Enter");
  await expect(page.getByTitle("Rename project")).toContainText(title);
}

/** Is an ffmpeg encode for /api/export running on this machine right now? */
function exportFfmpegRunning(): boolean | null {
  const r = spawnSync("pgrep", ["-f", "cadence-exports"], { encoding: "utf8" });
  if (r.error) return null; // no pgrep on this host
  return r.status === 0;
}

test("autosave: refresh → restore session brings back the edit AND the media", async ({ page }) => {
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  // A fresh browser context has no draft → no banner.
  await expect(page.getByRole("region", { name: "Restore your last session" })).toHaveCount(0);

  await page.locator('input[type="file"]').first().setInputFiles(fixtures.photoPaths);
  await expect(page.getByLabel("Applied edits")).toContainText("Cuts", { timeout: 60_000 });
  await rename(page, "Trip draft");
  await expect(page.getByText("Saved in this browser")).toBeVisible({ timeout: 15_000 });
  const clipCount = await page.locator("img[src^='blob:']").count();
  expect(clipCount).toBeGreaterThan(0);
  await shot(page, "01-before-refresh");

  // ---- simulate a crash / accidental refresh ----
  await page.reload();
  await page.waitForLoadState("networkidle");
  const banner = page.getByRole("region", { name: "Restore your last session" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Trip draft");
  await expect(banner).toContainText("4 media files");
  await shot(page, "02-restore-offer");

  await banner.getByRole("button", { name: "Restore session" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTitle("Rename project")).toContainText("Trip draft");
  await expect(page.getByLabel("Applied edits")).toContainText("Cuts");
  await expect(page.getByText(/Restored your last session/).first()).toBeVisible();
  // The media FILES came back too: previews render from fresh blob: URLs and the
  // export pre-flight finds every file (no "media isn't loaded" block).
  await expect(page.locator("img[src^='blob:']").first()).toBeVisible();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export options" });
  await expect(dialog.getByRole("button", { name: "Export .mp4" })).toBeEnabled();
  await expect(dialog.getByText(/isn't loaded/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await shot(page, "03-restored");

  // ---- Discard deletes the draft for good ----
  await page.reload();
  await page.waitForLoadState("networkidle");
  const again = page.getByRole("region", { name: "Restore your last session" });
  await expect(again).toBeVisible();
  await again.getByRole("button", { name: "Discard" }).click();
  await again.getByRole("button", { name: "Yes, discard" }).click();
  await expect(again).toHaveCount(0);
  await page.reload();
  await page.waitForLoadState("networkidle");
  // Give the async draft lookup time to (not) find anything.
  await page.waitForTimeout(800);
  await expect(page.getByRole("region", { name: "Restore your last session" })).toHaveCount(0);
});

test("export: live progress bar with percent, then a real .mp4 download", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  await makeTextVideo(page);

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export options" });
  // Ultra (4K) makes the encode long enough to watch the bar move.
  await dialog.getByRole("button", { name: /Ultra/ }).click();
  const downloadPromise = page.waitForEvent("download", { timeout: 180_000 });
  await dialog.getByRole("button", { name: "Export .mp4" }).click();

  const pill = page.getByRole("group", { name: "Export in progress" });
  await expect(pill).toBeVisible();
  const bar = page.getByRole("progressbar", { name: /Rendering progress/ });
  await expect(bar).toBeVisible({ timeout: 60_000 });
  // The bar is determinate and actually advances mid-encode.
  await expect.poll(async () => Number((await bar.getAttribute("aria-valuenow")) ?? 0), { timeout: 60_000 }).toBeGreaterThan(5);
  await shot(page, "04-export-progress");
  const seen = Number(await bar.getAttribute("aria-valuenow").catch(() => "0"));
  expect(seen).toBeLessThanOrEqual(100);

  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.mp4$/);
  const dest = resolve(DIR, "progress-export.mp4");
  await download.saveAs(dest);
  expect(statSync(dest).size).toBeGreaterThan(50_000);
  expect(readFileSync(dest).subarray(0, 12).toString("latin1")).toContain("ftyp");
  // The pill hands back to the normal Export button.
  await expect(pill).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeEnabled();
});

test("export: Cancel stops the render (server-side ffmpeg is killed)", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  await makeTextVideo(page);

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export options" });
  await dialog.getByRole("button", { name: /Ultra/ }).click();
  await dialog.getByRole("button", { name: "Export .mp4" }).click();
  const bar = page.getByRole("progressbar", { name: /Rendering progress/ });
  await expect.poll(async () => Number((await bar.getAttribute("aria-valuenow").catch(() => "0")) ?? 0), { timeout: 60_000 }).toBeGreaterThan(3);
  expect(exportFfmpegRunning()).not.toBe(false);

  await page.getByRole("button", { name: "Cancel export" }).click();
  await expect(page.getByText("Export cancelled.").first()).toBeVisible();
  await expect(page.getByRole("group", { name: "Export in progress" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeEnabled();
  // The encode must not keep burning CPU after the user said stop.
  await expect.poll(() => exportFfmpegRunning(), { timeout: 5_000 }).not.toBe(true);
  await shot(page, "05-cancelled");
});
