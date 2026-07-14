// claude.ts — Claude Code subscription-backed models via the official
// @anthropic-ai/claude-agent-sdk package.
//
// This preset intentionally carries no Anthropic API key. Authentication is owned
// by Claude Code itself (run `claude login`), so users with Claude Code Pro/Max or
// org entitlements can use the same native subscription path from canarycode.
//
// The SDK's `query()` is a full autonomous agent — it owns its own loop, tools,
// permissions, and skills. So this provider does NOT implement the single-turn
// `stream` contract for real work; instead it drives the SDK's native loop via
// `runSession` and translates the SDK message stream into the harness's
// `AgentEvent`s (see the runSession implementation). `stream` is kept only for the
// tool-free single-turn calls the harness makes directly (context compaction /
// summarization), where a one-shot query is exactly right.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { z } from "zod";
import type { AgentEvent, AgentOptions } from "../agent.ts";
import type { ProviderConfig } from "../config.ts";
import { computeDiff, type Diff } from "../diff.ts";
import type { Extension } from "../extension.ts";
import {
  type AnthropicBlock,
  type ContentBlock,
  type Message,
  type Provider,
  type ProviderFactory,
  type StreamEvent,
  type StreamRequest,
  TOOL_INPUT_PARSE_ERROR,
  toAnthropicBlock,
} from "../provider.ts";
import type { Tool } from "../tools.ts";

/** The provider key used for the baked-in Claude Code preset. */
export const CLAUDE_CODE_PROVIDER = "claude";

/** The provider `api` tag this extension owns (see registerProviderFactory). */
export const CLAUDE_CODE_API = "claude-code";

export function claudeCodeProviderConfig(): ProviderConfig {
  return {
    api: CLAUDE_CODE_API,
    models: [
      { id: "fable", name: "fable" },
      { id: "opus", name: "opus" },
      { id: "sonnet", name: "sonnet" },
      { id: "haiku", name: "haiku" },
    ],
  };
}

// ── SDK message shapes (the subset we read) ──────────────────────────────────

type ClaudeCodeStreamEvent = {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { output_tokens?: number };
};

/** The Anthropic content blocks the SDK surfaces on full assistant/user turns. */
type SdkContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: unknown;
      is_error?: boolean;
    };

type ClaudeCodeSdkMessage =
  | {
      type: "stream_event";
      event: ClaudeCodeStreamEvent;
    }
  // Full assistant turn: text/thinking/tool_use blocks. Emitted after the
  // streamed deltas for the same turn (used for tool_use + transcript, not text).
  | {
      type: "assistant";
      message: { content: SdkContentBlock[] };
      parent_tool_use_id?: string | null;
    }
  // Tool results the SDK produced by executing (or denying) a tool call.
  | {
      type: "user";
      message: { content: SdkContentBlock[] | string };
      parent_tool_use_id?: string | null;
    }
  | {
      type: "result";
      subtype?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
      total_usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
      result?: string;
    };

type ClaudeCodeSdkUserMessage = {
  type: "user";
  message: {
    role: "user";
    content: string | AnthropicBlock[];
  };
  parent_tool_use_id: null;
};

function toClaudeCodeContent(blocks: ContentBlock[]): AnthropicBlock[] {
  return blocks
    .map(toAnthropicBlock)
    .filter((b): b is AnthropicBlock => b !== null);
}

async function* toClaudeCodePrompt(
  system: string,
  messages: Message[],
): AsyncGenerator<ClaudeCodeSdkUserMessage> {
  const content: AnthropicBlock[] = [];
  if (system)
    content.push({ type: "text", text: `<system>\n${system}\n</system>\n\n` });
  for (const message of messages) {
    const prefix = message.role === "assistant" ? "Assistant" : "User";
    content.push({ type: "text", text: `\n\n<${prefix}>\n` });
    content.push(...toClaudeCodeContent(message.content));
    content.push({ type: "text", text: `\n</${prefix}>` });
  }
  yield {
    type: "user",
    message: {
      role: "user",
      content:
        content.length === 1 && content[0]?.type === "text"
          ? content[0].text
          : content,
    },
    parent_tool_use_id: null,
  };
}

