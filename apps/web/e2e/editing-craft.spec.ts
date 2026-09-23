import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures } from "./fixtures";

/**
 * Editing speed & timeline craft (senior-video-editor) on REAL in-browser media:
 * snapping toggle · frame step + in/out → remove range · ↑/↓ cut navigation ·
 * split all tracks (⇧S) · multi-select (⇧-click / marquee) + group duplicate /
 * delete · delete-with-gap → click-to-close gap · freeze frame · speed presets ·
 * copy / paste attributes · J/K/L shuttle · the grouped shortcuts sheet.
 * Every assertion reads the edit-doc from the code drawer (edits-as-code).
 */

let fixtures: Fixtures;

const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(ARTIFACT_DIR, `craft-${name}.png`), fullPage: true });

interface DocClip {
  id: string;
  kind: string;
  start: number;
  duration: number;
  speed?: number;
  freezeAtSec?: number;
}
interface DocShape {
  tracks: { id: string; clips: DocClip[] }[];
}

const readDoc = async (page: Page): Promise<DocShape> =>
  JSON.parse((await page.locator("pre code").textContent()) ?? "{}") as DocShape;
const videoClips = async (page: Page): Promise<DocClip[]> =>
  (await readDoc(page)).tracks.flatMap((t) => t.clips).filter((c) => c.kind === "video");
const totalSec = async (page: Page): Promise<number> =>
  Math.max(0, ...(await readDoc(page)).tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)));
const clipButtons = (page: Page) => page.getByRole("button", { name: /video clip,/i });

/**
 * Put focus on the page body so window shortcuts fire (not inside a field). Blur
 * rather than click: a click in the editor could land on a one-tap action.
 */
async function focusStage(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
}

/** Close the "… · Undo" toast so it never sits over the timeline we click. */
async function dismissToast(page: Page): Promise<void> {
  const d = page.getByRole("button", { name: "Dismiss" });
  if (await d.isVisible().catch(() => false)) await d.click().catch(() => {});
}

async function tap(page: Page, target: Locator): Promise<void> {
  await dismissToast(page);
  await target.click();
}

/** Select the i-th video clip with the keyboard (⇧+Enter adds it to the selection). */
async function selectClip(page: Page, i: number, add = false): Promise<void> {
  await dismissToast(page);
  await clipButtons(page).nth(i).focus();
  await page.keyboard.press(add ? "Shift+Enter" : "Enter");
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const page = await browser.newPage();
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.close();
});

