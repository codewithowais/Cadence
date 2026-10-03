import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, EDITOR_URL } from "./fixtures";

/**
 * Emoji (motion designer):
 *  1. Design → Emoji: a VIRTUALIZED grid (hundreds of cells mounted, not 3,000+), tabs, search
 *  2. click inserts a color-emoji sticker at the playhead — the Stage draws real sprite pixels
 *  3. skin tones swap the sprites; favorites + recents persist across a reload
 *  4. dragging an emoji (application/x-cadence-emoji) onto the Stage lands it where it drops
 *  5. reaction packs insert a staggered group that stays editable
 * Screens → test-artifacts/emoji/.
 */

const DIR = resolve(ARTIFACT_DIR, "emoji");
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(DIR, `${name}.png`) });

/** Count flame-colored (Twemoji fire orange) pixels across the Stage canvases. */
async function flamePixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    let n = 0;
    for (const cv of document.querySelectorAll<HTMLCanvasElement>("canvas[data-layer]")) {
      const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i]! > 225 && d[i + 1]! > 120 && d[i + 1]! < 175 && d[i + 2]! < 60 && d[i + 3]! > 200) n++;
    }
    return n;
  });
}

async function seek(page: Page, t: number) {
  await page.evaluate((v) => {
    const r = document.querySelector<HTMLInputElement>('input[aria-label="Scrubber"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(r, String(v));
    r.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await page.waitForTimeout(300);
}

async function openEmoji(page: Page) {
  await page.getByRole("button", { name: /^Design/ }).first().click();
  const cat = page.getByRole("button", { name: /^Emoji/ }).first();
  await cat.scrollIntoViewIfNeeded();
  await cat.click();
  await expect(page.getByTestId("emoji-picker")).toBeVisible();
}

test.beforeAll(() => mkdirSync(DIR, { recursive: true }));

test("emoji: virtualized picker → search → click inserts a color sprite → skin tone → favorites persist", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    try {
      localStorage.removeItem("cadence:emoji:recents");
      localStorage.removeItem("cadence:emoji:favorites");
      localStorage.removeItem("cadence:emoji:tone");
    } catch {
      /* ignore */
    }
  });
  await openEmoji(page);

  // 1. Virtualized: far fewer cells mounted than the 1,870 base emoji.
  const cells = page.locator('[data-testid="emoji-grid"] [data-idx]');
  await expect(cells.first()).toBeVisible();
  const mounted = await cells.count();
  expect(mounted).toBeGreaterThan(20);
  expect(mounted).toBeLessThan(400);
  await expect(page.getByLabel("Search emoji")).toHaveAttribute("placeholder", /Search 3,\d{3} emoji/);
  await shot(page, "01-picker");

  // A category tab jumps down the list (a different cell set mounts).
  const firstBefore = await cells.first().getAttribute("aria-label");
  await page.getByRole("tab", { name: "Flags" }).click();
  await expect.poll(async () => cells.first().getAttribute("aria-label")).not.toBe(firstBefore);

  // 2. Search + click: a fire sticker lands at the playhead; the Stage shows REAL color pixels.
  await page.getByLabel("Search emoji").fill("fire");
  await expect(page.getByRole("button", { name: "fire", exact: true })).toBeVisible();
  expect(await flamePixels(page)).toBe(0);
  await page.getByRole("button", { name: "fire", exact: true }).click();
  await expect(page.getByTestId("emoji-inspector")).toBeVisible();
  await seek(page, 1.4);
  await expect.poll(() => flamePixels(page), { timeout: 15_000 }).toBeGreaterThan(60);
  await shot(page, "02-fire-inserted");

  // Inspector keeps it editable: move + re-animate.
  await page.getByRole("button", { name: "Move to top right" }).click();
  await page.getByLabel("Emoji loop motion").selectOption("wiggle");
  await expect(page.getByLabel("Emoji loop motion")).toHaveValue("wiggle");
  await expect.poll(() => flamePixels(page), { timeout: 15_000 }).toBeGreaterThan(40);

  // 3. Skin tone: the toned sprite loads for "thumbs up"; recents list the fire.
  await page.getByLabel("Skin tone").selectOption("3");
  await page.getByLabel("Search emoji").fill("thumbs up");
  await expect(page.locator('[data-testid="emoji-grid"] img[src*="1f44d-1f3fd"]')).toBeVisible();
  await page.getByRole("button", { name: "thumbs up", exact: true }).hover();
  await page.getByRole("button", { name: /Favorite/ }).click();
  await expect(page.getByRole("button", { name: /★ Favorite/ })).toBeVisible();

  // Persistence (try/catch localStorage): reload → favorites + recents + tone survive.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await openEmoji(page);
  await expect(page.getByRole("tab", { name: "Favorites" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Recently used" })).toBeVisible();
  await expect(page.getByLabel("Skin tone")).toHaveValue("3");
});

test("emoji: drag from the picker onto the Stage, then a reaction pack", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(EDITOR_URL);
  await page.waitForLoadState("networkidle");
  await openEmoji(page);

  // Seed the doc so the Stage has a frame (insert one, then drag a second).
  await page.getByLabel("Search emoji").fill("sparkles");
  await page.getByRole("button", { name: "sparkles", exact: true }).click();
  await expect(page.getByTestId("emoji-inspector")).toBeVisible();

  await page.getByLabel("Search emoji").fill("fire");
  const cell = page.getByRole("button", { name: "fire", exact: true });
  await expect(cell).toBeVisible();

  // The real dragstart payload (what the timeline agent reads) → drop at the stage's top-left corner.
  const result = await page.evaluate(() => {
    const dt = new DataTransfer();
    const cellEl = document.querySelector<HTMLElement>('[data-testid="emoji-grid"] [aria-label="fire"]')!;
    cellEl.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    const payload = dt.getData("application/x-cadence-emoji");
    const cv = document.querySelector<HTMLCanvasElement>("canvas[data-layer]")!;
    const r = cv.getBoundingClientRect();
    const at = { clientX: r.left + r.width * 0.12, clientY: r.top + r.height * 0.15 };
    cv.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
    cv.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
    return { payload, plain: dt.getData("text/plain") };
  });
  expect(JSON.parse(result.payload)).toMatchObject({ v: 1, emoji: "🔥" });
  expect(result.plain).toBe("🔥");
  await seek(page, 1.4);
  // Dropped near the top-left: flame pixels exist and sit in the left/top part of the frame.
  const where = await page.evaluate(() => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    const cv = document.querySelector<HTMLCanvasElement>("canvas[data-layer]")!;
    const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i]! > 225 && d[i + 1]! > 120 && d[i + 1]! < 175 && d[i + 2]! < 60 && d[i + 3]! > 200) {
        const p = i / 4;
        sx += p % cv.width;
        sy += Math.floor(p / cv.width);
        n++;
      }
    }
    return { n, x: n ? sx / n / cv.width : -1, y: n ? sy / n / cv.height : -1 };
  });
  expect(where.n).toBeGreaterThan(60);
  expect(where.x).toBeLessThan(0.3);
  expect(where.y).toBeLessThan(0.35);
  await shot(page, "03-dropped");

  // Reaction packs: a staggered group that stays editable.
  await page.getByRole("button", { name: "Reaction packs" }).click();
  await page.getByRole("button", { name: "Add Confetti / party reaction" }).click();
  await expect(page.getByRole("button", { name: "Select party emoji group" })).toBeVisible();
  await page.getByRole("button", { name: "Add Burst reaction" }).click();
  await expect(page.getByRole("button", { name: "Select burst emoji group" })).toBeVisible();
  await seek(page, 2);
  await shot(page, "04-reactions");
});
