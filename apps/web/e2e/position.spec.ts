import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { ARTIFACT_DIR, EDITOR_URL } from "./fixtures";

/**
 * POSITION (Cycle J) — on-canvas selection box + Transform inspector, on a real
 * text video (no media): click-select, drag-move (one undo step), snap guides,
 * resize handle, rotate handle (shift = 15°), arrow-key nudge (shift ×10),
 * numeric entry (X / rotation / opacity), 9-point align, reset, in-place text
 * edit, and the Director ("move the title to the top left"). Screens → position/.
 */

const DIR = resolve(ARTIFACT_DIR, "position");
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(DIR, `${name}.png`) });

interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
}

async function seek(page: Page, t: number) {
  await page.evaluate((v) => {
    const r = document.querySelector<HTMLInputElement>('input[aria-label="Scrubber"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(r, String(v));
    r.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await page.waitForTimeout(250);
}

const layer = (page: Page): Locator => page.getByTestId("transform-layer");
const primaryBox = (page: Page): Locator => page.locator('[data-testid="transform-box"][data-primary="true"]');

async function readBox(page: Page): Promise<Box> {
  const raw = await primaryBox(page).getAttribute("data-box");
  const [cx, cy, w, h, rot] = (raw ?? "0,0,0,0,0").split(",").map(Number);
  return { cx: cx!, cy: cy!, w: w!, h: h!, rot: rot! };
}

/** Frame rect (CSS px) and the composition → screen scale. */
async function frame(page: Page) {
  const bb = (await layer(page).boundingBox())!;
  const comp = (await layer(page).getAttribute("data-comp"))!.split("x").map(Number);
  return { bb, W: comp[0]!, H: comp[1]!, s: bb.width / comp[0]! };
}

/** Screen position of a composition point. */
const toScreen = (f: Awaited<ReturnType<typeof frame>>, x: number, y: number) => ({ x: f.bb.x + x * f.s, y: f.bb.y + y * f.s });

/** Scan the frame until a click selects a layer. */
async function selectSomething(page: Page): Promise<void> {
  const f = await frame(page);
  for (const fy of [0.5, 0.42, 0.58, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85]) {
    for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      await page.mouse.click(f.bb.x + f.bb.width * fx, f.bb.y + f.bb.height * fy);
      if (await primaryBox(page).count()) return;
    }
  }
  throw new Error("no layer found on the preview");
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, opts: { alt?: boolean; shift?: boolean; hold?: () => Promise<void> } = {}) {
  if (opts.alt) await page.keyboard.down("Alt");
  if (opts.shift) await page.keyboard.down("Shift");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  if (opts.hold) await opts.hold();
  await page.mouse.up();
  if (opts.shift) await page.keyboard.up("Shift");
  if (opts.alt) await page.keyboard.up("Alt");
  await page.waitForTimeout(150);
}

async function open(page: Page) {
  await page.goto(`${EDITOR_URL}?prompt=${encodeURIComponent("Make a text video: Big news. We just launched. Try it free today.")}`);
  await expect(page.getByLabel("Scene 1 text")).toHaveValue("Big news.", { timeout: 30_000 });
  await seek(page, 1.2);
  await selectSomething(page);
  await expect(page.getByTestId("transform-inspector")).toBeVisible();
}

test.beforeAll(() => mkdirSync(DIR, { recursive: true }));
// A roomy window so the preview frame is big enough for pixel-accurate drags.
test.use({ viewport: { width: 1800, height: 1200 } });

test("position: select, drag (one undo step), guides, resize, rotate, nudge", async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  await shot(page, "01-selected");
  const b0 = await readBox(page);
  const f = await frame(page);
  expect(b0.w).toBeGreaterThan(20);

  // Drag-move (Alt = no snapping so the delta is exact) → the box follows the pointer.
  const c = toScreen(f, b0.cx, b0.cy);
  await drag(page, c, { x: c.x + 80, y: c.y + 50 }, { alt: true });
  const b1 = await readBox(page);
  expect(Math.abs(b1.cx - (b0.cx + 80 / f.s))).toBeLessThan(3);
  expect(Math.abs(b1.cy - (b0.cy + 50 / f.s))).toBeLessThan(3);
  await shot(page, "02-dragged");

  // The whole drag is ONE undo step.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  const bUndo = await readBox(page);
  expect(Math.abs(bUndo.cx - b0.cx)).toBeLessThan(2);
  expect(Math.abs(bUndo.cy - b0.cy)).toBeLessThan(2);
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(200);
  expect(Math.abs((await readBox(page)).cx - b1.cx)).toBeLessThan(2);

  // Smart guides: nudging the box's centre onto the canvas centre shows a guide mid-drag.
  const b2 = await readBox(page);
  const s2 = toScreen(f, b2.cx, b2.cy);
  const centreX = f.bb.x + f.bb.width / 2;
  let sawGuide = 0;
  await drag(page, s2, { x: centreX + 3, y: s2.y }, {
    hold: async () => {
      sawGuide = await page.getByTestId("snap-guide").count();
    },
  });
  expect(sawGuide).toBeGreaterThan(0);
  await shot(page, "03-guides");
  const b3 = await readBox(page);
  expect(Math.abs(b3.cx - f.W / 2)).toBeLessThan(2); // snapped to the canvas centre

  // Resize via the SE handle: bigger, aspect kept (text always scales uniformly).
  const rb = await readBox(page);
  const se = page.locator('[data-handle="se"]');
  const seBox = (await se.boundingBox())!;
  await drag(page, { x: seBox.x + seBox.width / 2, y: seBox.y + seBox.height / 2 }, { x: seBox.x + seBox.width / 2 + 60, y: seBox.y + seBox.height / 2 + 30 });
  const rb2 = await readBox(page);
  expect(rb2.w).toBeGreaterThan(rb.w + 10);
  expect(Math.abs(rb2.w / rb2.h - rb.w / rb.h)).toBeLessThan(0.08);
  await shot(page, "04-resized");

  // Rotate via the handle: pointer to the right of the centre → ~90°; Shift snaps to 15°.
  const cb = await readBox(page);
  const cs = toScreen(f, cb.cx, cb.cy);
  const rot = page.locator('[data-handle="rotate"]');
  const rotBox = (await rot.boundingBox())!;
  await drag(page, { x: rotBox.x + rotBox.width / 2, y: rotBox.y + rotBox.height / 2 }, { x: cs.x + 160, y: cs.y - 62 }, { shift: true });
  const rr = await readBox(page);
  expect(rr.rot % 15).toBe(0);
  expect(rr.rot).toBeGreaterThan(45);
  await shot(page, "05-rotated");

  // Arrow nudge: 1 px, Shift ×10 — and the playhead does NOT move.
  await layer(page).focus();
  const before = await readBox(page);
  const t0 = await page.locator('input[aria-label="Scrubber"]').inputValue();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(120);
  const n1 = await readBox(page);
  expect(n1.cx - before.cx).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(120);
  const n2 = await readBox(page);
  expect(n2.cx - n1.cx).toBeGreaterThanOrEqual(9);
  expect(await page.locator('input[aria-label="Scrubber"]').inputValue()).toBe(t0);
});

test("position: inspector — numeric entry, align, reset, flip, arrange", async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  const f = await frame(page);
  await shot(page, "06-inspector");

  // Reset → centred, upright, 100% opaque.
  await page.getByTestId("transform-reset").click();
  await page.waitForTimeout(200);
  let b = await readBox(page);
  expect(b.rot).toBe(0);
  expect(Math.abs(b.cx - f.W / 2)).toBeLessThan(2);
  expect(Math.abs(b.cy - f.H / 2)).toBeLessThan(2);

  // Numeric X: the top-left reference point goes to x = 100.
  await page.getByTestId("field-x").fill("100");
  await page.getByTestId("field-x").press("Enter");
  await page.waitForTimeout(200);
  b = await readBox(page);
  expect(Math.abs(b.cx - b.w / 2 - 100)).toBeLessThan(2);

  // Numeric rotation + opacity.
  await page.getByTestId("field-rotation").fill("30");
  await page.getByTestId("field-rotation").press("Enter");
  await page.waitForTimeout(200);
  expect((await readBox(page)).rot).toBe(30);
  await page.getByTestId("field-opacity").fill("40");
  await page.getByTestId("field-opacity").press("Enter");
  await expect(page.getByTestId("field-opacity")).toHaveValue("40");

  // Units toggle: % shows the same X as a share of the canvas.
  await page.getByRole("button", { name: "%", exact: true }).click();
  await expect(page.getByTestId("field-x")).not.toHaveValue("100");
  await page.getByRole("button", { name: "px", exact: true }).click();

  // 9-point align to the canvas: top-left puts the box's bounds in the corner.
  await page.getByTestId("transform-reset").click();
  await page.getByTestId("align-top-left").click();
  await page.waitForTimeout(200);
  b = await readBox(page);
  expect(Math.abs(b.cx - b.w / 2)).toBeLessThan(3);
  expect(Math.abs(b.cy - b.h / 2)).toBeLessThan(3);
  await page.getByTestId("align-bottom-right").click();
  await page.waitForTimeout(200);
  b = await readBox(page);
  expect(Math.abs(b.cx + b.w / 2 - f.W)).toBeLessThan(3);
  expect(Math.abs(b.cy + b.h / 2 - f.H)).toBeLessThan(3);
  await shot(page, "07-aligned");

  // Flip toggles pressed; arrange sends the layer back without breaking the doc.
  await page.getByRole("button", { name: "Flip horizontal" }).click();
  await expect(page.getByRole("button", { name: "Flip horizontal" })).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("arrange-front").click();
  await expect(primaryBox(page)).toBeVisible();
});

