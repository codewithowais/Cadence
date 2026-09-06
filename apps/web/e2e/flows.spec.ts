import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures } from "./fixtures";

/**
 * Feature flows that drive the REAL app on real in-browser-generated media:
 *  1. the task's video edit chain (highlight → vertical+captions → cinematic →
 *     vignette → 2.39:1 → 4K), asserting the edit-doc / applied strip each step;
 *  2. direct timeline editing (select · split · marker · zoom · ripple-delete);
 *  3. an interactive login demo built from screenshots (cursor + typewriter);
 *  4. the Audio room (attach music + duck) on a photo slideshow — with an
 *     explicit check of whether music attaches (the reported bug).
 *
 * Every step screenshots to test-artifacts/; the whole run records a .webm.
 */

let fixtures: Fixtures;

const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(ARTIFACT_DIR, `${name}.png`), fullPage: true });

const composer = (page: Page) => page.getByPlaceholder("Describe the edit…");
const editing = (page: Page) => page.getByText("Director is editing…");
const applied = (page: Page) => page.getByLabel("Applied edits");
const drawerCode = (page: Page) => page.locator("pre code");
const drawerText = (page: Page) => drawerCode(page).textContent();

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await editing(page)
    .waitFor({ state: "visible", timeout: 4000 })
    .catch(() => {});
  await editing(page).waitFor({ state: "hidden", timeout: 90_000 });
}

async function openEditorWith(page: Page, files: string | string[]): Promise<void> {
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(files);
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const page = await browser.newPage();
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.close();
});

// ---------------------------------------------------------------------------
// 1) Video edit chain (the task's exact sequence).
// ---------------------------------------------------------------------------
test("video chain: highlight · vertical+captions · cinematic · vignette · 2.39:1 · 4K", async ({
  page,
}) => {
  await openEditorWith(page, fixtures.videoPath);

  await expect(page.getByText(/Loaded .*spoken segments/i)).toBeVisible({ timeout: 60_000 });
  await expect(applied(page)).toBeVisible();
  await page.getByRole("button", { name: "{ } code" }).click();
  await expect(drawerCode(page)).toBeVisible();

  await send(page, "cut a 15-second highlight");
  await expect(drawerCode(page)).toContainText('"kind": "video"');
  await shot(page, "chain-01-highlight");

  await send(page, "make it vertical with captions");
  await expect(applied(page)).toContainText("9:16");
  await expect(applied(page)).toContainText("Captions");
  await expect(drawerCode(page)).toContainText('"captions"');
  await shot(page, "chain-02-vertical-captions");

  await send(page, "give it a cinematic look");
  await expect(applied(page)).toContainText("Cinematic");
  await shot(page, "chain-03-cinematic");

  await send(page, "add a vignette");
  // vfx.vignette is prefaulted to 0 and becomes 0.5 when applied.
  await expect(drawerCode(page)).toContainText('"vignette": 0.5');
  await shot(page, "chain-04-vignette");

  await send(page, "make it 2.39:1");
  // 2.39:1 anamorphic scope resolves to a 2048-wide composition.
  await expect(drawerCode(page)).toContainText('"width": 2048');
  await shot(page, "chain-05-scope");

  await send(page, "make it 4K");
  await expect(applied(page)).toContainText("4K");
  await expect(drawerCode(page)).toContainText('"ultra"');
  await shot(page, "chain-06-4k");

  // Full applied-strip snapshot: aspect + look + quality all registered.
  await expect(applied(page)).toContainText("Cinematic");
  await expect(applied(page)).toContainText("4K");
  await expect(applied(page)).toContainText("Captions");
});

// ---------------------------------------------------------------------------
// 2) Direct timeline editing.
// ---------------------------------------------------------------------------
test("timeline editing: select · split (S) · marker (M) · zoom · ripple-delete", async ({
  page,
}) => {
  await openEditorWith(page, fixtures.videoPath);
  await expect(page.getByText(/Loaded .*spoken segments/i)).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "{ } code" }).click();
  await expect(drawerCode(page)).toBeVisible();

  const countVideoClips = async () =>
    ((await drawerText(page)) ?? "").split('"kind": "video"').length - 1;

  // --- select a clip → the inspector appears ---
  const firstClip = page.getByRole("button", { name: /clip,/i }).first();
  await firstClip.click();
  await expect(page.getByRole("button", { name: "Ripple delete" })).toBeVisible();
  await shot(page, "tl-01-selected");

  // --- Split (S) at the playhead: move the head into the clip, then press S ---
  const before = await countVideoClips();
  await page.keyboard.press("ArrowRight"); // seek +1s into the ~2.5s clip
  await page.keyboard.press("s");
  await expect.poll(countVideoClips).toBeGreaterThan(before);
  await shot(page, "tl-02-split");

  // --- Marker (M): editor-only jump target at the playhead ---
  await page.keyboard.press("m");
  await expect(page.getByRole("button", { name: /Marker at/i })).toBeVisible();
  await shot(page, "tl-03-marker");

  // --- Zoom: the +/- controls drive the zoom slider (view-only, not the doc) ---
  // Match the zoom slider by name (its aria-label carries "Timeline zoom"); a
  // bare .first() would grab the Stage scrubber, which is also role=slider.
  const zoom = page.getByRole("slider", { name: /Timeline zoom/i });
  const zoomBefore = await zoom.inputValue();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Zoom in timeline" }).click();
  await expect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(Number(zoomBefore));
  await shot(page, "tl-04-zoom");

  // --- Ripple-delete: removes a clip and closes the gap (changes the doc) ---
  const splitCount = await countVideoClips();
  await page.getByRole("button", { name: /clip,/i }).first().click();
  await page.getByRole("button", { name: "Ripple delete" }).click();
  await expect.poll(countVideoClips).toBeLessThan(splitCount);
  await shot(page, "tl-05-ripple");
});

