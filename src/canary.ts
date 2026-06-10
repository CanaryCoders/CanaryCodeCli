// canary.ts — CanaryLLM first-class provider preset + model discovery.
//
// CanaryLLM (https://canaryllm.canarycoders.es) is a multi-provider gateway that
// exposes drop-in OpenAI-compatible (`/v1/chat/completions`) and
// Anthropic-compatible (`/v1/messages`) endpoints. We integrate against the
// OpenAI-compatible path via our `openai-compat` provider.
//
// CanaryLLM's public OpenAPI description has a few constraints we account for:
//   • the documented `servers` value may point at localhost, so baseUrl is fixed;
//   • examples may be absent, so the model parser is written defensively;
//   • model ids come from the unauthenticated `GET /api/public/models` endpoint.

import type { Config, ModelConfig, ProviderConfig } from "./config.ts";

/** The provider key used for the baked-in CanaryLLM preset. */
export const CANARY_PROVIDER = "canaryllm";
/** API host (the spec's `servers` URL is wrong — localhost only — so we set it). */
const CANARY_API_HOST = "https://canaryllm.canarycoders.es";
/** OpenAI-compatible base (the provider appends `/chat/completions`). */
const CANARY_BASE_URL = `${CANARY_API_HOST}/v1`;
/** Unauthenticated model-discovery endpoint. */
const CANARY_MODELS_URL = `${CANARY_API_HOST}/api/public/models`;

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
function isCanaryProvider(pc: ProviderConfig): boolean {
  return (
    pc.api === "openai-compat" && (pc.baseUrl ?? "").startsWith(CANARY_API_HOST)
  );
}

/**
 * Extract chat-usable models from a `GET /api/public/models` payload.
 *
 * Shape (defensively parsed): `{ success, data: { <provider>: { models: [{ id,
 * name, capabilities: [...] }] } } }`. We keep only models whose capabilities
 * include `chat` or `reasoning` (skipping image/video/audio/tts/realtime).
 *
 * The gateway's chat-completions endpoint requires a `provider/model` model
 * string (it 400s on a bare `gemini-3.5-flash`), but each entry's `id` is the
 * BARE model name — the provider segment is the *group key* the model is listed
 * under (`gemini`, `vertex`, `openai`, …). So we set `ModelConfig.id` to
 * `${group}/${id}`: that is both the user-facing handle (shown in `/model`) and,
 * with `name` left unset, the wire model string. Prefixing also disambiguates
 * the same bare id appearing under multiple providers (e.g. `gemini-2.5-flash`
 * is listed under both `gemini` and `vertex`), which a bare-id dedup would drop.
 */
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

function parseCanaryModels(payload: unknown): ModelConfig[] {
  const out: ModelConfig[] = [];
  const seen = new Set<string>();
  const data = (payload as { data?: unknown })?.data;
  if (!data || typeof data !== "object") return out;
  for (const [provider, group] of Object.entries(
    data as Record<string, unknown>,
  )) {
    const models = (group as { models?: unknown })?.models;
    if (!Array.isArray(models)) continue;
    for (const m of models as Array<Record<string, unknown>>) {
      const rawId = typeof m?.id === "string" ? m.id : undefined;
      if (!rawId) continue;
      const caps = Array.isArray(m?.capabilities)
        ? (m.capabilities as unknown[])
        : [];
      if (!isChatCapable(caps)) continue;
      // The model is already `provider/model` only if the gateway ever changes
      // its shape; otherwise prefix the group key it was listed under. (A regex
      // test for the separator, not a membership scan — `rawId` is a string.)
      const alreadyNamespaced = /\//.test(rawId);
      const id = alreadyNamespaced ? rawId : `${provider}/${rawId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id });
    }
  }
  return out;
}

/** Fetch + parse the discoverable CanaryLLM chat models. Throws on HTTP/parse error. */
async function fetchCanaryModels(
  opts: { url?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ModelConfig[]> {
  const url = opts.url ?? CANARY_MODELS_URL;
  const f = opts.fetchImpl ?? fetch;
  const res = await f(url, {
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
  });
  if (!res.ok) {
    throw new Error(
      `canaryllm: ${res.status} ${res.statusText} fetching ${url}`,
    );
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
    pc.models = await fetchCanaryModels(opts);
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
