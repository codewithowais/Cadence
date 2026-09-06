/**
 * @cadence/enhance — CLI arg templating, provider selection from config, and the
 * standing faithfulness contract (every provider preserves identity).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCliArgs,
  configFromEnv,
  selectProvider,
  allProviders,
} from "@cadence/enhance";

test("buildCliArgs substitutes {tokens} and splits into argv", () => {
  const args = buildCliArgs("esrgan -i {input} -o {output} -s {scale}", {
    input: "a.png",
    output: "b.png",
    scale: 4,
  });
  assert.deepEqual(args, ["esrgan", "-i", "a.png", "-o", "b.png", "-s", "4"]);
});

test("buildCliArgs keeps quoted tokens (paths with spaces) as one argv item", () => {
  const args = buildCliArgs('up "{input}" "{output}"', {
    input: "/my videos/in.png",
    output: "/my videos/out.png",
  });
  assert.deepEqual(args, ["up", "/my videos/in.png", "/my videos/out.png"]);
});

test("buildCliArgs replaces a missing var with an empty string", () => {
  assert.deepEqual(buildCliArgs("x {missing}", {}), ["x", ""]);
});

test("selectProvider maps ENHANCE_PROVIDER to the right provider", () => {
  assert.equal(selectProvider(configFromEnv({})).id, "free");
  assert.equal(selectProvider(configFromEnv({ ENHANCE_PROVIDER: "local" })).id, "local");
  assert.equal(selectProvider(configFromEnv({ ENHANCE_PROVIDER: "api" })).id, "api");
  assert.equal(selectProvider(configFromEnv({ ENHANCE_PROVIDER: "cli", ENHANCE_CLI_COMMAND: "x {input}" })).id, "cli");
});

test("selectProvider falls back to free for 'none' and unknown providers", () => {
  assert.equal(selectProvider(configFromEnv({ ENHANCE_PROVIDER: "none" })).id, "free");
  assert.equal(selectProvider(configFromEnv({ ENHANCE_PROVIDER: "wat" })).id, "free");
});

test("configFromEnv lowercases the provider name", () => {
  assert.equal(configFromEnv({ ENHANCE_PROVIDER: "LOCAL" }).provider, "local");
});

test("every provider preserves identity (faithfulness contract)", () => {
  const providers = allProviders(configFromEnv({}));
  assert.ok(providers.length >= 4);
  assert.ok(providers.every((p) => p.preservesIdentity === true), "a provider is not identity-preserving");
});

test("the provider roster offers both a non-AI and AI options", () => {
  const providers = allProviders(configFromEnv({}));
  assert.ok(providers.some((p) => !p.usesAI), "expected a non-AI (free) provider");
  assert.ok(providers.some((p) => p.usesAI), "expected at least one AI provider");
});
