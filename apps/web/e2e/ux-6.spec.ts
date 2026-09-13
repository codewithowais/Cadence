import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures, EDITOR_URL } from "./fixtures";

/** UX-6 artifact: Audio-room "Clean audio" toggle. */
const DIR = resolve(ARTIFACT_DIR, "ux-6");
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

test("ux-6: clean-audio toggle in the Audio room", async ({ page }) => {
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.videoPath);
  await expect(page.getByLabel("Applied edits")).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "Audio", exact: true }).click();
  await expect(page.getByText(/Clean audio/i).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "01-clean-audio");
});
