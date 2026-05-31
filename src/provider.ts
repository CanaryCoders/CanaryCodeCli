// provider.ts — the LLM provider abstraction + the Anthropic streaming impl.
//
// A Provider turns a request (system + messages + tools + optional thinking budget)
// into an async stream of small events the agent loop consumes. The built-in
// `anthropic` provider talks to the Messages API over SSE using plain `fetch`
// (no SDK dependency). `openai-compat` arrives in Phase 2.

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
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

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
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<Record<string, any>> {
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
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

function toAnthropicBlock(b: ContentBlock): AnthropicBlock | null {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking":
      // Replayed thinking blocks must carry their signature to be accepted; drop unsigned ones.
      return b.signature ? { type: "thinking", thinking: b.thinking, signature: b.signature } : null;
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error };
  }
}

function toAnthropicMessage(m: Message): { role: string; content: AnthropicBlock[] } {
  const content = m.content.map(toAnthropicBlock).filter((b): b is AnthropicBlock => b !== null);
  return { role: m.role, content };
}

export interface AnthropicOptions {
  apiKey: string;
  /** Defaults to https://api.anthropic.com. */
  baseUrl?: string;
  version?: string;
}

export function anthropicProvider(opts: AnthropicOptions): Provider {
  const baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
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
        // max_tokens must exceed the thinking budget.
        if (maxTokens <= req.thinkingBudget) maxTokens = req.thinkingBudget + 4096;
        body.thinking = { type: "enabled", budget_tokens: req.thinkingBudget };
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
        throw new Error(`anthropic: ${res.status} ${res.statusText}${errText ? ` — ${errText}` : ""}`);
      }

      // Accumulate streamed tool_use input JSON keyed by content block index.
      const pending: Record<number, { id: string; name: string; json: string }> = {};

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
              pending[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, json: "" };
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
              yield { type: "usage", inputTokens: 0, outputTokens: ev.usage.output_tokens ?? 0 };
            }
            if (ev.delta?.stop_reason) {
              yield { type: "done", stopReason: ev.delta.stop_reason };
            }
            break;
          case "error":
            throw new Error(`anthropic stream error: ${JSON.stringify(ev.error)}`);
          default:
            break;
        }
      }
    },
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

/** Build a Provider from a resolved ProviderConfig. */
export function createProvider(cfg: ProviderConfig): Provider {
  switch (cfg.api) {
    case "anthropic":
      if (!cfg.apiKey) {
        throw new Error("cc: anthropic provider requires an apiKey (set ANTHROPIC_API_KEY)");
      }
      return anthropicProvider({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
    case "openai-compat":
      throw new Error('cc: provider api "openai-compat" not yet implemented (Phase 2)');
    default:
      throw new Error(`cc: unknown provider api "${(cfg as ProviderConfig).api}"`);
  }
}
