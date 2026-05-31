// agent.ts — the core agent loop, shared by the headless CLI and the TUI.
//
// `runAgent` is an async generator: it streams a request, collects the model's
// text / thinking / tool_use, executes any tool calls, appends the results, and
// loops until the model stops asking for tools (or a turn cap / abort). Callers
// consume the yielded `AgentEvent`s to render however they like — stdout in
// headless mode, Ink components in the TUI. The conversation `messages` array is
// mutated in place so the caller keeps the full transcript for persistence.

import type { Message, ContentBlock, Provider, ToolDef } from "./provider.ts";
import type { Tool } from "./tools.ts";
import type { Diff } from "./diff.ts";

export type AgentMode = "normal" | "plan" | "auto";

/**
 * Plan-mode instructions appended to the system prompt. In plan mode the agent
 * runs read-only, investigates the project, then emits ONE structured plan and
 * stops — it does not implement. The TUI renders this plan with accept/edit/reject
 * (Phase 4); in headless it simply prints and exits. The fixed section headings
 * make the output easy to parse and present.
 */
export const PLAN_SYSTEM_PROMPT = [
  "",
  "── PLAN MODE ──",
  "You are in read-only planning mode. Inspect the project with your read-only tools",
  "(read_file, list_dir, grep, web_search). Write, edit, and bash tools are disabled and",
  "will return an error if called. Investigate as much as you need, then produce ONE",
  "structured plan and stop. Do NOT implement anything. Format the plan exactly like this:",
  "",
  "## Plan",
  "1. <step — what to do and why>",
  "2. <next step …>",
  "",
  "## Files to touch",
  "- `path/to/file` — <what changes>",
  "",
  "## Risks",
  '- <risk, or "none">',
  "",
  "After emitting the plan, stop. The user will review and accept it before any changes are made.",
].join("\n");

/**
 * Auto-mode instructions appended to the system prompt. In auto mode the agent
 * runs autonomously with no human between turns: it should drive the task to
 * completion itself rather than pausing to ask, and never wait for confirmation
 * before editing files or running commands. The loop enforces a hard turn cap
 * (`autoMaxTurns`) so this autonomy can't run away.
 */
export const AUTO_SYSTEM_PROMPT = [
  "",
  "── AUTO MODE ──",
  "You are running autonomously with no human in the loop between turns. Work the task",
  "through to completion: take each next step yourself instead of asking the user what to do,",
  "and do not pause for confirmation before editing files or running commands. Only stop when",
  "the task is fully done or you are genuinely blocked. You operate under a turn limit, so be",
  "efficient — avoid redundant tool calls and converge quickly.",
].join("\n");

/** Compose the system prompt for a mode: plan/auto append their extra rules. */
export function systemForMode(base: string, mode: AgentMode): string {
  if (mode === "plan") return `${base}\n${PLAN_SYSTEM_PROMPT}`;
  if (mode === "auto") return `${base}\n${AUTO_SYSTEM_PROMPT}`;
  return base;
}

export interface AgentOptions {
  provider: Provider;
  /** Concrete model name passed to the API. */
  model: string;
  system: string;
  /** Conversation so far. The loop appends assistant + tool-result messages. */
  messages: Message[];
  /** Tools available this run. Plan mode should pass only read-only tools. */
  tools: Tool[];
  mode?: AgentMode;
  thinkingBudget?: number;
  maxTokens?: number;
  /**
   * Maximum number of assistant turns before bailing. In `auto` mode this is the
   * autonomy cap; in `normal`/`plan` a single user prompt rarely needs many, but
   * tool-using replies still loop, so a cap guards against runaways.
   */
  maxTurns?: number;
  /**
   * Compact older history once the estimated context size exceeds this many
   * tokens. Checked at each turn boundary. Omitted/0 disables compaction.
   */
  compactAtTokens?: number;
  /** When compacting, how many recent messages to keep verbatim. Default 6. */
  keepRecentMessages?: number;
  /** Abort in-flight work. Checked at each turn boundary and during streaming. */
  signal?: AbortSignal;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; result: string; isError: boolean; diff?: Diff }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn_end"; stopReason?: string }
  | { type: "compaction"; beforeTokens: number; afterTokens: number; summarized: number }
  | { type: "done"; reason: "stop" | "max_turns" | "aborted" };