test("editing craft: snap · in/out · split all · multi-select · gaps · freeze · speed · attributes · JKL", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.videoPath);
  await expect(page.getByText(/Loaded .*spoken segments/i)).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "{ } code" }).click();
  await expect(page.locator("pre code")).toBeVisible();
  // A MediaRecorder webm reports its real length only once the browser has read
  // it (~1.5–2.5s): wait for the timeline length to settle before cutting.
  const scrubMax = async () => Number(await page.getByRole("slider", { name: "Scrubber" }).getAttribute("max"));
  await expect
    .poll(async () => {
      const a = await scrubMax();
      await page.waitForTimeout(600);
      return a === (await scrubMax());
    })
    .toBe(true);
  const startLen = await totalSec(page);
  expect(startLen).toBeGreaterThan(1.2);

  // --- Snapping toggle (button + N) ---
  const snapBtn = page.getByRole("button", { name: "Snapping" });
  await expect(snapBtn).toHaveAttribute("aria-pressed", "true");
  await snapBtn.click();
  await expect(snapBtn).toHaveAttribute("aria-pressed", "false");
  await focusStage(page);
  await page.keyboard.press("n");
  await expect(snapBtn).toHaveAttribute("aria-pressed", "true");

  // --- Frame step + I / O → the marked range, then Remove range ---
  // At 30fps: +30 frames (⇧. ×3) = 1.0s, −10 (⇧,) = 0.67s, −5 (, ×5) = 0.5s → IN;
  // +10 (⇧.) + 5 (. ×5) = 1.0s → OUT.
  const scrub = async () => Number(await page.getByRole("slider", { name: "Scrubber" }).inputValue());
  await page.keyboard.press("Home");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+Period");
  await expect.poll(scrub).toBeCloseTo(1, 2);
  await page.keyboard.press("Shift+Comma");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Comma");
  await expect.poll(scrub).toBeCloseTo(0.5, 2);
  await page.keyboard.press("i");
  await page.keyboard.press("Shift+Period");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Period");
  await expect.poll(scrub).toBeCloseTo(1, 2);
  await page.keyboard.press("o");
  const range = page.getByRole("group", { name: "Marked range" });
  await expect(range).toBeVisible();
  await expect(range).toContainText("0:00.5 → 0:01.0 · 0.5s");
  await expect(page.getByTestId("inout-range")).toBeVisible();
  await shot(page, "01-inout");
  await tap(page, range.getByRole("button", { name: "Remove range" }));
  await expect.poll(() => totalSec(page)).toBeCloseTo(startLen - 0.5, 1);
  await expect(range).toBeHidden();
  await shot(page, "02-range-removed");

  // --- ↑ / ↓ edit-point navigation lands on the cut the range left behind ---
  await focusStage(page);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown"); // → the cut at 0.5s
  await page.keyboard.press("i");
  await expect(range).toContainText("0:00.5 →");
  await page.keyboard.press("Escape"); // clears the marks
  await expect(range).toBeHidden();

  // --- Split all tracks (⇧S) at the playhead ---
  const beforeSplit = (await videoClips(page)).length;
  await page.keyboard.press("Home");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Period"); // 6 frames → 0.2s, inside clip 1
  await expect.poll(scrub).toBeCloseTo(0.2, 2);
  await page.keyboard.press("Shift+S");
  await expect.poll(async () => (await videoClips(page)).length).toBe(beforeSplit + 1);
  await shot(page, "03-split-all");

  // --- Multi-select (⇧-click) → duplicate → group delete ---
  const clips = clipButtons(page);
  await selectClip(page, 0);
  await selectClip(page, 1, true);
  const bar = page.getByRole("toolbar", { name: "Selected clips" });
  await expect(bar).toContainText("2 clips selected");
  const n0 = (await videoClips(page)).length;
  await tap(page, bar.getByRole("button", { name: "Duplicate 2" }));
  await expect.poll(async () => (await videoClips(page)).length).toBe(n0 + 2);
  await shot(page, "04-multi-duplicate");
  await focusStage(page);
  await page.keyboard.press("Delete"); // group ripple-delete of the 2 originals
  await expect.poll(async () => (await videoClips(page)).length).toBe(n0);
  await expect(bar).toBeHidden();

  // --- Marquee (⇧-drag from the ruler / an empty lane) selects several clips ---
  await dismissToast(page);
  const lane = clips.first().locator("xpath=..");
  const lb = await lane.boundingBox();
  if (!lb) throw new Error("no lane box");
  await page.keyboard.down("Shift");
  await page.mouse.move(lb.x + 3, lb.y - 12); // the ruler row above the lanes
  await page.mouse.down();
  await page.mouse.move(lb.x + lb.width - 3, lb.y + lb.height - 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(bar).toContainText(/\d+ clips selected/);
  await shot(page, "05-marquee");
  await tap(page, bar.getByRole("button", { name: "Clear selection" }));
  await expect(bar).toBeHidden();

  // --- Delete (leave a gap) → the gap shows → click it to close ---
  const count = (await videoClips(page)).length;
  expect(count).toBeGreaterThanOrEqual(2);
  await selectClip(page, 0);
  await tap(page, page.getByRole("button", { name: "Delete", exact: true }));
  const gap = page.getByRole("button", { name: /Close the .* gap at/ });
  await expect(gap).toBeVisible();
  await expect(page.getByRole("button", { name: /^Close gaps \(1\)$/ })).toBeEnabled();
  await shot(page, "06-gap");
  await tap(page, gap);
  await expect(gap).toBeHidden();
  await expect.poll(async () => (await videoClips(page))[0]!.start).toBe(0);

  // --- Speed preset (keeps the footage): 2× halves the clip ---
  await selectClip(page, 0);
  const first = (await videoClips(page))[0]!;
  await tap(page, page.getByRole("button", { name: "Retime to 2×" }));
  await expect.poll(async () => (await videoClips(page))[0]!.speed).toBe(2);
  const sped = (await videoClips(page))[0]!;
  expect(sped.duration).toBeCloseTo(first.duration / 2, 2);
  await expect(page.getByRole("button", { name: "Retime to 2×" })).toHaveAttribute("aria-pressed", "true");

  // --- Copy / paste attributes: copy the 2× clip's speed onto another clip ---
  await tap(page, page.getByRole("button", { name: "Copy attributes" }));
  await expect(page.getByText(/Copied video attributes/)).toBeVisible();
  await selectClip(page, 1);
  await tap(page, page.getByRole("button", { name: "Paste attributes…" }));
  const picker = page.getByRole("dialog", { name: "Paste attributes" });
  await expect(picker).toBeVisible();
  for (const g of ["Look", "Transform & blend", "Motion", "Audio"]) {
    const box = picker.getByRole("checkbox", { name: new RegExp(`^${g}`) });
    if (await box.count()) await box.uncheck();
  }
  await tap(page, picker.getByRole("button", { name: /^Paste to 1 clip$/ }));
  await expect.poll(async () => (await videoClips(page))[1]!.speed).toBe(2);
  await shot(page, "07-paste-attributes");

  // --- Freeze frame here: inserts a 2s hold of the frame at the playhead ---
  await selectClip(page, 0);
  const lenBeforeFreeze = await totalSec(page);
  await tap(page, page.getByRole("button", { name: /Freeze frame/ }));
  await expect.poll(async () => (await videoClips(page)).some((c) => c.freezeAtSec !== undefined)).toBe(true);
  expect(await totalSec(page)).toBeCloseTo(lenBeforeFreeze + 2, 1);
  await shot(page, "08-freeze");

  // --- J / K / L shuttle ---
  await focusStage(page);
  await page.keyboard.press("Home");
  await page.keyboard.press("l");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await page.keyboard.press("l");
  await expect(page.getByText("▶▶ 2×")).toBeVisible();
  await page.keyboard.press("k");
  await expect(page.getByText("▶▶ 2×")).toBeHidden();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();

  // --- Every shortcut is discoverable in the grouped sheet ---
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  for (const label of [
    "Play forward — tap again for 2× / 4×",
    "Step one frame back / forward",
    "Previous / next cut",
    "Split all tracks at playhead",
    "Mark in / out",
    "Freeze frame here (2s hold)",
    "Snapping on / off",
    "Paste attributes onto selection",
    "Marquee-select clips (drag from the ruler or an empty lane)",
    "Command palette (search every action)",
  ]) {
    await expect(help.getByText(label, { exact: true })).toBeVisible();
  }
  await shot(page, "09-shortcuts");
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();

  // --- Undo reverts the last craft edit (the freeze) through the same history ---
  await focusStage(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await videoClips(page)).some((c) => c.freezeAtSec !== undefined)).toBe(false);

  expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
});
