// opencode.test.ts — Zen credential discovery, catalog reading, and gating.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config.ts";
import {
  discoverZenKey,
  gateZenModels,
  OPENCODE_PROVIDER,
  opencodeExtension,
  populateZenModels,
  zenModels,
} from "./opencode.ts";
import { foldPresets } from "./registry.ts";

const cleanups: string[] = [];
afterAll(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
});

async function tempFile(name: string, content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-opencode-"));
  cleanups.push(dir);
  const path = join(dir, name);
  await Bun.write(path, JSON.stringify(content));
  return path;
}

/** A path that exists in no test environment. */
const MISSING = "/nonexistent/cc-test/none.json";

describe("discoverZenKey", () => {
  test("OPENCODE_API_KEY wins over the auth store", async () => {
    const authPath = await tempFile("auth.json", {
      opencode: { type: "api", key: "from-store" },
    });
    expect(
      await discoverZenKey({ OPENCODE_API_KEY: "from-env" }, authPath),
    ).toBe("from-env");
  });

  test("reads an api-type opencode entry from opencode's auth.json", async () => {
    const authPath = await tempFile("auth.json", {
      anthropic: { type: "oauth", access: "a", refresh: "r" },
      opencode: { type: "api", key: "zen-key" },
    });
    expect(await discoverZenKey({}, authPath)).toBe("zen-key");
  });

  test("reads a wellknown-type entry's token", async () => {
    const authPath = await tempFile("auth.json", {
      opencode: { type: "wellknown", key: "k", token: "tok" },
    });
    expect(await discoverZenKey({}, authPath)).toBe("tok");
  });

  test("ignores other vendors' oauth entries (never reuses their tokens)", async () => {
    const authPath = await tempFile("auth.json", {
      anthropic: { type: "oauth", access: "a", refresh: "r" },
      openai: { type: "oauth", access: "a", refresh: "r" },
    });
    expect(await discoverZenKey({}, authPath)).toBeUndefined();
  });

  test("undefined when opencode is not installed (no auth file)", async () => {
    expect(await discoverZenKey({}, MISSING)).toBeUndefined();
  });
});

describe("zenModels", () => {
  test("reads the opencode models.dev cache, carrying vision support", async () => {
    const cachePath = await tempFile("models.json", {
      opencode: {
        models: {
          "claude-sonnet-4-6": { modalities: { input: ["text", "image"] } },
          "qwen3-coder": { modalities: { input: ["text"] } },
        },
      },
    });
    const models = await zenModels(cachePath);
    expect(models).toEqual([
      { id: "claude-sonnet-4-6", supportsVision: true },
      { id: "qwen3-coder", supportsVision: false },
    ]);
  });

  test("falls back to the static set without a cache", async () => {
    const models = await zenModels(MISSING);
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id === "claude-sonnet-4-6")).toBe(true);
  });
});

describe("populateZenModels", () => {
  test("activates the preset when a key is found", async () => {
    const config = defaultConfig();
    foldPresets(config);
    const authPath = await tempFile("auth.json", {
      opencode: { type: "api", key: "zen-key" },
    });
    const result = await populateZenModels(config, {
      env: {},
      authPath,
      cachePath: MISSING,
    });
    const preset = config.providers[OPENCODE_PROVIDER]!;
    expect(result?.count).toBeGreaterThan(0);
    expect(preset.apiKey).toBe("zen-key");
    expect(preset.models?.length).toBe(result?.count);
  });

  test("gates the preset when signed out", async () => {
    const config = defaultConfig();
    foldPresets(config);
    // Pretend a previous activation left state behind.
    config.providers[OPENCODE_PROVIDER]!.apiKey = "stale";
    config.providers[OPENCODE_PROVIDER]!.models = [{ id: "x" }];
    const result = await populateZenModels(config, {
      env: {},
      authPath: MISSING,
    });
    expect(result).toBeUndefined();
    expect(config.providers[OPENCODE_PROVIDER]!.models).toEqual([]);
    expect(config.providers[OPENCODE_PROVIDER]!.apiKey).toBeUndefined();
  });
});

test("login-opencode refuses while the extension is disabled", async () => {
  const config = defaultConfig();
  foldPresets(config);
  config.extensions = { opencode: false };
  config.providers[OPENCODE_PROVIDER]!.models = [{ id: "stale" }];
  const notes: string[] = [];
  const login = opencodeExtension.commands!.find(
    (c) => c.name === "login-opencode",
  )!;
  await login.run({ config, note: (t) => notes.push(t) }, []);
  expect(notes.join("\n")).toContain("disabled");
  // It must not have re-activated the preset either.
  expect(config.providers[OPENCODE_PROVIDER]!.models).toEqual([
    { id: "stale" },
  ]);
});

test("startup gates the preset while the extension is disabled", async () => {
  const config = defaultConfig();
  foldPresets(config);
  config.extensions = { opencode: false };
  config.providers[OPENCODE_PROVIDER]!.apiKey = "k";
  config.providers[OPENCODE_PROVIDER]!.models = [{ id: "x" }];
  expect(await opencodeExtension.startup!(config, "fast")).toBeUndefined();
  expect(config.providers[OPENCODE_PROVIDER]!.models).toEqual([]);
});

test("gateZenModels empties the preset", () => {
  const config = defaultConfig();
  foldPresets(config);
  config.providers[OPENCODE_PROVIDER]!.apiKey = "k";
  config.providers[OPENCODE_PROVIDER]!.models = [{ id: "x" }];
  gateZenModels(config);
  expect(config.providers[OPENCODE_PROVIDER]!.models).toEqual([]);
  expect(config.providers[OPENCODE_PROVIDER]!.apiKey).toBeUndefined();
});
