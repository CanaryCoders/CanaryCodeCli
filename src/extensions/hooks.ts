// hooks.ts — Claude Code-compatible lifecycle hooks.
//
// Hooks are shell commands run via `bash -c` at agent lifecycle events. cc accepts
// Claude Code's nested matcher-group schema and the older cc flat shorthand. Hook
// commands receive a JSON payload on stdin with Claude-style field names
// (`hook_event_name`, `tool_name`, `tool_input`, etc.) plus legacy aliases
// (`event`, `tool`, `input`) so existing scripts keep working.

import type { HookConfig, HooksConfig } from "../config.ts";
import type { SessionExtension } from "../extension.ts";

export type HookEventName = keyof HooksConfig;

/** A tool call as seen by a hook. */
export interface HookCall {
  name: string;
  input: unknown;
}

/** Runtime metadata shared by Claude-style hook payloads. */
export interface HookContext {
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
}

interface NormalizedHook {
  event: HookEventName;
  matcher?: string;
  command: string;
  timeoutMs: number;
}

interface HookRun {
  code: number;
  stdout: string;
  stderr: string;
  output: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function hasNestedHooks(
  hook: HookConfig,
): hook is Extract<HookConfig, { hooks: unknown[] }> {
  return Array.isArray((hook as { hooks?: unknown }).hooks);
}

function timeoutMs(raw: number | undefined, nested: boolean): number {
  if (!raw || raw <= 0) return DEFAULT_TIMEOUT_MS;
  // Claude-style nested hooks use seconds; cc's legacy flat shorthand used ms.
  return nested ? raw * 1000 : raw;
}

/** Flatten Claude matcher groups and cc legacy entries into command hooks. */
function normalizeEventHooks(
  event: HookEventName,
  entries: HookConfig[] | undefined,
): NormalizedHook[] {
  const out: NormalizedHook[] = [];
  for (const entry of entries ?? []) {
    if (hasNestedHooks(entry)) {
      for (const hook of entry.hooks) {
        const h = hook as {
          type?: string;
          command?: unknown;
          timeout?: number;
        };
        if (h.type && h.type !== "command") continue;
        if (typeof h.command !== "string" || !h.command.trim()) continue;
        out.push({
          event,
          matcher: entry.matcher,
          command: h.command,
          timeoutMs: timeoutMs(h.timeout, true),
        });
      }
      continue;
    }
    const h = entry as {
      command?: unknown;
      timeout?: number;
      matcher?: string;
    };
    if (typeof h.command !== "string" || !h.command.trim()) continue;
    out.push({
      event,
      matcher: h.matcher,
      command: h.command,
      timeoutMs: timeoutMs(h.timeout, false),
    });
  }
  return out;
}

function configuredEvents(hooks: HooksConfig): HookEventName[] {
  return Object.keys(hooks) as HookEventName[];
}

/** Does this hook apply to `toolName`? No matcher = matches everything. */
function matches(hook: NormalizedHook, toolName: string): boolean {
  if (!hook.matcher) return true;
  try {
    return new RegExp(hook.matcher).test(toolName);
  } catch {
    // A malformed matcher regex matches nothing rather than throwing mid-loop.
    return false;
  }
}

function basePayload(event: HookEventName, ctx: HookContext = {}) {
  return {
    session_id: ctx.sessionId,
    transcript_path: ctx.transcriptPath,
    cwd: ctx.cwd ?? process.cwd(),
    hook_event_name: event,
    // Legacy aliases retained for old cc hook scripts.
    event,
  };
}

/** Run one hook command, piping `payload` as JSON on stdin. Never throws. */
async function runHook(
  hook: NormalizedHook,
  payload: unknown,
): Promise<HookRun> {
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
    }, hook.timeoutMs);
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
      return {
        code: 1,
        stdout,
        stderr: `hook timed out after ${hook.timeoutMs}ms`,
        output: `hook timed out after ${hook.timeoutMs}ms`,
      };
    }
    return { code, stdout, stderr, output };
  } catch (err) {
    const output = `hook failed to run: ${(err as Error).message}`;
    return { code: 1, stdout: "", stderr: output, output };
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function preToolJsonDecision(stdout: string): PreToolDecision | undefined {
  const json = parseJsonObject(stdout);
  if (!json) return undefined;
  const specific = json.hookSpecificOutput;
  const hookSpecific =
    specific && typeof specific === "object"
      ? (specific as Record<string, unknown>)
      : undefined;
  const decision =
    stringField(hookSpecific ?? json, "permissionDecision") ??
    stringField(json, "decision");
  const reason =
    stringField(hookSpecific ?? json, "permissionDecisionReason") ??
    stringField(json, "reason") ??
    stringField(json, "message");
  switch (decision) {
    case "allow":
    case "approve":
      return { allow: true };
    case "deny":
    case "block":
      return { allow: false, reason: reason || "blocked by a PreToolUse hook" };
    case "ask":
      // cc has no hook-driven ask escalation yet; fail closed with the hook reason.
      return {
        allow: false,
        reason: reason || "PreToolUse hook requested user approval",
      };
    default:
      return undefined;
  }
}

/** Outcome of the PreToolUse phase: blocked (with a reason) or cleared. */
export interface PreToolDecision {
  allow: boolean;
  reason?: string;
}

/**
 * Run all matching `PreToolUse` hooks in order. Claude-style JSON stdout can
 * allow/deny; exit code 2 blocks; legacy compatibility also blocks on any other
 * non-zero exit because older cc documented that behavior.
 */
export async function runPreToolHooks(
  hooks: HooksConfig,
  call: HookCall,
  ctx: HookContext = {},
): Promise<PreToolDecision> {
  const matching = normalizeEventHooks("PreToolUse", hooks.PreToolUse).filter(
    (h) => matches(h, call.name),
  );
  return matching.reduce<Promise<PreToolDecision>>(
    (prev, hook) =>
      prev.then(async (decision) => {
        if (!decision.allow) return decision;
        const payload = {
          ...basePayload("PreToolUse", ctx),
          tool_name: call.name,
          tool_input: call.input,
          // Legacy aliases.
          tool: call.name,
          input: call.input,
        };
        const run = await runHook(hook, payload);
        const jsonDecision = preToolJsonDecision(run.stdout);
        if (jsonDecision && !jsonDecision.allow) return jsonDecision;
        if (jsonDecision?.allow) return decision;
        if (run.code !== 0) {
          return {
            allow: false,
            reason:
              run.stderr.trim() ||
              run.stdout.trim() ||
              `blocked by a PreToolUse hook (exit ${run.code})`,
          };
        }
        return decision;
      }),
    Promise.resolve({ allow: true }),
  );
}

/** Run all matching `PostToolUse` hooks (observational; output ignored). */
export async function runPostToolHooks(
  hooks: HooksConfig,
  call: HookCall,
  result: { content: string; isError: boolean },
  ctx: HookContext = {},
): Promise<void> {
  const matching = normalizeEventHooks("PostToolUse", hooks.PostToolUse).filter(
    (h) => matches(h, call.name),
  );
  await Promise.all(
    matching.map((hook) =>
      runHook(hook, {
        ...basePayload("PostToolUse", ctx),
        tool_name: call.name,
        tool_input: call.input,
        tool_response: {
          content: result.content,
          is_error: result.isError,
        },
        // Legacy aliases.
        tool: call.name,
        input: call.input,
        result: result.content,
        isError: result.isError,
      }),
    ),
  );
}

export async function runUserPromptSubmitHooks(
  hooks: HooksConfig,
  prompt: string,
  ctx: HookContext = {},
): Promise<void> {
  const matching = normalizeEventHooks(
    "UserPromptSubmit",
    hooks.UserPromptSubmit,
  );
  await Promise.all(
    matching.map((hook) =>
      runHook(hook, {
        ...basePayload("UserPromptSubmit", ctx),
        prompt,
      }),
    ),
  );
}

export async function runSessionStartHooks(
  hooks: HooksConfig,
  source: "startup" | "resume" | "clear",
  ctx: HookContext = {},
): Promise<void> {
  const matching = normalizeEventHooks("SessionStart", hooks.SessionStart);
  await Promise.all(
    matching.map((hook) =>
      runHook(hook, {
        ...basePayload("SessionStart", ctx),
        source,
      }),
    ),
  );
}

/** Run all `Stop` hooks (observational; output ignored). */
export async function runStopHooks(
  hooks: HooksConfig,
  ctx: HookContext & { reason?: string; stopHookActive?: boolean } = {},
): Promise<void> {
  const matching = normalizeEventHooks("Stop", hooks.Stop);
  await Promise.all(
    matching.map((hook) =>
      runHook(hook, {
        ...basePayload("Stop", ctx),
        stop_hook_active: ctx.stopHookActive ?? false,
        reason: ctx.reason,
      }),
    ),
  );
}

export async function runSubagentStopHooks(
  hooks: HooksConfig,
  ctx: HookContext & { reason?: string } = {},
): Promise<void> {
  const matching = normalizeEventHooks("SubagentStop", hooks.SubagentStop);
  await Promise.all(
    matching.map((hook) =>
      runHook(hook, {
        ...basePayload("SubagentStop", ctx),
        reason: ctx.reason,
      }),
    ),
  );
}

export async function runSessionEndHooks(
  hooks: HooksConfig,
  ctx: HookContext & { reason?: string } = {},
): Promise<void> {
  const matching = normalizeEventHooks("SessionEnd", hooks.SessionEnd);
  await Promise.all(
    matching.map((hook) =>
      runHook(hook, {
        ...basePayload("SessionEnd", ctx),
        reason: ctx.reason,
      }),
    ),
  );
}

/** A one-line note describing configured hooks (undefined when none). */
export function describeHooks(hooks: HooksConfig): string | undefined {
  const labels: string[] = [];
  for (const event of configuredEvents(hooks)) {
    const count = normalizeEventHooks(event, hooks[event]).length;
    if (count > 0) labels.push(`${count} ${event}`);
  }
  return labels.length ? `⎇ hooks: ${labels.join(", ")}` : undefined;
}

export function hooksExtension(): SessionExtension {
  return {
    name: "hooks",
    async preToolUse(call, ctx) {
      if (!ctx.config.hooks.PreToolUse?.length) return { allow: true };
      return runPreToolHooks(ctx.config.hooks, call, {
        sessionId: ctx.sessionId,
        cwd: process.cwd(),
      });
    },
    async postToolUse(call, result, ctx) {
      if (!ctx.config.hooks.PostToolUse?.length) return;
      await runPostToolHooks(ctx.config.hooks, call, result, {
        sessionId: ctx.sessionId,
        cwd: process.cwd(),
      });
    },
  };
}
