import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures } from "./fixtures";

/**
 * Timeline upgrade + drag & drop (Cycle J, senior-video-editor) on REAL in-browser
 * media: adaptive ruler + timecode · ruler scrubbing · zoom · per-track height ·
 * filmstrip + per-clip waveform · reorder by drag (ghost + insertion preview, Esc
 * cancels, undo restores) · palette drops (Media tile, sticker) onto a lane at a
 * time with a visible preview, insert vs overwrite · drop on the preview as an
 * overlay · group drag · edge auto-scroll · keyboard lane move.
 * Every state assertion reads the edit-doc from the code drawer (edits-as-code).
 */

let fixtures: Fixtures;

// Mouse-driven drags need the whole timeline on screen (a laptop-sized window hides it).
test.use({ viewport: { width: 1600, height: 1250 } });

const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(ARTIFACT_DIR, `dnd-${name}.png`), fullPage: true });

interface DocClip {
  id: string;
  kind: string;
  start: number;
  duration: number;
  sourceIn?: number;
  text?: string;
  transform?: { x: number; y: number };
}
interface DocShape {
  tracks: { id: string; clips: DocClip[] }[];
}
const readDoc = async (page: Page): Promise<DocShape> =>
  JSON.parse((await page.locator("pre code").textContent()) ?? "{}") as DocShape;
const laneClips = async (page: Page, id: string): Promise<DocClip[]> =>
  (await readDoc(page)).tracks.find((t) => t.id === id)?.clips ?? [];
const mainOrder = async (page: Page): Promise<number[]> =>
  (await laneClips(page, "video")).sort((a, b) => a.start - b.start).map((c) => Math.round((c.sourceIn ?? 0) * 100) / 100);
const mainEnd = async (page: Page): Promise<number> =>
  Math.max(0, ...(await laneClips(page, "video")).map((c) => c.start + c.duration));
const allClips = async (page: Page, kind: string): Promise<DocClip[]> =>
  (await readDoc(page)).tracks.flatMap((t) => t.clips).filter((c) => c.kind === kind);

const videoClipBtns = (page: Page) => page.getByRole("button", { name: /video clip,/i });
const lane = (page: Page, id: string) => page.getByTestId(`lane-${id}`);

async function focusStage(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
}
async function dismissToast(page: Page): Promise<void> {
  const d = page.getByRole("button", { name: "Dismiss" });
  if (await d.isVisible().catch(() => false)) await d.click().catch(() => {});
}
async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error("no bounding box");
  return b;
}

/** Load the fixture video, open the code drawer and wait for its real length. */
async function openWithVideo(page: Page): Promise<void> {
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.videoPath);
  await expect(page.getByText(/Loaded .*spoken segments/i)).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "{ } code" }).click();
  await expect(page.locator("pre code")).toBeVisible();
  // Give the timeline panel its tallest size (keyboard-resize its divider) so the lanes
  // sit below the toolbar on screen — mouse drags need real, visible coordinates.
  await page.getByRole("separator", { name: "Resize the timeline" }).focus();
  for (let i = 0; i < 24; i++) await page.keyboard.press("ArrowUp");
  const scrubMax = async () => Number(await page.getByRole("slider", { name: "Scrubber" }).getAttribute("max"));
  await expect
    .poll(async () => {
      const a = await scrubMax();
      await page.waitForTimeout(600);
      return a === (await scrubMax());
    })
    .toBe(true);
}

/** Cut the main clip into 3 (split at ~1/3 and ~2/3 of the footage). */
async function makeThreeClips(page: Page): Promise<void> {
  const total = Number(await page.getByRole("slider", { name: "Scrubber" }).getAttribute("max"));
  const scrub = page.getByRole("slider", { name: "Scrubber" });
  for (const frac of [0.34, 0.67]) {
    await focusStage(page);
    await scrub.evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, total * frac);
    await focusStage(page);
    await page.keyboard.press("s");
  }
  await expect.poll(async () => (await laneClips(page, "video")).length).toBe(3);
}

/** Drag the i-th video clip to (x, y) with live checks possible between steps. */
async function pressClip(page: Page, i: number) {
  await dismissToast(page);
  const b = await box(videoClipBtns(page).nth(i));
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  return b;
}

