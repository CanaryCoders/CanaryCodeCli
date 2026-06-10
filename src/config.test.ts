// config.test.ts — role-to-model resolution and config merging.

import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Config,
  getRawConfigPath,
  loadConfig,
  modelForRole,
  modelSupportsVision,
  redactConfig,
  replaceConfigInPlace,
  setRawConfigPath,
  summarizeConfig,
  unsetRawConfigPath,
  validateConfigPathValue,
} from "./config.ts";

describe("modelSupportsVision", () => {
  test("respects an explicit supportsVision flag", () => {
    expect(modelSupportsVision({ id: "m", supportsVision: false })).toBe(false);
    expect(modelSupportsVision({ id: "m", supportsVision: true })).toBe(true);
  });

  test("defaults to true when the flag is absent (modern models are multimodal)", () => {
    expect(modelSupportsVision({ id: "opus" })).toBe(true);
  });
});

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "opus",
    providers: {},
    webSearch: {},
    mcpServers: {},
    ui: { nerdFont: false },
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

  test("loadConfig merges ui settings", async () => {
    const path = join(tmpdir(), `cc-config-ui-test-${process.pid}.json`);
    await Bun.write(path, JSON.stringify({ ui: { nerdFont: true } }));
    const loaded = await loadConfig(path);
    expect(loaded.ui.nerdFont).toBe(true);
  });
});

describe("replaceConfigInPlace", () => {
  test("same reference, new contents, stale keys dropped", () => {
    const target = { a: 1, stale: true } as unknown as Config;
    const next = { a: 2, fresh: "yes" } as unknown as Config;
    const ref = target;
    replaceConfigInPlace(target, next);
    expect(ref).toBe(target);
    expect(ref as unknown as Record<string, unknown>).toEqual({
      a: 2,
      fresh: "yes",
    });
  });
});

describe("raw config path helpers", () => {
  test("set/get/unset preserve unrelated keys and env placeholders", async () => {
    const path = join(tmpdir(), `cc-config-raw-${process.pid}.json`);
    await Bun.write(
      path,
      JSON.stringify({
        providers: {
          anthropic: { api: "anthropic", apiKey: "${ANTHROPIC_API_KEY}" },
        },
        custom: { untouched: true },
      }),
    );

    await setRawConfigPath("permission.mode", "ai", path);
    await setRawConfigPath("ui.nerdFont", true, path);
    // Config can hold inline API keys — every write must leave it owner-only.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await getRawConfigPath("permission.mode", path)).toBe("ai");
    expect(await getRawConfigPath("ui.nerdFont", path)).toBe(true);

    const raw = JSON.parse(await Bun.file(path).text());
    expect(raw.custom.untouched).toBe(true);
    expect(raw.providers.anthropic.apiKey).toBe("${ANTHROPIC_API_KEY}");

    await unsetRawConfigPath("permission.mode", path);
    expect(await getRawConfigPath("permission.mode", path)).toBeUndefined();
  });

  test("set creates parent directories and accepts custom provider/mcp/hook objects", async () => {
    const path = join(
      tmpdir(),
      `cc-config-dir-${process.pid}`,
      ".cc",
      "config.json",
    );
    await setRawConfigPath(
      "providers.local",
      { api: "openai-compat", baseUrl: "http://localhost" },
      path,
    );
    await setRawConfigPath(
      "mcpServers.fs",
      { command: "node", args: ["server.js"] },
      path,
    );
    await setRawConfigPath("hooks.PreToolUse", [{ command: "echo hi" }], path);
    const raw = JSON.parse(await Bun.file(path).text());
    expect(raw.providers.local.api).toBe("openai-compat");
    expect(raw.mcpServers.fs.command).toBe("node");
    expect(raw.hooks.PreToolUse[0].command).toBe("echo hi");
  });

  test("validates known paths", () => {
    expect(() => validateConfigPathValue("confirm", "nope")).toThrow();
    expect(() =>
      validateConfigPathValue("thinking", "think-hard"),
    ).not.toThrow();
    expect(() => validateConfigPathValue("permission.scope", "all")).toThrow();
    expect(() =>
      validateConfigPathValue("permission.failClosed", "yes"),
    ).toThrow();
    expect(() =>
      validateConfigPathValue("permission.failClosed", true),
    ).not.toThrow();
    expect(() => validateConfigPathValue("providers.x.api", "bogus")).toThrow();
    expect(() =>
      validateConfigPathValue("webSearch.apiKey", "${BRAVE_API_KEY}"),
    ).not.toThrow();
    expect(() => validateConfigPathValue("autoMaxTurns", 0)).toThrow();
    expect(() => validateConfigPathValue("checkpointEvery", 0)).not.toThrow();
    expect(() => validateConfigPathValue("ui.nerdFont", "true")).toThrow();
    expect(() =>
      validateConfigPathValue("autoUpdate.enabled", false),
    ).not.toThrow();
  });

  test("redacts sensitive keys in display helpers", () => {
    const redacted = redactConfig({
      apiKey: "secret",
      nested: { token: "tok", baseUrl: "https://example.com" },
      providers: { x: { apiKey: "secret2" } },
    }) as Record<string, unknown>;
    expect(redacted.apiKey).toBe("<redacted>");
    expect((redacted.nested as Record<string, unknown>).token).toBe(
      "<redacted>",
    );
    expect((redacted.nested as Record<string, unknown>).baseUrl).toBe(
      "https://example.com",
    );
    expect(summarizeConfig(redacted)).not.toContain("secret");
  });
});
