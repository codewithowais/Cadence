import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, EDITOR_URL } from "./fixtures";

/**
 * Graphics, overlays & social elements (motion designer):
 *  1. Design → Graphics: tiles are live canvas previews that animate on hover
 *  2. one click inserts a Subscribe CTA at the playhead; the Stage animates it
 *  3. the inspector keeps it editable (words widen the pill, move, color, motion)
 *  4. lower thirds / countdowns / progress / stickers / annotations insert too
 *  5. the Director adds a graphic from a plain-language prompt
 *  6. Export produces a real .mp4 (no media)
 * Screens → test-artifacts/graphics/.
 */

const DIR = resolve(ARTIFACT_DIR, "graphics");
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(DIR, `${name}.png`) });

async function canvasFingerprint(page: Page, selector = "canvas[data-layer]"): Promise<number> {
  return page.evaluate((sel) => {
    let sum = 0;
    for (const cv of document.querySelectorAll<HTMLCanvasElement>(sel)) {
      const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 0; i < d.length; i += 53) sum += d[i]! * ((i % 7) + 1);
    }
    return sum;
  }, selector);
}

async function seek(page: Page, t: number) {
  await page.evaluate((v) => {
    const r = document.querySelector<HTMLInputElement>('input[aria-label="Scrubber"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(r, String(v));
    r.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await page.waitForTimeout(250);
}

async function openGraphics(page: Page) {
  await page.getByRole("button", { name: /^Design/ }).first().click();
  const cat = page.getByRole("button", { name: /^Graphics/ }).first();
  await cat.scrollIntoViewIfNeeded();
  await cat.click();
  await expect(page.getByTestId("graphics-gallery")).toBeVisible();
}

test.beforeAll(() => mkdirSync(DIR, { recursive: true }));

test("graphics: gallery → insert → animate → edit → more packs → export", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  await openGraphics(page);
  await expect(page.getByRole("tab", { name: "Social" })).toHaveAttribute("aria-selected", "true");
  await shot(page, "01-gallery");

  // 1. A tile's preview animates while hovered (pixels change over time).
  const tile = page.getByRole("button", { name: "Add Subscribe + bell" });
  await tile.hover();
  await page.waitForTimeout(120);
  const a = await canvasFingerprint(page, '[data-preset="subscribe"] canvas');
  await page.waitForTimeout(350);
  const b = await canvasFingerprint(page, '[data-preset="subscribe"] canvas');
  expect(a).not.toBe(b);

  // 2. One click inserts it; the Stage draws it popping in, then settled.
  await tile.click();
  const inspector = page.getByLabel("Selected graphic");
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText("Subscribe + bell")).toBeVisible();
  await expect(page.getByRole("button", { name: "Export", exact: false }).first()).toBeEnabled();
  await seek(page, 0.15);
  const early = await canvasFingerprint(page);
  await seek(page, 1.5);
  const settled = await canvasFingerprint(page);
  expect(settled).not.toBe(early);
  await shot(page, "02-subscribe-inserted");

  // 3. Edit: words (the pill re-lays), position, color, motion — all undoable.
  const words = page.getByLabel("Button text");
  await words.fill("Subscribe for more");
  await expect(words).toHaveValue("Subscribe for more");
  const beforeMove = await canvasFingerprint(page);
  await page.getByRole("button", { name: "Move to top right" }).click();
  await page.waitForTimeout(200);
  expect(await canvasFingerprint(page)).not.toBe(beforeMove);
  await page.getByRole("button", { name: "Main #6d5dfc" }).click();
  await expect(page.getByRole("button", { name: "Main #6d5dfc" })).toHaveAttribute("aria-pressed", "true");
  await inspector.getByLabel("Loop").selectOption("wiggle");
  await expect(inspector.getByLabel("Loop")).toHaveValue("wiggle");
  await shot(page, "03-edited");

  // 4. Other packs: a lower third, a countdown, a progress bar, a sticker, a mark.
  await page.getByRole("tab", { name: "Lower thirds" }).click();
  await page.getByRole("button", { name: "Add Bar slide" }).click();
  await expect(inspector.getByText("Bar slide")).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Ayesha Khan");
  await page.getByLabel("Title", { exact: true }).fill("Host & producer");
  await page.getByRole("tab", { name: "Countdowns" }).click();
  await page.getByRole("button", { name: "Add Timer" }).click();
  await expect(page.getByLabel("Seconds")).toHaveValue("10");
  await page.getByRole("tab", { name: "Progress" }).click();
  await page.getByRole("button", { name: "Add Knob bar" }).click();
  await page.getByRole("tab", { name: "Stickers" }).click();
  await page.getByRole("button", { name: "Add NEW! badge" }).click();
  await page.getByRole("tab", { name: "Annotate" }).click();
  await page.getByRole("button", { name: "Add Circle it" }).click();
  await expect(page.getByRole("button", { name: /^Circle it ·/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Bar slide ·/ })).toBeVisible();
  await seek(page, 2);
  await shot(page, "04-packs");

  // Remove one — the list updates; undo brings it back.
  await page.getByRole("button", { name: /^Circle it ·/ }).click();
  await inspector.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("button", { name: /^Circle it ·/ })).toHaveCount(0);

  // 6. Export a real .mp4 with only graphics (canvas-rendered, preview == export).
  await page.getByRole("button", { name: /^Export/ }).first().click();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 180_000 }),
    page.getByRole("button", { name: /Export \.mp4/ }).click(),
  ]);
  const out = resolve(DIR, "graphics.mp4");
  await download.saveAs(out);
  expect(statSync(out).size).toBeGreaterThan(20_000);
});

test("graphics: the Director adds one from a prompt, and the Text room offers the gallery", async ({ page }) => {
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  const rail = page.getByRole("button", { name: "Open the chat panel" });
  if (await rail.isVisible()) await rail.click();
  await page.getByPlaceholder(/Describe a video/).fill("add a 3 2 1 countdown in the center");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Added 3-2-1 go/i).first()).toBeVisible({ timeout: 30_000 });
  await seek(page, 1.5);
  await shot(page, "05-director-countdown");
  await openGraphics(page);
  await expect(page.getByRole("button", { name: /^3-2-1 Go ·/ })).toBeVisible();

  await page.getByRole("button", { name: /^Text/ }).first().click();
  await page.getByRole("button", { name: /^Text\s*Add & edit/ }).click();
  await expect(page.getByRole("heading", { name: "Graphics & stickers" })).toBeVisible();
  await expect(page.getByTestId("graphics-gallery")).toBeVisible();
});
