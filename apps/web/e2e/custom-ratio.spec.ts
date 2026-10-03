import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures } from "./fixtures";

/**
 * Custom ratio (Canva "custom size" · CapCut "ratio" · Premiere sequence settings) on
 * REAL in-browser media: the Canvas panel (type W×H / ratio, link-lock, rotate,
 * validation, presets, saved sizes), Fit/Fill with blurred or solid bars on the Stage,
 * safe-zone guides, Magic resize, and the Director phrases ("make it 3:2",
 * "resize for all social platforms"). Every assertion reads the edit-doc from the code
 * drawer (edits-as-code).
 */

let fixtures: Fixtures;

const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(ARTIFACT_DIR, `canvas-${name}.png`), fullPage: true });

interface DocShape {
  meta: { width: number; height: number; canvas?: { fit?: string; fill?: string; ratio?: string; fillColor?: string; customPresets?: { name: string; width: number; height: number }[]; magicTargets?: string[] } };
}
const readDoc = async (page: Page): Promise<DocShape> =>
  JSON.parse((await page.locator("pre code").textContent()) ?? "{}") as DocShape;

const composer = (page: Page) => page.getByPlaceholder("Describe the edit…");
const editing = (page: Page) => page.getByText("Director is editing…");
async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await editing(page).waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
  await editing(page).waitFor({ state: "hidden", timeout: 90_000 });
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const page = await browser.newPage();
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.close();
});

