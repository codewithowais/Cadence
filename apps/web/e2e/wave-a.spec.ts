import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures } from "./fixtures";

/**
 * Wave A — manageable multi-track timeline. Loads a clip, adds a video/overlay
 * layer and an audio track, and captures the track-header gutter (rename / hide /
 * lock / mute / solo / reorder / remove + "+ Video/+ Audio"). Screens →
 * test-artifacts/wave-a/; the run also records a .webm.
 */

const DIR = resolve(ARTIFACT_DIR, "wave-a");
const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(DIR, `${name}.png`), fullPage: true });

let fixtures: Fixtures;

test.beforeAll(async ({ browser }) => {
  mkdirSync(DIR, { recursive: true });
  const page = await browser.newPage();
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.close();
});

test("wave A: multi-track headers — add layers, hide/lock/mute/solo", async ({ page }) => {
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.videoPath);
  await expect(page.getByText(/Loaded .*segments/i)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("region", { name: "Timeline" })).toBeVisible();
  await shot(page, "01-single-track");

  // Add a second visual (overlay) layer and an audio track.
  await page.getByRole("button", { name: /Add a video or overlay track/i }).click();
  await page.getByRole("button", { name: /Add an audio track/i }).click();
  await shot(page, "02-three-tracks-with-headers");
});
