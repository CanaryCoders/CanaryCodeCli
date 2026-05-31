// hooks.ts — lifecycle hooks: shell commands fired on agent events.
//
// A hook is a shell command (run via `bash -c`) bound to an event by an optional
// regex `matcher` on the tool name. The command receives a JSON payload on stdin
// describing the event. Hooks are deterministic policy, so they run in EVERY mode
// (including auto) — unlike the AI/human gates, which auto bypasses.
//
//   PreToolUse  — runs before a tool executes. A non-zero exit BLOCKS the call;
//                 the command's output becomes the reason the model is told.
//   PostToolUse — runs after a tool finishes. Fire-and-forget (output ignored).
//   Stop        — runs once when a turn ends. Fire-and-forget.
//
// Every hook is timeout-bounded (default 10s) so a hung command can't wedge the
// agent loop. Both front-ends share this runner via the engine's caller hooks.

import type { HookConfig, HooksConfig } from "./config.ts";

/** A tool call as seen by a hook. */
export interface HookCall {
  name: string;
  input: unknown;
}

/** Does this hook apply to `toolName`? No matcher = matches everything. */
function matches(hook: HookConfig, toolName: string): boolean {
  if (!hook.matcher) return true;
  try {
    return new RegExp(hook.matcher).test(toolName);
  } catch {
    // A malformed matcher regex matches nothing rather than throwing mid-loop.
    return false;
  }
}

interface HookRun {
  code: number;
  output: string;
}

/** Run one hook command, piping `payload` as JSON on stdin. Never throws. */
async function runHook(hook: HookConfig, payload: unknown): Promise<HookRun> {
  const timeoutMs = hook.timeout && hook.timeout > 0 ? hook.timeout : 10_000;
  try {
    const proc = Bun.spawn(["bash", "-c", hook.command], {
      stdin: new TextEncoder().encode(`${JSON.stringify(payload)}\n`),
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    const output = [stdout, stderr]
      .filter((s) => s.length > 0)
      .join("")
      .trim();
    if (timedOut) {
      return { code: 1, output: `hook timed out after ${timeoutMs}ms` };
    }
    return { code, output };
  } catch (err) {
    return { code: 1, output: `hook failed to run: ${(err as Error).message}` };
  }
}

/** Outcome of the PreToolUse phase: blocked (with a reason) or cleared. */
export interface PreToolDecision {
  allow: boolean;
  reason?: string;
}

/**
 * Run all matching `PreToolUse` hooks in order. The first hook to exit non-zero
 * blocks the call; its output (or a default) is returned as the deny reason. With
 * no matching hooks, the call is allowed.
 */
export async function runPreToolHooks(
  hooks: HooksConfig,
  call: HookCall,
): Promise<PreToolDecision> {
  const matching = (hooks.PreToolUse ?? []).filter((h) =>
    matches(h, call.name),
  );
  for (const hook of matching) {
    const { code, output } = await runHook(hook, {
      event: "PreToolUse",
      tool: call.name,
      input: call.input,
    });
    if (code !== 0) {
      return {
        allow: false,
        reason: output || `blocked by a PreToolUse hook (exit ${code})`,
      };
    }
  }
  return { allow: true };
}

/** Run all matching `PostToolUse` hooks (fire-and-forget; output ignored). */
export async function runPostToolHooks(
  hooks: HooksConfig,
  call: HookCall,
  result: { content: string; isError: boolean },
): Promise<void> {
  const matching = (hooks.PostToolUse ?? []).filter((h) =>
    matches(h, call.name),
  );
  await Promise.all(
    matching.map((hook) =>
      runHook(hook, {
        event: "PostToolUse",
        tool: call.name,
        input: call.input,
        result: result.content,
        isError: result.isError,
      }),
    ),
  );
}

/** Run all `Stop` hooks (fire-and-forget; output ignored). */
export async function runStopHooks(hooks: HooksConfig): Promise<void> {
  await Promise.all(
    (hooks.Stop ?? []).map((hook) => runHook(hook, { event: "Stop" })),
  );
}

/** A one-line note describing configured hooks (undefined when none). */
export function describeHooks(hooks: HooksConfig): string | undefined {
  const counts: string[] = [];
  if (hooks.PreToolUse?.length) counts.push(`${hooks.PreToolUse.length} pre`);
  if (hooks.PostToolUse?.length)
    counts.push(`${hooks.PostToolUse.length} post`);
  if (hooks.Stop?.length) counts.push(`${hooks.Stop.length} stop`);
  return counts.length ? `🪝 hooks: ${counts.join(", ")}` : undefined;
}
