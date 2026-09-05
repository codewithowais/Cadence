import type { NextConfig } from "next";

const config: NextConfig = {
  // Our workspace packages ship TypeScript source (no build step); let Next compile them.
  transpilePackages: [
    "@cadence/core",
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
  serverExternalPackages: ["@napi-rs/canvas"],
};

export default config;
