import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures } from "./fixtures";

/** UX-2 artifact: the unified Design room's thumbnail look gallery. */
const DIR = resolve(ARTIFACT_DIR, "ux-2");
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

test("ux-2: Design room look gallery", async ({ page }) => {
  await page.goto("http://localhost:3000/editor");
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.videoPath);
  await expect(page.getByLabel("Applied edits")).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "Design", exact: true }).click();
  const design = page.getByRole("navigation", { name: "Design categories" });
  await design.getByRole("button", { name: "Looks" }).click();
  await expect(page.getByRole("button", { name: "Cinematic", exact: true })).toBeVisible({ timeout: 15_000 });
  await shot(page, "01-design-looks");
});
