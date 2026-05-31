// canary.ts — CanaryLLM first-class provider preset + model discovery.
//
// CanaryLLM (https://canaryllm.canarycoders.es) is a multi-provider gateway that
// exposes drop-in OpenAI-compatible (`/v1/chat/completions`) and
// Anthropic-compatible (`/v1/messages`) endpoints. We integrate against the
// OpenAI-compatible path via our `openai-compat` provider.
//
// Design constraints recorded in RALPH.md §5b (we consume the spec, never fix it):
//   • the spec's `servers` only lists localhost, so we hard-set baseUrl here;
//   • the spec ships no examples, so the model parser is written defensively;
//   • model ids come from the unauthenticated `GET /api/public/models` endpoint.

import type { Config, ModelConfig, ProviderConfig } from "./config.ts";

/** The provider key used for the baked-in CanaryLLM preset. */
export const CANARY_PROVIDER = "canaryllm";
/** API host (the spec's `servers` URL is wrong — localhost only — so we set it). */
export const CANARY_API_HOST = "https://canaryllm.canarycoders.es";
/** OpenAI-compatible base (the provider appends `/chat/completions`). */
export const CANARY_BASE_URL = `${CANARY_API_HOST}/v1`;
/** Unauthenticated model-discovery endpoint. */
export const CANARY_MODELS_URL = `${CANARY_API_HOST}/api/public/models`;

/**
 * The baked-in CanaryLLM provider preset (OpenAI-compatible). The API key reads
 * from `${CANARYLLM_API_KEY}`; models stay empty until discovered (or a user
 * sets them explicitly in `~/.cc/config.json`).
 */
export function canaryProviderConfig(): ProviderConfig {
  return {
    api: "openai-compat",
    baseUrl: CANARY_BASE_URL,
    apiKey: "${CANARYLLM_API_KEY}",
    models: [],
  };
}

/** Whether a provider config points at the CanaryLLM gateway. */
export function isCanaryProvider(pc: ProviderConfig): boolean {
  return pc.api === "openai-compat" && (pc.baseUrl ?? "").startsWith(CANARY_API_HOST);
}

/**
 * Extract chat-usable models from a `GET /api/public/models` payload.
 *
 * Shape (defensively parsed): `{ success, data: { <group>: { models: [{ id,
 * name, capabilities: [...] }] } } }`. We keep only models whose capabilities
 * include `chat` or `reasoning` (skipping image/video/audio/tts/realtime). The
 * gateway's `id` IS the API model name, so we set `ModelConfig.id` and leave
 * `name` unset — the gateway's display `name` ("Gemini 2.5 Flash") is NOT a
 * valid API model id and must not become `ModelConfig.name`.
 */
export function parseCanaryModels(payload: unknown): ModelConfig[] {
  const out: ModelConfig[] = [];
  const seen = new Set<string>();
  const data = (payload as { data?: unknown })?.data;
  if (!data || typeof data !== "object") return out;
  for (const group of Object.values(data as Record<string, unknown>)) {
    const models = (group as { models?: unknown })?.models;
    if (!Array.isArray(models)) continue;
    for (const m of models as Array<Record<string, unknown>>) {
      const id = typeof m?.id === "string" ? m.id : undefined;
      if (!id || seen.has(id)) continue;
      const caps = Array.isArray(m?.capabilities) ? (m.capabilities as unknown[]) : [];
      if (!caps.includes("chat") && !caps.includes("reasoning")) continue;
      seen.add(id);
      out.push({ id });
    }
  }
  return out;
}

/** Fetch + parse the discoverable CanaryLLM chat models. Throws on HTTP/parse error. */
export async function fetchCanaryModels(
  opts: { url?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ModelConfig[]> {
  const url = opts.url ?? CANARY_MODELS_URL;
  const f = opts.fetchImpl ?? fetch;
  const res = await f(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
  if (!res.ok) {
    throw new Error(`canaryllm: ${res.status} ${res.statusText} fetching ${url}`);
  }
  return parseCanaryModels(await res.json());
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
  for (const [name, pc] of Object.entries(config.providers)) {
    if (!isCanaryProvider(pc)) continue;
    if ((pc.models?.length ?? 0) > 0) continue; // explicitly configured — leave it
    if (!pc.apiKey) continue; // no key → not opted in → skip the network call
    try {
      pc.models = await fetchCanaryModels(opts);
      return { provider: name, count: pc.models.length };
    } catch (err) {
      return { provider: name, error: (err as Error).message };
    }
  }
  return undefined;
}

/** One-line stderr/scrollback note describing a discovery result (or nothing). */
export function describeCanary(result: CanaryPopulateResult | undefined): string | undefined {
  if (!result) return undefined;
  if ("error" in result) return `note: CanaryLLM model discovery failed — ${result.error}`;
  if (result.count === 0) return undefined;
  return `note: CanaryLLM — discovered ${result.count} model${result.count === 1 ? "" : "s"}`;
}
