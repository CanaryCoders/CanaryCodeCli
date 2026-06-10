// subagents.test.ts — sub-agent model precedence and gate propagation.

import { describe, expect, test } from "bun:test";
import type { Config } from "./config.ts";
import type { Provider, StreamEvent } from "./provider.ts";
import { pickSubagentModel, Semaphore, spawnAgentTool } from "./subagents.ts";
import type { Tool } from "./tools.ts";

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

// A two-turn fake provider: turn 1 calls the `mutate` tool, turn 2 just stops.
function mutateOnceProvider(): Provider {
  let turn = 0;
  return {
    id: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      if (turn++ === 0) {
        yield { type: "tool_use", id: "c1", name: "mutate", input: {} };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "stop" };
      }
    },
  };
}

describe("spawnAgentTool gate propagation", () => {
  test("spawn_agent child respects the parent gate", async () => {
    let toolRan = false;
    let gateCalled = false;
    const mutating: Tool = {
      name: "mutate",
      description: "",
      readOnly: false,
      schema: { type: "object", properties: {} },
      async run() {
        toolRan = true;
        return "did it";
      },
    };
    const tool = spawnAgentTool({
      config: {
        maxDepth: 1,
        maxConcurrent: 1,
        autoMaxTurns: 5,
        hooks: {},
      } as Config,
      parentProvider: mutateOnceProvider(),
      parentModel: "m",
      inheritedTools: [mutating],
      depth: 0,
      limiter: new Semaphore(1),
      gate: async () => {
        gateCalled = true;
        return { allow: false, reason: "denied by test" };
      },
    });
    await tool.run({ task: "do the thing" });
    expect(gateCalled).toBe(true);
    expect(toolRan).toBe(false);
  });
});
