// provider.ts — the LLM provider abstraction + the streaming impls.
//
// A Provider turns a request (system + messages + tools + optional thinking budget)
// into an async stream of small events the agent loop consumes. Two built-ins,
// both over plain `fetch` (no SDK dependency): `anthropic` talks to the Messages
// API, `openai-compat` talks to the OpenAI Chat Completions API — the latter is
// what custom company gateways (incl. CanaryLLM) speak.

import type { ProviderConfig } from "./config.ts";

// ── Shared, provider-agnostic shapes ────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  schema: Record<string, unknown>;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface StreamRequest {
  /** Concrete model name passed to the API (the resolved `ModelConfig.name ?? id`). */
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDef[];
  /** Extended-thinking budget in tokens. Omitted/0 → thinking disabled. */
  thinkingBudget?: number;
  /** Output cap. Defaults to a sensible value per provider. */
  maxTokens?: number;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; stopReason?: string };

export interface Provider {
  id: string;
  stream(req: StreamRequest): AsyncIterable<StreamEvent>;
}

// ── SSE parsing ──────────────────────────────────────────────────────────────

/** Yield each parsed `data:` JSON object from a server-sent-events body. */
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  // biome-ignore lint/suspicious/noExplicitAny: SSE frames are dynamically shaped JSON read with optional chaining.
): AsyncIterable<Record<string, any>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data) {
            try {
              yield JSON.parse(data);
            } catch {
              // ignore non-JSON keepalive lines
            }
          }
        }
      }
    }
  }
}

// ── Anthropic ────────────────────────────────────────────────────────────────

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

function toAnthropicBlock(b: ContentBlock): AnthropicBlock | null {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking":
      // Replayed thinking blocks must carry their signature to be accepted; drop unsigned ones.
      return b.signature
        ? { type: "thinking", thinking: b.thinking, signature: b.signature }
        : null;
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: b.content,
        is_error: b.is_error,
      };
  }
}

function toAnthropicMessage(m: Message): {
  role: string;
  content: AnthropicBlock[];
} {
  const content = m.content
    .map(toAnthropicBlock)
    .filter((b): b is AnthropicBlock => b !== null);
  return { role: m.role, content };
}

export interface AnthropicOptions {
  apiKey: string;
  /** Defaults to https://api.anthropic.com. */
  baseUrl?: string;
  version?: string;
}

/**
 * Whether a model uses the adaptive thinking API (`thinking.type: "adaptive"` +
 * `output_config.effort`) instead of the classic `thinking.type: "enabled"`
 * budget form. Opus 4.5 and later reject the old shape.
 */
function usesAdaptiveThinking(model: string): boolean {
  // Opus 4.5 / Sonnet 4.5+ / Haiku 4.5 and the newer dated builds (e.g.
  // claude-opus-4-8, claude-sonnet-4-6) require adaptive thinking; the classic
  // `thinking.type: "enabled"` budget form is rejected for these.
  const m = /claude-(opus|sonnet|haiku)-(\d+)[-.](\d+)/i.exec(model);
  if (!m) return false;
  const major = Number(m[2]);
  const minor = Number(m[3]);
  if (major > 4) return true;
  if (major < 4) return false;
  return minor >= 5;
}

/** Map a token budget onto an adaptive effort level. */
function effortForBudget(budget: number): "low" | "medium" | "high" {
  if (budget <= 4_000) return "low";
  if (budget <= 10_000) return "medium";
  return "high";
}

function anthropicProvider(opts: AnthropicOptions): Provider {
  const baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(
    /\/$/,
    "",
  );
  const version = opts.version ?? "2023-06-01";

  return {
    id: "anthropic",
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      let maxTokens = req.maxTokens ?? 8192;
      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages.map(toAnthropicMessage),
        stream: true,
      };
      if (req.system) body.system = req.system;
      if (req.tools.length) {
        body.tools = req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.schema,
        }));
      }
      if (req.thinkingBudget && req.thinkingBudget > 0) {
        if (usesAdaptiveThinking(req.model)) {
          // Newer models (Opus 4.5+) reject `thinking.type: "enabled"` and want
          // adaptive thinking with an effort level on output_config.
          body.thinking = { type: "adaptive" };
          body.output_config = { effort: effortForBudget(req.thinkingBudget) };
        } else {
          // max_tokens must exceed the thinking budget.
          if (maxTokens <= req.thinkingBudget)
            maxTokens = req.thinkingBudget + 4096;
          body.thinking = {
            type: "enabled",
            budget_tokens: req.thinkingBudget,
          };
        }
      }
      body.max_tokens = maxTokens;

      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": version,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          `anthropic: ${res.status} ${res.statusText}${errText ? ` — ${errText}` : ""}`,
        );
      }

      // Accumulate streamed tool_use input JSON keyed by content block index.
      const pending: Record<
        number,
        { id: string; name: string; json: string }
      > = {};

      for await (const ev of parseSSE(res.body)) {
        switch (ev.type) {
          case "message_start":
            if (ev.message?.usage) {
              yield {
                type: "usage",
                inputTokens: ev.message.usage.input_tokens ?? 0,
                outputTokens: ev.message.usage.output_tokens ?? 0,
              };
            }
            break;
          case "content_block_start":
            if (ev.content_block?.type === "tool_use") {
              pending[ev.index] = {
                id: ev.content_block.id,
                name: ev.content_block.name,
                json: "",
              };
            }
            break;
          case "content_block_delta":
            if (ev.delta?.type === "text_delta") {
              yield { type: "text_delta", text: ev.delta.text };
            } else if (ev.delta?.type === "thinking_delta") {
              yield { type: "thinking_delta", text: ev.delta.thinking };
            } else if (ev.delta?.type === "input_json_delta") {
              const t = pending[ev.index];
              if (t) t.json += ev.delta.partial_json ?? "";
            }
            break;
          case "content_block_stop": {
            const t = pending[ev.index];
            if (t) {
              let input: unknown = {};
              try {
                input = t.json ? JSON.parse(t.json) : {};
              } catch {
                input = {};
              }
              yield { type: "tool_use", id: t.id, name: t.name, input };
              delete pending[ev.index];
            }
            break;
          }
          case "message_delta":
            if (ev.usage) {
              yield {
                type: "usage",
                inputTokens: 0,
                outputTokens: ev.usage.output_tokens ?? 0,
              };
            }
            if (ev.delta?.stop_reason) {
              yield { type: "done", stopReason: ev.delta.stop_reason };
            }
            break;
          case "error":
            throw new Error(
              `anthropic stream error: ${JSON.stringify(ev.error)}`,
            );
          default:
            break;
        }
      }
    },
  };
}

