import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures, EDITOR_URL } from "./fixtures";

/**
 * Wave C — manual craft controls. A photo slideshow gives multiple cuts (so the
 * per-cut transition ◇ chips show) plus a clip to keyframe. Captures the
 * per-cut transition chips + the on-timeline keyframe editor. Screens →
 * test-artifacts/wave-c/; the run also records a .webm.
 */

const DIR = resolve(ARTIFACT_DIR, "wave-c");
const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(DIR, `${name}.png`), fullPage: true });

let fixtures: Fixtures;

test.beforeAll(async ({ browser }) => {
  mkdirSync(DIR, { recursive: true });
  const page = await browser.newPage();
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.close();
});

test("wave C: per-cut transition chips + keyframe editor", async ({ page }) => {
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.photoPaths);
  await expect(page.getByLabel("Applied edits")).toBeVisible({ timeout: 60_000 });

  // Per-cut transition chips appear on the slideshow's cuts.
  await expect(page.getByRole("button", { name: /transition on this cut/i }).first()).toBeVisible({
    timeout: 30_000,
  });

  // Select a clip and open the on-timeline keyframe editor.
  await page.getByRole("button", { name: /image clip/i }).first().click();
  await page.getByRole("button", { name: /Show keyframes/i }).click();
  await expect(page.getByText(/click a lane.*to add at the playhead/i)).toBeVisible({ timeout: 15_000 });
  await shot(page, "01-transitions-and-keyframes");
});
