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

export type AgentMode = "normal" | "plan" | "auto";

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
  /** Abort in-flight work. Checked at each turn boundary and during streaming. */
  signal?: AbortSignal;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; result: string; isError: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn_end"; stopReason?: string }
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
  const toolDefs = tools.map(toToolDef);

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      yield { type: "done", reason: "aborted" };
      return;
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
      const { content, isError } = await runToolCall(tools, mode, call);
      yield { type: "tool_end", id: call.id, name: call.name, result: content, isError };
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
): Promise<{ content: string; isError: boolean }> {
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
    return { content: out, isError: false };
  } catch (err) {
    return { content: (err as Error).message ?? String(err), isError: true };
  }
}