function effortForClaudeCode(
  budget: number | undefined,
): "low" | "medium" | "high" | "xhigh" | undefined {
  if (!budget || budget <= 0) return undefined;
  if (budget <= 4_000) return "low";
  if (budget <= 10_000) return "medium";
  return "xhigh";
}

type ClaudeCodeQuery = (params: {
  prompt: AsyncIterable<ClaudeCodeSdkUserMessage>;
  options?: Record<string, unknown>;
}) => AsyncIterable<ClaudeCodeSdkMessage> & { close?: () => void };

/** The agent SDK's in-process tool result. */
type SdkToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** The agent SDK's `tool()` factory (builds one in-process tool definition). */
type SdkToolFn = (
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<SdkToolResult>,
) => unknown;

/** The agent SDK's `createSdkMcpServer()` factory. */
type SdkCreateMcpServerFn = (opts: {
  name: string;
  version?: string;
  tools?: unknown[];
}) => unknown;

export interface ClaudeCodeOptions {
  /** Injectable SDK `query` for tests; defaults to the real agent SDK. */
  query?: ClaudeCodeQuery;
  /** Injectable SDK in-process MCP builders for tests; default to the real SDK. */
  createSdkMcpServer?: SdkCreateMcpServerFn;
  tool?: SdkToolFn;
}

/** Lazily resolve the real SDK `query`, or the injected one in tests. */
async function resolveQuery(opts: ClaudeCodeOptions): Promise<ClaudeCodeQuery> {
  return (
    opts.query ??
    ((await import("@anthropic-ai/claude-agent-sdk").then(
      (m) => m.query,
    )) as unknown as ClaudeCodeQuery)
  );
}

/** Lazily resolve the SDK's in-process MCP builders (only when forwarding). */
async function resolveMcpBuilders(opts: ClaudeCodeOptions): Promise<{
  createSdkMcpServer: SdkCreateMcpServerFn;
  tool: SdkToolFn;
}> {
  if (opts.createSdkMcpServer && opts.tool)
    return { createSdkMcpServer: opts.createSdkMcpServer, tool: opts.tool };
  const m = await import("@anthropic-ai/claude-agent-sdk");
  return {
    createSdkMcpServer:
      opts.createSdkMcpServer ??
      (m.createSdkMcpServer as unknown as SdkCreateMcpServerFn),
    tool: opts.tool ?? (m.tool as unknown as SdkToolFn),
  };
}

/** Bridge an outer AbortSignal to a fresh AbortController the SDK can own. */
function forwardAbort(signal: AbortSignal | undefined): AbortController {
  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort(signal.reason);
    else
      signal.addEventListener(
        "abort",
        () => abortController.abort(signal.reason),
        {
          once: true,
        },
      );
  }
  return abortController;
}

/**
 * Environment for the SDK subprocess. Anthropic API-key vars are stripped so the
 * SDK authenticates through the Claude Code subscription (`claude login`) — the
 * whole point of this provider. Otherwise, a user who also has `ANTHROPIC_API_KEY`
 * set for the separate `anthropic` provider would silently bill the API here
 * instead of using their Pro/Max/org subscription.
 */
/**
 * Resolve the SDK's native `claude` binary from canarycode's own module graph and
 * hand it to `query()` via `pathToClaudeCodeExecutable`.
 *
 * The SDK otherwise resolves this optional, platform-specific dependency relative
 * to its own bundled `sdk.mjs`. That lookup fails — with "Native CLI binary for
 * <platform>-<arch> not found" — when canarycode runs as a compiled/standalone
 * binary, from an install tree where the SDK's `import.meta.url` doesn't sit above
 * the platform package, or after an `--omit=optional` install. Resolving from our
 * side is more robust, and passing the path explicitly is exactly the escape hatch
 * the SDK's own error names. Returns undefined when nothing resolves, so the SDK
 * falls back to (and reports) its own resolution.
 */
