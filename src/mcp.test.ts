// mcp.test.ts — MCP tool-result rendering, including image content blocks.

import { describe, expect, test } from "bun:test";
import {
  connectMcpServers,
  type RpcMessage,
  renderToolResult,
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
