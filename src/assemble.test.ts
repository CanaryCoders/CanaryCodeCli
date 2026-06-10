import { describe, expect, test } from "bun:test";
import { assembleSession } from "./assemble.ts";
import { defaultConfig } from "./config.ts";

function opts(mode: "normal" | "plan") {
  return {
    config: defaultConfig(),
    mode,
    provider: { id: "anthropic", stream: async function* () {} } as never,
    model: "test-model",
    sessionId: "s1",
    signal: new AbortController().signal,
    note: () => {},
    // askUserTool's answerer (AskUserFn): questions → answers (or null).
    askUser: (async () => []) as never,
    onTasks: () => {},
  };
}

describe("assembleSession", () => {
  test("default assembly yields the core 6 plus feature tools, in order", async () => {
    const session = await assembleSession(opts("normal"));
    const names = session.tools.map((t) => t.name);
    expect(names.slice(0, 6)).toEqual([
      "read_file",
      "write_file",
      "edit_file",
      "list_dir",
      "bash",
      "grep",
    ]);
    expect(names).toContain("web_search");
    expect(names).toContain("ask_user");
    expect(names).toContain("update_tasks");
    expect(names[names.length - 1]).toBe("update_tasks");
    await session.dispose();
  });

  test("plan mode filters to read-only tools", async () => {
    const session = await assembleSession(opts("plan"));
    expect(session.tools.every((t) => t.readOnly)).toBe(true);
    await session.dispose();
  });

  test("noTools yields an empty tool set", async () => {
    const session = await assembleSession({ ...opts("normal"), noTools: true });
    expect(session.tools).toEqual([]);
    await session.dispose();
  });

  test("AI permission (failClosed, unresolvable model) composes a denying gate", async () => {
    const config = defaultConfig();
    // No providers → the permission checker model can't resolve, so failClosed
    // makes the gate deny in-scope calls.
    config.providers = {};
    config.permission = {
      mode: "ai",
      model: "no-such-model-xyz",
      scope: "writes",
      failClosed: true,
    };
    const session = await assembleSession({ ...opts("normal"), config });
    expect(session.gate).toBeDefined();
    const v = await session.gate!({ id: "1", name: "bash", input: {} });
    expect(v.allow).toBe(false);
    await session.dispose();
  });
});
