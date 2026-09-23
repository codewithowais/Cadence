import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, EDITOR_URL, generateFixtures, type Fixtures } from "./fixtures";

/**
 * First-run ease & discoverability — the brand-new creator's first two minutes:
 *  1. ⌘K / Ctrl+K command palette: open, fuzzy search, run a prompt, a room, undo/redo.
 *  2. Getting-started checklist ticks itself off from REAL state (content → edit →
 *     preview → export) and next-step chips run follow-up edits.
 *  3. With footage: next-step chips, friendly "didn't understand" recovery, ↑ recalls
 *     recent prompts, and the "What can I say?" prompt library inserts a prompt.
 * Screens → test-artifacts/onboarding/.
 */

const DIR = resolve(ARTIFACT_DIR, "onboarding");
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(DIR, `${name}.png`) });

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const checklist = (page: Page) => page.getByRole("region", { name: "Getting started" });
const nextChips = (page: Page) => page.getByRole("group", { name: "Suggested next steps" });
const composer = (page: Page) => page.getByRole("textbox", { name: "Describe the edit" });

async function openEditor(page: Page) {
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  const rail = page.getByRole("button", { name: "Open the chat panel" });
  if (await rail.isVisible()) await rail.click();
}

let fixtures: Fixtures;

test.beforeAll(async ({ browser }) => {
  mkdirSync(DIR, { recursive: true });
  const page = await browser.newPage();
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.close();
});

