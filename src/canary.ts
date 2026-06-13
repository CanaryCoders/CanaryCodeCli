// canary.ts — CanaryLLM first-class provider preset + model discovery.
//
// CanaryLLM (https://canaryllm.canarycoders.es) is a multi-provider gateway. We
// lean on the official SDK for model discovery, while reusing canarycode's
// existing OpenAI-compatible streaming provider for the actual chat loop.

import type { ModelInfo } from "@canarycoders/canaryllm";

import type { Config, ModelConfig, ProviderConfig } from "./config.ts";

/** The provider key used for the baked-in CanaryLLM preset. */
export const CANARY_PROVIDER = "canaryllm";
const CANARY_API_HOST = "https://canaryllm.canarycoders.es";

/**
 * The baked-in CanaryLLM provider preset (OpenAI-compatible). The API key reads
 * from `${CANARYLLM_API_KEY}`; models stay empty until discovered (or a user
 * sets them explicitly in `~/.canarycode/config.json`).
 */
export function canaryProviderConfig(): ProviderConfig {
  return {
    api: "openai-compat",
    baseUrl: `${CANARY_API_HOST}/v1`,
    apiKey: "${CANARYLLM_API_KEY}",
    models: [],
  };
}

/** Whether a provider config points at the CanaryLLM gateway. */
function isCanaryProvider(pc: ProviderConfig): boolean {
  return (
    pc.api === "openai-compat" && (pc.baseUrl ?? "").startsWith(CANARY_API_HOST)
  );
}

/**
 * Whether a model's capability list marks it as chat-usable (`chat` or
 * `reasoning`). A single pass over the tiny capabilities array — cheaper than
 * allocating a Set per model, and keeps the membership test out of the parse
 * loop.
 */
function isChatCapable(caps: readonly unknown[]): boolean {
  for (const cap of caps) {
    if (cap === "chat" || cap === "reasoning") return true;
  }
  return false;
}

/**
 * Turn one SDK `ModelInfo` (listed under the `provider` group key) into a chat
 * `ModelConfig`, or null if it isn't chat-usable. `capabilities` is parsed
 * defensively: the catalogue omits it on some entries, so a missing/non-array
 * value is treated as "no declared capabilities" (→ skipped) rather than thrown.
 *
 * The gateway's chat-completions endpoint requires a `provider/model` string, so
 * the id is namespaced with the group key (the model's own `provider` field if
 * present). The slash guard leaves an already-namespaced id untouched.
 */
function toCanaryModel(provider: string, model: ModelInfo): ModelConfig | null {
  const caps = Array.isArray(model.capabilities) ? model.capabilities : [];
  if (!isChatCapable(caps)) return null;
  const id = /\//.test(model.id)
    ? model.id
    : `${model.provider || provider}/${model.id}`;
  return { id };
}

/**
 * Parse the SDK's `public.models()` catalogue — shape
 * `{ <provider>: { models: [{ id, capabilities, ... }] } }` (the transport has
 * already unwrapped the `{ success, data }` envelope) — into deduped chat models.
 */
function parseCanaryModels(
  catalogue: Record<string, { models?: readonly ModelInfo[] }>,
): ModelConfig[] {
  const out: ModelConfig[] = [];
  const seen = new Set<string>();
  for (const [provider, group] of Object.entries(catalogue ?? {})) {
    const models = group?.models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      const item = toCanaryModel(provider, model);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

function sdkBaseURL(baseUrl: string | undefined): string | undefined {
  return baseUrl?.replace(/\/v1\/?$/, "");
}

/**
 * Discover CanaryLLM chat models through the official SDK.
 *
 * Uses the unauthenticated `public.models()` catalogue, not `discovery.models()`:
 * the public endpoint returns full `capabilities` for every model, whereas the
 * per-provider discovery endpoint omits them on many chat models (which would
 * silently drop e.g. `gemini-2.5-flash`, `gpt-4.1`, all of perplexity/lmstudio).
 */
async function fetchCanaryModels(
  opts: {
    apiKey?: string;
    baseURL?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ModelConfig[]> {
  const { default: CanaryLLM } = await import("@canarycoders/canaryllm");
  const client = new CanaryLLM({
    apiKey: opts.apiKey,
    baseURL: sdkBaseURL(opts.baseURL),
    fetch: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 8000,
  });
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 8000);
  return parseCanaryModels(await client.public.models(signal));
}

/** Outcome of a model-discovery attempt, for the startup note. */
export type CanaryPopulateResult =
  | { provider: string; count: number }
  | { provider: string; error: string };

/**
 * Fill an empty CanaryLLM-preset provider with discovered models, in place.
 *
 * Skips when there is no CanaryLLM provider, when one already has models
 * configured, or when no API key is set (the user hasn't opted into CanaryLLM —
 * so we avoid the network call for the common anthropic-only path). Best-effort:
 * a fetch/parse failure leaves models empty and is reported, not thrown.
 */
export async function populateCanaryModels(
  config: Config,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CanaryPopulateResult | undefined> {
  // Pick the single CanaryLLM provider to populate first (pure, no I/O), then do
  // the one network call outside the loop. Only the first eligible provider is
  // ever discovered, so there is nothing to parallelize here.
  const target = Object.entries(config.providers).find(
    ([, pc]) =>
      isCanaryProvider(pc) &&
      (pc.models?.length ?? 0) === 0 && // not explicitly configured
      Boolean(pc.apiKey), // has a key → opted in
  );
  if (!target) return undefined;

  const [name, pc] = target;
  try {
    pc.models = await fetchCanaryModels({
      apiKey: pc.apiKey,
      baseURL: pc.baseUrl,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
    return { provider: name, count: pc.models.length };
  } catch (err) {
    return { provider: name, error: (err as Error).message };
  }
}

/** One-line stderr/scrollback note describing a discovery result (or nothing). */
export function describeCanary(
  result: CanaryPopulateResult | undefined,
): string | undefined {
  if (!result) return undefined;
  if ("error" in result)
    return `note: CanaryLLM model discovery failed — ${result.error}`;
  if (result.count === 0) return undefined;
  return `note: CanaryLLM — discovered ${result.count} model${result.count === 1 ? "" : "s"}`;
}
