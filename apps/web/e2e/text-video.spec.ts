import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, EDITOR_URL } from "./fixtures";

/**
 * Text video (Canva-style) — a whole video from words, NO upload:
 *  1. empty editor → "Start with text" → Create (example script) → text video
 *  2. the preview canvas really draws animated text (pixels change over time)
 *  3. scenes are editable (edit a line, add a scene), theme switch works
 *  4. Style / Animate / Background controls apply
 *  5. the Director makes one from a prompt with no media
 *  6. Export produces a real .mp4 (no media uploaded)
 * Screens → test-artifacts/text-video/.
 */

const DIR = resolve(ARTIFACT_DIR, "text-video");
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(DIR, `${name}.png`) });

/** Sum of the preview's over-layer canvas pixels (cheap fingerprint of what's drawn). */
async function canvasFingerprint(page: Page): Promise<number> {
  return page.evaluate(() => {
    const cvs = [...document.querySelectorAll<HTMLCanvasElement>("canvas[data-layer]")];
    let sum = 0;
    for (const cv of cvs) {
      const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 0; i < d.length; i += 97) sum += d[i]!;
    }
    return sum;
  });
}

async function seek(page: Page, t: number) {
  await page.evaluate((v) => {
    const r = document.querySelector<HTMLInputElement>('input[aria-label="Scrubber"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(r, String(v));
    r.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await page.waitForTimeout(250);
}

test.beforeAll(() => mkdirSync(DIR, { recursive: true }));

test("text video: create from words, edit scenes, style, animate, export", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");

  // 1. empty state → Text room → Create.
  await expect(page.getByText("Start with words or footage")).toBeVisible();
  await shot(page, "01-empty-state");
  await page.getByRole("button", { name: "Start with text" }).click();
  await page.getByRole("button", { name: "Tips", exact: true }).click();
  await page.getByRole("button", { name: "Create text video" }).click();

  // The Scenes list appears; play/export unlock without any media.
  await expect(page.getByLabel("Scene 1 text")).toHaveValue("3 tips for better sleep");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await shot(page, "02-scenes");

  // 2. The preview canvas animates: mid-intro ≠ settled.
  await seek(page, 0.3);
  const early = await canvasFingerprint(page);
  await seek(page, 1.6);
  const settled = await canvasFingerprint(page);
  expect(settled).not.toBe(early);
  await shot(page, "03-preview-settled");

  // 3. Edit a scene line in place, then add a scene.
  const line = page.getByLabel("Scene 2 text");
  await line.fill("No phones after 10pm");
  await line.blur();
  await expect(page.getByLabel("Scene 2 text")).toHaveValue("No phones after 10pm");
  const before = await page.getByLabel(/^Scene \d+ text$/).count();
  await page.getByRole("button", { name: "Add a scene after scene 1" }).click();
  await expect(page.getByLabel(/^Scene \d+ text$/)).toHaveCount(before + 1);

  // Switch theme — words survive.
  await page.getByRole("button", { name: "Neon", exact: true }).click();
  await expect(page.getByLabel("Scene 1 text")).toHaveValue("3 tips for better sleep");
  await seek(page, 1.6);
  await shot(page, "04-neon-theme");

  // 4. Style: a bundled font + gradient + effect; Animate: letter-by-letter scramble.
  await page.getByRole("button", { name: /^Style/ }).click();
  await page.getByRole("button", { name: /Bebas Neue/ }).click();
  await page.getByRole("button", { name: "Gradient text Sunset" }).click();
  await page.getByRole("button", { name: "Echo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Echo", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Neon", exact: true }).last()).toHaveAttribute("aria-pressed", "false");
  await shot(page, "05-style");
  await page.getByRole("button", { name: /^Animate/ }).click();
  await page.getByRole("button", { name: "Letter by letter" }).click();
  await page.getByRole("button", { name: "Scramble", exact: true }).click();
  await expect(page.getByRole("button", { name: "Scramble", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Background/ }).click();
  await page.getByRole("button", { name: "Aurora ✦" }).click();
  await seek(page, 2.2);
  await shot(page, "06-animated-aurora");

  // 6. Export a real .mp4 — no media was ever uploaded.
  await page.getByRole("button", { name: /^Export/ }).first().click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 180_000 }),
    page.getByRole("button", { name: /Export \.mp4/ }).click(),
  ]);
  const out = resolve(DIR, "text-video.mp4");
  await download.saveAs(out);
  expect(statSync(out).size).toBeGreaterThan(50_000);
});

test("text video: the Director makes one from a prompt with no media", async ({ page }) => {
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  const rail = page.getByRole("button", { name: "Open the chat panel" });
  if (await rail.isVisible()) await rail.click();
  await page.getByPlaceholder(/Describe a video/).fill("make a vertical elegant quote video: “Less is more.” — Mies van der Rohe");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Made a 1-scene elegant text video/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Scene 1 second line")).toHaveValue("— Mies van der Rohe");
  await seek(page, 2);
  await shot(page, "07-director-quote");
});

test("text video: a landing prompt chip (?prompt=) builds it on arrival", async ({ page }) => {
  await page.goto(`${EDITOR_URL}?prompt=${encodeURIComponent("Make a text video: Big news. We just launched. Try it free today.")}`);
  await expect(page.getByLabel("Scene 1 text")).toHaveValue("Big news.", { timeout: 30_000 });
  await expect(page).not.toHaveURL(/prompt=/);
  // Captions animation row + Design backgrounds gallery exist for mature text work.
  await page.getByRole("button", { name: /^Design/ }).first().click();
  await page.getByRole("button", { name: /Backgrounds/ }).first().click();
  await expect(page.getByRole("button", { name: "Aurora ✦" })).toBeVisible();
  await shot(page, "08-landing-prompt-design-bg");
});
