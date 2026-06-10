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

import type { PermissionConfig } from "./config.ts";
import type { Message, Provider } from "./provider.ts";

/** The tools the engine ever gates (mutating). Scope narrows this set. */
const WRITE_TOOLS = new Set(["bash", "write_file", "edit_file"]);

/** Does the permission scope cover `toolName`? */
export function inPermissionScope(
  scope: PermissionConfig["scope"],
  toolName: string,
): boolean {
  if (scope === "bash") return toolName === "bash";
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
  const verdict = parseVerdict(out);
  if (!verdict)
    return {
      safe: !opts.failClosed,
      reason: "safety check returned no verdict",
    };
  return verdict;
}
