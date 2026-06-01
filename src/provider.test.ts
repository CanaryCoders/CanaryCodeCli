// provider.test.ts — Codex (openai-responses) translation, SSE parsing, errors.

import { afterEach, describe, expect, test } from "bun:test";
import type { TokenGetter } from "./auth.ts";
import {
  createProvider,
  type Message,
  type StreamEvent,
  toAnthropicMessage,
  toOpenAIMessages,
  toResponsesInput,
} from "./provider.ts";

// ── image content blocks across all three providers ─────────────────────────

describe("image content blocks", () => {
  const imageMsg: Message = {
    role: "user",
    content: [
      { type: "text", text: "what is this?" },
      { type: "image", mediaType: "image/png", data: "AAAB" },
    ],
  };

  test("anthropic: image → source.base64 block alongside text", () => {
    expect(toAnthropicMessage(imageMsg)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAAB" },
        },
      ],
    });
  });

  test("openai-compat: image → image_url data URL in a content-parts array", () => {
    expect(toOpenAIMessages("", [imageMsg])).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAB" },
          },
        ],
      },
    ]);
  });

  test("openai-compat: text-only user message stays a plain string", () => {
    const textOnly: Message = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    };
    expect(toOpenAIMessages("", [textOnly])).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  test("responses (codex): image → input_image data URL part", () => {
    expect(toResponsesInput([imageMsg])).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "what is this?" },
          { type: "input_image", image_url: "data:image/png;base64,AAAB" },
        ],
      },
    ]);
  });
});

// ── toResponsesInput ─────────────────────────────────────────────────────────

describe("toResponsesInput", () => {
  test("maps user/assistant text, tool_use and tool_result; drops thinking", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret", signature: "s" },
          { type: "text", text: "calling tool" },
          { type: "tool_use", id: "call_1", name: "read", input: { p: "a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "file body" },
        ],
      },
    ];

    expect(toResponsesInput(messages)).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "calling tool" }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read",
        arguments: JSON.stringify({ p: "a" }),
      },
      { type: "function_call_output", call_id: "call_1", output: "file body" },
    ]);
  });

  test("never carries item ids on message/content parts", () => {
    const items = toResponsesInput([
      { role: "user", content: [{ type: "text", text: "x" }] },
    ]);
    expect(JSON.stringify(items)).not.toContain('"id"');
  });
});

// ── Codex provider streaming ─────────────────────────────────────────────────

/** A ReadableStream of UTF-8 bytes from an SSE text body. */
function sseStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeTokenGetter(onForce?: () => void): TokenGetter {
  return {
    async get() {
      return { accessToken: "tok", accountId: "acct" };
    },
    async forceRefresh() {
      onForce?.();
      return { accessToken: "tok2", accountId: "acct" };
    },
  };
}

async function collect(
  stream: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("openai-responses provider stream", () => {
  test("sends the slug as model and the handle's effort as reasoning.effort", async () => {
    let sentBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      const body = `data: ${JSON.stringify({ type: "response.completed", response: { usage: {} } })}\n\n\n`;
      return new Response(sseStream(body), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createProvider(
      { api: "openai-responses" },
      { tokenGetter: fakeTokenGetter() },
    );
    await collect(
      provider.stream({
        model: "gpt-5.5 xhigh",
        system: "sys",
        messages: [],
        tools: [],
      }),
    );

    expect(sentBody.model).toBe("gpt-5.5");
    expect(sentBody.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(sentBody.store).toBe(false);
    expect(sentBody.include).toEqual(["reasoning.encrypted_content"]);
  });

  test("derives reasoning.effort from the thinking budget when not pinned", async () => {
    const captureEffortFor = async (
      thinkingBudget: number,
    ): Promise<string> => {
      let effort = "";
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        effort = (
          JSON.parse(init.body as string).reasoning as { effort: string }
        ).effort;
        const body = `data: ${JSON.stringify({ type: "response.completed", response: { usage: {} } })}\n\n\n`;
        return new Response(sseStream(body), { status: 200 });
      }) as unknown as typeof fetch;
      const provider = createProvider(
        { api: "openai-responses" },
        { tokenGetter: fakeTokenGetter() },
      );
      await collect(
        provider.stream({
          model: "gpt-5.5", // bare slug → effort comes from the budget
          system: "",
          messages: [],
          tools: [],
          thinkingBudget,
        }),
      );
      return effort;
    };

    expect(await captureEffortFor(0)).toBe("low"); // off
    expect(await captureEffortFor(4_000)).toBe("medium"); // think
    expect(await captureEffortFor(10_000)).toBe("high"); // think-hard
    expect(await captureEffortFor(32_000)).toBe("xhigh"); // ultrathink
  });

  test("maps Responses SSE events to StreamEvents", async () => {
    const body = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
      "",
      `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "ponder" })}`,
      "",
      `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc1", call_id: "call_1", name: "read", arguments: "" } })}`,
      "",
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc1", delta: '{"p":' })}`,
      "",
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc1", delta: '"a"}' })}`,
      "",
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc1", call_id: "call_1", name: "read", arguments: '{"p":"a"}' } })}`,
      "",
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } })}`,
      "",
      "",
    ].join("\n");

    globalThis.fetch = (async () =>
      new Response(sseStream(body), {
        status: 200,
      })) as unknown as typeof fetch;

    const provider = createProvider(
      { api: "openai-responses" },
      { tokenGetter: fakeTokenGetter() },
    );
    const events = await collect(
      provider.stream({
        model: "gpt-5.1-codex",
        system: "sys",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
      }),
    );

    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "thinking_delta", text: "ponder" },
      { type: "tool_use", id: "call_1", name: "read", input: { p: "a" } },
      { type: "usage", inputTokens: 10, outputTokens: 5 },
      { type: "done", stopReason: "tool_use" },
    ]);
  });

  test("done stopReason is 'stop' when no tool was called", async () => {
    const body = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "done" })}`,
      "",
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })}`,
      "",
      "",
    ].join("\n");
    globalThis.fetch = (async () =>
      new Response(sseStream(body), {
        status: 200,
      })) as unknown as typeof fetch;

    const provider = createProvider(
      { api: "openai-responses" },
      { tokenGetter: fakeTokenGetter() },
    );
    const events = await collect(
      provider.stream({ model: "m", system: "", messages: [], tools: [] }),
    );
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
  });

  test("a 404 usage-limit body is surfaced as a 429", async () => {
    globalThis.fetch = (async () =>
      new Response("error: usage_limit_reached", {
        status: 404,
      })) as unknown as typeof fetch;

    const provider = createProvider(
      { api: "openai-responses" },
      { tokenGetter: fakeTokenGetter() },
    );
    await expect(
      collect(
        provider.stream({ model: "m", system: "", messages: [], tools: [] }),
      ),
    ).rejects.toThrow(/429/);
  });

  test("a 401 triggers one forced refresh and a retry", async () => {
    let calls = 0;
    let forced = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response("unauthorized", { status: 401 });
      const body = `data: ${JSON.stringify({ type: "response.completed", response: { usage: {} } })}\n\n\n`;
      return new Response(sseStream(body), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createProvider(
      { api: "openai-responses" },
      { tokenGetter: fakeTokenGetter(() => forced++) },
    );
    const events = await collect(
      provider.stream({ model: "m", system: "", messages: [], tools: [] }),
    );

    expect(calls).toBe(2);
    expect(forced).toBe(1);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
  });
});
