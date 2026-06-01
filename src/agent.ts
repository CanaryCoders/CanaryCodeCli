// agent.ts — the core agent loop, shared by the headless CLI and the TUI.
//
// `runAgent` is an async generator: it streams a request, collects the model's
// text / thinking / tool_use, executes any tool calls, appends the results, and
// loops until the model stops asking for tools (or a turn cap / abort). Callers
// consume the yielded `AgentEvent`s to render however they like — stdout in
// headless mode, Ink components in the TUI. The conversation `messages` array is
// mutated in place so the caller keeps the full transcript for persistence.

import type { ModelRole } from "./config.ts";
import type { Diff } from "./diff.ts";
import type { ContentBlock, Message, Provider, ToolDef } from "./provider.ts";
import type { Tool } from "./tools.ts";

export type AgentMode = "normal" | "plan" | "auto";

/**
 * Plan-mode instructions appended to the system prompt. In plan mode the agent
 * runs read-only: it must FIRST investigate the project with its read-only tools,
 * THEN emit ONE structured plan grounded in what it read and stop — it does not
 * implement. The prompt forbids investigation-as-plan-steps so the output is an
 * implementation plan, not a plan to explore. The TUI renders this plan with
 * accept/edit/reject (Phase 4); in headless it simply prints and exits. The fixed
 * section headings make the output easy to parse and present.
 */