let cachedClaudeExecutable: string | null | undefined;
function claudeExecutableOption(): { pathToClaudeCodeExecutable?: string } {
  if (cachedClaudeExecutable === undefined) {
    cachedClaudeExecutable = null;
    const base = "@anthropic-ai/claude-agent-sdk";
    const { platform, arch } = process;
    const suffix = platform === "win32" ? ".exe" : "";
    const pkgs =
      platform === "win32"
        ? [`${base}-win32-${arch}`]
        : platform === "linux"
          ? [`${base}-linux-${arch}`, `${base}-linux-${arch}-musl`]
          : [`${base}-${platform}-${arch}`];
    const req = createRequire(import.meta.url);
    for (const pkg of pkgs) {
      try {
        const p = req.resolve(`${pkg}/claude${suffix}`);
        if (existsSync(p)) {
          cachedClaudeExecutable = p;
          break;
        }
      } catch {
        // Not installed for this platform; try the next candidate.
      }
    }
  }
  return cachedClaudeExecutable
    ? { pathToClaudeCodeExecutable: cachedClaudeExecutable }
    : {};
}

function sdkEnv(): Record<string, string | undefined> {
  const {
    ANTHROPIC_API_KEY: _apiKey,
    ANTHROPIC_AUTH_TOKEN: _authToken,
    ...rest
  } = process.env;
  return { ...rest, CLAUDE_AGENT_SDK_CLIENT_APP: "canarycode" };
}

export function claudeCodeProvider(opts: ClaudeCodeOptions = {}): Provider {
  return {
    id: CLAUDE_CODE_API,
    // Single-turn, tool-free streaming. Used only for the harness's direct
    // compaction/summarization calls (tools: [] → no agentic loop, so a one-shot
    // maxTurns:1 query terminates cleanly). Real agent turns go through
    // `runSession` below, which drives the SDK's native loop.
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      const sdkQuery = await resolveQuery(opts);
      const abortController = forwardAbort(req.signal);
      const pending: Record<
        number,
        { id: string; name: string; json: string }
      > = {};
      let stopReason: string | undefined = "stop";
      const q = sdkQuery({
        prompt: toClaudeCodePrompt(req.system, req.messages),
        options: {
          abortController,
          cwd: process.cwd(),
          includePartialMessages: true,
          maxTurns: 1,
          model: req.model,
          permissionMode: "dontAsk",
          persistSession: false,
          settingSources: [],
          tools: [],
          ...(effortForClaudeCode(req.thinkingBudget)
            ? { effort: effortForClaudeCode(req.thinkingBudget) }
            : {}),
          ...claudeExecutableOption(),
          env: sdkEnv(),
        },
      });
      try {
        for await (const msg of q) {
          if (msg.type === "stream_event") {
            const ev = msg.event;
            switch (ev.type) {
              case "content_block_start":
                if (
                  ev.content_block?.type === "tool_use" &&
                  typeof ev.index === "number"
                ) {
                  pending[ev.index] = {
                    id: ev.content_block.id ?? randomUUID(),
                    name: ev.content_block.name ?? "",
                    json: "",
                  };
                }
                break;
              case "content_block_delta": {
                const delta = ev.delta;
                if (delta?.type === "text_delta") {
                  yield { type: "text_delta", text: delta.text ?? "" };
                } else if (delta?.type === "thinking_delta") {
                  yield { type: "thinking_delta", text: delta.thinking ?? "" };
                } else if (
                  delta?.type === "input_json_delta" &&
                  typeof ev.index === "number"
                ) {
                  const t = pending[ev.index];
                  if (t) t.json += delta.partial_json ?? "";
                }
                break;
              }
              case "content_block_stop": {
                if (typeof ev.index !== "number") break;
                const t = pending[ev.index];
                if (t) {
                  let input: unknown = {};
                  let inputError: string | undefined;
                  try {
                    input = t.json ? JSON.parse(t.json) : {};
                  } catch {
                    inputError = TOOL_INPUT_PARSE_ERROR;
                  }
                  yield {
                    type: "tool_use",
                    id: t.id,
                    name: t.name,
                    input,
                    ...(inputError ? { inputError } : {}),
                  };
                  delete pending[ev.index];
                }
                break;
              }
              case "message_delta":
                if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
                if (ev.usage) {
                  yield {
                    type: "usage",
                    inputTokens: 0,
                    outputTokens: ev.usage.output_tokens ?? 0,
                  };
                }
                break;
              default:
                break;
            }
          } else if (msg.type === "result") {
            const usage = msg.total_usage ?? msg.usage;
            if (usage) {
              yield {
                type: "usage",
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
              };
            }
            if (msg.subtype && msg.subtype !== "success") {
              stopReason = msg.subtype;
            }
          }
        }
      } finally {
        if ("close" in q && typeof q.close === "function") q.close();
      }
      yield { type: "done", stopReason };
    },
    // Real agent turns drive the SDK's native loop (tools, permissions, skills)
    // and translate its message stream into AgentEvents.
    runSession(agentOpts) {
      return runClaudeSession(agentOpts, opts);
    },
  };
}

