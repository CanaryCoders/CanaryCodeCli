// codex.ts — the "OpenAI Codex (ChatGPT subscription)" built-in extension:
// provider preset, model discovery, and the login/logout-codex commands.
//
// Mirrors the canary.ts preset pattern. This provider carries no API key or
// baseUrl: it authenticates with the ChatGPT-subscription OAuth tokens in
// ~/.cc/auth.json (see auth.ts) and talks the Responses-API path
// (chatgpt.com/backend-api/codex/responses) via the `openai-responses` provider
// impl in provider.ts (which also owns the wire-level model-handle parsing,
// `parseCodexModel`).
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

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  clearCredentials,
  hasCredentials,
  loginManual,
  loginWithBrowser,
  makeTokenGetter,
  openBrowser,
  type TokenGetter,
} from "../auth.ts";
import type { Config, ModelConfig, ProviderConfig } from "../config.ts";
import type { Extension, ExtensionCommandContext } from "../extension.ts";
import { extensionEnabled } from "../extension.ts";

/** The provider key used for the baked-in Codex preset. */
export const OPENAI_PROVIDER = "openai";

/** How long a cached Codex catalog is trusted before a background re-fetch. */
const CODEX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function codexCachePath(): string {
  return join(homedir(), ".cc", "codex-models.json");
}

interface CodexCache {
  /** Epoch ms of the last successful catalog fetch. */
  checkedAt: number;
  /** The models the catalog returned (bare slugs). */
  models: ModelConfig[];
}

async function readCodexCache(): Promise<CodexCache | null> {
  try {
    const parsed = JSON.parse(
      await readFile(codexCachePath(), "utf8"),
    ) as Partial<CodexCache>;
    if (typeof parsed.checkedAt === "number" && Array.isArray(parsed.models))
      return { checkedAt: parsed.checkedAt, models: parsed.models };
  } catch {
    // Missing or malformed cache is fine — treat as "never fetched".
  }
  return null;
}

async function writeCodexCache(cache: CodexCache): Promise<void> {
  try {
    await writeFile(codexCachePath(), JSON.stringify(cache), "utf8");
  } catch {
    // A failed cache write is non-fatal; we just re-fetch sooner next time.
  }
}

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
 * Apply the *cached* Codex catalog to the preset, synchronously-fast (a single
 * file read, no network). Used at startup so the TUI paints immediately instead of
 * waiting ~1.5s on the live catalog fetch; `refreshCodexModels` then updates the
 * cache (and this session) in the background. With no cache yet (first run) we seed
 * the static fallback so the preset is usable until the refresh lands. A no-op when
 * there is no Codex preset.
 */
export async function cachedCodexModels(
  config: Config,
): Promise<CodexPopulateResult | undefined> {
  const target = Object.values(config.providers).find(isCodexProvider);
  if (!target) return undefined;
  const cache = await readCodexCache();
  if (cache && cache.models.length > 0) {
    target.models = cache.models;
    return { count: cache.models.length };
  }
  target.models = CODEX_FALLBACK_MODELS;
  return { count: CODEX_FALLBACK_MODELS.length };
}

/**
 * Background refresh of the Codex catalog: re-fetch when the cache is stale (or
 * absent), update the preset in place and persist the cache for next launch.
 * Best-effort — a fetch failure leaves the cached/fallback set untouched. Returns
 * the live count when it actually re-fetched (so the caller can surface a note), or
 * undefined when it skipped (fresh cache) or failed.
 */
export async function refreshCodexModels(
  config: Config,
  opts: {
    tokenGetter?: TokenGetter;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<number | undefined> {
  const target = Object.values(config.providers).find(isCodexProvider);
  if (!target) return undefined;
  const cache = await readCodexCache();
  if (cache && Date.now() - cache.checkedAt < CODEX_CACHE_TTL_MS)
    return undefined;
  try {
    const models = await fetchCodexModels(opts);
    if (models.length === 0) return undefined;
    target.models = models;
    await writeCodexCache({ checkedAt: Date.now(), models });
    return models.length;
  } catch {
    return undefined; // keep the cached/fallback set
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

// ── built-in extension ───────────────────────────────────────────────────────

/** Sign in (browser OAuth, or --manual paste flow when a readLine is available),
 * then discover the account's models so `/model` can offer them immediately. */
async function runLoginCodex(
  ctx: ExtensionCommandContext,
  args: string[],
): Promise<void> {
  // A disabled extension stays disabled — login must not resurrect it.
  if (!extensionEnabled(ctx.config, "codex")) {
    ctx.note(
      "the codex extension is disabled — enable it first with /extensions enable codex",
    );
    return;
  }
  const manual = args.includes("--manual");
  if (manual && !ctx.readLine) {
    throw new Error("--manual sign-in needs a terminal (use `cc login-codex`)");
  }
  const { account_id } =
    manual && ctx.readLine
      ? await loginManual({
          onUrl: (url) =>
            ctx.note(
              `Open this URL in a browser, sign in, then paste the URL you are redirected to:\n\n${url}\n`,
            ),
          readLine: ctx.readLine,
        })
      : await loginWithBrowser({
          open: openBrowser,
          onUrl: (url) =>
            ctx.note(`if your browser didn't open, visit:\n${url}`),
        });
  const result = await populateCodexModels(ctx.config);
  const note = describeCodex(result);
  if (note) ctx.note(note);
  const ids = (ctx.config.providers[OPENAI_PROVIDER]?.models ?? []).map(
    (m) => m.id,
  );
  ctx.note(
    `signed in to ChatGPT${account_id ? ` (account ${account_id})` : ""}${
      ids.length ? ` — switch with e.g. /model ${ids[0]}` : ""
    }`,
  );
}

export const codexExtension: Extension = {
  name: "codex",
  description: "OpenAI Codex models via your ChatGPT subscription",
  providerPresets: () => ({ [OPENAI_PROVIDER]: openaiCodexProviderConfig() }),
  async startup(config, mode) {
    if (!extensionEnabled(config, "codex") || !(await hasCredentials())) {
      gateCodexModels(config, false);
      return undefined;
    }
    if (mode === "live")
      return describeCodex(await populateCodexModels(config));
    const note = describeCodex(await cachedCodexModels(config));
    void refreshCodexModels(config);
    return note;
  },
  commands: [
    {
      name: "login-codex",
      usage: "[--manual]",
      description: "sign in with your ChatGPT (OpenAI Codex) subscription",
      run: runLoginCodex,
    },
    {
      name: "logout-codex",
      description: "sign out of your ChatGPT (OpenAI Codex) subscription",
      async run(ctx) {
        await clearCredentials();
        gateCodexModels(ctx.config, false);
        ctx.note(
          "signed out of ChatGPT (removed ~/.cc/auth.json) — Codex models hidden",
        );
      },
    },
  ],
};