// ── OpenAI-compatible (Chat Completions) ─────────────────────────────────────

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

/**
 * Flatten the provider-agnostic transcript into OpenAI chat messages.
 *
 * One internal Message can hold mixed blocks, so it may expand into several
 * OpenAI messages: assistant text+tool_use → one assistant message carrying
 * `tool_calls`; each tool_result → its own `role: "tool"` message (which the API
 * requires to immediately follow the assistant turn that called the tools).
 * `thinking` blocks have no OpenAI equivalent and are dropped.
 */
function toOpenAIMessages(
  system: string,
  messages: Message[],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (m.role === "assistant") {
      let text = "";
      const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
      for (const b of m.content) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: {
              name: b.name,
              arguments: JSON.stringify(b.input ?? {}),
            },
          });
        }
        // thinking blocks: dropped (no OpenAI equivalent)
      }
      const msg: OpenAIMessage = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      // user turn: tool_result blocks become their own `tool` messages; plain
      // text blocks coalesce into a single user message.
      let text = "";
      for (const b of m.content) {
        if (b.type === "tool_result") {
          out.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: b.content,
          });
        } else if (b.type === "text") {
          text += b.text;
        }
      }
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

export interface OpenAICompatOptions {
  apiKey?: string;
  baseUrl: string;
}

function openaiCompatProvider(opts: OpenAICompatOptions): Provider {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");

  return {
    id: "openai-compat",
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: toOpenAIMessages(req.system, req.messages),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: req.maxTokens ?? 8192,
      };
      if (req.tools.length) {
        body.tools = req.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.schema,
          },
        }));
      }
      // Extended thinking has no portable Chat Completions equivalent; drop it.

      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          `openai-compat: ${res.status} ${res.statusText}${errText ? ` — ${errText}` : ""}`,
        );
      }

      // Accumulate streamed tool calls keyed by their `index` in the delta.
      const pending: Record<
        number,
        { id: string; name: string; args: string }
      > = {};
      let stopReason: string | undefined;

      const flushTools = function* (): Iterable<StreamEvent> {
        for (const key of Object.keys(pending)
          .map(Number)
          .sort((a, b) => a - b)) {
          const t = pending[key]!;
          let input: unknown = {};
          try {
            input = t.args ? JSON.parse(t.args) : {};
          } catch {
            input = {};
          }
          yield { type: "tool_use", id: t.id, name: t.name, input };
          delete pending[key];
        }
      };

      for await (const ev of parseSSE(res.body)) {
        if (ev.usage) {
          yield {
            type: "usage",
            inputTokens: ev.usage.prompt_tokens ?? 0,
            outputTokens: ev.usage.completion_tokens ?? 0,
          };
        }
        const choice = ev.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          yield { type: "text_delta", text: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx: number = tc.index ?? 0;
            const slot = (pending[idx] ??= { id: "", name: "", args: "" });
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
          }
        }
        if (choice.finish_reason) {
          // Map OpenAI finish reasons onto our (Anthropic-flavoured) stop reasons.
          stopReason =
            choice.finish_reason === "tool_calls"
              ? "tool_use"
              : choice.finish_reason;
        }
      }

      // Emit any reassembled tool calls, then the terminal done event.
      yield* flushTools();
      yield { type: "done", stopReason };
    },
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

/** Build a Provider from a resolved ProviderConfig. */
export function createProvider(cfg: ProviderConfig): Provider {
  switch (cfg.api) {
    case "anthropic":
      if (!cfg.apiKey) {
        throw new Error(
          "cc: anthropic provider requires an apiKey (set ANTHROPIC_API_KEY)",
        );
      }
      return anthropicProvider({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
    case "openai-compat":
      if (!cfg.baseUrl) {
        throw new Error("cc: openai-compat provider requires a baseUrl");
      }
      return openaiCompatProvider({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
    default:
      throw new Error(
        `cc: unknown provider api "${(cfg as ProviderConfig).api}"`,
      );
  }
}
