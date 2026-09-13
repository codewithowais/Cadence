import { mkdirSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures } from "./fixtures";

/**
 * Proves the user-facing contract: clicking Export actually DOWNLOADS a real .mp4
 * to the user's disk. We drive the real UI (upload → Export → Export .mp4), capture
 * the browser download, save it to a local folder, and assert it is a non-empty
 * MP4 (ftyp box). Covers both the video flow and the photo-slideshow flow.
 */
const DL_DIR = resolve(ARTIFACT_DIR, "downloads");

let fixtures: Fixtures;

test.beforeAll(async ({ browser }) => {
  mkdirSync(DL_DIR, { recursive: true });
  const page = await browser.newPage();
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.close();
});

/** Click Export → Export .mp4, capture the download, save it, and validate bytes. */
async function exportAndValidate(page: Page, saveName: string): Promise<void> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export options" });
  await expect(dialog).toBeVisible();

  const downloadPromise = page.waitForEvent("download", { timeout: 180_000 });
  await dialog.getByRole("button", { name: "Export .mp4" }).click();
  const download = await downloadPromise;

  // Filename the browser would use in the user's Downloads folder.
  expect(download.suggestedFilename()).toMatch(/\.mp4$/);

  // Actually persist it to a local folder (what "download to the user's PC" means).
  const dest = resolve(DL_DIR, saveName);
  await download.saveAs(dest);

  // The saved file must be a real, non-trivial MP4.
  const size = statSync(dest).size;
  expect(size).toBeGreaterThan(1000);
  const head = readFileSync(dest).subarray(0, 12);
  // MP4 files carry an 'ftyp' box near the start.
  expect(head.toString("latin1")).toContain("ftyp");
}

test("photo slideshow exports and downloads a real .mp4 to disk", async ({ page }) => {
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");

  await page.locator('input[type="file"]').first().setInputFiles(fixtures.photoPaths);
  await expect(page.getByLabel("Applied edits")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel("Applied edits")).toContainText("Cuts");

  await exportAndValidate(page, "slideshow.mp4");
});

test("video project exports and downloads a real .mp4 to disk", async ({ page }) => {
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");

  await page.locator('input[type="file"]').first().setInputFiles(fixtures.videoPath);
  await expect(page.getByText(/Loaded .*spoken segments/i)).toBeVisible({ timeout: 60_000 });

  await exportAndValidate(page, "video.mp4");
});
