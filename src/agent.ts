// agent.ts — the core agent loop, shared by the headless CLI and the TUI.
//
// `runAgent` is an async generator: it streams a request, collects the model's
// text / thinking / tool_use, executes any tool calls, appends the results, and
// loops until the model stops asking for tools (or a turn cap / abort). Callers
// consume the yielded `AgentEvent`s to render however they like — stdout in
// headless mode, React components in the TUI. The conversation `messages` array is
// mutated in place so the caller keeps the full transcript for persistence.

import type { ModelRole } from "./config.ts";
import type { Diff } from "./diff.ts";
import type { ImageData } from "./image.ts";
import type { ContentBlock, Message, Provider, ToolDef } from "./provider.ts";
import type { Tool } from "./tools.ts";

export type AgentMode = "normal" | "plan" | "auto";

/**
 * Plan-mode instructions appended to the system prompt. In plan mode the agent
 * runs read-only: it must FIRST investigate the project with its read-only tools,
 * THEN emit ONE structured plan grounded in what it read and stop — it does not
 * implement. The prompt forbids investigation-as-plan-steps so the output is an
 * implementation plan, not a plan to explore. The TUI renders this plan with
 * accept/edit/reject; in headless it simply prints and exits. The fixed
 * section headings make the output easy to parse and present.
 */
const PLAN_SYSTEM_PROMPT = [
  "",
  "── PLAN MODE ──",
  "You are in read-only planning mode. Write, edit, and bash tools are disabled and will",
  "return an error if called; you have read_file, list_dir, grep, web_fetch, github_read_file, and web_search.",
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
   * Whether the active model can see images. When a tool (read_file) returns an
   * image, the loop attaches it as an `image` block only if true; otherwise the
   * image is dropped and the tool_result text notes the model can't view it.
   * Defaults to true.
   */
  supportsVision?: boolean;
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
  /**
   * Cap, in characters, on a single tool result entering the conversation.
   * Small-context models need this: one unbounded read can fill the window.
   * Omitted/0 leaves results as the tool returned them.
   */
  maxToolResultChars?: number;
  /**
   * Cap, in characters, on the tool schemas sent with each request. When the
   * tool set is larger, tools marked `deferrable` are withheld and reached
   * through `describe_tool` / `call_tool` instead. Omitted/0 sends everything.
   */
  maxToolSchemaChars?: number;
  /** Optional provider/model override used only for context compaction. */
  compactProvider?: Provider;
  compactModel?: string;
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
  /**
   * Pull any queued user input to inject at the next tool-result boundary. Called
   * once per agentic iteration, right after the tool batch's results are gathered
   * and before they are appended to the conversation. A non-empty return is added
   * as a trailing `text` block on that user message so the model sees it on its
   * next step. Return `null`/empty to inject nothing. The earliest protocol-legal
   * injection point is this user message (all tool_results for a batch must be
   * returned together), so this never splits a tool_result from its tool_use.
   */
  drainInput?(): string | null;
  /**
   * Re-resolve volatile per-step settings (provider/model/thinking) at the top of
   * each loop iteration, so a mid-turn /model or /think takes effect on the next
   * step. When omitted, the construction-time `provider`/`model`/`supportsVision`/
   * `thinkingBudget` are used unchanged. Does NOT cover mode/tools/system (those
   * are fixed per run by the caller).
   */
  refreshTurnConfig?(): {
    provider: Provider;
    model: string;
    supportsVision: boolean;
    thinkingBudget: number | undefined;
    compactProvider?: Provider;
    compactModel?: string;
    /** Per-model budgets; fall back to the run's options when omitted. */
    maxTokens?: number;
    compactAtTokens?: number;
    maxToolResultChars?: number;
  };
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
  | {
      type: "turn_end";
      stopReason?: string;
      /** Estimated tokens the next request will carry (prompt + this reply). */
      contextTokens?: number;
    }
  | {
      type: "compaction";
      beforeTokens: number;
      afterTokens: number;
      summarized: number;
    }
  | { type: "checkpoint"; turn: number }
  | { type: "done"; reason: "stop" | "max_turns" | "aborted" | "stopped" };

/** How many times in a row the exact same tool call may execute before the
 * loop breaker denies it (legitimate back-to-back repeats — e.g. re-reading a
 * file after an edit elsewhere failed — stay under this). */
const MAX_IDENTICAL_CALLS = 2;

/** Strip a Tool down to the provider-facing `ToolDef` (no executor). */
function toToolDef(t: Tool): ToolDef {
  return { name: t.name, description: t.description, schema: t.schema };
}

/** Synthetic tool names used when part of the tool set is deferred. */
const DESCRIBE_TOOL = "describe_tool";
const CALL_TOOL = "call_tool";

/**
 * Decide which tool schemas go in the request. When they all fit the budget
 * nothing changes. Otherwise the `deferrable` ones are withheld and replaced
 * by two small tools: `describe_tool` returns one tool's parameters on demand
 * and `call_tool` runs it. A few MCP servers can otherwise spend most of a
 * 32k window on schemas the model never uses.
 */
export function planTools(
  tools: Tool[],
  maxSchemaChars: number,
): { active: Tool[]; deferred: boolean } {
  const size = (list: Tool[]) => JSON.stringify(list.map(toToolDef)).length;
  if (maxSchemaChars <= 0 || size(tools) <= maxSchemaChars)
    return { active: tools, deferred: false };
  const held = tools.filter((t) => t.deferrable);
  if (held.length === 0) return { active: tools, deferred: false };
  const byName = new Map(held.map((t) => [t.name, t] as const));
  const index = held
    .map((t) => {
      const line = t.description.split("\n")[0]!.trim();
      return `- ${t.name}: ${line.length > 140 ? `${line.slice(0, 137)}...` : line}`;
    })
    .join("\n");
  const describe: Tool = {
    name: DESCRIBE_TOOL,
    description: `Get the full description and parameters of one of the additional tools listed under ${CALL_TOOL}. Call this before the first use of such a tool.`,
    readOnly: true,
    schema: {
      type: "object",
      properties: { name: { type: "string", description: "Tool name." } },
      required: ["name"],
    },
    async run(input) {
      const tool = byName.get(String(input.name));
      if (!tool) throw new Error(`no such tool: ${input.name}`);
      return `${tool.name}\n${tool.description}\n\nParameters (JSON Schema):\n${JSON.stringify(tool.schema)}`;
    },
  };
  const call: Tool = {
    name: CALL_TOOL,
    description: `Run one of the additional tools below. Their parameters are not loaded, to save context: get them with ${DESCRIBE_TOOL} first, then pass them as \`arguments\`.\n${index}`,
    // Never the gate for plan mode: the loop unwraps this into the real tool.
    readOnly: held.every((t) => t.readOnly),
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tool name from the list." },
        arguments: {
          type: "object",
          description: "The tool's arguments, per its parameters.",
        },
      },
      required: ["name"],
    },
    async run(input) {
      throw new Error(
        `no such tool: ${input.name}. Use a name from the ${CALL_TOOL} list.`,
      );
    },
  };
  return {
    active: [...tools.filter((t) => !t.deferrable), describe, call],
    deferred: true,
  };
}

