// claude.test.ts — the Claude Code provider (relocated into the plugin) and the
// provider-factory seam that lets `createProvider` resolve it without the harness
// hardcoding any SDK-specific code.

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AgentEvent, AgentOptions } from "../agent.ts";
import type { Message } from "../provider.ts";
import {
  clearProviderFactories,
  createProvider,
  registerProviderFactory,
  type StreamEvent,
} from "../provider.ts";
import type { Tool } from "../tools.ts";
import {
  CLAUDE_CODE_API,
  type ClaudeCodeOptions,
  claudeCodeExtension,
  claudeCodeProvider,
  jsonSchemaToZodShape,
  partitionTools,
} from "./claude.ts";

/** A trivial Tool for partition / forwarding tests. */
function mkTool(name: string, over: Partial<Tool> = {}): Tool {
  return {
    name,
    description: name,
    schema: { type: "object", properties: {} },
    readOnly: false,
    run: async () => "",
    ...over,
  };
}

async function collect(
  stream: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

async function collectAgent(
  gen: AsyncGenerator<AgentEvent>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Minimal AgentOptions for exercising the driver directly. */
function agentOpts(
  over: Partial<AgentOptions> & { messages: Message[] },
): AgentOptions {
  return {
    provider: claudeCodeProvider(),
    model: "sonnet",
    system: "be helpful",
    tools: [],
    ...over,
  };
}

/**
 * A fake SDK `query` that plays one tool-using turn: streams text, emits an
 * assistant tool_use, consults the supplied canUseTool, then reflects the
 * decision as a tool_result and a terminal result. Mirrors the real SDK's
 * message ordering so the driver is exercised end-to-end.
 */
const oneToolTurnQuery: ClaudeCodeOptions["query"] = async function* ({
  options,
}) {
  const canUseTool = options?.canUseTool as
    | ((
        name: string,
        input: Record<string, unknown>,
        extra: { signal: AbortSignal },
      ) => Promise<
        { behavior: "allow" } | { behavior: "deny"; message: string }
      >)
    | undefined;
  yield {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Listing. " },
    },
  };
  yield {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Listing. " },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
    },
  };
  const decision = (await canUseTool?.(
    "Bash",
    { command: "ls" },
    {
      signal: new AbortController().signal,
    },
  )) ?? { behavior: "allow" };
  yield {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content:
            decision.behavior === "allow" ? "a.txt\nb.txt" : decision.message,
          is_error: decision.behavior === "deny",
        },
      ],
    },
  };
  yield {
    type: "result",
    subtype: "success",
    total_usage: { input_tokens: 12, output_tokens: 7 },
  };
};

afterEach(() => {
  clearProviderFactories();
});

describe("claude-code single-turn stream (summarization path)", () => {
  test("maps SDK partial messages to StreamEvents", async () => {
    const query: ClaudeCodeOptions["query"] = async function* () {
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" },
        },
      };
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "ponder" },
        },
      };
      yield {
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 4 },
        },
      };
      yield {
        type: "result",
        subtype: "success",
        total_usage: { input_tokens: 9, output_tokens: 4 },
      };
    };
    const provider = claudeCodeProvider({ query });
    const events = await collect(
      provider.stream({
        model: "sonnet",
        system: "sys",
        messages: [],
        tools: [],
      }),
    );

    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "thinking_delta", text: "ponder" },
      { type: "usage", inputTokens: 0, outputTokens: 4 },
      { type: "usage", inputTokens: 9, outputTokens: 4 },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  test("summarization path is tool-free and single-turn", async () => {
    let sentOptions: Record<string, unknown> = {};
    const provider = claudeCodeProvider({
      query: async function* ({ options }) {
        sentOptions = options ?? {};
        yield { type: "result", subtype: "success" };
      },
    });
    await collect(
      provider.stream({ model: "sonnet", system: "", messages: [], tools: [] }),
    );

    expect(sentOptions.tools).toEqual([]);
    expect(sentOptions.maxTurns).toBe(1);
    expect(sentOptions.permissionMode).toBe("dontAsk");
  });
});

