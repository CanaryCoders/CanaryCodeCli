// provider.ts — the LLM provider abstraction + the streaming impls.
//
// A Provider turns a request (system + messages + tools + optional thinking budget)
// into an async stream of small events the agent loop consumes. Two built-ins,
// both over plain `fetch` (no SDK dependency): `anthropic` talks to the Messages
// API, `openai-compat` talks to the OpenAI Chat Completions API — the latter is
// what custom company gateways (incl. CanaryLLM) speak.

import { makeTokenGetter, type TokenGetter } from "./auth.ts";
import type { ProviderConfig } from "./config.ts";
import { type CodexEffort, parseCodexModel } from "./openai-codex.ts";

/** Sentinel string carried on `StreamEvent.tool_use.inputError` when the
 *  accumulated argument JSON failed to parse (typically a truncated stream). */
export const TOOL_INPUT_PARSE_ERROR =
  "tool call arguments were not valid JSON (stream truncated?)";

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
    }
  // A base64-encoded image. `mediaType` is an IANA type (e.g. "image/png"); `data`
  // is the raw base64 (no `data:` prefix). Each provider's converter reshapes this
  // into its own wire form (Anthropic `source`, OpenAI `image_url` data URL, …).
  | { type: "image"; mediaType: string; data: string };

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
  /** Abort the in-flight HTTP request/stream. */
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
      /** Set when the streamed argument JSON failed to parse — the loop must not execute the call. */
      inputError?: string;
    }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; stopReason?: string };

export interface Provider {
  id: string;
  stream(req: StreamRequest): AsyncIterable<StreamEvent>;
}

// ── SSE parsing ──────────────────────────────────────────────────────────────

/**
 * Split the first blank-line-delimited SSE frame off a string buffer. Returns
 * the frame text and the remaining buffer, or `undefined` when no complete frame
 * is buffered yet. Pulling one frame per call keeps the scan out of the
 * streaming read loop.
 */
function takeFrame(buf: string): { frame: string; rest: string } | undefined {
  const sep = buf.indexOf("\n\n");
  if (sep === -1) return undefined;
  return { frame: buf.slice(0, sep), rest: buf.slice(sep + 2) };
}

/** Yield each parsed `data:` JSON object from a server-sent-events body. */
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  // biome-ignore lint/suspicious/noExplicitAny: SSE frames are dynamically shaped JSON read with optional chaining.
): AsyncIterable<Record<string, any>> {
  const decoder = new TextDecoder();
  let buf = "";
  // Iterate the byte stream directly: each chunk strictly follows the previous
  // one (the read cursor advances), so this pump is sequential by construction.
  for await (const value of body as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(value, { stream: true });
    let split = takeFrame(buf);
    while (split) {
      const chunk = split.frame;
      buf = split.rest;
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
      split = takeFrame(buf);
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
    }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
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
    case "image":
      return {
        type: "image",
        source: { type: "base64", media_type: b.mediaType, data: b.data },
      };
  }
}

