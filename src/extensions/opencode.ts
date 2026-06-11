// opencode.ts — the "OpenCode Zen" built-in extension: use opencode's model
// gateway (https://opencode.ai/docs/zen) inside cc, authenticated with the
// credentials opencode already holds.
//
// Zen is an OpenAI-compatible gateway at https://opencode.ai/zen/v1, so the
// existing `openai-compat` provider impl speaks to it as-is; this extension only
// supplies the preset, the key, and the model catalog. The key is resolved from
// OPENCODE_API_KEY, falling back to the entry `opencode auth login` stores in
// opencode's own credential file (~/.local/share/opencode/auth.json) — we read
// that store, we never write it, and the key only ever lives on the in-memory
// provider config (config.json is untouched). opencode's OAuth entries for
// OTHER vendors (anthropic/openai subscription tokens) are deliberately NOT
// reused: their refresh tokens rotate, so a second client refreshing them would
// break opencode's own sign-in.
//
// The model catalog comes from opencode's local models.dev cache
// (~/.cache/opencode/models.json) when present — fresh and offline-friendly —
// with a small static fallback. Until a key is found the preset is inert (empty
// model list), so `/model` never offers a model that would just fail.

import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, ModelConfig, ProviderConfig } from "../config.ts";
import type { Extension, ExtensionCommandContext } from "../extension.ts";
import { extensionEnabled } from "../extension.ts";

/** The provider key used for the baked-in OpenCode Zen preset. */
export const OPENCODE_PROVIDER = "opencode";

/** Zen's OpenAI-compatible API root (models.dev provider entry `opencode`). */
export const ZEN_BASE_URL = "https://opencode.ai/zen/v1";

/** Where `opencode auth login` stores credentials. */
function opencodeAuthPath(env = process.env): string {
  const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "auth.json");
}

/** Where opencode caches the models.dev catalog. */
function opencodeModelsPath(env = process.env): string {
  const cacheHome = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheHome, "opencode", "models.json");
}

/** The baked-in Zen preset (key resolved at startup, never from config.json). */
export function opencodeZenProviderConfig(): ProviderConfig {
  return { api: "openai-compat", baseUrl: ZEN_BASE_URL, models: [] };
}

// ── credential discovery ─────────────────────────────────────────────────────

/** One entry in opencode's auth.json (the union opencode's SDK defines). */
interface OpencodeAuthEntry {
  type?: "oauth" | "api" | "wellknown";
  key?: string;
  token?: string;
}

/**
 * Resolve a Zen API key: OPENCODE_API_KEY wins, else the `opencode` entry in
 * opencode's auth.json (`type:"api"` → key; `type:"wellknown"` → token).
 * Returns undefined when neither exists — the extension stays inert.
 */
export async function discoverZenKey(
  env: Record<string, string | undefined> = process.env,
  authPath: string = opencodeAuthPath(),
): Promise<string | undefined> {
  if (env.OPENCODE_API_KEY) return env.OPENCODE_API_KEY;
  try {
    const store = (await Bun.file(authPath).json()) as Record<
      string,
      OpencodeAuthEntry
    >;
    const entry = store[OPENCODE_PROVIDER];
    if (!entry) return undefined;
    if (entry.type === "api") return entry.key;
    if (entry.type === "wellknown") return entry.token ?? entry.key;
  } catch {
    // No opencode install / no auth file — simply not signed in.
  }
  return undefined;
}

// ── model catalog ────────────────────────────────────────────────────────────

/**
 * Static fallback when opencode's models.dev cache is unavailable. A small
 * curated coding set; the cache supersedes it whenever present.
 */
const ZEN_FALLBACK_MODELS: ModelConfig[] = [
  { id: "claude-opus-4-8" },
  { id: "claude-sonnet-4-6" },
  { id: "claude-haiku-4-5" },
  { id: "gpt-5.5" },
  { id: "gpt-5.4" },
  { id: "gpt-5.3-codex", supportsVision: false },
  { id: "big-pickle", supportsVision: false },
  { id: "kimi-k2.5", supportsVision: false },
  { id: "qwen3-coder", supportsVision: false },
  { id: "grok-code", supportsVision: false },
];

/** The slice of a models.dev model entry we read. */
interface ModelsDevModel {
  modalities?: { input?: string[] };
}

/**
 * Zen's model list from opencode's local models.dev cache, or the static
 * fallback. Vision support is carried over so attached images are dropped with
 * a warning on text-only models instead of erroring at the API.
 */
