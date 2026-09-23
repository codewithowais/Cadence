import type { NextConfig } from "next";

const config: NextConfig = {
  // Our workspace packages ship TypeScript source (no build step); let Next compile them.
  transpilePackages: [
    "@cadence/core",
    "@cadence/db",
    "@cadence/director",
    "@cadence/understanding",
    "@cadence/render-node",
    "@cadence/enhance",
    "@cadence/render-ffmpeg",
  ],
  // Native Skia canvas must not be bundled — keep it external to the server build.
  // NOTE: @cadence/render-ffmpeg ships TS source (needs transpiling) and has no
  // native addon — it only shells out to the SYSTEM ffmpeg via node:child_process
  // (a Node builtin Next externalizes automatically). So it stays in
  // transpilePackages; Turbopack forbids a package in BOTH lists at once.
  //
  // `pg` (node-postgres) must be external, NOT bundled: it does conditional
  // requires of optional peers (`pg-native`, `pg-cloudflare`) that the bundler
  // would try (and fail) to resolve. Next ships `pg` in its default external
  // list; we pin it explicitly so the intent survives config changes. `@cadence/db`
  // itself ships TS source and stays in transpilePackages (a different package —
  // no Turbopack both-lists conflict).
  serverExternalPackages: ["@napi-rs/canvas", "pg", "ffmpeg-static"],
  // The export/render routes rasterize text through Skia with the BUNDLED fonts
  // (public/fonts, registered by @cadence/render-node). Public files aren't in a
  // serverless function's trace by default, so include the latin woff2 files the
  // node renderer registers — otherwise exported text would fall back to system
  // fonts (no-op on the Docker/Render deploy, where the whole app is on disk).
  outputFileTracingIncludes: {
    "/api/export": ["./public/fonts/**/*-latin-*.woff2"],
    "/api/render": ["./public/fonts/**/*-latin-*.woff2"],
  },
};

export default config;
