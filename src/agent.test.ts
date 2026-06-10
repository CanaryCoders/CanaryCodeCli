// agent.test.ts — mode-to-role mapping and image tool-result threading.

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, roleForMode, runAgent } from "./agent.ts";
import {
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
  const path = join(tmpdir(), "cc-agent-image.png");
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