// ---------------------------------------------------------------------------
// 3) Interactive login demo from screenshots.
// ---------------------------------------------------------------------------
test("interactive demo: screenshots → cursor + typed login walkthrough", async ({ page }) => {
  await openEditorWith(page, fixtures.photoPaths); // 4 photos = 4 "screens"
  await expect(applied(page)).toBeVisible({ timeout: 60_000 });
  await expect(applied(page)).toContainText("Cuts");
  await page.getByRole("button", { name: "{ } code" }).click();
  await expect(drawerCode(page)).toBeVisible();

  await send(
    page,
    "make an interactive demo from these screenshots, type email and password then click login",
  );

  // The walkthrough seeds a moving cursor + typewriter fields on screen 1.
  await expect(drawerCode(page)).toContainText('"kind": "cursor"');
  await expect(drawerCode(page)).toContainText('"typewriter"');
  await expect(drawerCode(page)).toContainText('"demo-text"');
  await shot(page, "demo-01-editdoc");

  // Preview at two moments so the typing + cursor are visible in the stills.
  // Seek via the keyboard transport (ArrowRight = +1s), clicking the stage first
  // so focus is on the page body (not a form field, where shortcuts are ignored).
  await page.getByRole("button", { name: "Close code" }).click();
  await page.locator("main").click({ position: { x: 200, y: 120 } });
  await page.keyboard.press("ArrowRight");
  await shot(page, "demo-02-preview-1s");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await shot(page, "demo-03-preview-3s");
});

// ---------------------------------------------------------------------------
// 4) Audio room on a photo slideshow — attach music + duck; check attachment.
// ---------------------------------------------------------------------------
test("audio room: attach music + duck on a slideshow (music-attachment check)", async ({
  page,
}, testInfo) => {
  await openEditorWith(page, fixtures.photoPaths);
  await expect(applied(page)).toBeVisible({ timeout: 60_000 });
  await expect(applied(page)).toContainText("Cuts");

  // Upload the audio with an EXPLICIT audio mime — a bare .webm is sniffed as
  // video by extension, which would replace the slideshow instead of adding music.
  const audioBuffer = readFileSync(fixtures.audioPath);
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "music.webm",
    mimeType: "audio/webm",
    buffer: audioBuffer,
  });
  await expect(page.getByText(/add background music/i)).toBeVisible({ timeout: 30_000 });

  // Open the Audio room and the code drawer.
  const rooms = page.getByRole("navigation", { name: "Rooms" });
  await rooms.getByRole("button", { name: "Audio" }).click();
  await expect(page.getByRole("button", { name: "Use as music" })).toBeVisible();
  await page.getByRole("button", { name: "{ } code" }).click();
  await expect(drawerCode(page)).toBeVisible();
  await shot(page, "audio-01-room");

  // --- Attach music ---
  await page.getByRole("button", { name: "Use as music" }).click();
  await editing(page).waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});

  // Does the music VISIBLY attach? Record the exact observed behavior.
  const docAfterMusic = (await drawerText(page)) ?? "";
  const hasMusicTrack = docAfterMusic.includes('"id": "music"');
  const appliedShowsMusic = ((await applied(page).textContent()) ?? "").includes("Music");
  const musicSliderVisible = await page
    .getByRole("slider", { name: /Music volume/i })
    .isVisible()
    .catch(() => false);
  testInfo.annotations.push({
    type: "music-on-slideshow",
    description: `musicTrackInDoc=${hasMusicTrack} appliedChip=${appliedShowsMusic} volumeSlider=${musicSliderVisible} (preview is silent by design; music only renders on export/ffmpeg)`,
  });
  await shot(page, "audio-02-music-attached");

  // These are expected to hold at the doc/UI level (music DOES attach there).
  expect(hasMusicTrack, "music track present in edit-doc").toBe(true);
  expect(appliedShowsMusic, "Applied strip shows a Music chip").toBe(true);

  // --- Duck under speech (auto-mix) ---
  await page.getByRole("button", { name: "Duck under speech" }).click();
  await editing(page).waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await shot(page, "audio-03-ducked");
});