const PLAN_SYSTEM_PROMPT = [
  "",
  "── PLAN MODE ──",
  "You are in read-only planning mode. Write, edit, and bash tools are disabled and will",
  "return an error if called; you have read_file, list_dir, grep, and web_search.",
  "",
  "FIRST, investigate. Actually read the relevant code now — open the files you would",
  "change, trace how they work, and confirm the real names, signatures, and line numbers",
  "with your tools. Do not guess, and do not defer this to the plan. The plan you produce",
  "must be grounded in what you just read.",
  "",
  "THEN produce ONE structured plan and stop — do NOT implement anything. The plan",
  "describes the implementation only. Exploration is never a plan step: do not write steps",
  'like "look at", "find", "investigate", or "understand X" — you do that now, before',
  "planning. Every step must be a concrete change a developer can carry out, naming the",
  "real files and symbols you found.",
  "",
  "Format the plan exactly like this:",
  "",
  "## Plan",
  "1. <concrete implementation step — what to change and why>",
  "2. <next step …>",
  "",
  "## Files to touch",
  "- `path/to/file` — <what changes>",
  "",
  "## Risks",
  '- <risk, or an open question you could not resolve by reading, or "none">',
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
const AUTO_SYSTEM_PROMPT = [
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

/** Map an agent mode to the model role it should run on: plan investigates on the
 * reasoning model; normal/auto execute (and talk) on the coding model. */
export function roleForMode(mode: AgentMode): ModelRole {
  return mode === "plan" ? "reasoning" : "coding";
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
   * Hard cap on assistant turns, used only when `checkpointEvery` is 0/unset.
   * In `auto` mode and headless this is the autonomy/runaway cap; interactive
   * callers prefer `checkpointEvery` + `onCheckpoint` for an unbounded loop.
   */
  maxTurns?: number;
  /**
   * Turns between runaway checkpoints. When > 0 the loop runs unbounded and, every
   * `checkpointEvery` turns, calls `onCheckpoint` to decide whether to continue.
   * If no `onCheckpoint` is supplied the checkpoint becomes a hard stop (the
   * non-interactive backstop). 0/unset → the legacy `maxTurns` hard cap.
   */
  checkpointEvery?: number;
  /**
   * Called at each checkpoint with the turn count reached. Resolving `false` stops
   * the loop (reason `stopped`); `true` runs on for another `checkpointEvery`
   * turns. The TUI surfaces a "keep going?" prompt; auto/headless omit it so a
   * checkpoint is a hard stop instead.
   */
  onCheckpoint?(turn: number): Promise<boolean>;
  /**
   * Compact older history once the estimated context size exceeds this many
   * tokens. Checked at each turn boundary. Omitted/0 disables compaction.
   */
  compactAtTokens?: number;
  /** When compacting, how many recent messages to keep verbatim. Default 6. */
  keepRecentMessages?: number;
  /** Abort in-flight work. Checked at each turn boundary and during streaming. */
  signal?: AbortSignal;
  /**
   * Optional approval gate. Called just before a mutating (non-read-only) tool
   * runs; resolving `{ allow: false }` declines the call — the model gets the
   * `reason` (or a default "user declined") as an error tool_result and can adapt,
   * and the tool never executes. Read-only tools are never gated. The front-ends
   * supply this to compose the AI permission check and the human confirm box;
   * leaving it undefined runs every mutating tool. Keeping it a caller-supplied
   * hook keeps this loop a pure engine.
   */
  gate?(call: {
    id: string;
    name: string;
    input: unknown;
  }): Promise<{ allow: boolean; reason?: string }>;
  /**
   * Optional PreToolUse hook, run before EVERY tool (read-only included) and in
   * every mode. Resolving `{ allow: false }` blocks the call with `reason`. Runs
   * before `gate`, so a hook can veto a call the gate would otherwise see.
   */
  preToolUse?(call: {
    id: string;
    name: string;
    input: unknown;
  }): Promise<{ allow: boolean; reason?: string }>;
  /**
   * Optional PostToolUse hook, run after every tool finishes (observational).
   * Errors are swallowed by the caller; it never affects the loop.
   */
  postToolUse?(
    call: { id: string; name: string; input: unknown },
    result: { content: string; isError: boolean },
  ): Promise<void>;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | {
      type: "tool_end";
      id: string;
      name: string;
      result: string;
      isError: boolean;
      diff?: Diff;
    }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn_end"; stopReason?: string }
  | {
      type: "compaction";
      beforeTokens: number;
      afterTokens: number;
      summarized: number;
    }
  | { type: "checkpoint"; turn: number }
  | { type: "done"; reason: "stop" | "max_turns" | "aborted" | "stopped" };

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
export async function* runAgent(
  opts: AgentOptions,
): AsyncGenerator<AgentEvent> {
  const { provider, model, system, messages, tools, signal } = opts;
  const mode: AgentMode = opts.mode ?? "normal";
  const maxTurns = opts.maxTurns ?? 25;
  const checkpointEvery = opts.checkpointEvery ?? 0;
  const compactAtTokens = opts.compactAtTokens ?? 0;
  const keepRecent = opts.keepRecentMessages ?? 6;
  const toolDefs = tools.map(toToolDef);
  // Index tools by name once so the per-call lookups below are O(1).
  const toolByName = new Map(tools.map((t) => [t.name, t] as const));

  // The loop is unbounded when checkpointing is on (`checkpointEvery > 0`): it runs
  // until the model stops asking for tools, the signal aborts, or the caller declines
  // a checkpoint. When checkpointing is off it stops at the legacy `maxTurns` cap.
  for (let turn = 0; ; turn++) {
    if (signal?.aborted) {
      yield { type: "done", reason: "aborted" };
      return;
    }

    // ── turn-boundary cap / checkpoint ──
    if (checkpointEvery > 0) {
      if (turn > 0 && turn % checkpointEvery === 0) {
        // Interactive caller decides whether to continue; without a hook the
        // checkpoint is a hard stop (the non-interactive runaway backstop).
        yield { type: "checkpoint", turn };
        if (opts.onCheckpoint) {
          // The agent loop is inherently sequential — each turn depends on the
          // previous turn's tool results, and this checkpoint blocks on a human
          // y/n. Parallelizing (the rule's suggested fix) is impossible here.
          // eslint-disable-next-line react-doctor/async-await-in-loop -- sequential by design; see above
          const keepGoing = await opts.onCheckpoint(turn);
          if (signal?.aborted) {
            yield { type: "done", reason: "aborted" };
            return;
          }
          if (!keepGoing) {
            yield { type: "done", reason: "stopped" };
            return;
          }
        } else {
          yield { type: "done", reason: "max_turns" };
          return;
        }
      }
    } else if (turn >= maxTurns) {
      yield { type: "done", reason: "max_turns" };
      return;
    }

    // ── compact older history if the context has grown too large ──
    // Done at the turn boundary (message list is in a valid, paired state here).
    if (compactAtTokens > 0) {
      const beforeTokens = estimateTokens(messages, system);
      if (beforeTokens > compactAtTokens) {
        const result = await compactConversation({
          provider,
          model,
          messages,
          keepRecent,
          signal,
        });
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
    // Some OpenAI-compatible gateways never return token usage when streaming
    // (even with `include_usage`). Track whether the provider reported any so we
    // can fall back to a local estimate, keeping the footer counter live.
    let reportedUsage = false;
    const promptTokens = estimateTokens(messages, system);

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
          collected.toolUses.push({
            id: ev.id,
            name: ev.name,
            input: ev.input,
          });
          collected.blocks.push({
            type: "tool_use",
            id: ev.id,
            name: ev.name,
            input: ev.input,
          });
          break;
        case "usage":
          reportedUsage = true;
          yield {
            type: "usage",
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
          };
          break;
        case "done":
          collected.stopReason = ev.stopReason;
          break;
      }
    }
    flushText();
    // Fallback usage: if the provider never reported token counts, estimate them
    // (prompt size in, generated blocks out) so the session counter still moves.
    if (!reportedUsage) {
      const outputTokens = Math.ceil(
        JSON.stringify(collected.blocks).length / CHARS_PER_TOKEN,
      );
      if (promptTokens > 0 || outputTokens > 0) {
        yield { type: "usage", inputTokens: promptTokens, outputTokens };
      }
    }
    // Record thinking for display continuity; unsigned thinking is dropped by the
    // provider on replay, so it is safe to keep but won't be sent back.
    if (thinkingBuf)
      collected.blocks.unshift({ type: "thinking", thinking: thinkingBuf });

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
      yield {
        type: "tool_start",
        id: call.id,
        name: call.name,
        input: call.input,
      };

      // Deny a call without running it: report `reason` to the model as an error
      // tool_result so it can adapt, and move on to the next call.
      const deny = (reason: string): void => {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: reason,
          is_error: true,
        });
      };

      // ── 1. PreToolUse hooks: deterministic policy, every tool, every mode ──
      if (opts.preToolUse) {
        // Tool calls run in order: each result is pushed sequentially and the gate
        // below can prompt the human, which must be serialized. Awaiting per-call
        // in the loop is intentional, not a missed Promise.all.
        // eslint-disable-next-line react-doctor/async-await-in-loop -- sequential by design; see above
        const h = await opts.preToolUse(call);
        if (signal?.aborted) {
          yield { type: "done", reason: "aborted" };
          return;
        }
        if (!h.allow) {
          const reason = h.reason ?? `blocked by a PreToolUse hook`;
          yield {
            type: "tool_end",
            id: call.id,
            name: call.name,
            result: reason,
            isError: true,
          };
          deny(reason);
          continue;
        }
      }

      // ── 2/3. Approval gate (AI permission + human confirm): mutating only ──
      // A declined call is reported back to the model as an error tool_result.
      if (opts.gate) {
        const tool = toolByName.get(call.name);
        if (tool && !tool.readOnly) {
          const g = await opts.gate(call);
          if (signal?.aborted) {
            yield { type: "done", reason: "aborted" };
            return;
          }
          if (!g.allow) {
            const reason = g.reason ?? `user declined to run ${call.name}`;
            yield {
              type: "tool_end",
              id: call.id,
              name: call.name,
              result: reason,
              isError: true,
            };
            deny(reason);
            continue;
          }
        }
      }

      // ── 4. run the tool ──
      const { content, isError, diff } = await runToolCall(
        toolByName,
        mode,
        call,
      );
      yield {
        type: "tool_end",
        id: call.id,
        name: call.name,
        result: content,
        isError,
        diff,
      };
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content,
        is_error: isError,
      });

      // ── 5. PostToolUse hooks: observational, never block the loop ──
      if (opts.postToolUse) {
        await opts.postToolUse(call, { content, isError }).catch(() => {});
      }
    }
    messages.push({ role: "user", content: results });
  }
}

