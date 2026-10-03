import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, EDITOR_URL, generateFixtures, type Fixtures } from "./fixtures";

/**
 * Render/engine debt (Cycle J) — the UI surfaces, on REAL in-browser media:
 *  1. Edit room: selecting a video clip shows the speed-ramp preset strip; Montage
 *     writes a multi-point speedRamp into the edit-doc.
 *  2. Design → Color grade: the free built-in LUT looks apply (`bundled:<key>`), the
 *     preview media carries the LUT's SVG filter, and the LUT can be cleared.
 *  3. Text room: a scene can be given its own theme (recorded in textVideo.sceneThemes).
 * Every assertion reads the edit-doc from the code drawer (edits-as-code).
 */

let fixtures: Fixtures;
const DIR = resolve(ARTIFACT_DIR, "render-debt");
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(DIR, `${name}.png`) });

interface DocShape {
  tracks: { id: string; clips: { id: string; kind: string; look?: { lut?: string }; speedRamp?: number[][] }[] }[];
  textVideo?: { theme: string; sceneThemes?: Record<string, string> };
}
const readDoc = async (page: Page): Promise<DocShape> =>
  JSON.parse((await page.locator("pre code").textContent()) ?? "{}") as DocShape;

test.beforeAll(async ({ browser }) => {
  mkdirSync(DIR, { recursive: true });
  const page = await browser.newPage();
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.close();
});

test("speed-ramp strip + bundled LUT looks", async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.videoPath);
  await expect(page.getByText(/Loaded .*spoken segments/i)).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "{ } code" }).click();
  await expect(page.locator("pre code")).toBeVisible();

  // 1. Select the clip → the speed-ramp strip appears in the Edit room.
  await expect(page.getByTestId("speed-ramp")).toHaveCount(0);
  const clip = page.getByRole("button", { name: /video clip,/i }).first();
  await clip.focus();
  await page.keyboard.press("Enter");
  const strip = page.getByTestId("speed-ramp");
  await expect(strip).toBeVisible();
  await shot(page, "01-speed-strip");
  await strip.getByRole("button", { name: /Montage/ }).click();
  await expect
    .poll(async () => (await readDoc(page)).tracks.flatMap((t) => t.clips).find((c) => c.kind === "video")?.speedRamp?.length ?? 0)
    .toBe(7);
  await expect(strip.getByRole("button", { name: /Montage/ })).toHaveAttribute("aria-pressed", "true");
  await strip.getByRole("button", { name: "Constant" }).click();
  await expect
    .poll(async () => (await readDoc(page)).tracks.flatMap((t) => t.clips).find((c) => c.kind === "video")?.speedRamp?.length ?? 0)
    .toBe(0);

  // 2. Design → Color grade → built-in LUT looks.
  await page.getByRole("button", { name: /^Design/ }).first().click();
  await page.getByRole("button", { name: /Color grade/ }).first().click();
  const looks = page.getByTestId("lut-looks");
  await expect(looks).toBeVisible();
  await looks.getByRole("button", { name: /Teal & orange/ }).click();
  await expect
    .poll(async () => (await readDoc(page)).tracks.flatMap((t) => t.clips).find((c) => c.kind === "video")?.look?.lut)
    .toBe("bundled:teal-orange");
  // The preview media carries the fitted SVG filter for that LUT.
  await expect
    .poll(() => page.evaluate(() => document.querySelector("video")?.style.filter ?? ""))
    .toMatch(/url\(["']?#cadence-lut-/);
  await expect(page.locator('filter[id^="cadence-lut-"]')).toHaveCount(1);
  await shot(page, "02-lut-applied");
  await looks.getByRole("button", { name: /Teal & orange/ }).click(); // toggles off
  await expect
    .poll(async () => (await readDoc(page)).tracks.flatMap((t) => t.clips).find((c) => c.kind === "video")?.look?.lut ?? "")
    .toBe("");
  expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
});

test("text video: a scene gets its own theme", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Start with text" }).click();
  await page.getByRole("button", { name: "Tips", exact: true }).click();
  await page.getByRole("button", { name: "Create text video" }).click();
  await expect(page.getByLabel("Scene 1 text")).toHaveValue("3 tips for better sleep");
  await page.getByRole("button", { name: "{ } code" }).click();
  await expect(page.locator("pre code")).toBeVisible();

  await page.getByLabel("Scene 2 theme").selectOption({ label: "Neon" });
  await expect.poll(async () => (await readDoc(page)).textVideo?.sceneThemes?.["1"]).toBe("neon");
  await expect(page.getByLabel("Scene 2 theme")).toHaveValue("neon");
  await expect(page.getByLabel("Scene 1 theme")).toHaveValue("");
  await shot(page, "03-scene-theme");
  // A whole-video theme switch resets the override.
  await page.getByRole("button", { name: "Elegant", exact: true }).click();
  await expect.poll(async () => (await readDoc(page)).textVideo?.sceneThemes?.["1"] ?? "").toBe("");
});