test("command palette: ⌘K opens, fuzzy search runs prompts, rooms and undo/redo", async ({ page }) => {
  await openEditor(page);

  // Keyboard open (Ctrl+K / ⌘K), focus lands in the search box.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
  const search = palette(page).getByRole("combobox", { name: /Search actions/ });
  await expect(search).toBeFocused();
  // With nothing loaded, unavailable edits are hidden but text videos are offered.
  await expect(palette(page).getByRole("option", { name: /Quote text video/ })).toBeVisible();
  await shot(page, "01-palette-empty");

  // Fuzzy search (typo-ish) → Enter runs the Director through the normal path.
  await search.fill("neon promo");
  await expect(palette(page).getByRole("option").first()).toContainText("Neon promo text video");
  await shot(page, "02-palette-search");
  await search.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect(page.getByLabel("Scene 1 text")).toHaveValue(/Tonight only/, { timeout: 30_000 });

  // Escape closes; focus returns to where it was.
  await composer(page).focus();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
  await expect(composer(page)).toBeFocused();

  // TopBar button opens it too; a room command switches rooms.
  await page.getByRole("button", { name: "Search actions" }).click();
  await palette(page).getByRole("combobox").fill("design");
  await palette(page).getByRole("option", { name: /Go to Design/ }).click();
  await expect(page.getByRole("navigation", { name: "Design categories" })).toBeVisible();

  // Undo via the palette (↓/↑ navigation + Enter): the text video goes away…
  await page.keyboard.press("ControlOrMeta+k");
  await palette(page).getByRole("combobox").fill("undo");
  await expect(palette(page).getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Start with words or footage")).toBeVisible();
  // …and Redo brings it back.
  await page.keyboard.press("ControlOrMeta+k");
  await palette(page).getByRole("combobox").fill("redo");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Start with words or footage")).toBeHidden();

  // Free text that matches nothing is still runnable: "Ask the Director".
  await page.keyboard.press("ControlOrMeta+k");
  await palette(page).getByRole("combobox").fill("make it vertical");
  const options = palette(page).getByRole("option");
  await expect(options.first()).toContainText("Make it vertical (9:16)");
  await expect(options.last()).toContainText("Ask the Director");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Applied edits")).toContainText("9:16", { timeout: 30_000 });
  await shot(page, "03-palette-ran-vertical");
});

test("checklist ticks from real state; next-step chips run the next edit", async ({ page }) => {
  test.setTimeout(240_000);
  await openEditor(page);
  const list = checklist(page);
  await expect(list).toBeVisible();
  await expect(list).toContainText("0/4");
  await list.getByRole("button", { name: "Show getting started steps" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(4);
  await shot(page, "04-checklist-expanded");
  await list.getByRole("button", { name: "Collapse getting started steps" }).click();

  // Step 1 — content: a one-tap text starter makes a text video.
  await page.getByRole("button", { name: /Announcement — bold/ }).click();
  await expect(page.getByLabel("Scene 1 text")).toHaveValue("Big news.", { timeout: 30_000 });
  await expect(list).toContainText("1/4");

  // Next-step chips appear under the Director's reply; they skip what's applied.
  const chips = nextChips(page);
  await expect(chips).toBeVisible();
  await expect(chips.getByRole("button", { name: "Try the Neon theme" })).toBeVisible();
  await shot(page, "05-next-steps");

  // Step 2 — tap a chip → a real Director edit (restyle) → "first edit" ticks.
  await chips.getByRole("button", { name: "Try the Neon theme" }).click();
  await expect(list).toContainText("2/4", { timeout: 30_000 });
  // The chips moved on: the neon theme is no longer suggested.
  await expect(nextChips(page).getByRole("button", { name: "Try the Neon theme" })).toHaveCount(0);

  // Step 3 — preview via the checklist's own CTA.
  await list.getByRole("button", { name: "Play the preview" }).click();
  await expect(list).toContainText("3/4");

  // Step 4 — export: the CTA opens Deliver; starting the render ticks it.
  await list.getByRole("button", { name: "Open export options" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 180_000 }),
    page.getByRole("button", { name: /Export \.mp4/ }).first().click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.mp4$|\.json$/);
  await expect(list).toContainText("You're all set");
  await expect(list).toContainText("4/4");
  await shot(page, "06-checklist-complete");

  // Dismiss persists across reloads.
  await list.getByRole("button", { name: "Hide getting started" }).click();
  await expect(checklist(page)).toHaveCount(0);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(checklist(page)).toHaveCount(0);
});

test("with footage: chips, did-you-mean recovery, ↑ recent prompts, prompt library", async ({ page }) => {
  await openEditor(page);
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.videoPath);
  await expect(page.getByText(/Loaded .*spoken segments/i)).toBeVisible({ timeout: 60_000 });

  // Starter chips after the upload; tapping one runs it and it's not offered again.
  const chips = nextChips(page);
  await expect(chips.getByRole("button", { name: "Add captions" })).toBeVisible();
  await chips.getByRole("button", { name: "Add captions" }).click();
  await expect(page.getByLabel("Applied edits")).toContainText("Captions", { timeout: 30_000 });
  await expect(nextChips(page)).toBeVisible();
  await expect(nextChips(page).getByRole("button", { name: "Add captions" })).toHaveCount(0);
  await shot(page, "07-video-next-steps");

  // "Didn't understand" → closest real capabilities, one tap each.
  await composer(page).fill("make it shorter");
  await composer(page).press("Enter");
  const closest = page.getByRole("group", { name: "Closest things I can do" });
  await expect(closest).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/I'm not sure how to do/)).toBeVisible();
  await expect(closest.getByRole("button", { name: "Cut a 60-second highlight" })).toBeVisible();
  await shot(page, "08-did-you-mean");
  await closest.getByRole("button", { name: "Cut a 60-second highlight" }).click();
  await expect(nextChips(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("group", { name: "Closest things I can do" })).toHaveCount(0);

  // ↑ in an empty composer recalls the last typed prompt; ↓ returns to the draft.
  await composer(page).focus();
  await page.keyboard.press("ArrowUp");
  await expect(composer(page)).toHaveValue("make it shorter");
  await page.keyboard.press("ArrowDown");
  await expect(composer(page)).toHaveValue("");

  // "What can I say?" → search → pick → it lands in the composer, ready to tweak.
  await page.getByRole("button", { name: "What can I say?" }).click();
  const lib = page.getByRole("dialog", { name: "Prompt ideas" });
  await expect(lib).toBeVisible();
  await shot(page, "09-prompt-library");
  await lib.getByRole("textbox", { name: "Search prompt ideas" }).fill("slow");
  await lib.getByRole("button", { name: /^Slow motion/ }).click();
  await expect(lib).toBeHidden();
  await expect(composer(page)).toHaveValue("slow motion");
  await expect(composer(page)).toBeFocused();
  await composer(page).press("Enter");
  await expect(page.getByRole("log").getByText("slow motion", { exact: true })).toBeVisible();
  await expect(composer(page)).toBeEnabled({ timeout: 30_000 });
  await shot(page, "10-after-library-prompt");

  // The palette lists recent prompts too.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page).getByRole("option", { name: /slow motion/ }).first()).toBeVisible();
  await page.keyboard.press("Escape");
});
