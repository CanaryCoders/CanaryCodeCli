// agent.test.ts — mode-to-role mapping and image tool-result threading.

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roleForMode, runAgent } from "./agent.ts";
import type { Message, Provider, StreamEvent } from "./provider.ts";
import { tools } from "./tools.ts";

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
