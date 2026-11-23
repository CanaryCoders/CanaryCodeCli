// agent.test.ts — mode-to-role mapping and image tool-result threading.

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  coerceToolInput,
  planTools,
  roleForMode,
  runAgent,
} from "./agent.ts";
import {
  type ContentBlock,
  type Message,
  type Provider,
  type StreamEvent,
  TOOL_INPUT_PARSE_ERROR,
} from "./provider.ts";
import { type Tool, tools } from "./tools.ts";

describe("roleForMode", () => {
  test("plan maps to reasoning", () => {
    expect(roleForMode("plan")).toBe("reasoning");
  });

  test("normal and auto map to coding", () => {
    expect(roleForMode("normal")).toBe("coding");
    expect(roleForMode("auto")).toBe("coding");
  });
});

// A two-turn fake provider: turn 1 calls read_file on `path`, turn 2 just stops.
function imageReadProvider(path: string): Provider {
  let turn = 0;
  return {
    id: "fake",
    async *stream(): AsyncIterable<StreamEvent> {
      if (turn++ === 0) {
        yield {
          type: "tool_use",
          id: "c1",
          name: "read_file",
          input: { path },
        };
        yield { type: "done", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "stop" };
      }
    },
  };
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) {
    // consume
  }
}

describe("runAgent image tool results", () => {
  const path = join(tmpdir(), "canarycode-agent-image.png");
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  afterEach(async () => {
    await rm(path, { force: true });
  });

  test("attaches an image block to the tool-result turn for vision models", async () => {
    await Bun.write(path, bytes);
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "read it" }] },
    ];
    await drain(
      runAgent({
        provider: imageReadProvider(path),
        model: "m",
        system: "",
        messages,
        tools,
        supportsVision: true,
      }),
    );
    const toolTurn = messages.find(
      (m) =>
        m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    );
    expect(toolTurn).toBeDefined();
    const img = toolTurn!.content.find((b) => b.type === "image");
    expect(img).toEqual({
      type: "image",
      mediaType: "image/png",
      data: Buffer.from(bytes).toString("base64"),
    });
  });

  test("drops the image and notes it when the model is not vision-capable", async () => {
    await Bun.write(path, bytes);
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "read it" }] },
    ];
    await drain(
      runAgent({
        provider: imageReadProvider(path),
        model: "m",
        system: "",
        messages,
        tools,
        supportsVision: false,
      }),
    );
    const toolTurn = messages.find(
      (m) =>
        m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    )!;
    expect(toolTurn.content.some((b) => b.type === "image")).toBe(false);
    const tr = toolTurn.content.find((b) => b.type === "tool_result");
    expect(tr && tr.type === "tool_result" && tr.content).toContain("cannot");
  });
});

describe("runAgent malformed tool-call JSON", () => {
  test("a tool_use carrying inputError is rejected without running the tool", async () => {
    let turn = 0;
    // Turn 1 emits a tool_use whose streamed args failed to parse; turn 2 stops.
    const provider: Provider = {
      id: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        if (turn++ === 0) {
          yield {
            type: "tool_use",
            id: "1",
            name: "t",
            input: {},
            inputError: TOOL_INPUT_PARSE_ERROR,
          };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "done", stopReason: "stop" };
        }
      },
    };
    let ran = false;
    const tool: Tool = {
      name: "t",
      description: "test tool",
      schema: { type: "object" },
      readOnly: true,
      run: async () => {
        ran = true;
        return "ok";
      },
    };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
    ];
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      provider,
      model: "m",
      system: "",
      messages,
      tools: [tool],
    })) {
      events.push(ev);
    }

    // The tool itself must never execute.
    expect(ran).toBe(false);

    // The loop reports the rejection as an error tool_end.
    const end = events.find((e) => e.type === "tool_end");
    expect(end).toBeDefined();
    expect(end!.type === "tool_end" && end!.isError).toBe(true);
    expect(end!.type === "tool_end" && end!.result).toContain("rejected");

    // The follow-up user message pairs the tool_use with an error tool_result.
    const toolTurn = messages.find(
      (m) =>
        m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    );
    expect(toolTurn).toBeDefined();
    const tr = toolTurn!.content.find((b) => b.type === "tool_result");
    expect(tr && tr.type === "tool_result" && tr.tool_use_id).toBe("1");
    expect(tr && tr.type === "tool_result" && tr.is_error).toBe(true);
  });
});

