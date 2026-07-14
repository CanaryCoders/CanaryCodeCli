// permission.ts — the AI permission-approval engine.
//
// When `permission.mode` is "ai", each gated mutating tool call is first shown to
// a separate, usually cheap, model that classifies it as safe or unsafe to run in
// the user's working directory. The front-ends decide what to do with the verdict:
// the TUI escalates an "unsafe" verdict to the human y/n/a box (showing the reason);
// headless, with no human present, blocks an unsafe call and tells the model why.
//
// The checker is a one-shot, tool-free call — it never touches the filesystem; it
// only reasons about the proposed call. It fails OPEN by default: any network/parse
// error yields a "safe" verdict so a flaky checker degrades to today's behavior
// rather than wedging the agent. Setting `permission.failClosed` flips checker
// failures to "unsafe" (headless blocks the call; the TUI escalates to the human
// box). Auto mode / `--yolo` skip the checker entirely.

import type { AgentOptions } from "../agent.ts";
import type { Config, PermissionConfig } from "../config.ts";
import { modelForRole, resolveModel } from "../config.ts";
import type { Message, Provider } from "../provider.ts";
import { createProvider } from "../provider.ts";

/** The tools the engine ever gates (mutating). Scope narrows this set. */
const WRITE_TOOLS = new Set(["bash", "bash_kill", "write_file", "edit_file"]);

/** Does the permission scope cover `toolName`? */
export function inPermissionScope(
  scope: PermissionConfig["scope"],
  toolName: string,
): boolean {
  if (scope === "bash") return toolName === "bash" || toolName === "bash_kill";
  // "writes" (the default) covers every mutating tool.
  return WRITE_TOOLS.has(toolName);
}

export interface SafetyVerdict {
  safe: boolean;
  reason: string;
}

const CHECKER_SYSTEM = [
  "You are a security reviewer guarding a coding agent that runs tool calls in the",
  "user's working directory. You are shown ONE proposed tool call. Decide whether it",
  "is safe to execute automatically without a human's explicit approval.",
  "",
  "Treat as UNSAFE: deleting or overwriting data outside the obvious task; recursive",
  "or wildcard deletes; modifying files outside the project; piping the network into a",
  "shell; exfiltrating secrets, credentials, or environment variables; disabling",
  "security controls; package publishing, force-pushes, or other irreversible/remote",
  "side effects; anything you cannot clearly judge as benign.",
  "Treat as SAFE: ordinary reads, edits, builds, tests, and local git operations",
  "scoped to the project.",
  "",
  'Reply with ONLY a JSON object and nothing else: {"verdict":"safe"|"unsafe",',
  '"reason":"<one short sentence>"}.',
].join("\n");

/** Render a proposed call into the reviewer's user message. */
function describeCall(call: { name: string; input: unknown }): string {
  return `Tool: ${call.name}\nArguments:\n${JSON.stringify(call.input, null, 2)}`;
}

/** Pull the first JSON object out of the model's reply (it may add stray text). */
function parseVerdict(text: string): SafetyVerdict | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { verdict?: string; reason?: string };
    const safe = obj.verdict === "safe";
    const unsafe = obj.verdict === "unsafe";
    if (!safe && !unsafe) return null;
    return { safe, reason: obj.reason?.trim() || "(no reason given)" };
  } catch {
    return null;
  }
}

/**
 * Classify a proposed tool call. Fails open by default: a network error, an empty
 * reply, or an unparseable verdict all resolve to `{ safe: true }` (with a note)
 * so the agent is never blocked by checker flakiness — the human/headless layers
 * still apply their own policy on top. With `opts.failClosed` those same failures
 * resolve to `{ safe: false }` instead, so the call cannot run unchecked.
 */
export async function checkCommandSafety(
  provider: Provider,
  model: string,
  call: { name: string; input: unknown },
  signal?: AbortSignal,
  opts: { failClosed?: boolean } = {},
): Promise<SafetyVerdict> {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: describeCall(call) }] },
  ];
  let out = "";
  try {
    for await (const ev of provider.stream({
      model,
      system: CHECKER_SYSTEM,
      messages,
      tools: [],
      maxTokens: 256,
    })) {
      if (signal?.aborted) break;
      if (ev.type === "text_delta") out += ev.text;
    }
  } catch (err) {
    return {
      safe: !opts.failClosed,
      reason: `safety check failed: ${(err as Error).message}`,
    };
  }
  // An aborted check is the user cancelling the run, not a checker failure —
  // fail open regardless of failClosed so teardown isn't misclassified as unsafe.
  if (signal?.aborted) return { safe: true, reason: "check aborted" };
  const verdict = parseVerdict(out);
  if (!verdict)
    return {
      safe: !opts.failClosed,
      reason: "safety check returned no verdict",
    };
  return verdict;
}

