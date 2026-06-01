// subagents.test.ts — sub-agent model precedence.

import { describe, expect, test } from "bun:test";
import type { Config } from "./config.ts";
import { pickSubagentModel } from "./subagents.ts";

const cfg = (subagent?: string): Config =>
  ({ model: "opus", models: subagent ? { subagent } : undefined }) as Config;

describe("pickSubagentModel", () => {
  test("explicit request model wins over everything", () => {
    expect(pickSubagentModel("haiku", "sonnet", cfg("gemini"))).toBe("haiku");
  });

  test("agent def model wins over the subagent role", () => {
    expect(pickSubagentModel(undefined, "sonnet", cfg("gemini"))).toBe(
      "sonnet",
    );
  });

  test("subagent role used when no request/def model", () => {
    expect(pickSubagentModel(undefined, undefined, cfg("gemini"))).toBe(
      "gemini",
    );
  });

  test("undefined when nothing is set (caller falls back to parent)", () => {
    expect(pickSubagentModel(undefined, undefined, cfg())).toBeUndefined();
  });
});
