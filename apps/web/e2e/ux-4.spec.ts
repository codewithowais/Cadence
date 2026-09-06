import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures } from "./fixtures";

/** Artifacts: speed-ramp curve + Design-room LUT/adjustment controls. */
const DIR = resolve(ARTIFACT_DIR, "ux-4");
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

test("ux-4: speed-ramp curve + LUT/adjustment controls", async ({ page }) => {
  await page.goto("http://localhost:3000/editor");
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.videoPath);
  await expect(page.getByLabel("Applied edits")).toBeVisible({ timeout: 60_000 });

  // Select the clip and open the Speed section.
  await page.getByRole("button", { name: /video clip/i }).first().click();
  const speedToggle = page.getByRole("button", { name: /Speed/i }).first();
  await speedToggle.click();
  await shot(page, "01-speed-ramp");

  // Design room → Color grade → LUT + Adjustment controls.
  await page.getByRole("button", { name: "Design", exact: true }).click();
  const design = page.getByRole("navigation", { name: "Design categories" });
  await design.getByRole("button", { name: /Color grade/i }).click();
  await expect(page.getByRole("button", { name: /Import LUT/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /Adjustment layer/i })).toBeVisible();
  await shot(page, "02-lut-adjustment");
});
