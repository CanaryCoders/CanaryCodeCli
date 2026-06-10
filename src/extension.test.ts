// src/extension.test.ts
import { describe, expect, test } from "bun:test";
import {
  composeExtensions,
  type Extension,
  type ExtensionHost,
} from "./extension.ts";
import type { Tool } from "./tools.ts";

function fakeTool(name: string): Tool {
  return {
    name,
    description: name,
    schema: { type: "object", properties: {} },
    readOnly: true,
    run: async () => "ok",
  };
}

// Minimal host: extensions under test only use note/getTools.
const host = {
  note: () => {},
  signal: new AbortController().signal,
} as unknown as ExtensionHost;

describe("composeExtensions", () => {
  test("collects tools in extension order", async () => {
    const a: Extension = { name: "a", tools: () => [fakeTool("t1")] };
    const b: Extension = { name: "b", tools: async () => [fakeTool("t2")] };
    const c = await composeExtensions([a, b], host);
    expect(c.tools.map((t) => t.name)).toEqual(["t1", "t2"]);
  });

  test("getTools() exposes the full composed set to every extension", async () => {
    let seen: string[] = [];
    const a: Extension = { name: "a", tools: () => [fakeTool("t1")] };
    const b: Extension = {
      name: "b",
      tools: (ctx) => [
        {
          ...fakeTool("t2"),
          // capture lazily, like spawn_agent's inheritedTools will
          run: async () => {
            seen = ctx.getTools().map((t) => t.name);
            return "ok";
          },
        },
      ],
    };
    const c = await composeExtensions([a, b], host);
    await c.tools[1]?.run({});
    expect(seen).toEqual(["t1", "t2"]);
  });

  test("joins systemPrompt sections in order, skipping empties", async () => {
    const a: Extension = { name: "a", systemPrompt: () => "SECTION A" };
    const b: Extension = { name: "b", systemPrompt: () => undefined };
    const d: Extension = { name: "d", systemPrompt: async () => "SECTION D" };
    const c = await composeExtensions([a, b, d], host);
    expect(c.promptSections).toEqual(["SECTION A", "SECTION D"]);
  });

  test("preToolUse: first deny wins, later hooks not called", async () => {
    const calls: string[] = [];
    const allow: Extension = {
      name: "allow",
      preToolUse: async () => {
        calls.push("allow");
        return { allow: true };
      },
    };
    const deny: Extension = {
      name: "deny",
      preToolUse: async () => {
        calls.push("deny");
        return { allow: false, reason: "nope" };
      },
    };
    const after: Extension = {
      name: "after",
      preToolUse: async () => {
        calls.push("after");
        return { allow: true };
      },
    };
    const c = await composeExtensions([allow, deny, after], host);
    const verdict = await c.preToolUse({ id: "1", name: "bash", input: {} });
    expect(verdict).toEqual({ allow: false, reason: "nope" });
    expect(calls).toEqual(["allow", "deny"]);
  });

  test("postToolUse: all run; one throwing does not stop the rest", async () => {
    const calls: string[] = [];
    const boom: Extension = {
      name: "boom",
      postToolUse: async () => {
        calls.push("boom");
        throw new Error("x");
      },
    };
    const ok: Extension = {
      name: "ok",
      postToolUse: async () => {
        calls.push("ok");
      },
    };
    const c = await composeExtensions([boom, ok], host);
    await c.postToolUse(
      { id: "1", name: "bash", input: {} },
      { content: "", isError: false },
    );
    expect(calls).toEqual(["boom", "ok"]);
  });

  test("dispose: all run even when one throws", async () => {
    const calls: string[] = [];
    const boom: Extension = {
      name: "boom",
      dispose: async () => {
        calls.push("boom");
        throw new Error("x");
      },
    };
    const ok: Extension = {
      name: "ok",
      dispose: async () => {
        calls.push("ok");
      },
    };
    const c = await composeExtensions([boom, ok], host);
    await c.dispose();
    expect(calls).toEqual(["boom", "ok"]);
  });
});
