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
});