// ── Native agent loop (runSession) ───────────────────────────────────────────
//
// The SDK's `query()` owns the whole agentic loop: it runs its built-in tools,
// checks permissions, and iterates until the model stops calling tools. We drive
// that loop and translate the SDK's message stream into the harness's
// `AgentEvent`s, so a Claude Code session renders exactly like any other provider
// (live text/thinking, first-class tool cards) while the SDK does the work.

/** SDK built-in tools that never mutate — never sent through the harness gate. */
const READ_ONLY_SDK_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "NotebookRead",
  "TodoWrite",
]);

/**
 * SDK built-in tools that mutate a single file at `input.file_path`. The SDK owns
 * their execution, so — unlike canarycode's own write_file/edit_file — no diff
 * rides out with the tool_result. We reconstruct one: snapshot the file before the
 * write (in the permission callback, which fires pre-execution) and diff it against
 * the on-disk result at tool_end, so the front-ends can preview the change.
 */
const FILE_EDIT_SDK_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** The `file_path` a file-editing SDK tool targets, or undefined if not one. */
export function editFilePath(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!FILE_EDIT_SDK_TOOLS.has(displayToolName(toolName))) return undefined;
  const fp = input.file_path;
  return typeof fp === "string" && fp.length > 0 ? fp : undefined;
}

/** Read a file's text, treating a missing/unreadable path as empty (new file). */
async function readFileOrEmpty(path: string): Promise<string> {
  try {
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : "";
  } catch {
    return "";
  }
}

/**
 * Build the unified diff for a completed file-editing SDK tool: diff the snapshot
 * captured before the write against the file now on disk. Returns undefined for
 * non-editing tools or a no-op change (nothing for the front-ends to preview).
 */
export async function editDiff(
  toolName: string,
  input: Record<string, unknown> | undefined,
  preEditContent: Map<string, string>,
): Promise<Diff | undefined> {
  if (!input) return undefined;
  const path = editFilePath(toolName, input);
  if (!path) return undefined;
  const before = preEditContent.get(path) ?? "";
  preEditContent.delete(path);
  const after = await readFileOrEmpty(path);
  const diff = computeDiff(before, after);
  return diff.hunks.length > 0 ? diff : undefined;
}

/**
 * canarycode's own tools that the SDK's built-ins already cover, so they are NOT
 * forwarded into the SDK loop — the model uses the SDK's native Read/Write/Edit/
 * Bash/Grep/Glob and WebFetch/WebSearch for these instead.
 */
const SDK_COVERED_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "bash",
  "bash_output",
  "bash_kill",
  "grep",
  "web_fetch",
  "web_search",
  "github_read_file",
]);

/** Name prefix the SDK gives tools from our in-process MCP server. */
const MCP_PREFIX = "mcp__canarycode__";

/** Strip the in-process MCP prefix so events/gates see the bare tool name. */
function displayToolName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/**
 * Split the harness tool set into the tools we forward into the SDK loop (skills,
 * MCP, sub-agents, user tools — everything canarycode owns) and the ones the SDK
 * covers natively (dropped). Exported for testing the partition.
 */
export function partitionTools(tools: Tool[]): {
  forward: Tool[];
  covered: Tool[];
} {
  const forward: Tool[] = [];
  const covered: Tool[] = [];
  for (const t of tools) {
    (SDK_COVERED_TOOLS.has(t.name) ? covered : forward).push(t);
  }
  return { forward, covered };
}