describe("runAgent repeated-call loop breaker", () => {
  /** Provider that emits one identical tool call per turn, `n` times, then stops. */
  function repeatProvider(n: number, input: unknown = { x: 1 }): Provider {
    let turn = 0;
    return {
      id: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        if (turn++ < n) {
          yield { type: "tool_use", id: `c${turn}`, name: "t", input };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "done", stopReason: "stop" };
        }
      },
    };
  }

  function countingTool(): { tool: Tool; runs: () => number } {
    let runs = 0;
    const tool: Tool = {
      name: "t",
      description: "test tool",
      schema: { type: "object" },
      readOnly: true,
      run: async () => {
        runs++;
        return "ok";
      },
    };
    return { tool, runs: () => runs };
  }

  test("the third consecutive identical call is denied without running the tool", async () => {
    const { tool, runs } = countingTool();
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
    ];
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      provider: repeatProvider(3),
      model: "m",
      system: "",
      messages,
      tools: [tool],
    })) {
      events.push(ev);
    }

    // The first two identical calls run; the third is broken as a loop.
    expect(runs()).toBe(2);
    const ends = events.filter((e) => e.type === "tool_end");
    expect(ends).toHaveLength(3);
    const last = ends.at(-1)!;
    expect(last.type === "tool_end" && last.isError).toBe(true);
    expect(last.type === "tool_end" && last.result).toContain("loop");

    // The denial reaches the model as an error tool_result, keeping turns paired.
    const errorResults = messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result" && b.is_error),
    );
    expect(errorResults).toHaveLength(1);
  });

  test("a different input resets the repeat counter", async () => {
    const { tool, runs } = countingTool();
    let turn = 0;
    // Two identical calls, one different, then the first shape again: no loop.
    const inputs = [{ x: 1 }, { x: 1 }, { x: 2 }, { x: 1 }];
    const provider: Provider = {
      id: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        if (turn < inputs.length) {
          yield {
            type: "tool_use",
            id: `c${turn}`,
            name: "t",
            input: inputs[turn++],
          };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "done", stopReason: "stop" };
        }
      },
    };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
    ];
    await drain(
      runAgent({ provider, model: "m", system: "", messages, tools: [tool] }),
    );
    expect(runs()).toBe(4);
  });

  test("denied repeats stay denied until the call changes", async () => {
    const { tool, runs } = countingTool();
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
    ];
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      provider: repeatProvider(5),
      model: "m",
      system: "",
      messages,
      tools: [tool],
    })) {
      events.push(ev);
    }
    // Calls 3, 4 and 5 are all denied; the tool still ran only twice.
    expect(runs()).toBe(2);
    const errorEnds = events.filter((e) => e.type === "tool_end" && e.isError);
    expect(errorEnds).toHaveLength(3);
  });
});

describe("runAgent drainInput injection", () => {
  // Turn 1 calls `echo`; turn 2 stops with plain text. drainInput fires once at
  // the tool-result boundary, so its text rides on the tool-result user message.
  function echoThenStopProvider(): Provider {
    let turn = 0;
    return {
      id: "fake",
      async *stream(): AsyncIterable<StreamEvent> {
        if (turn++ === 0) {
          yield { type: "tool_use", id: "c1", name: "echo", input: {} };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "done", stopReason: "stop" };
        }
      },
    };
  }

  test("drainInput appends queued text to the tool-result user message", async () => {
    let drained = false;
    const drainInput = () => {
      if (drained) return null;
      drained = true;
      return "INJECTED";
    };
    const echo: Tool = {
      name: "echo",
      description: "",
      schema: { type: "object" },
      readOnly: true,
      run: async () => "ok",
    };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
    ];
    await drain(
      runAgent({
        provider: echoThenStopProvider(),
        model: "m",
        system: "",
        messages,
        tools: [echo],
        drainInput,
      }),
    );

    // messages: [user "go", assistant(tool_use), user(tool_result + injected), assistant("done")]
    const toolResultMsg = messages[2];
    expect(toolResultMsg.role).toBe("user");
    const blocks = toolResultMsg.content as ContentBlock[];
    const text = blocks.find((b) => b.type === "text");
    expect(text?.type === "text" && text.text).toBe("INJECTED");
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[blocks.length - 1].type).toBe("text");
  });
});

