import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures, EDITOR_URL } from "./fixtures";

/** UX-1 artifact: media thumbnail grid + focus-mode (both rails collapsed). */
const DIR = resolve(ARTIFACT_DIR, "ux-1");
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

test("ux-1: media grid + collapsed rails (focus mode)", async ({ page }) => {
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.photoPaths);
  await expect(page.getByLabel("Applied edits")).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "Media", exact: true }).click();
  await shot(page, "01-media-grid");

  // Focus mode: collapse both rails.
  await page.keyboard.press("Backslash");
  await page.waitForTimeout(250);
  await shot(page, "02-focus-mode");
});
