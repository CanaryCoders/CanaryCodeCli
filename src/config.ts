// config.ts — load and merge ~/.cc/config.json with defaults + env interpolation.
//
// Resolution: built-in defaults  <  ~/.cc/config.json  <  (CLI overrides applied by callers).
// Any string value of the form "${VAR}" is replaced with process.env.VAR (empty if unset).

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CANARY_PROVIDER, canaryProviderConfig } from "./canary.ts";

export type ProviderApi = "anthropic" | "openai-compat";

/**
 * Confirm-before-running gate (a TUI-only concern). "off" runs every tool;
 * "bash" prompts before each `bash`; "writes" prompts before `bash`/`write_file`/
 * `edit_file`. Auto mode and `--yolo` bypass it; headless ignores it entirely.
 */
export type ConfirmMode = "off" | "bash" | "writes";

export interface ModelConfig {
  id: string;
  /** Optional display name / alias. */
  name?: string;
}

export interface ProviderConfig {
  api: ProviderApi;
  apiKey?: string;
  baseUrl?: string;
  models?: ModelConfig[];
}

export interface WebSearchConfig {
  /** Backend identifier, e.g. "brave" | "tavily". */
  provider?: string;
  apiKey?: string;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** SSE transport URL (alternative to command). */
  url?: string;
}

export interface Config {
  /** Active model id. Resolved against providers' model lists. */
  model: string;
  providers: Record<string, ProviderConfig>;
  webSearch: WebSearchConfig;
  mcpServers: Record<string, McpServerConfig>;

  /** Auto mode max loop turns before bailing. */
  autoMaxTurns: number;
  /** Sub-agent concurrency cap. */
  maxConcurrent: number;
  /** Sub-agent nesting depth cap. */
  maxDepth: number;
  /** Compact context once estimated tokens exceed this. */
  compactAtTokens: number;
  /** TUI confirm-before-running gate: off | bash | writes (headless ignores). */
  confirm: ConfirmMode;
}

/** Path to the config file (~/.cc/config.json). */
function configPath(): string {
  return join(homedir(), ".cc", "config.json");
}

/** Built-in defaults — a usable config with zero user setup (needs ANTHROPIC_API_KEY in env). */
function defaultConfig(): Config {
  return {
    model: "opus",
    providers: {
      anthropic: {
        api: "anthropic",
        apiKey: "${ANTHROPIC_API_KEY}",
        models: [
          { id: "opus", name: "claude-opus-4-8" },
          { id: "sonnet", name: "claude-sonnet-4-6" },
          { id: "haiku", name: "claude-haiku-4-5-20251001" },
        ],
      },
      // CanaryLLM gateway, first-class. Inert until CANARYLLM_API_KEY is set;
      // models discovered from /api/public/models on startup (see canary.ts).
      [CANARY_PROVIDER]: canaryProviderConfig(),
    },
    webSearch: {},
    mcpServers: {},
    autoMaxTurns: 25,
    maxConcurrent: 3,
    maxDepth: 2,
    compactAtTokens: 120_000,
    confirm: "off",
  };
}

/** Recursively replace "${VAR}" string values with the matching env var. */
function interpolateEnv<T>(
  value: T,
  env: Record<string, string | undefined> = process.env,
): T {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([A-Z0-9_]+)\}/gi,
      (_m, name: string) => env[name] ?? "",
    ) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnv(v, env)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v, env);
    return out as T;
  }
  return value;
}

/** Shallow-with-known-keys merge of a partial user config onto defaults. */
function mergeConfig(base: Config, user: Partial<Config>): Config {
  return {
    model: user.model ?? base.model,
    providers: { ...base.providers, ...(user.providers ?? {}) },
    webSearch: { ...base.webSearch, ...(user.webSearch ?? {}) },
    mcpServers: { ...base.mcpServers, ...(user.mcpServers ?? {}) },
    autoMaxTurns: user.autoMaxTurns ?? base.autoMaxTurns,
    maxConcurrent: user.maxConcurrent ?? base.maxConcurrent,
    maxDepth: user.maxDepth ?? base.maxDepth,
    compactAtTokens: user.compactAtTokens ?? base.compactAtTokens,
    confirm: user.confirm ?? base.confirm,
  };
}

/**
 * Load config: defaults merged with ~/.cc/config.json (if present), then env-interpolated.
 * A missing file is fine. A malformed file throws with a clear message.
 */
export async function loadConfig(path: string = configPath()): Promise<Config> {
  const file = Bun.file(path);
  let user: Partial<Config> = {};
  if (await file.exists()) {
    let raw: string;
    try {
      raw = await file.text();
    } catch (err) {
      throw new Error(
        `cc: cannot read config at ${path}: ${(err as Error).message}`,
      );
    }
    try {
      user = JSON.parse(raw) as Partial<Config>;
    } catch (err) {
      throw new Error(`cc: invalid JSON in ${path}: ${(err as Error).message}`);
    }
  }
  return interpolateEnv(mergeConfig(defaultConfig(), user));
}

/**
 * The subset of config a user can change at runtime (via `/model`, `/think`'s
 * sibling settings, etc.) and that we persist back to `~/.cc/config.json` so it
 * becomes the default next launch.
 */
export type PersistableSettings = Partial<
  Pick<Config, "model" | "confirm">
>;

/**
 * Persist runtime preference changes back to `~/.cc/config.json`, merging onto
 * whatever the user already has on disk. Only the keys in `settings` are touched —
 * every other key (providers, secrets, MCP servers) is read back from the raw file
 * and written through verbatim, so we never serialize an env-interpolated secret
 * (e.g. an expanded `${ANTHROPIC_API_KEY}`) into the file. A missing file is created.
 */
export async function saveConfig(
  settings: PersistableSettings,
  path: string = configPath(),
): Promise<void> {
  // Read the raw on-disk file (NOT the interpolated in-memory Config) so we
  // preserve `${VAR}` placeholders and any hand-edited keys exactly.
  let raw: Record<string, unknown> = {};
  const file = Bun.file(path);
  if (await file.exists()) {
    try {
      raw = JSON.parse(await file.text()) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `cc: cannot update config at ${path}: invalid JSON (${(err as Error).message})`,
      );
    }
  }
  for (const [k, v] of Object.entries(settings)) {
    if (v !== undefined) raw[k] = v;
  }
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(raw, null, 2)}\n`);
}

/** Resolve a model id to its provider + concrete model. `--model`/config id are accepted. */
export function resolveModel(
  config: Config,
  modelId?: string,
):
  | { provider: string; providerConfig: ProviderConfig; model: ModelConfig }
  | undefined {
  const wanted = modelId ?? config.model;
  for (const [provider, providerConfig] of Object.entries(config.providers)) {
    for (const model of providerConfig.models ?? []) {
      if (model.id === wanted || model.name === wanted) {
        return { provider, providerConfig, model };
      }
    }
  }
  // Fall back to the first model of the first provider when nothing matched.
  for (const [provider, providerConfig] of Object.entries(config.providers)) {
    const model = providerConfig.models?.[0];
    if (model) return { provider, providerConfig, model };
  }
  return undefined;
}
