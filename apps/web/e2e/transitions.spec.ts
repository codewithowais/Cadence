import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures } from "./fixtures";

/**
 * Transitions, end-to-end on the REAL app. The reported bug: "transitions are
 * still not working, I can't change the transition." Two root causes are covered:
 *
 *  1) The browser PREVIEW must honor the chosen transition TYPE (not crossfade
 *     everything). We add a `data-transition` / `data-transition-active` attribute
 *     to the Stage's visual layers (fed by the pure `transitionStyle` helper) and
 *     assert the preview reflects the type mid-transition — plus a computed style
 *     (clip-path for wipe, transform for slide).
 *  2) A clip with no interior cut (single-clip project, first/last clip) must
 *     still be able to CHANGE a transition — via a fade-in-from-black chip on the
 *     first clip and a fade-out-to-black chip at the end of the last clip.
 *
 * Screens → test-artifacts/transitions/; the run also records a .webm.
 */

const DIR = resolve(ARTIFACT_DIR, "transitions");
const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(DIR, `${name}.png`), fullPage: true });

let fixtures: Fixtures;

const drawerCode = (page: Page) => page.locator("pre code");
const applied = (page: Page) => page.getByLabel("Applied edits");

interface DocClip {
  id: string;
  kind: string;
  start: number;
  duration: number;
  transitionInSec?: number;
  transitionOutSec?: number;
  transitionType?: string;
}

/** Parse the live edit-doc out of the open code drawer. */
async function readDoc(page: Page): Promise<{ tracks: { clips: DocClip[] }[] }> {
  const text = (await drawerCode(page).textContent()) ?? "{}";
  return JSON.parse(text);
}

/** The main visual (video/image) clips in track order. */
function visualClips(doc: { tracks: { clips: DocClip[] }[] }): DocClip[] {
  return doc.tracks.flatMap((t) => t.clips).filter((c) => c.kind === "image" || c.kind === "video");
}

/** Seek the Stage transport to an exact time (drives React's onChange). */
async function seekTo(page: Page, t: number): Promise<void> {
  await page.evaluate((time) => {
    const el = document.querySelector('input[aria-label="Scrubber"]') as HTMLInputElement | null;
    if (!el) throw new Error("scrubber not found");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, String(time));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(DIR, { recursive: true });
  const page = await browser.newPage();
  // A page opened via browser.newPage() does NOT inherit the config baseURL, so
  // navigate with an absolute URL.
  await page.goto("http://localhost:3000/editor");
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.close();
});

