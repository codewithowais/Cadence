import { defineConfig, devices } from "@playwright/test";

/**
 * Cadence end-to-end tests. Drives the REAL app (Director API, upload, export)
 * with a real in-browser-generated video + photos.
 *
 * A dev server is normally already running at :3000 during local QA — the
 * `webServer` block reuses it. In CI (no server yet) it boots `npm run dev`
 * and waits for the port before the suite starts.
 */
const PORT = Number(process.env.CADENCE_E2E_PORT ?? 3000);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Fixture generation (canvas → MediaRecorder) + the full flow are sequential
  // by nature; keep it single-worker and give real edits room to render.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  // Per-test artifacts (videos, traces) land under the (gitignored) test-artifacts
  // dir so a QA run leaves everything collectable in one place. Playwright writes
  // each test's recording to <outputDir>/<test-title-slug>/video.webm.
  outputDir: "../../test-artifacts/pw-output",
  // Keep artifacts for passing runs too — this suite exists to SHOW the app, so
  // every run's video is worth keeping, not just failures.
  preserveOutput: "always",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Record a .webm of every test (docs: TestOptions.video "on" = record + keep
    // for every run). Videos are finalized when the page/context closes.
    video: { mode: "on", size: { width: 1280, height: 800 } },
    // MediaRecorder + canvas.captureStream need no special flags in Chromium,
    // but fake media avoids any device-permission prompt.
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
