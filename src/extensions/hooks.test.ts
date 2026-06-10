// hooks.test.ts — hooksExtension factory: PreToolUse blocking, short-circuit on
// empty config, and PostToolUse fire-and-forget path.

import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config.ts";
import { hooksExtension } from "./hooks.ts";

/** Build a ctx stub as the spec prescribes: { config, sessionId } as never. */
function ctx(hooks: ReturnType<typeof defaultConfig>["hooks"]) {
  const config = defaultConfig();
  config.hooks = hooks;
  return { config, sessionId: "s1" } as never;
}

const CALL = { id: "c1", name: "bash", input: { command: "echo hi" } };

describe("hooksExtension", () => {
  test("returns an extension named 'hooks'", () => {
    expect(hooksExtension().name).toBe("hooks");
  });

  test("preToolUse: short-circuits with allow=true when PreToolUse is empty", async () => {
    const ext = hooksExtension();
    // No command runs at all — guard short-circuit path.
    const result = await ext.preToolUse!(CALL, ctx({}));
    expect(result).toEqual({ allow: true });
  });

  test("preToolUse: allow=true when PreToolUse array is present but empty", async () => {
    const ext = hooksExtension();
    const result = await ext.preToolUse!(CALL, ctx({ PreToolUse: [] }));
    expect(result).toEqual({ allow: true });
  });

  test("preToolUse: blocks (allow=false) when hook exits nonzero", async () => {
    const ext = hooksExtension();
    const c = ctx({
      PreToolUse: [
        {
          matcher: "bash",
          hooks: [
            { type: "command", command: "bash -c 'echo blocked >&2; exit 2'" },
          ],
        } as never,
      ],
    });
    const result = await ext.preToolUse!(CALL, c);
    expect(result?.allow).toBe(false);
  });

  test("preToolUse: allows when hook exits 0", async () => {
    const ext = hooksExtension();
    const c = ctx({
      PreToolUse: [
        {
          matcher: "bash",
          hooks: [{ type: "command", command: "bash -c 'exit 0'" }],
        } as never,
      ],
    });
    const result = await ext.preToolUse!(CALL, c);
    expect(result?.allow).toBe(true);
  });

  test("postToolUse: no-ops when PostToolUse is empty (short-circuit)", async () => {
    const ext = hooksExtension();
    // Should resolve without running any process.
    await expect(
      ext.postToolUse!(CALL, { content: "ok", isError: false }, ctx({})),
    ).resolves.toBeUndefined();
  });
});