// ── Forwarding canarycode tools into the SDK as an in-process MCP server ──────

/** Convert one JSON Schema node to a Zod type (best-effort; unknowns → z.any). */
function jsonSchemaToZod(
  schema: Record<string, unknown> | undefined,
): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any();
  const enumVals = schema.enum;
  if (
    Array.isArray(enumVals) &&
    enumVals.length > 0 &&
    enumVals.every((e) => typeof e === "string")
  ) {
    return z.enum(enumVals as [string, ...string[]]);
  }
  switch (schema.type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(
        jsonSchemaToZod(schema.items as Record<string, unknown> | undefined),
      );
    case "object":
      return z.object(jsonSchemaToZodShape(schema));
    default:
      return z.any();
  }
}

/**
 * Convert a JSON Schema object's `properties` into a Zod raw shape (the form the
 * SDK's `tool()` wants). canarycode tools carry simple, flat schemas, so this is
 * faithful; exotic shapes degrade gracefully to `z.any()`. Exported for testing.
 */
export function jsonSchemaToZodShape(
  schema: Record<string, unknown> | undefined,
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const props = (schema?.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set((schema?.required as string[] | undefined) ?? []);
  for (const [key, prop] of Object.entries(props)) {
    let zt = jsonSchemaToZod(prop);
    if (typeof prop?.description === "string")
      zt = zt.describe(prop.description);
    if (!required.has(key)) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}

/** Build an in-process SDK MCP server exposing our tools; returns it plus a
 *  name→Tool map for permission classification. */
function buildForwardServer(
  tools: Tool[],
  sdk: { createSdkMcpServer: SdkCreateMcpServerFn; tool: SdkToolFn },
): { server: unknown; byName: Map<string, Tool> } {
  const byName = new Map<string, Tool>();
  const defs = tools.map((t) => {
    byName.set(t.name, t);
    return sdk.tool(
      t.name,
      t.description,
      jsonSchemaToZodShape(t.schema),
      async (args): Promise<SdkToolResult> => {
        try {
          const out = await t.run(args);
          // Only the text result crosses the MCP boundary; canarycode's diff /
          // image extras are display-only and do not apply to SDK sessions.
          const text = typeof out === "string" ? out : out.content;
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return {
            content: [
              { type: "text", text: (err as Error).message ?? String(err) },
            ],
            isError: true,
          };
        }
      },
    );
  });
  const server = sdk.createSdkMcpServer({
    name: "canarycode",
    version: "1.0.0",
    tools: defs,
  });
  return { server, byName };
}

/** Whether a tool the SDK is about to run is read-only (skips the harness gate).
 *  Forwarded canarycode tools carry their own `readOnly` flag; SDK built-ins use
 *  the static classification above. */
function isReadOnlyTool(
  toolName: string,
  forwardedByName: Map<string, Tool>,
): boolean {
  if (toolName.startsWith(MCP_PREFIX)) {
    const t = forwardedByName.get(toolName.slice(MCP_PREFIX.length));
    return t ? t.readOnly : false;
  }
  return READ_ONLY_SDK_TOOLS.has(toolName);
}

/** The SDK permission callback: allow/deny each tool programmatically (never a
 *  blocking stdin prompt), routing to the harness's PreToolUse hooks + approval
 *  gate so canarycode's policy governs both SDK built-ins and forwarded tools. */
type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  extra: { signal: AbortSignal },
) => Promise<
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string }
>;

