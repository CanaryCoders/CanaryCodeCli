// mcp.test.ts — MCP tool-result rendering, including image content blocks.

import { describe, expect, test } from "bun:test";
import {
  childEnv,
  connectMcpServers,
  type RpcMessage,
  renderToolResult,
  sseTransport,
  type Transport,
} from "./mcp.ts";

describe("renderToolResult", () => {
  test("joins text content blocks", () => {
    expect(
      renderToolResult({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toEqual({ content: "a\nb" });
  });

  test("extracts an image block as base64 image data", () => {
    const out = renderToolResult({
      content: [{ type: "image", data: "AAAB", mimeType: "image/png" }],
    });
    expect(out.image).toEqual({ mediaType: "image/png", data: "AAAB" });
    // No text → a short marker so the tool_result is never empty.
    expect(out.content).toContain("image/png");
  });

  test("keeps text and the first image together", () => {
    const out = renderToolResult({
      content: [
        { type: "text", text: "screenshot taken" },
        { type: "image", data: "ZZZ", mimeType: "image/jpeg" },
      ],
    });
    expect(out.content).toBe("screenshot taken");
    expect(out.image).toEqual({ mediaType: "image/jpeg", data: "ZZZ" });
  });

  test("throws on an error result", () => {
    expect(() =>
      renderToolResult({
        isError: true,
        content: [{ type: "text", text: "boom" }],
      }),
    ).toThrow("boom");
  });
});

// A scripted transport: answers initialize, tools/list (one screenshot tool), and
// tools/call (returns an image block) — enough to exercise the wrapped tool.
function fakeTransport(): Transport {
  let onMessage: (m: RpcMessage) => void = () => {};
  return {
    onMessage(h) {
      onMessage = h;
    },
    onClose() {},
    async start() {},
    async send(msg) {
      if (msg.method === "initialize")
        queueMicrotask(() =>
          onMessage({ jsonrpc: "2.0", id: msg.id, result: {} }),
        );
      else if (msg.method === "tools/list")
        queueMicrotask(() =>
          onMessage({
            jsonrpc: "2.0",
            id: msg.id,
            result: { tools: [{ name: "screenshot" }] },
          }),
        );
      else if (msg.method === "tools/call")
        queueMicrotask(() =>
          onMessage({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [
                { type: "image", data: "PNGDATA", mimeType: "image/png" },
              ],
            },
          }),
        );
    },
    async close() {},
  };
}

// ── SSE transport: endpoint origin restriction ──────────────────────────────

/** A one-shot SSE response body emitting the given raw event text, then EOF. */
function sseBody(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** A fake fetch that records every call and serves `events` for the SSE GET. */
function recordingFetch(events: string) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "GET")
      return new Response(sseBody(events), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    return new Response("", { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("sseTransport endpoint origin check", () => {
  test("rejects a cross-origin endpoint and never POSTs to it", async () => {
    const { calls, fetchImpl } = recordingFetch(
      "event: endpoint\ndata: http://evil.example/steal\n\n",
    );
    const t = sseTransport({ url: "http://127.0.0.1:9999/sse" }, fetchImpl);
    await t.start();
    await expect(
      t.send({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    ).rejects.toThrow(/does not match server origin/);
    expect(calls.filter((c) => c.url.includes("evil.example"))).toHaveLength(0);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("accepts a same-origin (relative) endpoint and POSTs there", async () => {
    const { calls, fetchImpl } = recordingFetch(
      "event: endpoint\ndata: /messages?session=1\n\n",
    );
    const t = sseTransport({ url: "http://127.0.0.1:9999/sse" }, fetchImpl);
    await t.start();
    await t.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(calls).toContainEqual({
      url: "http://127.0.0.1:9999/messages?session=1",
      method: "POST",
    });
  });
});

// ── stdio transport: child env allowlist ────────────────────────────────────

describe("childEnv", () => {
  test("inherits allowlisted vars but not arbitrary parent secrets", () => {
    process.env.CANARYCODE_TEST_SECRET = "supersecret";
    try {
      const env = childEnv();
      expect("CANARYCODE_TEST_SECRET" in env).toBe(false);
      expect(env.PATH).toBe(process.env.PATH!);
    } finally {
      delete process.env.CANARYCODE_TEST_SECRET;
    }
  });

  test("explicit cfg.env entries pass through and override", () => {
    const env = childEnv({ MY_TOKEN: "abc", PATH: "/custom" });
    expect(env.MY_TOKEN).toBe("abc");
    expect(env.PATH).toBe("/custom");
  });
});

describe("wrapped MCP tool with image result", () => {
  test("a screenshot tool surfaces an image ToolRunResult", async () => {
    const conn = await connectMcpServers({ shots: { command: "x" } }, () =>
      fakeTransport(),
    );
    const tool = conn.tools.find((t) => t.name === "mcp__shots__screenshot");
    expect(tool).toBeDefined();
    const out = await tool!.run({});
    if (typeof out === "string") throw new Error("expected a ToolRunResult");
    expect(out.image).toEqual({ mediaType: "image/png", data: "PNGDATA" });
    await Promise.all(conn.clients.map((c) => c.close()));
  });
});

// ── mcpExtension factory ────────────────────────────────────────────────────

import { defaultConfig } from "../config.ts";
import { mcpExtension } from "./mcp.ts";

describe("mcpExtension", () => {
  test("with zero servers contributes nothing and never connects", async () => {
    const cfg = defaultConfig();
    // defaultConfig().mcpServers is {} — verify no note was emitted (proving
    // no connect attempt, since describeMcp always emits a note for attempted servers).
    const notes: string[] = [];
    const ext = mcpExtension();
    const tools = await ext.tools!({
      config: cfg,
      note: (n: string) => notes.push(n),
    } as never);
    expect(tools).toEqual([]);
    expect(notes).toHaveLength(0);
  });

  test("dispose is safe before tools() is called", async () => {
    // dispose() with no connection should resolve without throwing.
    await expect(mcpExtension().dispose!()).resolves.toBeUndefined();
  });

  test("tools() → dispose() closes the opened client", async () => {
    // Track whether close() was called on the transport.
    let closed = false;
    const transport: Transport = {
      ...fakeTransport(),
      async close() {
        closed = true;
      },
    };

    // Inject our instrumented transport so no real process is spawned.
    const ext = mcpExtension(() => transport);
    const notes: string[] = [];
    const tools = await ext.tools!({
      config: { ...defaultConfig(), mcpServers: { srv: { command: "x" } } },
      note: (n: string) => notes.push(n),
    } as never);

    // tools() should have returned the server's wrapped tool.
    expect(tools.find((t) => t.name === "mcp__srv__screenshot")).toBeDefined();

    // After dispose(), the transport must be closed.
    await ext.dispose!();
    expect(closed).toBe(true);
  });
});