describe("runSession native loop", () => {
  test("terminates and renders text + tool card + usage + done (freeze fixed)", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "list files" }] },
    ];
    const provider = claudeCodeProvider({ query: oneToolTurnQuery });
    const events = await collectAgent(
      provider.runSession!(agentOpts({ messages })),
    );

    expect(events).toEqual([
      { type: "text", text: "Listing. " },
      { type: "tool_start", id: "t1", name: "Bash", input: { command: "ls" } },
      { type: "turn_end" },
      {
        type: "tool_end",
        id: "t1",
        name: "Bash",
        result: "a.txt\nb.txt",
        isError: false,
      },
      { type: "usage", inputTokens: 12, outputTokens: 7 },
      { type: "done", reason: "stop" },
    ]);
  });

  test("appends the produced assistant + tool turns to the transcript", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "list files" }] },
    ];
    const provider = claudeCodeProvider({ query: oneToolTurnQuery });
    await collectAgent(provider.runSession!(agentOpts({ messages })));

    expect(messages).toHaveLength(3);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toContainEqual({
      type: "tool_use",
      id: "t1",
      name: "Bash",
      input: { command: "ls" },
    });
    expect(messages[2].content).toContainEqual({
      type: "tool_result",
      tool_use_id: "t1",
      content: "a.txt\nb.txt",
      is_error: false,
    });
  });

  test("gate denial surfaces as an errored tool_end", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "list files" }] },
    ];
    const provider = claudeCodeProvider({ query: oneToolTurnQuery });
    const events = await collectAgent(
      provider.runSession!(
        agentOpts({
          messages,
          gate: async () => ({ allow: false, reason: "nope" }),
        }),
      ),
    );
    const toolEnd = events.find((e) => e.type === "tool_end");
    expect(toolEnd).toMatchObject({ isError: true, result: "nope" });
  });

  test("plan mode denies a mutating SDK tool without a gate", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "list files" }] },
    ];
    const provider = claudeCodeProvider({ query: oneToolTurnQuery });
    const events = await collectAgent(
      provider.runSession!(agentOpts({ messages, mode: "plan" })),
    );
    const toolEnd = events.find((e) => e.type === "tool_end");
    expect(toolEnd).toMatchObject({ isError: true });
    expect((toolEnd as { result: string }).result).toContain("plan mode");
  });

  test("read-only SDK tools bypass the gate", async () => {
    let gateCalls = 0;
    const readOnlyTurn: ClaudeCodeOptions["query"] = async function* ({
      options,
    }) {
      const canUseTool = options?.canUseTool as CanUseToolFake;
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "r1", name: "Read", input: { path: "x" } },
          ],
        },
      };
      await canUseTool?.(
        "Read",
        { path: "x" },
        {
          signal: new AbortController().signal,
        },
      );
      yield {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "r1", content: "body" },
          ],
        },
      };
      yield { type: "result", subtype: "success" };
    };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "read x" }] },
    ];
    const provider = claudeCodeProvider({ query: readOnlyTurn });
    await collectAgent(
      provider.runSession!(
        agentOpts({
          messages,
          gate: async () => {
            gateCalls++;
            return { allow: false, reason: "should not run" };
          },
        }),
      ),
    );
    expect(gateCalls).toBe(0);
  });
});

type CanUseToolFake = (
  name: string,
  input: Record<string, unknown>,
  extra: { signal: AbortSignal },
) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }>;

