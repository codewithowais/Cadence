import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR } from "./fixtures";

/**
 * A guided page tour: visit and full-page-screenshot each surface of the app so
 * a reviewer can see the whole thing without running it. Sign-in goes through the
 * REAL form (email + name → /dashboard); the dev-auth fallback secret makes this
 * work with no .env and no database (the dashboard then shows its graceful
 * "connect a database" state, which is itself worth capturing).
 *
 * Shots land in test-artifacts/tour/ (gitignored). The whole run is also recorded
 * to a .webm by the shared config (use.video = "on").
 */

const TOUR_DIR = resolve(ARTIFACT_DIR, "tour");

const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(TOUR_DIR, `${name}.png`), fullPage: true });

test.beforeAll(() => {
  mkdirSync(TOUR_DIR, { recursive: true });
});

test("page tour: landing → login → dashboard → settings → editor", async ({ page }) => {
  // ---- landing / ----
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /Describe the edit/i })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await shot(page, "01-landing");

  // ---- /login ----
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await shot(page, "02-login");

  // ---- sign in through the real form → lands on /dashboard ----
  await page.getByLabel("Email").fill("qa@cadence.test");
  await page.getByLabel(/Name/i).fill("Cadence QA");
  await shot(page, "03-login-filled");
  await page.getByRole("button", { name: /Continue/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 30_000 });

  // ---- /dashboard ----
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await shot(page, "04-dashboard");

  // ---- /settings ----
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await shot(page, "05-settings");

  // ---- /editor (scratch) ----
  // Empty scratch editor: no media yet, so the composer is disabled and shows the
  // "Add a video first" placeholder alongside the empty-state prompt.
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  await expect(page.getByPlaceholder("Add a video first")).toBeVisible();
  await shot(page, "06-editor");
});