/** Execute one tool call, enforcing plan-mode read-only gating. Never throws. */
async function runToolCall(
  toolByName: Map<string, Tool>,
  mode: AgentMode,
  call: { id: string; name: string; input: unknown },
): Promise<{ content: string; isError: boolean; diff?: Diff }> {
  const tool = toolByName.get(call.name);
  if (!tool) {
    return { content: `unknown tool: ${call.name}`, isError: true };
  }
  if (mode === "plan" && !tool.readOnly) {
    return {
      content: `tool "${call.name}" is blocked in plan mode (read-only)`,
      isError: true,
    };
  }
  const input = (call.input ?? {}) as Record<string, unknown>;
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
function estimateTokens(messages: Message[], system = ""): number {
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
          parts.push(
            `${m.role} called ${b.name}(${JSON.stringify(b.input).slice(0, 800)})`,
          );
          break;
        case "tool_result": {
          const c =
            typeof b.content === "string"
              ? b.content
              : JSON.stringify(b.content);
          parts.push(
            `tool_result${b.is_error ? " (error)" : ""}: ${c.slice(0, 800)}`,
          );
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
async function compactConversation(
  opts: CompactOptions,
): Promise<{ summarized: number }> {
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
      content: [
        {
          type: "text",
          text: `Summarize this conversation transcript:\n\n${transcript}`,
        },
      ],
    },
  ];
  let out = "";
  for await (const ev of provider.stream({
    model,
    system: SUMMARIZER_SYSTEM,
    messages,
    tools: [],
  })) {
    if (signal?.aborted) break;
    if (ev.type === "text_delta") out += ev.text;
  }
  return out;
}