/** Turn a `call_tool` invocation into a call to the tool it names. */
function unwrapCallTool<T extends { name: string; input: unknown }>(
  call: T,
): T {
  if (call.name !== CALL_TOOL) return call;
  const input = coerceToolInput(
    { properties: { arguments: { type: "object" } } },
    call.input,
  );
  if (typeof input.name !== "string" || input.name === CALL_TOOL) return call;
  return { ...call, name: input.name, input: input.arguments ?? {} };
}

interface CollectedTurn {
  blocks: ContentBlock[];
  toolUses: { id: string; name: string; input: unknown; inputError?: string }[];
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
  const { system, messages, tools, signal } = opts;
  const mode: AgentMode = opts.mode ?? "normal";
  const maxTurns = opts.maxTurns ?? 25;
  const checkpointEvery = opts.checkpointEvery ?? 0;
  const keepRecent = opts.keepRecentMessages ?? 6;
  const plan = planTools(tools, opts.maxToolSchemaChars ?? 0);
  const toolDefs = plan.active.map(toToolDef);
  // Tool schemas ride along on every request, so they count against the window.
  const toolTokens = Math.ceil(
    JSON.stringify(toolDefs).length / CHARS_PER_TOKEN,
  );
  // One-shot recoveries, so a model that keeps failing the same way still stops.
  let nudgedEmpty = false;
  let overflowRetried = false;
  // Index tools by name once so the per-call lookups below are O(1).
  const toolByName = new Map(
    [...tools, ...plan.active].map((t) => [t.name, t] as const),
  );

