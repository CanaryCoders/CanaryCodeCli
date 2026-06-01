// openai-codex.test.ts — model-handle parsing and catalog discovery.

import { describe, expect, test } from "bun:test";
import type { Config } from "./config.ts";
import {
  type CodexPopulateResult,
  OPENAI_PROVIDER,
  openaiCodexProviderConfig,
  parseCodexModel,
  populateCodexModels,
} from "./openai-codex.ts";

describe("parseCodexModel", () => {
  test("splits a trailing effort token off the slug", () => {
    expect(parseCodexModel("gpt-5.5 xhigh")).toEqual({
      slug: "gpt-5.5",
      effort: "xhigh",
    });
    expect(parseCodexModel("gpt-5.3-codex high")).toEqual({
      slug: "gpt-5.3-codex",
      effort: "high",
    });
  });

  test("a bare slug has no effort", () => {
    expect(parseCodexModel("gpt-5.5")).toEqual({ slug: "gpt-5.5" });
  });

  test("a non-effort trailing token is left on the slug", () => {
    expect(parseCodexModel("gpt-5.5 turbo")).toEqual({ slug: "gpt-5.5 turbo" });
  });
});

function configWithCodex(): Config {
  return {
    model: "opus",
    providers: { [OPENAI_PROVIDER]: openaiCodexProviderConfig() },
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
  };
}

const fakeToken = {
  async get() {
    return { accessToken: "t", accountId: "a" };
  },
  async forceRefresh() {
    return { accessToken: "t", accountId: "a" };
  },
};

describe("populateCodexModels", () => {
  test("lists each visible model as a bare slug, hidden ones excluded", async () => {
    const catalog = {
      models: [
        { slug: "gpt-5.5", visibility: "list" },
        { slug: "gpt-5.3-codex", visibility: "list" },
        { slug: "gpt-5.5", visibility: "list" }, // duplicate ignored
        { slug: "hidden-model", visibility: "hide" },
      ],
    };
    const config = configWithCodex();
    const result = (await populateCodexModels(config, {
      tokenGetter: fakeToken,
      fetchImpl: (async () =>
        new Response(JSON.stringify(catalog), {
          status: 200,
        })) as unknown as typeof fetch,
    })) as { count: number };

    const ids = config.providers[OPENAI_PROVIDER]!.models?.map((m) => m.id);
    expect(ids).toEqual(["gpt-5.5", "gpt-5.3-codex"]);
    expect(result.count).toBe(2);
  });

  test("falls back to a static list when the fetch fails", async () => {
    const config = configWithCodex();
    const result = (await populateCodexModels(config, {
      tokenGetter: fakeToken,
      fetchImpl: (async () =>
        new Response("nope", { status: 500 })) as unknown as typeof fetch,
    })) as CodexPopulateResult;

    expect("error" in result).toBe(true);
    const ids =
      config.providers[OPENAI_PROVIDER]!.models?.map((m) => m.id) ?? [];
    expect(ids.some((id) => id.startsWith("gpt-5.5"))).toBe(true);
    expect(ids).not.toContain("gpt-5.2-codex");
  });
});
