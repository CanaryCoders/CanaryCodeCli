import { describe, expect, test } from "bun:test";
import type { Item } from "./Message.tsx";
import { statusVerb, thinkingSummary } from "./message-helpers.ts";

describe("busy row", () => {
  test("names the running tool and its target", () => {
    const live: Item[] = [
      {
        id: 1,
        kind: "tool",
        toolId: "t",
        name: "spawn_agent",
        input: { task: "Update only locale files" },
        pending: true,
      },
    ];
    expect(statusVerb(live)).toBe("Sub-agent: Update only locale files");
  });

  test("tells reasoning from answering", () => {
    expect(statusVerb([{ id: 1, kind: "thinking", text: "hm" }])).toBe(
      "Thinking",
    );
    expect(statusVerb([{ id: 1, kind: "assistant", text: "hi" }])).toBe(
      "Writing the answer",
    );
    expect(statusVerb([])).toBe("Waiting for the model");
  });

  test("summarises a reasoning block", () => {
    expect(thinkingSummary({ text: "a\n\nb\n", ms: 65_000 })).toBe(
      "Thought for 1m 05s (2 lines)",
    );
    expect(thinkingSummary({ text: "a" })).toBe("Thought (1 line)");
  });
});