test("position: double-click edits text in place; the Director moves the title", async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  const b = await readBox(page);
  const f = await frame(page);
  const c = toScreen(f, b.cx, b.cy);
  await page.mouse.dblclick(c.x, c.y);
  const editor = page.getByTestId("text-editor");
  await expect(editor).toBeVisible();
  await editor.fill("Brand new headline");
  await editor.press("Enter");
  await expect(page.getByTestId("text-editor")).toHaveCount(0);
  await expect(page.getByLabel("Scene 1 text")).toHaveValue("Brand new headline");
  await shot(page, "08-edited-in-place");

  // The Director: "move the title to the top left" (set_transform / align_clip).
  const rail = page.getByRole("button", { name: "Open the chat panel" });
  if (await rail.isVisible()) await rail.click();
  await page.getByPlaceholder(/Describe a video/).fill("move the title to the top left");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Aligned 1 layer to top left/).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "09-director-top-left");
});

test("position: Shift-click multi-select, align to the selection, Escape clears", async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  const b = await readBox(page);
  const f = await frame(page);
  // Shift-click the accent bar under the title to add it to the selection.
  let got = 1;
  for (let dy = 8; dy <= 90 && got < 2; dy += 6) {
    const p = toScreen(f, b.cx, b.cy + b.h / 2);
    await page.keyboard.down("Shift");
    await page.mouse.click(p.x, p.y + dy);
    await page.keyboard.up("Shift");
    await page.waitForTimeout(200);
    got = await page.getByTestId("transform-box").count();
  }
  expect(got).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("transform-group")).toBeVisible();
  await shot(page, "10-multi-select");

  // Align left edges to the SELECTION: both layers' left bounds coincide.
  await page.getByRole("button", { name: "selection", exact: true }).click();
  await page.getByTestId("align-left").click();
  await page.waitForTimeout(250);
  const boxes = await page.getByTestId("transform-box").evaluateAll((els) =>
    els.map((el) => (el.getAttribute("data-box") ?? "").split(",").map(Number)),
  );
  const lefts = boxes.map((v) => v[0]! - v[2]! / 2);
  expect(Math.abs(lefts[0]! - lefts[1]!)).toBeLessThan(2);

  // Escape (focus on the layer) clears the selection.
  await layer(page).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("transform-box")).toHaveCount(0);
});