/**
 * Move a held HTML5 drag to (x, y). Chromium only fires `dragover` on the move AFTER
 * `dragenter`, and a drop needs a fresh `dragover` at the final position — so settle
 * with two tiny extra moves (Playwright's own "hover twice" advice).
 */
async function dragTo(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.move(x + 1, y, { steps: 2 });
  await page.mouse.move(x, y, { steps: 2 });
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const page = await browser.newPage();
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.close();
});

test("timeline: timecode ruler · scrubbing · zoom · track height · filmstrip · waveforms", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await openWithVideo(page);
  const total = Number(await page.getByRole("slider", { name: "Scrubber" }).getAttribute("max"));

  // --- Ruler: labelled majors + the current-time readout in NLE timecode ---
  const labels = page.getByTestId("ruler-label");
  await expect.poll(() => labels.count()).toBeGreaterThanOrEqual(2);
  const before = await labels.allTextContents();
  const tc = page.getByTestId("timecode");
  await expect(tc).toContainText("00:00:00");
  await focusStage(page);
  await page.keyboard.press("Home");
  await page.keyboard.press("Period"); // one frame
  await expect(tc).toContainText("00:00:01");
  await page.keyboard.press("Shift+Period"); // ten more frames
  await expect(tc).toContainText("00:00:11");

  // --- Scrub: press on the ruler and drag; the playhead + readout follow ---
  const rb = await box(page.getByTestId("ruler"));
  await page.mouse.move(rb.x + rb.width * 0.7, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width * 0.4, rb.y + rb.height / 2, { steps: 6 });
  await page.mouse.up();
  const scrubVal = Number(await page.getByRole("slider", { name: "Scrubber" }).inputValue());
  expect(Math.abs(scrubVal - total * 0.4)).toBeLessThan(total * 0.12);
  await expect(page.getByRole("slider", { name: "Playhead" })).toHaveAttribute("aria-valuetext", /^\d\d:\d\d:\d\d$/);

  // --- Zoom: ticks re-adapt (finer majors) ---
  await page.getByRole("slider", { name: /Timeline zoom/ }).fill("6");
  await expect.poll(async () => (await labels.allTextContents()).join("|")).not.toBe(before.join("|"));
  await page.getByRole("button", { name: "Fit" }).click();

  // --- Per-track height: S → M ---
  const laneBox0 = await box(lane(page, "video"));
  await page.getByTestId("height-video").click();
  await expect.poll(async () => (await box(lane(page, "video"))).height).toBeGreaterThan(laneBox0.height + 10);

  // --- Filmstrip: real frames behind the video clip ---
  const strip = page.getByTestId("filmstrip").first();
  await expect(strip.locator("img").first()).toBeVisible({ timeout: 25_000 });

  // --- A music clip gets its own waveform ---
  await page.locator('input[type="file"]').first().setInputFiles({ name: "music.webm", mimeType: "audio/webm", buffer: readFileSync(fixtures.audioPath) });
  await expect(page.getByText(/as background music/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("clip-waveform").first()).toBeVisible({ timeout: 25_000 });
  await shot(page, "01-timeline");
  expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
});

