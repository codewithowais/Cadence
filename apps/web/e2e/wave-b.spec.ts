import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures } from "./fixtures";

/**
 * Wave B — the Walkthrough / Demo room. Loads screenshots (photos as "screens"),
 * opens the Demo room, and captures the build controls + annotate palette. Screens
 * → test-artifacts/wave-b/; the run also records a .webm.
 */

const DIR = resolve(ARTIFACT_DIR, "wave-b");
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

test("wave B: Walkthrough/Demo room from screenshots", async ({ page }) => {
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.photoPaths);
  await expect(page.getByLabel("Applied edits")).toBeVisible({ timeout: 60_000 });

  // Open the Demo room.
  await page.getByRole("button", { name: /Demo/i }).first().click();
  // The room shows the screens + a Build walkthrough action.
  await expect(page.getByRole("button", { name: /Build walkthrough/i })).toBeVisible({ timeout: 30_000 });
  await shot(page, "01-demo-room");
});