  // Repeated-call loop breaker: a model that re-issues the exact same call
  // (same tool, same input) over and over is stuck — execute it at most
  // MAX_IDENTICAL_CALLS times in a row, then deny with a corrective error so
  // the model gets a signal it can act on instead of an endless echo.
  let lastCallSig = "";
  let lastCallSigCount = 0;

  // The loop is unbounded when checkpointing is on (`checkpointEvery > 0`): it runs
  // until the model stops asking for tools, the signal aborts, or the caller declines
  // a checkpoint. When checkpointing is off it stops at the legacy `maxTurns` cap.
  for (let turn = 0; ; turn++) {
    if (signal?.aborted) {
      yield { type: "done", reason: "aborted" };
      return;
    }

    // Re-resolve volatile settings so a mid-turn /model or /think lands on this step.
    const cfg = opts.refreshTurnConfig?.();
    const provider = cfg?.provider ?? opts.provider;
    const model = cfg?.model ?? opts.model;
    const supportsVision = cfg?.supportsVision ?? opts.supportsVision ?? true;
    const thinkingBudget = cfg ? cfg.thinkingBudget : opts.thinkingBudget;
    const maxTokens = cfg?.maxTokens ?? opts.maxTokens;
    const compactAtTokens = cfg?.compactAtTokens ?? opts.compactAtTokens ?? 0;
    const maxToolResultChars =
      cfg?.maxToolResultChars ?? opts.maxToolResultChars ?? 0;

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
      const beforeTokens = estimateTokens(messages, system) + toolTokens;
      if (beforeTokens > compactAtTokens) {
        try {
          const result = await shrinkContext({
            provider: cfg?.compactProvider ?? opts.compactProvider ?? provider,
            model: cfg?.compactModel ?? opts.compactModel ?? model,
            messages,
            keepRecent,
            targetTokens: compactAtTokens - toolTokens,
            system,
            signal,
          });
          if (result.summarized > 0) {
            yield {
              type: "compaction",
              beforeTokens,
              afterTokens: estimateTokens(messages, system) + toolTokens,
              summarized: result.summarized,
            };
          }
        } catch (err) {
          // Same treatment as the streaming loop below: an abort mid-compaction
          // must surface as the clean `aborted` outcome, not an error.
          if (signal?.aborted) {
            yield { type: "done", reason: "aborted" };
            return;
          }
          throw err;
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
    const promptTokens = estimateTokens(messages, system) + toolTokens;

    const flushText = () => {
      if (textBuf) {
        collected.blocks.push({ type: "text", text: textBuf });
        textBuf = "";
      }
    };

    try {
      for await (const ev of provider.stream({
        model,
        system,
        messages,
        tools: toolDefs,
        thinkingBudget,
        maxTokens,
        signal,
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
              inputError: ev.inputError,
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
    } catch (err) {
      // An attached signal makes an aborted fetch reject mid-stream; surface it as
      // the clean `aborted` outcome rather than an error.
      if (signal?.aborted) {
        yield { type: "done", reason: "aborted" };
        return;
      }
      // The request did not fit the model's window (our estimate is chars/4 and
      // the window is not always known). Shrink hard and retry this turn once;
      // nothing was appended yet, so the transcript is still in a paired state.
      const nothingStreamed =
        !textBuf && !thinkingBuf && collected.blocks.length === 0;
      if (!overflowRetried && nothingStreamed && isContextOverflow(err)) {
        overflowRetried = true;
        const beforeTokens = promptTokens;
        const result = await shrinkContext({
          provider: cfg?.compactProvider ?? opts.compactProvider ?? provider,
          model: cfg?.compactModel ?? opts.compactModel ?? model,
          messages,
          keepRecent: 2,
          targetTokens: Math.floor(estimateTokens(messages, system) / 2),
          system,
          signal,
        }).catch(() => ({ summarized: 0 }));
        if (result.summarized > 0) {
          yield {
            type: "compaction",
            beforeTokens,
            afterTokens: estimateTokens(messages, system) + toolTokens,
            summarized: result.summarized,
          };
          continue;
        }
      }
      throw err;
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
    yield {
      type: "turn_end",
      stopReason: collected.stopReason,
      contextTokens:
        promptTokens +
        Math.ceil(JSON.stringify(collected.blocks).length / CHARS_PER_TOKEN),
    };

    // ── empty reply → nudge once ──
    // Smaller models sometimes end a turn with no text and no tool call (often
    // after spending the whole turn reasoning). Ending the run there looks like
    // a silent hang-up, so ask once for the next step before giving up.
    const saidNothing = !collected.blocks.some(
      (b) => (b.type === "text" && b.text.trim()) || b.type === "tool_use",
    );
    if (saidNothing && !nudgedEmpty && messages.length > 0) {
      nudgedEmpty = true;
      const last = messages[messages.length - 1]!;
      const text =
        collected.stopReason === "length" ||
        collected.stopReason === "max_tokens"
          ? "Your last reply was cut off before any answer or tool call. Reply again, more briefly."
          : "Your last reply was empty. Continue with the next tool call, or give your final answer.";
      // Keep user/assistant alternation: fold into a trailing user turn.
      if (last.role === "user") last.content.push({ type: "text", text });
      else messages.push({ role: "user", content: [{ type: "text", text }] });
      continue;
    }

    // ── no tools → we're done ──
    if (collected.toolUses.length === 0) {
      yield { type: "done", reason: "stop" };
      return;
    }

    // ── execute tool calls, gather results into one user message ──
    const results: ContentBlock[] = [];
    // Image blocks produced by tools this turn, appended after all tool_results so
    // they never split a tool_result from its tool_use in the OpenAI/Codex wire form.
    const images: ContentBlock[] = [];
    for (const issued of collected.toolUses) {
      if (signal?.aborted) {
        yield { type: "done", reason: "aborted" };
        return;
      }
      // A deferred tool is invoked through `call_tool`; unwrap it so hooks,
      // the approval gate and the UI all see the real tool and its input.
      const call = plan.deferred ? unwrapCallTool(issued) : issued;
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

      // ── 0. malformed streamed args: never execute, tell the model why ──
      // The tool_use block is already in the assistant turn (collected during
      // streaming), so this error tool_result keeps the conversation paired.
      // tool_start was already emitted above; the error tool_end closes it.
      if (call.inputError) {
        const msg = `tool call rejected: ${call.inputError} — issue the call again (if it keeps failing, try a smaller or simpler call)`;
        yield {
          type: "tool_end",
          id: call.id,
          name: call.name,
          result: msg,
          isError: true,
        };
        deny(msg);
        continue;
      }

      // ── 0.5. repeated-call loop breaker ──
      // Counted across turns: text/thinking between calls does not reset it,
      // only a different call (or different input) does.
      const sig = `${call.name} ${JSON.stringify(call.input ?? {})}`;
      if (sig === lastCallSig) {
        lastCallSigCount++;
      } else {
        lastCallSig = sig;
        lastCallSigCount = 1;
      }
      if (lastCallSigCount > MAX_IDENTICAL_CALLS) {
        const msg =
          `loop detected: this exact ${call.name} call has now been issued ` +
          `${lastCallSigCount} times in a row with identical input, so it was NOT run — ` +
          `repeating it will not change anything. Take a different next step: change the ` +
          `input, use one of your other available tools, or reply in text describing what ` +
          `you are trying to do and what is blocking you.`;
        yield {
          type: "tool_end",
          id: call.id,
          name: call.name,
          result: msg,
          isError: true,
        };
        deny(msg);
        continue;
      }

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
      const { content, isError, diff, image } = await runToolCall(
        toolByName,
        mode,
        call,
      );
      // An image result rides along as an `image` block on this user turn — but
      // only for vision-capable models; otherwise drop it and say so in the text.
      const visionOk = supportsVision;
      const capped = capToolResult(content, maxToolResultChars);
      const resultText =
        image && !visionOk
          ? `${capped} (the current model cannot view images)`
          : capped;
      if (image && visionOk) {
        images.push({
          type: "image",
          mediaType: image.mediaType,
          data: image.data,
        });
      }
      yield {
        type: "tool_end",
        id: call.id,
        name: call.name,
        result: resultText,
        isError,
        diff,
      };
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: resultText,
        is_error: isError,
      });

      // ── 5. PostToolUse hooks: observational, never block the loop ──
      if (opts.postToolUse) {
        await opts
          .postToolUse(call, { content: resultText, isError })
          .catch(() => {});
      }
    }
    results.push(...images);
    const injected = opts.drainInput?.();
    if (injected) results.push({ type: "text", text: injected });
    messages.push({ role: "user", content: results });
  }
}

/**
 * Drive one agent session. Dispatches to a provider that owns its own agentic
 * loop (`Provider.runSession` — e.g. the Claude Code SDK, whose runtime executes
 * tools and loops itself) or, by default, to the built-in {@link runAgent}
 * engine. Every front-end calls this instead of `runAgent` directly, so an
 * SDK-backed provider transparently swaps in its native loop while still
 * yielding the same {@link AgentEvent} stream the callers already render.
 */
export function runSession(opts: AgentOptions): AsyncGenerator<AgentEvent> {
  return opts.provider.runSession
    ? opts.provider.runSession(opts)
    : runAgent(opts);
}

/** Execute one tool call, enforcing plan-mode read-only gating. Never throws. */
async function runToolCall(
  toolByName: Map<string, Tool>,
  mode: AgentMode,
  call: { id: string; name: string; input: unknown },
): Promise<{
  content: string;
  isError: boolean;
  diff?: Diff;
  image?: ImageData;
}> {
  const tool = toolByName.get(call.name);
  if (!tool) {
    return {
      content: `unknown tool: ${call.name}. Available tools: ${[...toolByName.keys()].join(", ")}`,
      isError: true,
    };
  }
  if (mode === "plan" && !tool.readOnly) {
    return {
      content: `tool "${call.name}" is blocked in plan mode (read-only)`,
      isError: true,
    };
  }
  const input = coerceToolInput(tool.schema, call.input);
  try {
    const out = await tool.run(input);
    // Tools may return a bare string or a `{ content, diff }` result.
    if (typeof out === "string") return { content: out, isError: false };
    return {
      content: out.content,
      isError: false,
      diff: out.diff,
      image: out.image,
    };
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

/** Placeholder left where a stale tool result was dropped from the context. */
const CLEARED_TOOL_RESULT =
  "[earlier tool output cleared to save context; run the tool again if you need it]";

/** Tool results shorter than this are not worth clearing. */
const CLEAR_MIN_CHARS = 400;

/**
 * Drop the bodies of tool results older than the last `keepRecent` messages.
 * Old file reads and command output are the bulk of a long session and the
 * model has already acted on them, so this frees most of the window without a
 * summarization round-trip. Returns how many results were cleared.
 */
function clearStaleToolResults(
  messages: Message[],
  keepRecent: number,
): number {
  let cleared = 0;
  const end = messages.length - keepRecent;
  for (let i = 0; i < end; i++) {
    for (const b of messages[i]!.content) {
      if (
        b.type === "tool_result" &&
        b.content.length > CLEAR_MIN_CHARS &&
        b.content !== CLEARED_TOOL_RESULT
      ) {
        b.content = CLEARED_TOOL_RESULT;
        cleared++;
      }
    }
  }
  return cleared;
}

/**
 * Bring the transcript under `targetTokens`: clear stale tool output first, and
 * only summarize when that is not enough. The kept tail shrinks (6 → 4 → 2
 * messages) until it fits half the target, so a few large recent results
 * cannot keep the transcript over the limit. Returns the number of messages
 * affected (0 = nothing could be done).
 */
async function shrinkContext(opts: {
  provider: Provider;
  model: string;
  messages: Message[];
  keepRecent: number;
  targetTokens: number;
  system: string;
  signal?: AbortSignal;
}): Promise<{ summarized: number }> {
  const { messages, system, targetTokens } = opts;
  const cleared = clearStaleToolResults(messages, Math.max(opts.keepRecent, 4));
  if (cleared > 0 && estimateTokens(messages, system) <= targetTokens * 0.8) {
    return { summarized: cleared };
  }
  let keepRecent = opts.keepRecent;
  for (const keep of [opts.keepRecent, 4, 2]) {
    if (keep > opts.keepRecent) continue;
    const cut = pickCut(messages, keep);
    if (cut === 0) continue;
    keepRecent = keep;
    if (estimateTokens(messages.slice(cut)) <= targetTokens / 2) break;
  }
  const result = await compactConversation({
    provider: opts.provider,
    model: opts.model,
    messages,
    keepRecent,
    signal: opts.signal,
  });
  return { summarized: result.summarized + cleared };
}

/** Whether a provider error says the request exceeded the context window. */
function isContextOverflow(err: unknown): boolean {
  return /context (length|window|size)|maximum context|context_length|too many tokens|prompt is too long|exceeds? the (model's )?(maximum|context)|n_ctx|tokens to keep/i.test(
    (err as Error)?.message ?? "",
  );
}

/** Keep the head and tail of an oversized tool result, with a notice between. */
function capToolResult(content: string, maxChars: number): string {
  if (maxChars <= 0 || content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  const omitted = content.length - maxChars;
  return `${content.slice(0, head)}\n\n[... ${omitted} characters omitted: the output is too large for this model's context window. Narrow the request (read_file with offset/limit, grep, or a more specific command) to see the rest.]\n\n${content.slice(content.length - tail)}`;
}

/**
 * Coerce a tool call's arguments toward the tool's JSON schema. Open-weight
 * models regularly send `"limit": "50"`, `"replace_all": "true"`, or a whole
 * argument object as a JSON string; rejecting those costs a full turn each
 * time, so fix the unambiguous cases and leave everything else untouched.
 */
export function coerceToolInput(
  schema: Record<string, unknown>,
  raw: unknown,
): Record<string, unknown> {
  let input = raw;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      input = {};
    }
  }
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return {};
  const out = { ...(input as Record<string, unknown>) };
  const props = (schema.properties ?? {}) as Record<
    string,
    { type?: string } | undefined
  >;
  for (const [key, value] of Object.entries(out)) {
    const type = props[key]?.type;
    if (!type) continue;
    if (typeof value === "string") {
      const v = value.trim();
      if ((type === "number" || type === "integer") && v !== "") {
        const n = Number(v);
        if (Number.isFinite(n)) out[key] = n;
      } else if (type === "boolean") {
        if (v === "true") out[key] = true;
        else if (v === "false") out[key] = false;
      } else if (type === "array" || type === "object") {
        try {
          const parsed = JSON.parse(v);
          if (parsed !== null && typeof parsed === "object") out[key] = parsed;
        } catch {
          // leave as-is; the tool reports the bad argument
        }
      }
    } else if (
      type === "string" &&
      (typeof value === "number" || typeof value === "boolean")
    ) {
      out[key] = String(value);
    }
  }
  return out;
}

export interface CompactOptions {
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
export async function compactConversation(
  opts: CompactOptions,
): Promise<{ summarized: number }> {
  const { provider, model, messages, keepRecent, signal } = opts;
  const cut = pickCut(messages, keepRecent);
  if (cut === 0) return { summarized: 0 };

  const older = messages.slice(0, cut);
  // The opening request is the one thing a summary must not paraphrase: carry
  // it over verbatim and summarize only what followed it.
  const first = older[0]!;
  const request =
    first.role === "user" &&
    first.content.every((b) => b.type === "text") &&
    !first.content.some(
      (b) => b.type === "text" && b.text.startsWith(SUMMARY_MARKER),
    )
      ? first.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("\n")
          .slice(0, REQUEST_KEEP_CHARS)
      : undefined;
  const transcript = renderTranscript(request ? older.slice(1) : older);
  const summary = await summarize(provider, model, transcript, signal);
  if (!summary.trim()) return { summarized: 0 };

  const synthetic: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `${SUMMARY_MARKER}\n\n` +
          (request ? `The original request:\n${request}\n\n` : "") +
          "Summary of the work so far:\n" +
          summary,
      },
    ],
  };
  // Replace the summarized prefix with the single synthetic message.
  messages.splice(0, cut, synthetic);
  return { summarized: cut };
}

const SUMMARY_MARKER =
  "[Earlier conversation was summarized to conserve context.]";

/** Upper bound on the opening request carried verbatim through a compaction. */
const REQUEST_KEEP_CHARS = 8000;

const SUMMARIZER_SYSTEM =
  "You are a summarizer. Condense the transcript of a coding session into a brief " +
  "that lets the assistant continue the task without re-reading anything. Preserve: " +
  "the user's goal and constraints, decisions made, every file changed so far with " +
  "what was changed in it (so the work is not repeated or undone), relevant file " +
  "paths, function names and line numbers, commands run and their outcome, and the " +
  "steps still pending. Use terse bullet points. Do not invent details.";

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
    signal,
  })) {
    if (signal?.aborted) break;
    if (ev.type === "text_delta") out += ev.text;
  }
  return out;
}