describe("runAgent refreshTurnConfig", () => {
  // Provider that records the `model` it was streamed with on each call. Turn 1
  // does one echo tool call; turn 2 stops with plain text.
  function modelRecordingProvider(seen: string[]): Provider {
    let turn = 0;
    return {
      id: "fake",
      async *stream(req): AsyncIterable<StreamEvent> {
        seen.push(req.model);
        if (turn++ === 0) {
          yield { type: "tool_use", id: "c1", name: "echo", input: {} };
          yield { type: "done", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "done", stopReason: "stop" };
        }
      },
    };
  }

  test("refreshTurnConfig swaps the model used on the next step", async () => {
    const modelsSeen: string[] = [];
    const provider = modelRecordingProvider(modelsSeen);
    let n = 0;
    const refreshTurnConfig = () => {
      n += 1;
      return {
        provider,
        model: n === 1 ? "m1" : "m2",
        supportsVision: true,
        thinkingBudget: undefined,
      };
    };
    const echo: Tool = {
      name: "echo",
      description: "",
      schema: { type: "object" },
      readOnly: true,
      run: async () => "ok",
    };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
    ];
    await drain(
      runAgent({
        provider,
        model: "ignored",
        system: "",
        messages,
        tools: [echo],
        refreshTurnConfig,
      }),
    );

    expect(modelsSeen[0]).toBe("m1");
    expect(modelsSeen[1]).toBe("m2");
  });
});

describe("runAgent compaction", () => {
  test("uses the dedicated compact provider/model when configured", async () => {
    let compactModel = "";
    const compactProvider: Provider = {
      id: "compact",
      async *stream(req): AsyncIterable<StreamEvent> {
        compactModel = req.model;
        yield { type: "text_delta", text: "summary" };
        yield { type: "done", stopReason: "stop" };
      },
    };
    const mainProvider: Provider = {
      id: "main",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "done", stopReason: "stop" };
      },
    };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "one" }] },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: [{ type: "text", text: "three" }] },
      { role: "assistant", content: [{ type: "text", text: "four" }] },
    ];

    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      provider: mainProvider,
      model: "main-model",
      system: "x".repeat(100),
      messages,
      tools: [],
      compactAtTokens: 1,
      keepRecentMessages: 1,
      compactProvider,
      compactModel: "compact-model",
    })) {
      events.push(ev);
    }

    expect(compactModel).toBe("compact-model");
    expect(events.some((ev) => ev.type === "compaction")).toBe(true);
    expect(messages[0]?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("summary"),
    });
  });
});

describe("runAgent abort during streaming", () => {
  test("an aborted fetch rejection surfaces as a clean aborted done event", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    // Mimics a provider whose underlying fetch carries the signal: it streams one
    // delta, then the run is cancelled and the fetch rejects with an AbortError.
    const provider: Provider = {
      id: "fake",
      async *stream(req): AsyncIterable<StreamEvent> {
        receivedSignal = req.signal;
        yield { type: "text_delta", text: "partial" };
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      provider,
      model: "m",
      system: "",
      messages,
      tools: [],
      signal: controller.signal,
    })) {
      events.push(ev);
    }
    expect(receivedSignal).toBeDefined();
    expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
  });

  test("abort before any event yields clean aborted done", async () => {
    const controller = new AbortController();
    // Mimics a fetch that is cancelled before the stream produces anything: the
    // provider rejects with an AbortError without yielding a single event.
    const provider: Provider = {
      id: "fake",
      // biome-ignore lint/correctness/useYield: aborts before producing anything by design
      async *stream(): AsyncIterable<StreamEvent> {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      provider,
      model: "m",
      system: "",
      messages,
      tools: [],
      signal: controller.signal,
    })) {
      events.push(ev);
    }
    expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
  });
});

