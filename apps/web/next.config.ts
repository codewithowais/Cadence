import type { NextConfig } from "next";

const config: NextConfig = {
  // Our workspace packages ship TypeScript source (no build step); let Next compile them.
  transpilePackages: [
    "@cadence/core",
    "@cadence/director",
    "@cadence/understanding",
    "@cadence/render-node",
  ],
  // Native Skia canvas must not be bundled — keep it external to the server build.
  serverExternalPackages: ["@napi-rs/canvas"],
};

export default config;
