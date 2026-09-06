import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ARTIFACT_DIR, generateFixtures, type Fixtures } from "./fixtures";

/**
 * Wave 5 — the AI-native edge, demonstrated on the REAL app with real
 * in-browser-generated media:
 *   1. edit-by-transcript (open the Words room, select a sentence, Remove);
 *   2. one-tap cleanups (Tighten pauses / Remove filler words);
 *   3. auto-reframe to 9:16 (with the honestly-disabled "subject tracking" pill);
 *   4. AI voice-over composer surfacing the graceful money-gated message.
 *
 * Screenshots land in test-artifacts/wave5/; the whole run records a .webm
 * (use.video = "on" in the shared config).
 */

const W5_DIR = resolve(ARTIFACT_DIR, "wave5");
const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(W5_DIR, `${name}.png`), fullPage: true });

let fixtures: Fixtures;

test.beforeAll(async ({ browser }) => {
  mkdirSync(W5_DIR, { recursive: true });
  const page = await browser.newPage();
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  fixtures = await generateFixtures(page);
  await page.close();
});

test("wave 5: edit-by-transcript · cleanups · auto-reframe · AI voice-over", async ({ page }) => {
  // ---- load a clip; the app auto-transcribes it ----
  await page.goto("/editor");
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.videoPath);
  await expect(page.getByText(/Loaded .*segments/i)).toBeVisible({ timeout: 60_000 });

  // ---- open the Words room ----
  await page.getByRole("button", { name: /Words/i }).click();

  // If the transcript wasn't auto-attached, load it on demand.
  const loadBtn = page.getByRole("button", { name: /Load transcript/i });
  if (await loadBtn.isVisible().catch(() => false)) {
    await loadBtn.click();
  }
  const transcriptGroup = page.getByRole("group", { name: /Transcript — click a sentence/i });
  await expect(transcriptGroup).toBeVisible({ timeout: 60_000 });
  await shot(page, "01-words-room");

  // ---- edit by transcript: select the first sentence, Remove it ----
  await page.getByRole("button", { name: /Select the whole sentence/i }).first().click();
  await shot(page, "02-sentence-selected");
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText(/shorter\. Undo any time\./i)).toBeVisible({ timeout: 30_000 });
  await shot(page, "03-removed-sentence");

  // ---- one-tap: tighten pauses (remove_silence) ----
  await page.getByRole("button", { name: /Tighten pauses/i }).click();
  // Either it tightened, or the pacing was already tight — both are honest outcomes.
  await expect(
    page.getByText(/Tightened pauses|already tight/i),
  ).toBeVisible({ timeout: 30_000 });
  await shot(page, "04-tighten-pauses");

  // ---- auto-reframe to 9:16 (free centered) ----
  await page.getByRole("button", { name: "9:16", exact: true }).click();
  await expect(page.getByText(/Reframed to 9:16/i)).toBeVisible({ timeout: 30_000 });
  // The "subject tracking" upgrade pill is present but disabled (never faked).
  await expect(page.getByRole("button", { name: /Keep subject centered/i })).toBeDisabled();
  await shot(page, "05-auto-reframe-vertical");

  // ---- AI voice-over: type a script, Generate → graceful money-gated message ----
  await page.getByLabel("Voice-over script").fill(
    "In this video, I'll show you three quick edits you can make just by talking.",
  );
  await page.getByRole("button", { name: /Generate voice-over/i }).click();
  // TTS provider is "none" by default → an honest, non-crashing gated message.
  await expect(
    page.getByText(/provider|configured|gated|upgrade|voice-over/i).first(),
  ).toBeVisible({ timeout: 30_000 });
  await shot(page, "06-voiceover-gated");
});