// ---------------------------------------------------------------------------
// 1) Per-cut transitions on a photo slideshow: change the type + see it render.
// ---------------------------------------------------------------------------
test("per-cut: change the transition type and the preview honors it", async ({ page }) => {
  await page.goto("http://localhost:3000/editor");
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.photoPaths);
  await expect(applied(page)).toBeVisible({ timeout: 60_000 });

  // Open the code drawer so we can read the exact edit-doc.
  await page.getByRole("button", { name: "{ } code" }).click();
  await expect(drawerCode(page)).toBeVisible();

  // The interior cut chips appear on the slideshow's cuts.
  const cutChip = page.getByRole("button", { name: /transition on this cut/i }).first();
  await expect(cutChip).toBeVisible({ timeout: 30_000 });

  // Identify the clip this first interior chip targets (the 2nd visual clip).
  const target = visualClips(await readDoc(page))[1]!;
  expect(target, "a second visual clip exists to target").toBeTruthy();
  const targetId = target.id;
  const findTarget = async () => visualClips(await readDoc(page)).find((c) => c.id === targetId)!;

  // --- Pick "Wipe" ---
  await cutChip.click();
  const dialog = page.getByRole("dialog", { name: "Cut transition" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Wipe", exact: true }).click();

  // (a) The doc reflects the new type + an incoming ramp.
  await expect(drawerCode(page)).toContainText('"transitionType": "wipe"');
  await expect.poll(async () => (await findTarget()).transitionInSec ?? 0).toBeGreaterThan(0);

  // (b) The PREVIEW visibly reflects the type mid-transition.
  await page.keyboard.press("Escape"); // close the popover overlay
  let tc = await findTarget();
  await seekTo(page, tc.start + (tc.transitionInSec ?? 0.6) / 2);
  const wipeLayer = page.locator('img[data-transition="wipe"][data-transition-active="true"]');
  await expect(wipeLayer).toBeVisible();
  // Computed style: a wipe clips the layer (clip-path inset), never "none".
  const clipPath = await wipeLayer.first().evaluate((el) => getComputedStyle(el).clipPath);
  expect(clipPath, `wipe should clip the preview layer (got ${clipPath})`).not.toBe("none");
  await shot(page, "01-wipe");

  // (c) Change to another type ("Slide") — it updates.
  await cutChip.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Slide", exact: true }).click();
  await expect(drawerCode(page)).toContainText('"transitionType": "slide"');

  await page.keyboard.press("Escape");
  tc = await findTarget();
  await seekTo(page, tc.start + (tc.transitionInSec ?? 0.6) / 2);
  const slideLayer = page.locator('img[data-transition="slide"][data-transition-active="true"]');
  await expect(slideLayer).toBeVisible();
  // Computed style: a slide translates the layer (transform matrix, not identity).
  const transform = await slideLayer.first().evaluate((el) => getComputedStyle(el).transform);
  expect(transform, `slide should translate the preview layer (got ${transform})`).not.toBe("none");
  expect(transform).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
  await shot(page, "02-slide");

  // (d) "Hard cut" clears the transition back to a plain cut.
  await cutChip.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Hard cut" }).click();
  await expect.poll(async () => (await findTarget()).transitionInSec ?? 0).toBe(0);
  await shot(page, "03-hard-cut");
});

// ---------------------------------------------------------------------------
// 2) Single-clip project: fade in from black + fade out to black (no interior cut).
// ---------------------------------------------------------------------------
test("single clip: fade in from black + fade out to black", async ({ page }) => {
  await page.goto("http://localhost:3000/editor");
  await page.waitForLoadState("networkidle");
  // One photo = a single-clip project with NO interior cut.
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.photoPaths[0]!);
  await expect(applied(page)).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "{ } code" }).click();
  await expect(drawerCode(page)).toBeVisible();

  const soleId = visualClips(await readDoc(page))[0]!.id;
  const sole = async () => visualClips(await readDoc(page)).find((c) => c.id === soleId)!;

  // Both edge affordances are present even with no cut.
  const fadeInChip = page.getByRole("button", { name: /fade in from black/i });
  const fadeOutChip = page.getByRole("button", { name: /fade out to black/i });
  await expect(fadeInChip).toBeVisible({ timeout: 30_000 });
  await expect(fadeOutChip).toBeVisible();

  // --- Fade out to black ---
  await fadeOutChip.click();
  const outDialog = page.getByRole("dialog", { name: "Fade out to black" });
  await expect(outDialog).toBeVisible();
  await outDialog.getByRole("button", { name: "Add fade out" }).click();
  await expect.poll(async () => (await sole()).transitionOutSec ?? 0).toBeGreaterThan(0);

  // Preview: near the end the clip is inside its out-ramp and dimmed (fading).
  await page.keyboard.press("Escape");
  const s = await sole();
  await seekTo(page, s.start + s.duration - (s.transitionOutSec ?? 0.6) / 2);
  const outLayer = page.locator('img[data-transition-active="true"]').first();
  await expect(outLayer).toBeVisible();
  const opacity = await outLayer.evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(opacity, `fade-out should dim the preview (got ${opacity})`).toBeLessThan(1);
  await shot(page, "04-fade-out");

  // Clearing turns the fade-out off.
  await fadeOutChip.click();
  await expect(outDialog).toBeVisible();
  await outDialog.getByRole("button", { name: "No fade out" }).click();
  await expect.poll(async () => (await sole()).transitionOutSec ?? 0).toBe(0);

  // --- Fade in from black (the first clip's incoming ramp) ---
  await fadeInChip.click();
  const inDialog = page.getByRole("dialog", { name: "Cut transition" });
  await expect(inDialog).toBeVisible();
  await inDialog.getByRole("button", { name: "Crossfade", exact: true }).click();
  await expect.poll(async () => (await sole()).transitionInSec ?? 0).toBeGreaterThan(0);
  await shot(page, "05-fade-in");
});