describe("tool forwarding", () => {
  test("partitionTools drops SDK-covered primitives, forwards the rest", () => {
    const { forward, covered } = partitionTools([
      mkTool("read_file"),
      mkTool("bash"),
      mkTool("web_search"),
      mkTool("read_skill", { readOnly: true }),
      mkTool("spawn_agent"),
      mkTool("mcp__external__thing"),
    ]);
    expect(covered.map((t) => t.name)).toEqual([
      "read_file",
      "bash",
      "web_search",
    ]);
    expect(forward.map((t) => t.name)).toEqual([
      "read_skill",
      "spawn_agent",
      "mcp__external__thing",
    ]);
  });

  test("jsonSchemaToZodShape honors required/optional and types", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        name: { type: "string", description: "the skill" },
        offset: { type: "number" },
      },
      required: ["name"],
    });
    const obj = z.object(shape);
    expect(obj.safeParse({ name: "a" }).success).toBe(true); // offset optional
    expect(obj.safeParse({ offset: 1 }).success).toBe(false); // name required
    expect(obj.safeParse({ name: 1 }).success).toBe(false); // name must be string
  });

  test("forwards non-primitive tools as an in-process MCP server and runs them", async () => {
    let ran = "";
    const skill = mkTool("read_skill", {
      readOnly: true,
      description: "load a skill",
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      run: async (a) => {
        ran = String(a.name);
        return `skill body for ${a.name}`;
      },
    });

    type ToolDef = {
      name: string;
      handler: (
        a: Record<string, unknown>,
        extra: unknown,
      ) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        isError?: boolean;
      }>;
    };
    const captured: ToolDef[] = [];
    const toolFake: NonNullable<ClaudeCodeOptions["tool"]> = (
      name,
      _description,
      _schema,
      handler,
    ) => {
      const def = { name, handler };
      captured.push(def);
      return def;
    };
    const createSdkMcpServer: NonNullable<
      ClaudeCodeOptions["createSdkMcpServer"]
    > = (o) => ({ __canarycode: o.name, tools: o.tools });

    const query: ClaudeCodeOptions["query"] = async function* ({ options }) {
      // The SDK sees our in-process server, and running the forwarded tool
      // executes canarycode's Tool.run.
      const servers = options?.mcpServers as
        | Record<string, unknown>
        | undefined;
      expect(servers?.canarycode).toBeTruthy();
      const def = captured.find((d) => d.name === "read_skill");
      const res = await def!.handler({ name: "serve-sim" }, {});
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "s1",
              name: "mcp__canarycode__read_skill",
              input: { name: "serve-sim" },
            },
          ],
        },
      };
      yield {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "s1",
              content: res.content[0].text,
            },
          ],
        },
      };
      yield { type: "result", subtype: "success" };
    };

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "use serve-sim" }] },
    ];
    const provider = claudeCodeProvider({
      query,
      tool: toolFake,
      createSdkMcpServer,
    });
    const events = await collectAgent(
      provider.runSession!(agentOpts({ messages, tools: [skill] })),
    );

    expect(ran).toBe("serve-sim");
    // The mcp__canarycode__ prefix is stripped for display + transcript.
    expect(events.find((e) => e.type === "tool_start")).toMatchObject({
      name: "read_skill",
    });
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({
      name: "read_skill",
      result: "skill body for serve-sim",
    });
    expect(messages[1].content).toContainEqual({
      type: "tool_use",
      id: "s1",
      name: "read_skill",
      input: { name: "serve-sim" },
    });
  });

  test("forwarded read-only tool bypasses the gate; mutating one is gated", async () => {
    const decisions: Record<string, string> = {};
    const query: ClaudeCodeOptions["query"] = async function* ({ options }) {
      const canUseTool = options?.canUseTool as CanUseToolFake;
      decisions.ro = (
        await canUseTool(
          "mcp__canarycode__read_skill",
          {},
          {
            signal: new AbortController().signal,
          },
        )
      ).behavior;
      decisions.rw = (
        await canUseTool(
          "mcp__canarycode__spawn_agent",
          {},
          {
            signal: new AbortController().signal,
          },
        )
      ).behavior;
      yield { type: "result", subtype: "success" };
    };
    const provider = claudeCodeProvider({
      query,
      tool: (n, _d, _s, h) => ({ n, h }),
      createSdkMcpServer: () => ({}),
    });
    await collectAgent(
      provider.runSession!(
        agentOpts({
          messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
          tools: [
            mkTool("read_skill", { readOnly: true }),
            mkTool("spawn_agent", { readOnly: false }),
          ],
          gate: async () => ({ allow: false, reason: "denied" }),
        }),
      ),
    );
    expect(decisions.ro).toBe("allow"); // read-only bypasses the gate
    expect(decisions.rw).toBe("deny"); // mutating is gated → denied
  });

  test("aliases the SDK's built-in AskUserQuestion onto forwarded ask_user", async () => {
    let sentOptions: Record<string, unknown> = {};
    const query: ClaudeCodeOptions["query"] = async function* ({ options }) {
      sentOptions = options ?? {};
      yield { type: "result", subtype: "success" };
    };
    const provider = claudeCodeProvider({
      query,
      tool: (n, _d, _s, h) => ({ n, h }),
      createSdkMcpServer: () => ({}),
    });
    await collectAgent(
      provider.runSession!(
        agentOpts({
          messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
          tools: [mkTool("ask_user", { readOnly: true })],
        }),
      ),
    );
    // The built-in AskUserQuestion has no interactive handler in this embedded
    // loop; routing it to canarycode's forwarded ask_user makes it block on the TUI.
    expect(sentOptions.toolAliases).toEqual({
      AskUserQuestion: "mcp__canarycode__ask_user",
    });
  });

  test("omits the AskUserQuestion alias when ask_user is not forwarded", async () => {
    let sentOptions: Record<string, unknown> = {};
    const query: ClaudeCodeOptions["query"] = async function* ({ options }) {
      sentOptions = options ?? {};
      yield { type: "result", subtype: "success" };
    };
    const provider = claudeCodeProvider({
      query,
      tool: (n, _d, _s, h) => ({ n, h }),
      createSdkMcpServer: () => ({}),
    });
    await collectAgent(
      provider.runSession!(
        agentOpts({
          messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
          tools: [mkTool("read_skill", { readOnly: true })],
        }),
      ),
    );
    expect(sentOptions.toolAliases).toBeUndefined();
  });
});

describe("provider-factory seam", () => {
  test("extension registers a claude-code factory keyed by api tag", () => {
    const factories = claudeCodeExtension.providerFactories?.() ?? {};
    expect(Object.keys(factories)).toContain(CLAUDE_CODE_API);
    const provider = factories[CLAUDE_CODE_API]({ api: CLAUDE_CODE_API });
    expect(provider.id).toBe(CLAUDE_CODE_API);
  });

  test("createProvider resolves a registered extension factory", () => {
    registerProviderFactory(CLAUDE_CODE_API, () =>
      claudeCodeProvider({
        query: async function* () {
          yield { type: "result", subtype: "success" };
        },
      }),
    );
    const provider = createProvider({ api: CLAUDE_CODE_API });
    expect(provider.id).toBe(CLAUDE_CODE_API);
  });

  test("createProvider throws for an unregistered api", () => {
    expect(() => createProvider({ api: "claude-code" as never })).toThrow(
      /unknown provider api/,
    );
  });
});
