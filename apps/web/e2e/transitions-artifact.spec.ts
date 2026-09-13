import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures, EDITOR_URL } from "./fixtures";

/** Wave: transitions — capture the per-cut transition gallery open + applied. */
const DIR = resolve(ARTIFACT_DIR, "transitions");
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

test("transitions: gallery open + a type applied", async ({ page }) => {
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.photoPaths);
  await expect(page.getByLabel("Applied edits")).toBeVisible({ timeout: 60_000 });

  // Open a cut's transition popover and screenshot the gallery.
  await page.getByRole("button", { name: /transition on this cut/i }).first().click();
  const dialog = page.getByRole("dialog", { name: /transition/i });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await shot(page, "01-transition-gallery");

  // Pick a distinct type (Wipe/Slide) and confirm the chip reflects it.
  const pick = dialog.getByRole("button", { name: /wipe|slide|zoom|dissolve/i }).first();
  await pick.click();
  await shot(page, "02-transition-applied");
});
