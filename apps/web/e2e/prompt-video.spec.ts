import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, EDITOR_URL, generateFixtures, type Fixtures } from "./fixtures";

/**
 * Prompt-based video making — ONE sentence → storyboard review → a complete, editable video:
 *  1. landing hero box → studio opens pre-filled → "Plan my video" → storyboard cards
 *  2. edit copy, regenerate one scene, reorder → "Create video" → Text room with the scenes,
 *     real music + graphics on the timeline, one-step Undo
 *  3. refinement chips (punchier) work afterwards
 *  4. export: a real .mp4 (or, without ffmpeg, the graceful message)
 *  5. attached photos appear behind the words
 *  6. the "didn't understand" fallback offers the studio; the composer routes a sentence too
 * Screens → test-artifacts/prompt-video/.
 */

const DIR = resolve(ARTIFACT_DIR, "prompt-video");
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(DIR, `${name}.png`) });

let fixtures: Fixtures;

test.beforeAll(() => mkdirSync(DIR, { recursive: true }));

test("hero sentence → storyboard review → edit → create → refine → export", async ({ page }) => {
  test.setTimeout(240_000);

  // 1. Landing hero: a plain GET form hands the sentence to the editor.
  await page.goto("/");
  await page.getByTestId("hero-describe").fill("30s Instagram promo for my coffee shop, warm vibe, upbeat music");
  await shot(page, "01-landing-hero");
  await page.getByTestId("hero-describe-go").click();
  await expect(page).toHaveURL(/\/editor/);
  await expect(page).not.toHaveURL(/describe=/);

  const dialog = page.getByRole("dialog", { name: "Describe your video" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("studio-prompt")).toHaveValue(/coffee shop/);
  await shot(page, "02-studio-compose");

  // The chips are real controls.
  await dialog.getByRole("group", { name: "Length" }).getByRole("button", { name: "30s" }).click();
  await expect(dialog.getByRole("group", { name: "Length" }).getByRole("button", { name: "30s" })).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("studio-plan").click();

  // 2. Storyboard review: scene cards, notes, timing.
  const cards = page.getByTestId("sb-scene");
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThanOrEqual(4);
  await expect(page.getByTestId("studio-total")).toContainText(/\d+s · \d+ scenes/);
  const firstHeading = await page.getByLabel("Scene 1 heading").inputValue();
  expect(firstHeading.length).toBeGreaterThan(3);
  expect(firstHeading).not.toMatch(/lorem|undefined/i);
  await shot(page, "03-storyboard-review");

  // Edit a scene's words, regenerate scene 2, move scene 3 up.
  await page.getByLabel("Scene 1 heading").fill("Coffee that feels like home");
  const second = await page.getByLabel("Scene 2 heading").inputValue();
  await page.getByRole("button", { name: "Regenerate scene 2" }).click();
  await expect(page.getByLabel("Scene 2 heading")).not.toHaveValue(second);
  const third = await page.getByLabel("Scene 3 heading").inputValue();
  await page.getByRole("button", { name: "Move scene 3 up" }).click();
  await expect(page.getByLabel("Scene 2 heading")).toHaveValue(third);
  // Style controls: a different palette keeps the words.
  await page.getByRole("button", { name: "ocean palette" }).click();
  await expect(page.getByLabel("Scene 1 heading")).toHaveValue("Coffee that feels like home");

  // 3. Create → the editor opens on the Text room's scenes with the user's edit.
  await page.getByTestId("studio-create").click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(page.getByLabel("Scene 1 text")).toHaveValue("Coffee that feels like home", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await expect(page.getByText(/Made your promo/).first()).toBeVisible();
  await shot(page, "04-created");

  // The timeline got real music + a CTA graphic (Instagram → link in bio).
  await expect(page.getByText("Music", { exact: true }).first()).toBeVisible();

  // 4. Refine afterwards from the Text room's Describe tab (chips send ordinary phrases to the Director).
  await page.getByRole("button", { name: /^Describe/ }).click();
  await expect(page.getByText(/Made from/)).toBeVisible();
  await page.getByRole("group", { name: "Refine the video" }).getByRole("button", { name: "Make it punchier" }).click();
  await expect(page.getByText(/Made it punchier/).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "05-punchier");

  // Undo steps back one refinement (the user's edit is still the source until then).
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Undo/ }).first().click();

  // 5. Export: a real .mp4 (ffmpeg is bundled) — music, sfx, graphics and every scene included.
  await page.getByRole("button", { name: /^Export/ }).first().click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 180_000 }),
    page.getByRole("button", { name: /Export \.mp4/ }).click(),
  ]);
  const out = resolve(DIR, "prompt-video.mp4");
  await download.saveAs(out);
  expect(statSync(out).size).toBeGreaterThan(50_000);
});

test("photos: attach in the studio, they appear behind the words", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");

  await page.getByTestId("empty-describe").click();
  await page.getByTestId("studio-prompt").fill("travel recap of Istanbul using my photos");
  await page.getByTestId("studio-file").setInputFiles(fixtures.photoPaths);
  await expect(page.getByRole("list", { name: "Media to use" }).getByRole("button")).toHaveCount(fixtures.photoPaths.length, { timeout: 30_000 });
  await shot(page, "06-studio-photos");
  await page.getByTestId("studio-plan").click();

  // Every scene has a media pick (assigned from the photos); copy names the place.
  await expect(page.getByLabel("Scene 1 media")).not.toHaveValue("");
  await expect(page.getByTestId("sb-scene").first()).toBeVisible();
  const headings = await page.getByTestId("sb-heading").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join(" | "));
  expect(headings).toContain("Istanbul");
  await page.getByTestId("studio-create").click();
  await expect(page.getByLabel("Scene 1 text")).toHaveValue(/Istanbul/, { timeout: 30_000 });

  // The preview shows the photo layer (the Stage draws image clips as <img>).
  await expect(page.locator("img[src^='blob:']").first()).toBeAttached({ timeout: 15_000 });
  await shot(page, "07-created-with-photos");
});

test("fallbacks: the composer routes a sentence; unmatched input offers the studio", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  const rail = page.getByRole("button", { name: "Open the chat panel" });
  if (await rail.isVisible()) await rail.click();

  // A sentence typed in the composer builds the video directly (no studio).
  await page.getByPlaceholder(/Describe a video/).fill("birthday wish for Ayesha");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByLabel("Scene 1 text")).toHaveValue("Happy Birthday, Ayesha!", { timeout: 30_000 });
  await shot(page, "08-composer-birthday");

  // "I didn't understand" now points at the studio, pre-filled with what they typed.
  await page.getByLabel("Describe the edit").fill("flibbertigibbet the zorp");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/not sure how to do/).first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("unmatched-describe").click();
  await expect(page.getByTestId("studio-prompt")).toHaveValue("flibbertigibbet the zorp");
  await shot(page, "09-unmatched-studio");
});
