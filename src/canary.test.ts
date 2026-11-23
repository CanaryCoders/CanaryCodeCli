// canary.test.ts — CanaryLLM model discovery and first-run default.

import { describe, expect, test } from "bun:test";
import { canaryProviderConfig, populateCanaryModels } from "./canary.ts";
import { defaultConfig } from "./config.ts";

const catalogue = {
  success: true,
  data: {
    lmstudio: {
      models: [
        {
          id: "qwen3.6-27b-mlx",
          contextWindow: 32768,
          maxOutputTokens: 8192,
          capabilities: ["chat", "vision"],
        },
      ],
    },
    zhipu: {
      models: [
        {
          id: "glm-5.3",
          contextWindow: 1000000,
          maxOutputTokens: 128000,
          capabilities: ["chat", "reasoning"],
        },
      ],
    },
    ollama: {
      models: [
        {
          id: "flux2-klein",
          contextWindow: 0,
          maxOutputTokens: 0,
          capabilities: ["image-generation"],
        },
      ],
    },
  },
};

const fetchImpl = (async () =>
  new Response(JSON.stringify(catalogue), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

function configWithKey() {
  const config = defaultConfig();
  config.providers.anthropic!.apiKey = "";
  config.providers.canaryllm = {
    ...canaryProviderConfig(),
    apiKey: "clk-test",
  };
  return config;
}

describe("populateCanaryModels", () => {
  test("carries context limits and vision support from the catalogue", async () => {
    const config = configWithKey();
    await populateCanaryModels(config, { fetchImpl });
    expect(config.providers.canaryllm!.models).toEqual([
      {
        id: "lmstudio/qwen3.6-27b-mlx",
        supportsVision: true,
        contextWindow: 32768,
        maxOutputTokens: 8192,
      },
      {
        id: "zhipu/glm-5.3",
        supportsVision: false,
        contextWindow: 1000000,
        maxOutputTokens: 128000,
      },
    ]);
  });

  test("with no Anthropic key the default model moves to CanaryLLM", async () => {
    const config = configWithKey();
    await populateCanaryModels(config, { fetchImpl });
    expect(config.model).toBe("zhipu/glm-5.3");
  });

  test("a configured CanaryLLM model is left alone", async () => {
    const config = configWithKey();
    config.model = "lmstudio/qwen3.6-27b-mlx";
    await populateCanaryModels(config, { fetchImpl });
    expect(config.model).toBe("lmstudio/qwen3.6-27b-mlx");
  });

  test("a usable Anthropic default is left alone", async () => {
    const config = configWithKey();
    config.providers.anthropic!.apiKey = "sk-ant-test";
    await populateCanaryModels(config, { fetchImpl });
    expect(config.model).toBe("opus");
  });
});