test("drag & drop: reorder (ghost · preview · Esc · undo) · group · palette drops · overwrite · stage · keyboard · auto-scroll", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await openWithVideo(page);
  await makeThreeClips(page);
  const order0 = await mainOrder(page);
  expect(order0.length).toBe(3);
  const len0 = await mainEnd(page);

  // --- Reorder: drag clip 1 to the end — ghost + insertion preview while dragging ---
  let lb = await box(lane(page, "video"));
  let b = await pressClip(page, 0);
  await page.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2, { steps: 4 });
  await page.mouse.move(lb.x + lb.width - 6, b.y + b.height / 2, { steps: 12 });
  await expect(page.getByTestId("drag-ghost")).toBeVisible();
  const prev = page.getByTestId("drop-preview");
  await expect(prev).toBeVisible();
  await expect(prev).toHaveAttribute("data-mode", "insert-ripple");
  await shot(page, "02-reorder-drag");

  // --- Esc cancels: nothing changes ---
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("drag-ghost")).toBeHidden();
  await expect(prev).toBeHidden();
  await page.mouse.up();
  expect(await mainOrder(page)).toEqual(order0);

  // --- Drag again and drop: [A,B,C] → [B,C,A] ---
  lb = await box(lane(page, "video"));
  b = await pressClip(page, 0);
  await page.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2, { steps: 4 });
  await page.mouse.move(lb.x + lb.width - 6, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => mainOrder(page)).toEqual([order0[1], order0[2], order0[0]]);
  expect(Math.abs((await mainEnd(page)) - len0)).toBeLessThan(0.05);
  await shot(page, "03-reordered");

  // --- Undo restores the order (every drop is one undoable edit) ---
  await focusStage(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => mainOrder(page)).toEqual(order0);

  // --- Group drag: select clips 1+2 (⇧+Enter) and drag them past the third ---
  await dismissToast(page);
  await videoClipBtns(page).nth(0).focus();
  await page.keyboard.press("Enter");
  await videoClipBtns(page).nth(1).focus();
  await page.keyboard.press("Shift+Enter");
  await expect(page.getByRole("toolbar", { name: "Selected clips" })).toContainText("2");
  lb = await box(lane(page, "video"));
  b = await pressClip(page, 0);
  await page.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2, { steps: 4 });
  await page.mouse.move(lb.x + lb.width - 6, b.y + b.height / 2, { steps: 12 });
  await expect(page.getByTestId("drag-ghost")).toContainText("2 clips");
  await page.mouse.up();
  await expect.poll(() => mainOrder(page)).toEqual([order0[2], order0[0], order0[1]]);
  await focusStage(page);
  await page.keyboard.press("Escape"); // clear selection
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => mainOrder(page)).toEqual(order0);

  // --- Palette: drag a Media tile onto the lane at a time (insert, with a preview) ---
  await page.getByRole("navigation", { name: "Rooms" }).getByRole("button", { name: "Media" }).click();
  const tile = page.locator('[draggable="true"][aria-label*="drag onto a timeline lane"]').first();
  await expect(tile).toBeVisible();
  const clipsBefore = (await laneClips(page, "video")).length;
  lb = await box(lane(page, "video"));
  const tb = await box(tile);
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2 + 20, tb.y + tb.height / 2 + 20, { steps: 3 });
  await dragTo(page, lb.x + lb.width * 0.5, lb.y + lb.height / 2);
  await expect(page.getByTestId("drop-preview")).toBeVisible();
  await expect(page.getByTestId("drop-preview")).toHaveAttribute("data-mode", "insert-ripple");
  await shot(page, "04-media-drop-preview");
  await page.mouse.up();
  await expect.poll(async () => (await laneClips(page, "video")).length).toBe(clipsBefore + 1);
  await expect.poll(() => mainEnd(page)).toBeGreaterThan(len0 + 0.5);
  await focusStage(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await laneClips(page, "video")).length).toBe(clipsBefore);

  // --- Overwrite mode: the preview shows the footage it replaces; the length is kept ---
  await page.getByRole("button", { name: "Overwrite", exact: true }).click();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2 + 20, tb.y + tb.height / 2 + 20, { steps: 3 });
  await dragTo(page, lb.x + lb.width * 0.3, lb.y + lb.height / 2);
  await expect(page.getByTestId("drop-carve")).toBeVisible();
  await expect(page.getByTestId("drop-preview")).toHaveAttribute("data-mode", "overwrite");
  await shot(page, "05-overwrite-preview");
  await page.mouse.up();
  // The 2.5s asset dropped at ~0.7s replaced the later cuts: the first clip is trimmed to
  // the drop point, the covered clips are gone, and the new clip took their place.
  await expect.poll(async () => (await laneClips(page, "video")).length).toBeLessThan(clipsBefore);
  const afterOw = (await laneClips(page, "video")).sort((a, b) => a.start - b.start);
  expect(afterOw[0]!.duration).toBeLessThan(0.84 - 0.05);
  expect(afterOw[afterOw.length - 1]!.duration).toBeGreaterThan(2);
  expect(Math.abs(afterOw[0]!.start + afterOw[0]!.duration - afterOw[1]!.start)).toBeLessThan(0.02);
  await focusStage(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await laneClips(page, "video")).length).toBe(clipsBefore);
  await page.getByRole("button", { name: "Insert", exact: true }).click();

  // --- Stickers / text styles: Design room → drag a sticker onto a lane and onto the preview ---
  await page.getByRole("navigation", { name: "Rooms" }).getByRole("button", { name: "Design" }).click();
  await page.getByRole("navigation", { name: "Design categories" }).getByRole("button", { name: /Text styles/ }).click();
  await page.getByRole("searchbox", { name: "Search emoji" }).first().fill("fire");
  const sticker = page.getByRole("button", { name: "fire", exact: true }).first();
  await expect(sticker).toBeVisible();
  const textsBefore = (await allClips(page, "text")).length;
  await sticker.scrollIntoViewIfNeeded();
  const sb = await box(sticker);
  lb = await box(lane(page, "video"));
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + 20, sb.y + 20, { steps: 3 });
  await dragTo(page, lb.x + lb.width * 0.5, lb.y + lb.height / 2);
  await expect(page.getByTestId("drop-preview")).toBeVisible();
  await page.mouse.up();
  await expect.poll(async () => (await allClips(page, "text")).length).toBe(textsBefore + 1);
  const stickerClip = (await allClips(page, "text")).find((c) => c.text === "🔥");
  expect(stickerClip, "sticker clip exists").toBeTruthy();
  expect(stickerClip!.start).toBeGreaterThan(0.2);

  const stageFrame = page.locator('[style*="aspect-ratio"]').first();
  const fb = await box(stageFrame);
  await sticker.scrollIntoViewIfNeeded();
  const sb2 = await box(sticker);
  await page.mouse.move(sb2.x + sb2.width / 2, sb2.y + sb2.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb2.x + 20, sb2.y + 20, { steps: 3 });
  await dragTo(page, fb.x + fb.width * 0.25, fb.y + fb.height * 0.25);
  await expect(page.getByTestId("stage-drop-hint")).toBeVisible();
  await shot(page, "06-stage-drop-hint");
  await page.mouse.up();
  await expect(page.getByTestId("stage-drop-hint")).toHaveCount(0);
  await expect.poll(async () => (await allClips(page, "text")).length).toBe(textsBefore + 2);
  const placed = (await allClips(page, "text")).filter((c) => c.text === "🔥").pop()!;
  // Dropped in the upper-left quarter of the 16:9 preview.
  expect(placed.transform!.x).toBeLessThan(1280 * 0.45);
  expect(placed.transform!.y).toBeLessThan(720 * 0.45);

  // --- Keyboard alternative: ⌥⇧↑ moves the focused clip to the lane above ---
  await page.getByRole("button", { name: "Add a video or overlay track" }).click();
  await dismissToast(page);
  await videoClipBtns(page).nth(1).focus();
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await expect(page.getByTestId("timeline-announce")).toContainText(/Moved video clip to/);
  // The lane directly above the main one (the sticker's titles lane, here) now holds a video clip.
  await expect
    .poll(async () => (await readDoc(page)).tracks.some((t) => t.id !== "video" && t.clips.some((c) => c.kind === "video")))
    .toBe(true);
  await shot(page, "06b-keyboard-lane-move");

  // --- Edge auto-scroll while dragging at a deep zoom ---
  await page.getByRole("slider", { name: /Timeline zoom/ }).fill("12");
  await expect.poll(() =>
    page.getByTestId("ruler").evaluate((el) => {
      let n: HTMLElement | null = el as HTMLElement;
      while (n && getComputedStyle(n).overflowX !== "auto") n = n.parentElement;
      return n ? n.scrollWidth > n.clientWidth + 50 : false;
    }),
  ).toBe(true);
  const scroller = () =>
    page.getByTestId("ruler").evaluate((el) => {
      let n: HTMLElement | null = el as HTMLElement;
      while (n && getComputedStyle(n).overflowX !== "auto") n = n.parentElement;
      return n ? n.scrollLeft : -1;
    });
  const startScroll = await scroller();
  const cb = await box(lane(page, "video").getByRole("button", { name: /video clip,/i }).first());
  const edgeX = await page.getByTestId("ruler").evaluate((el) => {
    let n: HTMLElement | null = el as HTMLElement;
    while (n && getComputedStyle(n).overflowX !== "auto") n = n.parentElement;
    return n ? n.getBoundingClientRect().right - 6 : 0;
  });
  // Grab the clip near its (visible) left end — at this zoom its centre is off-screen.
  await page.mouse.move(cb.x + 40, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + 65, cb.y + cb.height / 2, { steps: 3 });
  await page.mouse.move(edgeX, cb.y + cb.height / 2, { steps: 6 });
  await page.waitForTimeout(700);
  expect(await scroller()).toBeGreaterThan(startScroll + 20);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await shot(page, "07-autoscroll");
  expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
});