// ── small-context behaviour ──────────────────────────────────────────────────

/** A provider that plays back one scripted turn per call. */
function scripted(turns: StreamEvent[][]): Provider & { calls: number } {
  const p = {
    id: "fake",
    calls: 0,
    async *stream(): AsyncIterable<StreamEvent> {
      const turn = turns[Math.min(p.calls++, turns.length - 1)]!;
      for (const ev of turn) yield ev;
    },
  };
  return p;
}

const echo: Tool = {
  name: "echo",
  description: "echo",
  readOnly: true,
  schema: {
    type: "object",
    properties: { n: { type: "number" }, loud: { type: "boolean" } },
  },
  async run(input) {
    return `${typeof input.n}:${input.n} ${typeof input.loud}:${input.loud}`;
  },
};

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("coerceToolInput", () => {
  test("fixes stringified numbers, booleans and whole-argument strings", () => {
    expect(coerceToolInput(echo.schema, { n: "50", loud: "true" })).toEqual({
      n: 50,
      loud: true,
    });
    expect(coerceToolInput(echo.schema, '{"n":"7"}')).toEqual({ n: 7 });
    expect(coerceToolInput(echo.schema, null)).toEqual({});
  });

  test("leaves values it cannot interpret untouched", () => {
    expect(coerceToolInput(echo.schema, { n: "many", other: "1" })).toEqual({
      n: "many",
      other: "1",
    });
  });
});

describe("runAgent recoveries", () => {
  test("coerced arguments reach the tool", async () => {
    const messages = [userMsg("go")];
    await drain(
      runAgent({
        provider: scripted([
          [
            {
              type: "tool_use",
              id: "c1",
              name: "echo",
              input: { n: "3", loud: "false" },
            },
            { type: "done", stopReason: "tool_use" },
          ],
          [{ type: "text_delta", text: "ok" }, { type: "done" }],
        ]),
        model: "m",
        system: "",
        messages,
        tools: [echo],
      }),
    );
    const result = messages[2]!.content[0] as { content: string };
    expect(result.content).toBe("number:3 boolean:false");
  });

  test("an empty reply is nudged once, then the run ends", async () => {
    const provider = scripted([[{ type: "done", stopReason: "stop" }]]);
    const messages = [userMsg("go")];
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      provider,
      model: "m",
      system: "",
      messages,
      tools: [],
    }))
      events.push(ev);
    expect(provider.calls).toBe(2);
    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
    expect(JSON.stringify(messages)).toContain("Your last reply was empty");
  });

  test("an oversized tool result is cut down with a notice", async () => {
    const big: Tool = {
      ...echo,
      name: "big",
      async run() {
        return "x".repeat(5000);
      },
    };
    const messages = [userMsg("go")];
    await drain(
      runAgent({
        provider: scripted([
          [
            { type: "tool_use", id: "c1", name: "big", input: {} },
            { type: "done", stopReason: "tool_use" },
          ],
          [{ type: "text_delta", text: "ok" }, { type: "done" }],
        ]),
        model: "m",
        system: "",
        messages,
        tools: [big],
        maxToolResultChars: 1000,
      }),
    );
    const result = messages[2]!.content[0] as { content: string };
    expect(result.content.length).toBeLessThan(1400);
    expect(result.content).toContain("4000 characters omitted");
  });

  test("over the limit, stale tool output is cleared before summarizing", async () => {
    const stale = "y".repeat(4000);
    const messages: Message[] = [userMsg("the task")];
    for (let i = 0; i < 8; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `c${i}`, name: "echo", input: {} }],
      });
      messages.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: `c${i}`, content: stale },
        ],
      });
    }
    const provider = scripted([
      [{ type: "text_delta", text: "done" }, { type: "done" }],
    ]);
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      provider,
      model: "m",
      system: "",
      messages,
      tools: [],
      compactAtTokens: 5000,
    }))
      events.push(ev);
    // One model call: the reply. No summarization round-trip was needed.
    expect(provider.calls).toBe(1);
    expect(events.some((e) => e.type === "compaction")).toBe(true);
    expect(JSON.stringify(messages[2])).toContain("tool output cleared");
    expect(JSON.stringify(messages.at(-2)).includes(stale)).toBe(true);
    expect(messages[0]).toEqual(userMsg("the task"));
  });

  test("a context-overflow error shrinks the transcript and retries once", async () => {
    const messages: Message[] = [userMsg("the task")];
    for (let i = 0; i < 6; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `step ${i} ${"z".repeat(600)}` }],
      });
      messages.push(userMsg(`next ${i}`));
    }
    let calls = 0;
    const provider: Provider = {
      id: "fake",
      async *stream(req): AsyncIterable<StreamEvent> {
        calls++;
        if (calls === 1)
          throw new Error("400 — maximum context length is 32768 tokens");
        // call 2 is the summarizer (no tools, its own system prompt)
        yield { type: "text_delta", text: req.system ? "summary" : "ok" };
        yield { type: "done" };
      },
    };
    const before = messages.length;
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      provider,
      model: "m",
      system: "",
      messages,
      tools: [],
    }))
      events.push(ev);
    expect(events.some((e) => e.type === "compaction")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
    expect(messages.length).toBeLessThan(before);
    expect(JSON.stringify(messages[0])).toContain("the task");
  });
});

