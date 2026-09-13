import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures, EDITOR_URL } from "./fixtures";

/** UX-5 artifact: the Words room caption-style + position controls. */
const DIR = resolve(ARTIFACT_DIR, "ux-5");
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

test("ux-5: caption style + position controls", async ({ page }) => {
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.videoPath);
  await expect(page.getByText(/Loaded .*segments/i)).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: /Words/i }).click();
  await expect(page.getByText(/Caption style/i).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "01-caption-style");
});