export async function zenModels(
  cachePath: string = opencodeModelsPath(),
): Promise<ModelConfig[]> {
  try {
    const registry = (await Bun.file(cachePath).json()) as Record<
      string,
      { models?: Record<string, ModelsDevModel> }
    >;
    const models = registry[OPENCODE_PROVIDER]?.models ?? {};
    const out = Object.entries(models).map(([id, m]) => ({
      id,
      supportsVision: (m.modalities?.input ?? []).includes("image"),
    }));
    if (out.length > 0) return out;
  } catch {
    // No opencode cache — use the fallback set.
  }
  return ZEN_FALLBACK_MODELS;
}

// ── populate / gate / describe ───────────────────────────────────────────────

/** Outcome of a Zen discovery attempt, for the startup note. */
export type ZenPopulateResult = { count: number } | undefined;

/**
 * Activate the Zen preset in place when a key is found: set the key on the
 * in-memory provider config and fill the model list. Returns undefined (and
 * gates the preset) when signed out. A no-op when there is no Zen preset.
 */
export async function populateZenModels(
  config: Config,
  opts: {
    env?: Record<string, string | undefined>;
    authPath?: string;
    cachePath?: string;
  } = {},
): Promise<ZenPopulateResult> {
  const target = config.providers[OPENCODE_PROVIDER];
  if (!target || target.baseUrl !== ZEN_BASE_URL) return undefined;
  const key = await discoverZenKey(opts.env, opts.authPath);
  if (!key) {
    gateZenModels(config);
    return undefined;
  }
  target.apiKey = key;
  target.models = await zenModels(opts.cachePath);
  return { count: target.models.length };
}

/** Empty the Zen preset (signed out / disabled) so `/model` never offers it. */
export function gateZenModels(config: Config): void {
  const target = config.providers[OPENCODE_PROVIDER];
  if (!target || target.baseUrl !== ZEN_BASE_URL) return;
  target.models = [];
  target.apiKey = undefined;
}

/** One-line note describing a discovery result (or nothing). */
export function describeZen(result: ZenPopulateResult): string | undefined {
  if (!result || result.count === 0) return undefined;
  return `note: OpenCode Zen — ${result.count} model${result.count === 1 ? "" : "s"} available`;
}

// ── built-in extension ───────────────────────────────────────────────────────

/** Re-scan for opencode credentials and activate the Zen models, or explain
 * how to sign in. The actual OAuth happens in opencode's own console flow —
 * we piggyback its credential store rather than reimplement it. */
async function runLoginOpencode(ctx: ExtensionCommandContext): Promise<void> {
  // A disabled extension stays disabled — login must not resurrect it.
  if (!extensionEnabled(ctx.config, "opencode")) {
    ctx.note(
      "the opencode extension is disabled — enable it first with /extensions enable opencode",
    );
    return;
  }
  const result = await populateZenModels(ctx.config);
  if (result) {
    const ids = (ctx.config.providers[OPENCODE_PROVIDER]?.models ?? []).map(
      (m) => m.id,
    );
    ctx.note(
      `signed in to OpenCode Zen — ${result.count} models available${
        ids.length ? `; switch with e.g. /model ${ids[0]}` : ""
      }`,
    );
    return;
  }
  ctx.note(
    [
      "no OpenCode Zen credentials found. To sign in:",
      "  1. run `opencode auth login` in another terminal and pick “opencode”",
      "     (or set OPENCODE_API_KEY in your environment),",
      "  2. then run /login-opencode again to pick the key up.",
    ].join("\n"),
  );
}

export const opencodeBuiltin: Extension = {
  name: "opencode",
  description: "OpenCode Zen models via opencode's credentials",
  providerPresets: () => ({
    [OPENCODE_PROVIDER]: opencodeZenProviderConfig(),
  }),
  async startup(config) {
    if (!extensionEnabled(config, "opencode")) {
      gateZenModels(config);
      return undefined;
    }
    // Both modes are "fast": discovery is two local file reads, no network.
    return describeZen(await populateZenModels(config));
  },
  commands: [
    {
      name: "login-opencode",
      description: "use OpenCode Zen models via opencode's sign-in",
      run: runLoginOpencode,
    },
    {
      name: "logout-opencode",
      description: "stop using OpenCode Zen models this session",
      async run(ctx) {
        gateZenModels(ctx.config);
        ctx.note(
          "OpenCode Zen models hidden for this session. The credentials live in " +
            "opencode — run `opencode auth logout` (or unset OPENCODE_API_KEY) to " +
            "remove them, or `/extensions disable opencode` to keep them off.",
        );
      },
    },
  ],
};