describe("deferred tool schemas", () => {
  const remote: Tool = {
    name: "mcp__docs__search",
    description: "Search the docs.\nLong details the index leaves out.",
    readOnly: true,
    deferrable: true,
    schema: {
      type: "object",
      properties: { query: { type: "string", description: "x".repeat(2000) } },
    },
    async run(input) {
      return `results for ${input.query}`;
    },
  };

  test("everything is sent when the schemas fit", () => {
    const plan = planTools([echo, remote], 100_000);
    expect(plan.deferred).toBe(false);
    expect(plan.active).toEqual([echo, remote]);
  });

  test("over budget, deferrable tools are swapped for an index", () => {
    const plan = planTools([echo, remote], 1000);
    expect(plan.deferred).toBe(true);
    expect(plan.active.map((t) => t.name)).toEqual([
      "echo",
      "describe_tool",
      "call_tool",
    ]);
    const call = plan.active[2]!;
    expect(call.description).toContain("- mcp__docs__search: Search the docs.");
    expect(call.description).not.toContain("Long details");
  });

  test("call_tool runs the named tool and reports it under its own name", async () => {
    const messages = [userMsg("go")];
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      provider: scripted([
        [
          {
            type: "tool_use",
            id: "c1",
            name: "call_tool",
            input: { name: "mcp__docs__search", arguments: '{"query":"hono"}' },
          },
          { type: "done", stopReason: "tool_use" },
        ],
        [{ type: "text_delta", text: "ok" }, { type: "done" }],
      ]),
      model: "m",
      system: "",
      messages,
      tools: [echo, remote],
      maxToolSchemaChars: 1000,
    }))
      events.push(ev);
    const end = events.find((e) => e.type === "tool_end") as {
      name: string;
      result: string;
    };
    expect(end.name).toBe("mcp__docs__search");
    expect(end.result).toBe("results for hono");
  });

  test("describe_tool returns the withheld parameters", async () => {
    const describe = planTools([echo, remote], 1000).active[1]!;
    const out = await describe.run({ name: "mcp__docs__search" });
    expect(out).toContain('"query"');
    await expect(describe.run({ name: "nope" })).rejects.toThrow(
      /no such tool/,
    );
  });
});
