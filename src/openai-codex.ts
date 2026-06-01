// openai-codex.ts — "OpenAI Codex (ChatGPT subscription)" provider preset + model
// discovery.
//
// Mirrors the canary.ts preset pattern. This provider carries no API key or
// baseUrl: it authenticates with the ChatGPT-subscription OAuth tokens in
// ~/.cc/auth.json (see auth.ts) and talks the Responses-API path
// (chatgpt.com/backend-api/codex/responses) via the `openai-responses` provider
// impl in provider.ts.
//
// Models are NOT hardcoded — the set a ChatGPT account may use is curated
// server-side and changes over time (e.g. gpt-5.2-codex was dropped, gpt-5.5
// added). We fetch the catalog from the same endpoint the Codex CLI uses and
// expose each visible model as a bare slug. The reasoning effort (low / medium /
// high / xhigh) is driven by cc's thinking level — `/think` → the provider's
// effortForCodex — so it is NOT part of the model handle. A handle MAY still pin an
// effort explicitly ("gpt-5.5 xhigh") to override the thinking level, which
// `parseCodexModel` understands. Until the user signs in the preset is inert (empty
// model list), so `/model` never offers a model that would just fail.

import { makeTokenGetter, type TokenGetter } from "./auth.ts";
import type { Config, ModelConfig, ProviderConfig } from "./config.ts";

/** The provider key used for the baked-in Codex preset. */
export const OPENAI_PROVIDER = "openai";

/** Catalog endpoint (same one the Codex CLI fetches). */
const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
/**
 * Client version sent on the catalog request. The backend returns only models
 * whose `minimal_client_version` is ≤ this (a plain version comparison), so a low
 * value silently hides newer models — e.g. gpt-5.5 requires ≥ 1.0.0. We send a
 * deliberately high version to surface every model the account is entitled to,
 * regardless of how the bar moves (verified: the endpoint accepts arbitrarily high
 * versions and just returns the full set). We already impersonate the Codex CLI
 * via `originator: codex_cli_rs`.
 */
const CODEX_CLIENT_VERSION = "9.99.0";

/** Reasoning effort levels, weakest → strongest (the Codex `ReasoningEffort` enum). */
export const CODEX_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];

/**
 * Static fallback used only when the catalog fetch fails (offline, transient
 * error). The current ChatGPT-account set as of mid-2026 — deliberately NOT the
 * stale gpt-5.1 / gpt-5.2-codex generation. `gpt-5.5` is the recommended default.
 */
const CODEX_FALLBACK_MODELS: ModelConfig[] = [
  { id: "gpt-5.5" },
  { id: "gpt-5.4" },
  { id: "gpt-5.4-mini" },
  { id: "gpt-5.3-codex" },
  { id: "gpt-5.2" },
];

/** The baked-in Codex provider preset (auth via ~/.cc/auth.json, not an apiKey). */
export function openaiCodexProviderConfig(): ProviderConfig {
  // Models start empty: populated on startup once signed in (see populateCodexModels).
  return { api: "openai-responses", models: [] };
}

/** Whether a provider config is the Codex preset (the only `openai-responses`). */
function isCodexProvider(pc: ProviderConfig): boolean {
  return pc.api === "openai-responses";
}

/**
 * Split a Codex model handle into its wire slug and optional reasoning effort.
 * Catalog handles look like "gpt-5.5 xhigh" — the trailing token is an effort
 * level. A bare slug (no recognised effort suffix) returns `effort: undefined`.
 */
export function parseCodexModel(model: string): {
  slug: string;
  effort?: CodexEffort;
} {
  const at = model.lastIndexOf(" ");
  if (at > 0) {
    const tail = model.slice(at + 1) as CodexEffort;
    if ((CODEX_EFFORTS as readonly string[]).includes(tail)) {
      return { slug: model.slice(0, at), effort: tail };
    }
  }
  return { slug: model };
}

// ── catalog fetch ────────────────────────────────────────────────────────────

/** One model entry from the catalog (only the fields we use). */
interface CatalogModel {
  slug?: string;
  visibility?: string;
}

/**
 * Parse a catalog payload into model handles: one bare slug per model whose
 * visibility is "list" (deduped, order preserved). Reasoning effort is applied
 * separately from the thinking level, so it is not encoded here.
 */
function parseCatalog(payload: unknown): ModelConfig[] {
  const models = (payload as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const out: ModelConfig[] = [];
  const seen = new Set<string>();
  for (const m of models as CatalogModel[]) {
    if (!m?.slug || (m.visibility ?? "list") !== "list") continue;
    if (seen.has(m.slug)) continue;
    seen.add(m.slug);
    out.push({ id: m.slug });
  }
  return out;
}

/** Fetch + parse the ChatGPT-account model catalog. Throws on HTTP/parse error. */
async function fetchCodexModels(opts: {
  tokenGetter?: TokenGetter;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ModelConfig[]> {
  const getter = opts.tokenGetter ?? makeTokenGetter();
  const f = opts.fetchImpl ?? fetch;
  const { accessToken, accountId } = await getter.get();
  const url = `${CODEX_MODELS_URL}?client_version=${CODEX_CLIENT_VERSION}`;
  const res = await f(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      originator: "codex_cli_rs",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
  });
  if (!res.ok) {
    throw new Error(`codex: ${res.status} ${res.statusText} fetching models`);
  }
  return parseCatalog(await res.json());
}

/** Outcome of a Codex model-discovery attempt, for the startup note. */
export type CodexPopulateResult =
  | { count: number }
  | { count: number; fallback: true }
  | { error: string };

/**
 * Fill the Codex preset with the catalog's models, in place. Best-effort: on a
 * fetch/parse failure we fall back to the current static set so the user can still
 * pick a working model. A no-op when there is no Codex preset.
 */
export async function populateCodexModels(
  config: Config,
  opts: {
    tokenGetter?: TokenGetter;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<CodexPopulateResult | undefined> {
  const target = Object.values(config.providers).find(isCodexProvider);
  if (!target) return undefined;
  try {
    const models = await fetchCodexModels(opts);
    if (models.length === 0) {
      target.models = CODEX_FALLBACK_MODELS;
      return { count: CODEX_FALLBACK_MODELS.length, fallback: true };
    }
    target.models = models;
    return { count: models.length };
  } catch (err) {
    target.models = CODEX_FALLBACK_MODELS;
    return { error: (err as Error).message };
  }
}

/**
 * Empty the Codex preset's models (used on logout / when not signed in) so it is
 * hidden from `/model` and is never the resolve fallback. A no-op when no preset.
 */
export function gateCodexModels(config: Config, signedIn: boolean): void {
  if (signedIn) return; // populateCodexModels fills the list when signed in
  for (const pc of Object.values(config.providers)) {
    if (isCodexProvider(pc)) pc.models = [];
  }
}

/** One-line note describing a discovery result (or nothing). */
export function describeCodex(
  result: CodexPopulateResult | undefined,
): string | undefined {
  if (!result) return undefined;
  if ("error" in result)
    return `note: Codex model discovery failed (${result.error}) — using a built-in fallback list`;
  if ("fallback" in result)
    return `note: Codex returned no models — using a built-in fallback list`;
  if (result.count === 0) return undefined;
  return `note: OpenAI Codex — ${result.count} model${result.count === 1 ? "" : "s"} available`;
}
