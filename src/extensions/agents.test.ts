// agents.test.ts — delegation: agentsExtension factory, sub-agent model
// precedence, and gate propagation.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { defaultConfig } from "../config.ts";
import type { Provider, StreamEvent } from "../provider.ts";
import type { Tool } from "../tools.ts";
import {
  agentsExtension,
  pickSubagentModel,
  Semaphore,
  spawnAgentTool,
} from "./agents.ts";

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
      inheritedTools: () => [mutating],
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

// ---------------------------------------------------------------------------
// agentsExtension factory
// ---------------------------------------------------------------------------

/** Minimal ExtensionContext stub the factory needs. */
function extCtx(config: Config) {
  return {
    config,
    note: () => {},
    provider: { id: "fake" } as Provider,
    model: "m",
    signal: undefined,
    getTools: () => [],
    gate: undefined,
  } as never;
}

describe("agentsExtension factory", () => {
  test("maxDepth=0 ⇒ no tools and no system prompt", async () => {
    const config = { ...defaultConfig(), maxDepth: 0 } as Config;
    const ext = agentsExtension();
    const tools = await ext.tools!(extCtx(config));
    expect(tools).toEqual([]);
    expect(ext.systemPrompt!(extCtx(config))).toBeUndefined();
  });

  test("maxDepth>0 ⇒ one spawn_agent tool and a Delegation prompt", async () => {
    const config = defaultConfig(); // maxDepth defaults to 2
    const ext = agentsExtension([]); // no custom-agent dirs
    const tools = await ext.tools!(extCtx(config));
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("spawn_agent");
    expect(tools[0]!.readOnly).toBe(false);
    const section = ext.systemPrompt!(extCtx(config));
    expect(section).toContain("## Delegation");
  });

  test("custom agents are discovered and announced via the factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-agents-test-"));
    try {
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, "test-writer.md"),
        "---\nname: test-writer\ndescription: writes tests\n---\n\nYou write tests.",
      );
      const config = defaultConfig();
      const ext = agentsExtension([{ dir: root, source: "project" }]);
      await ext.tools!(extCtx(config));
      const section = ext.systemPrompt!(extCtx(config));
      expect(section).toContain("## Delegation");
      expect(section).toContain("test-writer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