test("custom ratio: panel · validation · presets · fit · safe zones · magic resize · Director", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.videoPath);
  await expect(page.getByText(/Loaded .*spoken segments/i)).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "{ } code" }).click();
  await expect(page.locator("pre code")).toBeVisible();

  // --- Open from the top bar -------------------------------------------------------
  const chip = page.getByTestId("canvas-chip");
  await expect(chip).toBeVisible();
  await chip.click();
  const panel = page.getByTestId("canvas-panel");
  await expect(panel).toBeVisible();
  const w = panel.getByLabel("Canvas width in pixels");
  const h = panel.getByLabel("Canvas height in pixels");
  await expect(w).toHaveValue("1280");
  await expect(h).toHaveValue("720");
  await shot(page, "01-panel");

  // --- Validation: empty/zero is refused; odd numbers round to even ---------------
  const apply = panel.getByRole("button", { name: "Apply", exact: true });
  await panel.getByRole("button", { name: /Ratio (locked|unlocked)/ }).click(); // unlock
  await w.fill("0");
  await expect(apply).toBeDisabled();
  await expect(panel.getByTestId("canvas-hint")).toContainText(/positive/i);
  await w.fill("1081");
  await h.fill("1351");
  await expect(panel.getByTestId("canvas-hint")).toContainText("1082×1352");
  await w.fill("1080");
  await h.fill("1350");
  await apply.click();
  await expect.poll(async () => (await readDoc(page)).meta.width).toBe(1080);
  expect((await readDoc(page)).meta.height).toBe(1350);
  // The Stage frame takes the exact aspect.
  const ratio = await page.evaluate(() => {
    const el = document.querySelector("[style*='aspect-ratio']") as HTMLElement | null;
    return el ? el.style.aspectRatio : "";
  });
  expect(ratio.replace(/\s/g, "")).toBe("1080/1350");
  await shot(page, "02-1080x1350");

  // --- Link-lock keeps the ratio while typing --------------------------------------
  await panel.getByRole("button", { name: /Ratio unlocked/ }).click(); // lock at 4:5
  await w.fill("540");
  await expect(h).toHaveValue("675");
  await w.fill("1080");

  // --- Rotate swaps orientation ----------------------------------------------------
  await panel.getByRole("button", { name: /Rotate/ }).click();
  await expect.poll(async () => (await readDoc(page)).meta.width).toBe(1350);
  expect((await readDoc(page)).meta.height).toBe(1080);

  // --- A typed ratio ---------------------------------------------------------------
  await panel.getByLabel("Canvas ratio").fill("21:9");
  await panel.getByRole("button", { name: /Set 2560×1080/ }).click();
  await expect.poll(async () => (await readDoc(page)).meta.width).toBe(2560);
  expect((await readDoc(page)).meta.canvas?.ratio).toBe("21:9");
  await panel.getByLabel("Canvas ratio").fill("zzz");
  await expect(panel.getByRole("alert")).toContainText(/usable ratio/i);
  await panel.getByLabel("Canvas ratio").fill("");

  // --- A platform preset, then Fit with blurred bars --------------------------------
  await panel.getByLabel("Search size presets").fill("tiktok");
  await panel.getByRole("button", { name: /^TikTok/ }).click();
  await expect.poll(async () => (await readDoc(page)).meta.height).toBe(1920);
  expect((await readDoc(page)).meta.width).toBe(1080);
  await panel.getByLabel("Search size presets").fill("");

  await panel.getByRole("button", { name: /Fit · blur/ }).click();
  await expect.poll(async () => (await readDoc(page)).meta.canvas?.fit).toBe("fit");
  expect((await readDoc(page)).meta.canvas?.fill).toBe("blur");
  await expect(page.locator("video[data-fit-backdrop='blur']")).toHaveCount(1);
  await expect(page.locator("video.object-contain")).toHaveCount(1);
  await shot(page, "03-fit-blur");

  // --- Fit with a solid colour: no backdrop copy, frame takes the bar colour --------
  await panel.getByRole("button", { name: /Fit · color/ }).click();
  await expect.poll(async () => (await readDoc(page)).meta.canvas?.fill).toBe("solid");
  await expect(page.locator("[data-fit-backdrop]")).toHaveCount(0);
  await expect(page.locator("video.object-contain")).toHaveCount(1);

  // --- Fill is the default cover ----------------------------------------------------
  await panel.getByRole("button", { name: /^Fill/ }).click();
  await expect.poll(async () => (await readDoc(page)).meta.canvas?.fit).toBe("fill");
  await expect(page.locator("video.object-cover:not([data-fit-backdrop])")).toHaveCount(1);

  // --- Safe-zone guides --------------------------------------------------------------
  await expect(page.getByTestId("safe-zone-overlay")).toHaveCount(0);
  await panel.getByRole("radio", { name: "TikTok" }).click();
  await expect(page.getByTestId("safe-zone-overlay")).toHaveAttribute("data-safe-zone", "tiktok");
  await shot(page, "04-safe-zone");
  await panel.getByRole("radio", { name: "Off" }).click();
  await expect(page.getByTestId("safe-zone-overlay")).toHaveCount(0);

  // --- Saved sizes: persisted in the doc, listed, deletable --------------------------
  await panel.getByLabel("Name for saved size").fill("My vertical");
  await panel.getByRole("button", { name: "Save size" }).click();
  await expect.poll(async () => (await readDoc(page)).meta.canvas?.customPresets?.[0]?.name).toBe("My vertical");
  await expect(panel.getByRole("button", { name: /^My vertical/ })).toBeVisible();
  await panel.getByRole("button", { name: "Delete saved size My vertical" }).click();
  await expect(panel.getByRole("button", { name: /^My vertical/ })).toHaveCount(0);

  // --- Undo restores the previous canvas ---------------------------------------------
  const before = (await readDoc(page)).meta.width;
  await panel.getByLabel("Search size presets").fill("a4 landscape");
  await panel.getByRole("button", { name: /^A4 landscape/ }).click();
  await expect.poll(async () => (await readDoc(page)).meta.width).toBe(3508);
  await page.getByRole("button", { name: /^Undo/ }).first().click();
  await expect.poll(async () => (await readDoc(page)).meta.width).not.toBe(3508);
  void before;

  // --- Magic resize: pick sizes → copies (no database ⇒ files) -------------------------
  await panel.getByRole("radio", { name: "Magic resize" }).click();
  await expect(panel.getByTestId("magic-count")).toContainText("6 selected");
  await panel.getByRole("button", { name: "Clear" }).click();
  await expect(panel.getByTestId("magic-count")).toContainText("0 selected");
  await panel.getByRole("button", { name: "Social set" }).click();
  const downloads: string[] = [];
  page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await panel.getByRole("button", { name: /Create 6 copies/ }).click();
  await expect(panel.getByRole("status")).toContainText(/Created 6 sibling projects|downloaded as .editdoc.json/i, { timeout: 30_000 });
  await expect(panel.getByTestId("magic-status-tiktok")).toContainText("✓");
  if (downloads.length) expect(downloads.every((n) => n.endsWith(".editdoc.json"))).toBe(true);
  await shot(page, "05-magic");
  await panel.getByRole("button", { name: "Close canvas panel" }).click();
  await expect(panel).toBeHidden();

  // --- Director phrases ---------------------------------------------------------------
  await send(page, "make it 3:2");
  await expect.poll(async () => (await readDoc(page)).meta.width).toBe(1620);
  expect((await readDoc(page)).meta.height).toBe(1080);
  await send(page, "make it 1080 by 1350");
  await expect.poll(async () => (await readDoc(page)).meta.height).toBe(1350);
  await send(page, "fit the whole video with a blurred background");
  await expect.poll(async () => (await readDoc(page)).meta.canvas?.fit).toBe("fit");
  await send(page, "resize for all social platforms");
  await expect(page.getByTestId("canvas-panel")).toBeVisible();
  await expect(page.getByTestId("magic-count")).toContainText("6 selected");
  expect((await readDoc(page)).meta.canvas?.magicTargets?.length).toBeGreaterThanOrEqual(5);
  await shot(page, "06-director-magic");

  expect(errors, `uncaught page errors: ${errors.join(" | ")}`).toEqual([]);
});
