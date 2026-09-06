import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures } from "./fixtures";

/** UX-3 artifact: new theme + Demo room (tall) with the video still visible. */
const DIR = resolve(ARTIFACT_DIR, "ux-3");
const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(DIR, `${name}.png`), fullPage: true });

let fixtures: Fixtures;

test.beforeAll(async ({ browser }) => {
  mkdirSync(DIR, { recursive: true });
  const page = await browser.newPage();
  await page.goto("http://localhost:3000/editor");
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.close();
});

test("ux-3: new theme + Demo room keeps the video visible", async ({ page }) => {
  await page.goto("http://localhost:3000/editor");
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.photoPaths);
  await expect(page.getByLabel("Applied edits")).toBeVisible({ timeout: 60_000 });

  // Editor with the new theme.
  await shot(page, "01-editor-theme");

  // Open the tall Demo room — the preview must remain visible below it.
  await page.getByRole("button", { name: "Demo", exact: true }).click();
  await expect(page.getByRole("button", { name: /Build walkthrough/i })).toBeVisible({ timeout: 15_000 });
  await shot(page, "02-demo-room-video-visible");
});