export function toAnthropicMessage(m: Message): {
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
        signal: req.signal,
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
          case "content_block_delta": {
            const delta = ev.delta;
            if (delta?.type === "text_delta") {
              yield { type: "text_delta", text: delta.text };
            } else if (delta?.type === "thinking_delta") {
              yield { type: "thinking_delta", text: delta.thinking };
            } else if (delta?.type === "input_json_delta") {
              const t = pending[ev.index];
              if (t) t.json += delta.partial_json ?? "";
            }
            break;
          }
          case "content_block_stop": {
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

/** A base64 image content block rendered as a `data:` URL — the form every
 *  OpenAI-style API (Chat Completions `image_url`, Responses `input_image`)
 *  accepts for inline base64 images. */
function imageDataUrl(b: { mediaType: string; data: string }): string {
  return `data:${b.mediaType};base64,${b.data}`;
}

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentPart[] | null;
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
export function toOpenAIMessages(
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
      // user turn: tool_result blocks become their own `tool` messages; text and
      // image blocks coalesce into a single user message. With images present the
      // content becomes a parts array (text part + `image_url` parts); otherwise it
      // stays a plain string so text-only turns are unchanged.
      let text = "";
      const images: OpenAIContentPart[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") {
          out.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: b.content,
          });
        } else if (b.type === "text") {
          text += b.text;
        } else if (b.type === "image") {
          images.push({
            type: "image_url",
            image_url: { url: imageDataUrl(b) },
          });
        }
      }
      if (images.length) {
        const parts: OpenAIContentPart[] = [];
        if (text) parts.push({ type: "text", text });
        parts.push(...images);
        out.push({ role: "user", content: parts });
      } else if (text) {
        out.push({ role: "user", content: text });
      }
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
        signal: req.signal,
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
          let inputError: string | undefined;
          try {
            input = t.args ? JSON.parse(t.args) : {};
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

// ── OpenAI Codex (Responses API, ChatGPT subscription) ───────────────────────
//
// The subscription path is NOT the Chat Completions API above: it speaks the
// Responses API served from a special host, authenticated with the OAuth bearer
// token in ~/.cc/auth.json (see auth.ts). The request body must force a stateless,
// streaming shape (`store:false`, encrypted reasoning carried server-side) and use
// the Responses item vocabulary (`input_text`/`output_text`, `function_call`).

/** Where the ChatGPT-subscription Responses endpoint lives. */
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

type ResponsesInputItem =
  | {
      type: "message";
      role: "user" | "assistant";
      content: ResponsesContentPart[];
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/**
 * Flatten the provider-agnostic transcript into Responses API `input` items.
 *
 * User text → a `message` with `input_text`; assistant text → `output_text`.
 * `tool_use` → a `function_call` item; `tool_result` → a `function_call_output`.
 * `thinking` blocks are dropped (their encrypted reasoning lives server-side via
 * `store:false` + `include:["reasoning.encrypted_content"]`). No item carries an
 * `id` — under `store:false` the backend rejects references to prior item ids.
 */
export function toResponsesInput(messages: Message[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  for (const m of messages) {
    const textType = m.role === "user" ? "input_text" : "output_text";
    // Accumulate ordered content parts (text + images) for the current message,
    // flushing them when a tool_use/tool_result interrupts the run or at message end.
    let parts: ResponsesContentPart[] = [];
    const flushParts = () => {
      if (parts.length) {
        out.push({ type: "message", role: m.role, content: parts });
        parts = [];
      }
    };
    for (const b of m.content) {
      if (b.type === "text") {
        // Merge consecutive text into the trailing text part (preserves the old
        // single-part shape for plain text turns).
        const last = parts[parts.length - 1];
        if (last && last.type === textType) last.text += b.text;
        else
          parts.push({ type: textType, text: b.text } as ResponsesContentPart);
      } else if (b.type === "image") {
        // input_image is only valid on user turns, which is where images arrive.
        parts.push({ type: "input_image", image_url: imageDataUrl(b) });
      } else if (b.type === "tool_use") {
        flushParts();
        out.push({
          type: "function_call",
          call_id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        });
      } else if (b.type === "tool_result") {
        flushParts();
        out.push({
          type: "function_call_output",
          call_id: b.tool_use_id,
          output: b.content,
        });
      }
      // thinking blocks: dropped.
    }
    flushParts();
  }
  return out;
}

/**
 * Map an extended-thinking token budget onto a Codex reasoning effort. This is how
 * cc's thinking levels drive Codex: the four `/think` levels (off / think /
 * think-hard / ultrathink → budgets 0 / 4k / 10k / 32k) map onto the four useful
 * Codex efforts low / medium / high / xhigh. Codex models always reason, so "off"
 * floors at "low" rather than disabling it; "ultrathink" reaches the top "xhigh".
 */
function effortForCodex(budget: number): CodexEffort {
  if (budget <= 0) return "low";
  if (budget <= 4_000) return "medium";
  if (budget <= 10_000) return "high";
  return "xhigh";
}

/** Subscription-quota exhaustion arrives as a 404 with one of these markers. */
const USAGE_LIMIT_RE =
  /usage_limit_reached|usage_not_included|rate_limit_exceeded/;

export interface OpenAIResponsesOptions {
  tokenGetter: TokenGetter;
}

function openaiResponsesProvider(opts: OpenAIResponsesOptions): Provider {
  const { tokenGetter } = opts;

  return {
    id: "openai-responses",
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      // Reasoning effort comes from the thinking level (see effortForCodex). A
      // handle may still pin an effort explicitly (e.g. "gpt-5.5 xhigh"), which
      // overrides the thinking level; otherwise the wire model is the bare slug.
      const { slug, effort } = parseCodexModel(req.model);
      const reasoningEffort: CodexEffort =
        effort ?? effortForCodex(req.thinkingBudget ?? 0);
      const body: Record<string, unknown> = {
        model: slug,
        // The system prompt rides in `instructions`, not as an input item.
        instructions: req.system,
        input: toResponsesInput(req.messages),
        // The backend is stateless: no stored conversation, reasoning context is
        // returned encrypted and replayed via the include below.
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: reasoningEffort, summary: "auto" },
        text: { verbosity: "medium" },
      };
      if (req.tools.length) {
        body.tools = req.tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.schema,
          strict: false,
        }));
      }
      // Note: no max_tokens / max_completion_tokens — the backend rejects them.

      // Fetch with the bearer token; on a 401 refresh once and retry.
      const doFetch = async (force: boolean): Promise<Response> => {
        const { accessToken, accountId } = force
          ? await tokenGetter.forceRefresh()
          : await tokenGetter.get();
        const res = await fetch(CODEX_RESPONSES_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${accessToken}`,
            "chatgpt-account-id": accountId,
            "OpenAI-Beta": "responses=experimental",
            originator: "codex_cli_rs",
            accept: "text/event-stream",
          },
          body: JSON.stringify(body),
          signal: req.signal,
        });
        if (res.status === 401 && !force) {
          if (req.signal?.aborted)
            throw new DOMException("aborted", "AbortError");
          return doFetch(true);
        }
        return res;
      };

      const res = await doFetch(false);

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        if (res.status === 404 && USAGE_LIMIT_RE.test(errText)) {
          throw new Error(
            "codex: 429 usage limit reached for your ChatGPT subscription — try again later",
          );
        }
        throw new Error(
          `codex: ${res.status} ${res.statusText}${errText ? ` — ${errText}` : ""}`,
        );
      }

      // Accumulate streamed function-call items keyed by their output-item id; the
      // backend may stream `name`/`call_id` on `output_item.added`, the JSON args
      // across `function_call_arguments.delta`, and a final form on `output_item.done`.
      const calls: Record<string, { id: string; name: string; args: string }> =
        {};
      let sawToolCall = false;

      const emitCall = function* (slot: {
        id: string;
        name: string;
        args: string;
      }): Iterable<StreamEvent> {
        let input: unknown = {};
        let inputError: string | undefined;
        try {
          input = slot.args ? JSON.parse(slot.args) : {};
        } catch {
          inputError = TOOL_INPUT_PARSE_ERROR;
        }
        sawToolCall = true;
        yield {
          type: "tool_use",
          id: slot.id,
          name: slot.name,
          input,
          ...(inputError ? { inputError } : {}),
        };
      };

      for await (const ev of parseSSE(res.body)) {
        switch (ev.type) {
          case "response.output_text.delta":
            if (typeof ev.delta === "string") {
              yield { type: "text_delta", text: ev.delta };
            }
            break;
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta":
          case "response.reasoning.delta":
            if (typeof ev.delta === "string") {
              yield { type: "thinking_delta", text: ev.delta };
            }
            break;
          case "response.output_item.added": {
            const item = ev.item;
            if (item?.type === "function_call") {
              calls[item.id ?? item.call_id] = {
                id: item.call_id ?? item.id,
                name: item.name ?? "",
                args: typeof item.arguments === "string" ? item.arguments : "",
              };
            }
            break;
          }
          case "response.function_call_arguments.delta": {
            const slot = calls[ev.item_id];
            if (slot && typeof ev.delta === "string") slot.args += ev.delta;
            break;
          }
          case "response.output_item.done": {
            const item = ev.item;
            if (item?.type === "function_call") {
              const slot = calls[item.id ?? item.call_id] ?? {
                id: item.call_id ?? item.id,
                name: item.name ?? "",
                args: "",
              };
              // Prefer the fully-formed args on the done event when present.
              if (typeof item.arguments === "string" && item.arguments)
                slot.args = item.arguments;
              if (item.call_id) slot.id = item.call_id;
              if (item.name) slot.name = item.name;
              yield* emitCall(slot);
              delete calls[item.id ?? item.call_id];
            }
            break;
          }
          case "response.completed": {
            const usage = ev.response?.usage;
            if (usage) {
              yield {
                type: "usage",
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
              };
            }
            break;
          }
          case "response.failed":
            throw new Error(
              `codex stream error: ${JSON.stringify(ev.response?.error ?? ev)}`,
            );
          case "error":
            throw new Error(
              `codex stream error: ${JSON.stringify(ev.error ?? ev)}`,
            );
          default:
            break;
        }
      }

      // Flush any function call that never got an explicit `done` event.
      for (const slot of Object.values(calls)) yield* emitCall(slot);
      // The agent loop keys on `stopReason === "tool_use"` to run another round.
      yield { type: "done", stopReason: sawToolCall ? "tool_use" : "stop" };
    },
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a Provider from a resolved ProviderConfig. The optional `tokenGetter` is
 * only consulted by the `openai-responses` (Codex) provider; it defaults to one
 * backed by ~/.cc/auth.json, so existing call sites need not pass anything.
 */
export function createProvider(
  cfg: ProviderConfig,
  opts: { tokenGetter?: TokenGetter } = {},
): Provider {
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
    case "openai-responses":
      return openaiResponsesProvider({
        tokenGetter: opts.tokenGetter ?? makeTokenGetter(),
      });
    default:
      throw new Error(
        `cc: unknown provider api "${(cfg as ProviderConfig).api}"`,
      );
  }
}