function makeCanUseTool(
  opts: AgentOptions,
  forwardedByName: Map<string, Tool>,
  onEditSnapshot?: (path: string) => Promise<void>,
): CanUseToolFn {
  return async (toolName, input) => {
    const readOnly = isReadOnlyTool(toolName, forwardedByName);
    const call = { id: randomUUID(), name: displayToolName(toolName), input };
    if (opts.preToolUse) {
      const h = await opts.preToolUse(call);
      if (!h.allow)
        return {
          behavior: "deny",
          message: h.reason ?? "blocked by a PreToolUse hook",
        };
    }
    if (opts.mode === "plan" && !readOnly) {
      return {
        behavior: "deny",
        message: `"${call.name}" is blocked in plan mode (read-only)`,
      };
    }
    if (opts.gate && !readOnly) {
      const g = await opts.gate(call);
      if (!g.allow)
        return {
          behavior: "deny",
          message: g.reason ?? `user declined to run ${call.name}`,
        };
    }
    // About to execute: snapshot the pre-write contents of a file-editing tool so
    // tool_end can diff against the result. Best-effort — never blocks the call.
    if (onEditSnapshot) {
      const fp = editFilePath(toolName, input);
      if (fp) await onEditSnapshot(fp);
    }
    // The SDK's allow result requires `updatedInput`; echo the input unchanged.
    return { behavior: "allow", updatedInput: input };
  };
}

/** Flatten an MCP-style tool_result content into the text the model saw. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === "string"
          ? p
          : typeof (p as { text?: unknown })?.text === "string"
            ? (p as { text: string }).text
            : "",
      )
      .join("");
  }
  return content == null ? "" : String(content);
}

/** Map the SDK's Anthropic content blocks onto the harness ContentBlock shape,
 *  so produced assistant/tool turns persist in the transcript and seed the next. */
function sdkContentToBlocks(content: SdkContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of content) {
    switch (b.type) {
      case "text":
        out.push({ type: "text", text: b.text });
        break;
      case "thinking":
        out.push({
          type: "thinking",
          thinking: b.thinking,
          signature: b.signature,
        });
        break;
      case "tool_use":
        out.push({
          type: "tool_use",
          id: b.id,
          name: displayToolName(b.name),
          input: b.input,
        });
        break;
      case "tool_result":
        out.push({
          type: "tool_result",
          tool_use_id: b.tool_use_id,
          content: toolResultText(b.content),
          is_error: b.is_error,
        });
        break;
    }
  }
  return out;
}

/**
 * Render the conversation so far to plain text for seeding a fresh SDK query.
 * The SDK is stateless between turns (persistSession:false) and streaming input
 * only accepts user messages, so prior assistant/tool turns are replayed as a
 * readable transcript rather than as tool_use/tool_result blocks (which are
 * invalid inside a user turn). Intra-turn tool calls remain fully native.
 */
function renderConversation(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "Assistant" : "User";
    for (const b of m.content) {
      switch (b.type) {
        case "text":
          if (b.text.trim()) parts.push(`${role}: ${b.text}`);
          break;
        case "tool_use":
          parts.push(
            `${role} called ${b.name}(${JSON.stringify(b.input).slice(0, 2000)})`,
          );
          break;
        case "tool_result": {
          const c =
            typeof b.content === "string"
              ? b.content
              : JSON.stringify(b.content);
          parts.push(
            `tool_result${b.is_error ? " (error)" : ""}: ${c.slice(0, 4000)}`,
          );
          break;
        }
        // thinking / image blocks are display-only; omit from the seed.
      }
    }
  }
  return parts.join("\n\n");
}

async function* toSeedPrompt(
  messages: Message[],
): AsyncGenerator<ClaudeCodeSdkUserMessage> {
  yield {
    type: "user",
    message: { role: "user", content: renderConversation(messages) },
    parent_tool_use_id: null,
  };
}

/** Map an SDK result subtype (and abort state) onto a harness done reason. */
function doneEvent(subtype: string | undefined, aborted: boolean): AgentEvent {
  if (aborted) return { type: "done", reason: "aborted" };
  if (subtype === "error_max_turns")
    return { type: "done", reason: "max_turns" };
  return { type: "done", reason: "stop" };
}

/**
 * Drive the Claude Code SDK's native agent loop for one user turn, yielding
 * harness AgentEvents and appending the produced assistant/tool turns into
 * `messages` in place (so persistence and the next turn's seed stay correct).
 */