// ===========================================================================
// AI permission gate — construction + composition
// ===========================================================================

/** A mutating-tool approval gate: allow/deny a proposed call by name + input.
 * Matches the agent loop's gate shape so a composed gate threads straight into
 * `runAgent` and through spawn_agent to children. */
export type Gate = NonNullable<AgentOptions["gate"]>;

/** A frontend gate may receive an optional AI advisory when the AI checker
 * flagged the call; the human's verdict is then final. The extra `aiFlag`
 * parameter is optional, so a `FrontendGate` is assignable to `Gate` (callers
 * that don't pass an advisory still typecheck). */
export type FrontendGate = (
  call: Parameters<Gate>[0],
  aiFlag?: { reason: string },
) => ReturnType<Gate>;

export interface PermissionGateOptions {
  config: Config;
  signal: AbortSignal;
  /** Status note writer (stderr in headless). */
  note(text: string): void;
}

/** Build the AI permission gate from config, or undefined when disabled.
 * Kept as a `gate` (not a preToolUse hook) so it threads through
 * spawn_agent to child agents exactly as before. */
export function buildPermissionGate(
  opts: PermissionGateOptions,
): Gate | undefined {
  const { config, signal, note } = opts;

  // With permission.failClosed, an unavailable checker DENIES in-scope calls
  // instead of letting everything run unchecked.
  const denyGate = (text: string): Gate => {
    note(text);
    return async (call) =>
      inPermissionScope(config.permission.scope, call.name)
        ? {
            allow: false,
            reason:
              "AI safety check unavailable and permission.failClosed is set",
          }
        : { allow: true };
  };

  const permResolved = resolveModel(config, modelForRole(config, "permission"));
  if (!permResolved) {
    if (config.permission.failClosed) {
      return denyGate(
        `note: permission model "${modelForRole(config, "permission")}" not found; safety checks are required (permission.failClosed) but unavailable — gated calls will be blocked`,
      );
    }
    note(
      `note: permission model "${modelForRole(config, "permission")}" not found; AI safety check disabled`,
    );
    return undefined;
  }

  try {
    const checkerProvider = createProvider(permResolved.providerConfig);
    const checkerModel = permResolved.model.name ?? permResolved.model.id;
    note(`⛉ AI permission check (${checkerModel})`);
    return async (call) => {
      if (!inPermissionScope(config.permission.scope, call.name)) {
        return { allow: true };
      }
      const v = await checkCommandSafety(
        checkerProvider,
        checkerModel,
        call,
        signal,
        { failClosed: config.permission.failClosed },
      );
      if (v.safe) return { allow: true };
      return {
        allow: false,
        reason: `blocked by AI safety check: ${v.reason}`,
      };
    };
  } catch (err) {
    if (config.permission.failClosed) {
      return denyGate(
        `note: AI safety check unavailable (${(err as Error).message}); checks are required (permission.failClosed) — gated calls will be blocked`,
      );
    }
    note(`note: AI safety check disabled: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Compose the AI gate and the frontend gate into one. The AI gate runs first:
 *   • allow → the frontend gate is consulted with NO advisory (silent pass when
 *     the frontend allows, e.g. permission "ai" with the TUI's allow-through).
 *   • deny  → the call is ESCALATED to the frontend gate WITH the AI's reason as
 *     an advisory; the human's verdict is final (they can still approve). When
 *     there is no frontend gate (headless), the AI deny stands as a hard block.
 * Undefined pieces are skipped; if both are undefined the result is undefined
 * (no gate at all).
 */
export function composeGates(
  aiGate: Gate | undefined,
  frontendGate: FrontendGate | undefined,
): Gate | undefined {
  if (!aiGate && !frontendGate) return undefined;
  if (!aiGate) return frontendGate as Gate;
  if (!frontendGate) return aiGate;
  return async (call) => {
    const ai = await aiGate(call);
    if (ai.allow) return frontendGate(call);
    // AI flagged it: escalate to the human with the reason; their verdict is final.
    return frontendGate(call, {
      reason: ai.reason ?? "flagged by AI safety check",
    });
  };
}
