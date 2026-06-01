// config.test.ts — role-to-model resolution and config merging.

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig, modelForRole } from "./config.ts";

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "opus",
    providers: {},
    webSearch: {},
    mcpServers: {},
    autoMaxTurns: 25,
    checkpointEvery: 50,
    maxConcurrent: 3,
    maxDepth: 2,
    compactAtTokens: 120_000,
    confirm: "off",
    permission: { mode: "off", model: "haiku", scope: "writes" },
    hooks: {},
    thinking: "off",
    autoUpdate: { enabled: true },
    ...overrides,
  };
}

describe("modelForRole", () => {
  test("reasoning/coding fall back to base model when unset", () => {
    const c = baseConfig();
    expect(modelForRole(c, "reasoning")).toBe("opus");
    expect(modelForRole(c, "coding")).toBe("opus");
  });

  test("explicit role overrides win", () => {
    const c = baseConfig({ models: { reasoning: "opus", coding: "sonnet" } });
    expect(modelForRole(c, "reasoning")).toBe("opus");
    expect(modelForRole(c, "coding")).toBe("sonnet");
  });

  test("permission falls back to legacy permission.model then haiku", () => {
    expect(modelForRole(baseConfig(), "permission")).toBe("haiku");
    expect(
      modelForRole(
        baseConfig({ models: { permission: "sonnet" } }),
        "permission",
      ),
    ).toBe("sonnet");
    const noLegacy = baseConfig({
      permission: { mode: "off", scope: "writes" } as Config["permission"],
    });
    expect(modelForRole(noLegacy, "permission")).toBe("haiku");
  });

  test("loadConfig merges a user models map", async () => {
    const path = join(tmpdir(), `cc-config-test-${process.pid}.json`);
    await Bun.write(path, JSON.stringify({ models: { coding: "sonnet" } }));
    const loaded = await loadConfig(path);
    expect(loaded.models?.coding).toBe("sonnet");
    expect(modelForRole(loaded, "coding")).toBe("sonnet");
    expect(modelForRole(loaded, "reasoning")).toBe(loaded.model);
  });
});