async function* runClaudeSession(
  agentOpts: AgentOptions,
  clientOpts: ClaudeCodeOptions,
): AsyncGenerator<AgentEvent> {
  const { messages, signal } = agentOpts;
  if (signal?.aborted) {
    yield { type: "done", reason: "aborted" };
    return;
  }

  const sdkQuery = await resolveQuery(clientOpts);

  // Forward canarycode's own tools (skills, MCP, sub-agents, user tools) into the
  // SDK loop as one in-process MCP server; the SDK's built-ins own the primitives.
  const { forward } = partitionTools(agentOpts.tools);
  let forwardedByName = new Map<string, Tool>();
  let mcpServers: Record<string, unknown> | undefined;
  if (forward.length > 0) {
    const built = buildForwardServer(
      forward,
      await resolveMcpBuilders(clientOpts),
    );
    forwardedByName = built.byName;
    mcpServers = { canarycode: built.server };
  }

  // Redirect the SDK's built-in AskUserQuestion onto canarycode's forwarded
  // `ask_user`. The claude_code preset ships its own AskUserQuestion (identical
  // schema), but its interactive prompt has no handler in this embedded loop, so a
  // call resolves with no answer — the box "flashes and disappears" and the model
  // is told nothing was picked. Aliasing routes the model's AskUserQuestion tool_use
  // to `mcp__canarycode__ask_user`, whose `run` blocks on the TUI's AskUserView and
  // returns the real choice. Only wired when ask_user is actually forwarded.
  const askUserAlias = forwardedByName.has("ask_user")
    ? { AskUserQuestion: `${MCP_PREFIX}ask_user` }
    : undefined;

  // Mid-turn queued input (opts.drainInput) is intentionally NOT injected into
  // the SDK's streaming input here: the SDK pulls prompt messages only at turn
  // boundaries, so timing is unreliable. The front-end instead re-runs anything
  // left queued as the next turn (a fresh runSession seeded with the updated
  // transcript), so no input is lost.

  // Turn budget — mirror runAgent's cap/checkpoint semantics so a Claude Code
  // session isn't silently capped where the native loop would run on. Interactive
  // callers (`checkpointEvery > 0`) run unbounded, pausing every `checkpointEvery`
  // turns to ask "keep going?"; the SDK owns no checkpoint hook, so we cap each
  // query at the checkpoint boundary and, on `error_max_turns`, prompt via
  // `onCheckpoint` and reseed a fresh query from the transcript appended in place.
  // Non-interactive callers keep the hard `maxTurns` cap. Without this, the SDK's
  // internal loop would stop at `maxTurns` (default 25) even in interactive mode.
  const checkpointEvery = agentOpts.checkpointEvery ?? 0;
  const perQueryCap =
    checkpointEvery > 0 ? checkpointEvery : agentOpts.maxTurns;
  let completedCheckpoints = 0;

  for (;;) {
    const abortController = forwardAbort(signal);
    // tool_use id → display name, so a later tool_result can name its tool_end.
    const toolNames = new Map<string, string>();
    // tool_use id → raw input, so tool_end can find a file-editing tool's path.
    const toolInputs = new Map<string, Record<string, unknown>>();
    // file_path → pre-write contents, captured in canUseTool, diffed at tool_end.
    const preEditContent = new Map<string, string>();
    let stopSubtype: string | undefined;

    const q = sdkQuery({
      prompt: toSeedPrompt(messages),
      options: {
        abortController,
        canUseTool: makeCanUseTool(agentOpts, forwardedByName, async (path) => {
          preEditContent.set(path, await readFileOrEmpty(path));
        }),
        cwd: process.cwd(),
        includePartialMessages: true,
        model: agentOpts.model,
        // Our instructions (the CLAUDE.md-equivalent) layered on the SDK's
        // tool-competent base prompt; the machine's ~/.claude settings stay out.
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: agentOpts.system,
        },
        settingSources: [],
        skills: [],
        // SDK built-in tools own the primitives (Read/Write/Edit/Bash/Grep/Glob,
        // WebFetch/WebSearch). canarycode's skills/MCP ride in via mcpServers.
        tools: { type: "preset", preset: "claude_code" },
        ...(mcpServers ? { mcpServers } : {}),
        ...(askUserAlias ? { toolAliases: askUserAlias } : {}),
        permissionMode: "default",
        persistSession: false,
        ...(perQueryCap ? { maxTurns: perQueryCap } : {}),
        ...(effortForClaudeCode(agentOpts.thinkingBudget)
          ? { effort: effortForClaudeCode(agentOpts.thinkingBudget) }
          : {}),
        ...claudeExecutableOption(),
        env: sdkEnv(),
      },
    });

    try {
      for await (const msg of q) {
        if (signal?.aborted) {
          yield { type: "done", reason: "aborted" };
          return;
        }
        switch (msg.type) {
          case "stream_event": {
            const d = msg.event.delta;
            if (msg.event.type === "content_block_delta") {
              if (d?.type === "text_delta")
                yield { type: "text", text: d.text ?? "" };
              else if (d?.type === "thinking_delta")
                yield { type: "thinking", text: d.thinking ?? "" };
            }
            break;
          }
          case "assistant": {
            for (const b of msg.message.content) {
              if (b.type === "tool_use") {
                const name = displayToolName(b.name);
                toolNames.set(b.id, name);
                toolInputs.set(b.id, b.input as Record<string, unknown>);
                yield { type: "tool_start", id: b.id, name, input: b.input };
              }
            }
            messages.push({
              role: "assistant",
              content: sdkContentToBlocks(msg.message.content),
            });
            yield { type: "turn_end" };
            break;
          }
          case "user": {
            const content =
              typeof msg.message.content === "string"
                ? [
                    {
                      type: "text",
                      text: msg.message.content,
                    } as SdkContentBlock,
                  ]
                : msg.message.content;
            for (const b of content) {
              if (b.type === "tool_result") {
                const name = toolNames.get(b.tool_use_id) ?? "tool";
                yield {
                  type: "tool_end",
                  id: b.tool_use_id,
                  name,
                  result: toolResultText(b.content),
                  isError: Boolean(b.is_error),
                  diff: b.is_error
                    ? undefined
                    : await editDiff(
                        name,
                        toolInputs.get(b.tool_use_id),
                        preEditContent,
                      ),
                };
              }
            }
            messages.push({
              role: "user",
              content: sdkContentToBlocks(content),
            });
            break;
          }
          case "result": {
            const usage = msg.total_usage ?? msg.usage;
            if (usage)
              yield {
                type: "usage",
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
              };
            if (msg.subtype && msg.subtype !== "success")
              stopSubtype = msg.subtype;
            break;
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        yield { type: "done", reason: "aborted" };
        return;
      }
      throw err;
    } finally {
      if ("close" in q && typeof q.close === "function") q.close();
    }

    if (signal?.aborted) {
      yield { type: "done", reason: "aborted" };
      return;
    }

    // Interactive checkpoint: the SDK ran to the checkpoint boundary but wanted to
    // keep going (`error_max_turns`). Ask the caller whether to continue and, if
    // so, reseed a fresh query from the transcript we appended in place above.
    if (stopSubtype === "error_max_turns" && checkpointEvery > 0) {
      completedCheckpoints++;
      const turn = completedCheckpoints * checkpointEvery;
      yield { type: "checkpoint", turn };
      if (agentOpts.onCheckpoint) {
        const keepGoing = await agentOpts.onCheckpoint(turn);
        if (signal?.aborted) {
          yield { type: "done", reason: "aborted" };
          return;
        }
        if (!keepGoing) {
          yield { type: "done", reason: "stopped" };
          return;
        }
        continue;
      }
      // No checkpoint hook (the non-interactive runaway backstop): hard stop.
      yield { type: "done", reason: "max_turns" };
      return;
    }

    yield doneEvent(stopSubtype, Boolean(signal?.aborted));
    return;
  }
}

/** Factory registered through the extension provider-factory seam. */
export function claudeCodeProviderFactory(
  opts: ClaudeCodeOptions = {},
): ProviderFactory {
  return () => claudeCodeProvider(opts);
}

export const claudeCodeExtension: Extension = {
  name: "claude-code",
  description: "Anthropic models via your Claude Code subscription",
  providerPresets: () => ({
    [CLAUDE_CODE_PROVIDER]: claudeCodeProviderConfig(),
  }),
  providerFactories: () => ({ [CLAUDE_CODE_API]: claudeCodeProviderFactory() }),
};