/** Strip a Tool down to the provider-facing `ToolDef` (no executor). */
function toToolDef(t: Tool): ToolDef {
  return { name: t.name, description: t.description, schema: t.schema };
}

interface CollectedTurn {
  blocks: ContentBlock[];
  toolUses: { id: string; name: string; input: unknown }[];
  stopReason?: string;
}

/**
 * Drive the agent to completion, yielding events as they happen.
 *
 * Returns when the model produces a reply with no tool calls (`stop`), the turn
 * cap is reached (`max_turns`), or the signal aborts (`aborted`).
 */
export async function* runAgent(opts: AgentOptions): AsyncGenerator<AgentEvent> {
  const { provider, model, system, messages, tools, signal } = opts;
  const mode: AgentMode = opts.mode ?? "normal";
  const maxTurns = opts.maxTurns ?? 25;
  const compactAtTokens = opts.compactAtTokens ?? 0;
  const keepRecent = opts.keepRecentMessages ?? 6;
  const toolDefs = tools.map(toToolDef);

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      yield { type: "done", reason: "aborted" };
      return;
    }

    // ── compact older history if the context has grown too large ──
    // Done at the turn boundary (message list is in a valid, paired state here).
    if (compactAtTokens > 0) {
      const beforeTokens = estimateTokens(messages, system);
      if (beforeTokens > compactAtTokens) {
        const result = await compactConversation({ provider, model, messages, keepRecent, signal });
        if (result.summarized > 0) {
          yield {
            type: "compaction",
            beforeTokens,
            afterTokens: estimateTokens(messages, system),
            summarized: result.summarized,
          };
        }
      }
    }

    // ── stream one assistant turn ──
    const collected: CollectedTurn = { blocks: [], toolUses: [] };
    let textBuf = "";
    let thinkingBuf = "";

    const flushText = () => {
      if (textBuf) {
        collected.blocks.push({ type: "text", text: textBuf });
        textBuf = "";
      }
    };

    for await (const ev of provider.stream({
      model,
      system,
      messages,
      tools: toolDefs,
      thinkingBudget: opts.thinkingBudget,
      maxTokens: opts.maxTokens,
    })) {
      if (signal?.aborted) {
        yield { type: "done", reason: "aborted" };
        return;
      }
      switch (ev.type) {
        case "text_delta":
          textBuf += ev.text;
          yield { type: "text", text: ev.text };
          break;
        case "thinking_delta":
          thinkingBuf += ev.text;
          yield { type: "thinking", text: ev.text };
          break;
        case "tool_use":
          // A tool_use closes any open text block so ordering is preserved.
          flushText();
          collected.toolUses.push({ id: ev.id, name: ev.name, input: ev.input });
          collected.blocks.push({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
          break;
        case "usage":
          yield { type: "usage", inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
          break;
        case "done":
          collected.stopReason = ev.stopReason;
          break;
      }
    }
    flushText();
    // Record thinking for display continuity; unsigned thinking is dropped by the
    // provider on replay, so it is safe to keep but won't be sent back.
    if (thinkingBuf) collected.blocks.unshift({ type: "thinking", thinking: thinkingBuf });

    // Persist the assistant turn (skip an empty one to avoid a malformed message).
    if (collected.blocks.length > 0) {
      messages.push({ role: "assistant", content: collected.blocks });
    }
    yield { type: "turn_end", stopReason: collected.stopReason };

    // ── no tools → we're done ──
    if (collected.toolUses.length === 0) {
      yield { type: "done", reason: "stop" };
      return;
    }

    // ── execute tool calls, gather results into one user message ──
    const results: ContentBlock[] = [];
    for (const call of collected.toolUses) {
      if (signal?.aborted) {
        yield { type: "done", reason: "aborted" };
        return;
      }
      yield { type: "tool_start", id: call.id, name: call.name, input: call.input };
      const { content, isError, diff } = await runToolCall(tools, mode, call);
      yield { type: "tool_end", id: call.id, name: call.name, result: content, isError, diff };
      results.push({ type: "tool_result", tool_use_id: call.id, content, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }

  yield { type: "done", reason: "max_turns" };
}

/** Execute one tool call, enforcing plan-mode read-only gating. Never throws. */
async function runToolCall(
  tools: Tool[],
  mode: AgentMode,
  call: { id: string; name: string; input: unknown },
): Promise<{ content: string; isError: boolean; diff?: Diff }> {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) {
    return { content: `unknown tool: ${call.name}`, isError: true };
  }
  if (mode === "plan" && !tool.readOnly) {
    return { content: `tool "${call.name}" is blocked in plan mode (read-only)`, isError: true };
  }
  const input = (call.input ?? {}) as Record<string, any>;
  try {
    const out = await tool.run(input);
    // Tools may return a bare string or a `{ content, diff }` result.
    if (typeof out === "string") return { content: out, isError: false };
    return { content: out.content, isError: false, diff: out.diff };
  } catch (err) {
    return { content: (err as Error).message ?? String(err), isError: true };
  }
}

// ── Context compaction ─────────────────────────────────────────────────────────
// When a conversation outgrows the model's useful context window, summarize the
// older messages into one synthetic message and keep only the recent tail. We
// estimate token count with a cheap chars/4 heuristic — no tokenizer dependency —
// which is good enough to decide *when* to compact.

const CHARS_PER_TOKEN = 4;

/** Rough token estimate for a transcript (system + messages), chars/4. */
export function estimateTokens(messages: Message[], system = ""): number {
  let chars = system.length;
  for (const m of messages) chars += JSON.stringify(m.content).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Render a message transcript to plain text for the summarizer prompt. */
function renderTranscript(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      switch (b.type) {
        case "text":
          if (b.text.trim()) parts.push(`${m.role}: ${b.text}`);
          break;
        case "tool_use":
          parts.push(`${m.role} called ${b.name}(${JSON.stringify(b.input).slice(0, 800)})`);
          break;
        case "tool_result": {
          const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          parts.push(`tool_result${b.is_error ? " (error)" : ""}: ${c.slice(0, 800)}`);
          break;
        }
        // thinking blocks are display-only; omit from the summary input.
      }
    }
  }
  return parts.join("\n");
}

/**
 * Choose the split index: summarize `[0, cut)`, keep `[cut, end)`. `cut` is moved
 * forward to the first assistant message so the kept tail starts assistant-first
 * (valid after a synthetic user summary) and never orphans a tool_result from its
 * tool_use. Returns 0 when no safe, worthwhile split exists.
 */
function pickCut(messages: Message[], keepRecent: number): number {
  let cut = messages.length - keepRecent;
  if (cut <= 0) return 0;
  while (cut < messages.length && messages[cut].role !== "assistant") cut++;
  // Need at least one message kept and at least two summarized to be worthwhile.
  if (cut >= messages.length || cut < 2) return 0;
  return cut;
}

interface CompactOptions {
  provider: Provider;
  model: string;
  messages: Message[];
  keepRecent: number;
  signal?: AbortSignal;
}

/**
 * Summarize the older portion of `messages` in place, replacing it with a single
 * synthetic user message. Returns the number of messages that were summarized
 * away (0 if compaction was skipped or produced no summary). Exported for testing.
 */
export async function compactConversation(opts: CompactOptions): Promise<{ summarized: number }> {
  const { provider, model, messages, keepRecent, signal } = opts;
  const cut = pickCut(messages, keepRecent);
  if (cut === 0) return { summarized: 0 };

  const older = messages.slice(0, cut);
  const transcript = renderTranscript(older);
  const summary = await summarize(provider, model, transcript, signal);
  if (!summary.trim()) return { summarized: 0 };

  const synthetic: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text:
          "[Earlier conversation was summarized to conserve context.]\n\n" +
          "Summary of the work so far:\n" +
          summary,
      },
    ],
  };
  // Replace the summarized prefix with the single synthetic message.
  messages.splice(0, cut, synthetic);
  return { summarized: cut };
}

const SUMMARIZER_SYSTEM =
  "You are a summarizer. Condense the conversation transcript into a compact but " +
  "complete brief that lets the assistant continue the task seamlessly. Preserve: " +
  "the user's goal, key decisions, files inspected or modified, important findings, " +
  "and any pending next steps. Use terse bullet points. Do not invent details.";

/** One-shot, tool-free summarization call against the provider. */
async function summarize(
  provider: Provider,
  model: string,
  transcript: string,
  signal?: AbortSignal,
): Promise<string> {
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: `Summarize this conversation transcript:\n\n${transcript}` }],
    },
  ];
  let out = "";
  for await (const ev of provider.stream({ model, system: SUMMARIZER_SYSTEM, messages, tools: [] })) {
    if (signal?.aborted) break;
    if (ev.type === "text_delta") out += ev.text;
  }
  return out;
}
