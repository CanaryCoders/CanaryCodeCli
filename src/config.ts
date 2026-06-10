// config.ts — load and merge ~/.cc/config.json with defaults + env interpolation.
//
// Resolution: built-in defaults  <  ~/.cc/config.json  <  (CLI overrides applied by callers).
// Any string value of the form "${VAR}" is replaced with process.env.VAR (empty if unset).

import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CANARY_PROVIDER, canaryProviderConfig } from "./canary.ts";
import { OPENAI_PROVIDER, openaiCodexProviderConfig } from "./openai-codex.ts";
import type { ThinkingLevel } from "./thinking.ts";

export type ProviderApi = "anthropic" | "openai-compat" | "openai-responses";

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
  /**
   * Whether this model can see images. Omitted → assumed true, since the
   * built-in models (Claude 4.x, GPT-5) are all multimodal. Set `false` on a
   * text-only gateway model so attached images are dropped with a warning
   * instead of triggering an opaque API error.
   */
  supportsVision?: boolean;
}

/** Whether image content may be sent to this model (see ModelConfig.supportsVision). */
export function modelSupportsVision(model: ModelConfig): boolean {
  return model.supportsVision ?? true;
}

export interface ProviderConfig {
  api: ProviderApi;
  apiKey?: string;
  baseUrl?: string;
  models?: ModelConfig[];
}

/** A model "role" — a slot in the optional `models` map that overrides the base model. */
export type ModelRole = "reasoning" | "coding" | "subagent" | "permission";

export interface WebSearchConfig {
  /**
   * Backend identifier: "duckduckgo" (free, no API key — the default),
   * "brave", or "tavily".
   */
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

/**
 * AI permission-approval engine. When `mode` is "ai", a separate (usually cheap)
 * model classifies each gated mutating tool call as safe/unsafe before it runs:
 * "safe" runs silently, "unsafe" escalates to the human y/n/a box (TUI) or blocks
 * the call (headless, where there is no human). Auto mode / `--yolo` bypass it.
 * "off" (default) falls back to the deterministic `confirm` gate instead.
 */
export interface PermissionConfig {
  mode: "off" | "ai";
  /** Checker model id (resolved against providers). Defaults to a cheap model. */
  model?: string;
  /** Which tools to check: "bash" or "writes" (bash + write_file + edit_file). */
  scope?: "bash" | "writes";
}

/** A shell hook command. Claude-compatible entries use timeout seconds. */
export interface HookCommandConfig {
  /** Claude Code uses command hooks; other hook types are ignored with diagnostics. */
  type?: "command" | string;
  /** Shell command run via `bash -c`, receiving a JSON payload on stdin. */
  command: string;
  /** Timeout in seconds for Claude-style entries; milliseconds for legacy flat entries. */
  timeout?: number;
}

/** Legacy flat hook entry retained for backwards compatibility. */
export interface LegacyHookConfig extends HookCommandConfig {
  /** Regex matched against the tool name (omitted = all tools). */
  matcher?: string;
}

/** Claude Code-compatible matcher group. */
export interface HookMatcherConfig {
  /** Regex matched against the tool name for tool events (omitted = all tools). */
  matcher?: string;
  hooks: HookCommandConfig[];
}

/** One configured hook entry: Claude Code matcher group or cc's old flat form. */
export type HookConfig = LegacyHookConfig | HookMatcherConfig;

/**
 * Lifecycle hooks. `PreToolUse` hooks can BLOCK a call; `PostToolUse` and the
 * session/stop events are observational. Hooks run in every mode, including auto.
 */
export interface HooksConfig {
  PreToolUse?: HookConfig[];
  PostToolUse?: HookConfig[];
  UserPromptSubmit?: HookConfig[];
  SessionStart?: HookConfig[];
  Stop?: HookConfig[];
  SubagentStop?: HookConfig[];
  SessionEnd?: HookConfig[];
  Notification?: HookConfig[];
  PreCompact?: HookConfig[];
}

export interface UiConfig {
  /** Use nerd-font glyphs in the TUI. Defaults false for ASCII-safe output. */
  nerdFont: boolean;
}

export interface Config {
  /** Active model id. Resolved against providers' model lists. */
  model: string;
  /** Optional per-role model overrides. Unset roles fall back to `model`
   * (or, for `permission`, to `permission.model` then a cheap default). */
  models?: Partial<Record<ModelRole, string>>;
  providers: Record<string, ProviderConfig>;
  webSearch: WebSearchConfig;
  mcpServers: Record<string, McpServerConfig>;
  /** TUI display preferences. */
  ui: UiConfig;

  /** Auto mode max loop turns before bailing. */
  autoMaxTurns: number;
  /**
   * Interactive (normal/plan) turns between runaway checkpoints. The loop runs
   * unbounded; every `checkpointEvery` turns it pauses and asks whether to keep
   * going. 0 disables checkpoints (falls back to a hard cap). Auto mode ignores
   * this and uses `autoMaxTurns` as a hard cap (no human to ask).
   */
  checkpointEvery: number;
  /** Sub-agent concurrency cap. */
  maxConcurrent: number;
  /** Sub-agent nesting depth cap. */
  maxDepth: number;
  /** Compact context once estimated tokens exceed this. */
  compactAtTokens: number;
  /** TUI confirm-before-running gate: off | bash | writes (headless ignores). */
  confirm: ConfirmMode;
  /** AI permission-approval engine (overrides `confirm` when mode is "ai"). */
  permission: PermissionConfig;
  /** Lifecycle hooks (PreToolUse / PostToolUse / Stop). */
  hooks: HooksConfig;
  /** Default extended-thinking level; persisted across runs (off | think | think-hard | ultrathink). */
  thinking: ThinkingLevel;
  /** Self-update behavior (only ever active for compiled release binaries). */
  autoUpdate: AutoUpdateConfig;
}

/**
 * Self-update settings. The background check and `cc update` / `/update` apply
 * step are gated on this being enabled AND the running process being a compiled
 * release binary in a writable location. Nix installs set `CC_DISABLE_UPDATE=1`,
 * which overrides this entirely.
 */
export interface AutoUpdateConfig {
  /** Enable the once-a-day background "newer version available" check. */
  enabled: boolean;
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
      // OpenAI Codex (ChatGPT subscription) preset. Inert until the user signs in
      // with `cc login-codex`; its models are gated on ~/.cc/auth.json at startup
      // (see openai-codex.ts / gateCodexModels).
      [OPENAI_PROVIDER]: openaiCodexProviderConfig(),
    },
    webSearch: {},
    mcpServers: {},
    ui: { nerdFont: false },
    autoMaxTurns: 25,
    checkpointEvery: 50,
    maxConcurrent: 3,
    maxDepth: 2,
    compactAtTokens: 120_000,
    confirm: "off",
    permission: { mode: "off", model: "haiku", scope: "writes" },
    hooks: {},
    thinking: "off",
    autoUpdate: { enabled: true },
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
    models: user.models ?? base.models,
    providers: { ...base.providers, ...(user.providers ?? {}) },
    webSearch: { ...base.webSearch, ...(user.webSearch ?? {}) },
    mcpServers: { ...base.mcpServers, ...(user.mcpServers ?? {}) },
    ui: { ...base.ui, ...(user.ui ?? {}) },
    autoMaxTurns: user.autoMaxTurns ?? base.autoMaxTurns,
    checkpointEvery: user.checkpointEvery ?? base.checkpointEvery,
    maxConcurrent: user.maxConcurrent ?? base.maxConcurrent,
    maxDepth: user.maxDepth ?? base.maxDepth,
    compactAtTokens: user.compactAtTokens ?? base.compactAtTokens,
    confirm: user.confirm ?? base.confirm,
    permission: { ...base.permission, ...(user.permission ?? {}) },
    hooks: { ...base.hooks, ...(user.hooks ?? {}) },
    thinking: user.thinking ?? base.thinking,
    autoUpdate: { ...base.autoUpdate, ...(user.autoUpdate ?? {}) },
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
  Pick<Config, "model" | "confirm" | "thinking">
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
  // Config may hold inline API keys — owner-only, like auth.json.
  await chmod(path, 0o600);
}

export const CONFIG_PATHS = [
  "model",
  "models.reasoning",
  "models.coding",
  "models.subagent",
  "models.permission",
  "providers.<name>",
  "providers.<name>.api",
  "providers.<name>.apiKey",
  "providers.<name>.baseUrl",
  "providers.<name>.models",
  "webSearch.provider",
  "webSearch.apiKey",
  "mcpServers.<name>",
  "ui.nerdFont",
  "autoMaxTurns",
  "checkpointEvery",
  "maxConcurrent",
  "maxDepth",
  "compactAtTokens",
  "confirm",
  "permission.mode",
  "permission.model",
  "permission.scope",
  "hooks.<event>",
  "thinking",
  "autoUpdate.enabled",
] as const;

const ROOT_CONFIG_KEYS = new Set([
  "model",
  "models",
  "providers",
  "webSearch",
  "mcpServers",
  "ui",
  "autoMaxTurns",
  "checkpointEvery",
  "maxConcurrent",
  "maxDepth",
  "compactAtTokens",
  "confirm",
  "permission",
  "hooks",
  "thinking",
  "autoUpdate",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function splitConfigPath(path: string): string[] {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("cc: config path cannot be empty");
  if (!ROOT_CONFIG_KEYS.has(parts[0])) {
    throw new Error(`cc: unknown config path '${path}'`);
  }
  return parts;
}

async function readRawConfig(path: string): Promise<Record<string, unknown>> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  try {
    const parsed = JSON.parse(await file.text()) as unknown;
    if (!isRecord(parsed)) throw new Error("root must be a JSON object");
    return parsed;
  } catch (err) {
    throw new Error(
      `cc: cannot update config at ${path}: invalid JSON (${(err as Error).message})`,
    );
  }
}

async function writeRawConfig(
  raw: Record<string, unknown>,
  path: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(raw, null, 2)}\n`);
  // Config may hold inline API keys — owner-only, like auth.json.
  await chmod(path, 0o600);
}

export function getRawConfigValue(
  raw: Record<string, unknown>,
  path: string,
): unknown {
  const parts = splitConfigPath(path);
  let cur: unknown = raw;
  for (const part of parts) {
    if (!isRecord(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setRawConfigValue(
  raw: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = splitConfigPath(path);
  let cur = raw;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(cur[part])) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetRawConfigValue(raw: Record<string, unknown>, path: string): void {
  const parts = splitConfigPath(path);
  let cur: unknown = raw;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(cur)) return;
    cur = cur[part];
  }
  if (isRecord(cur)) delete cur[parts[parts.length - 1]];
}

export function validateConfigPathValue(path: string, value: unknown): void {
  const parts = splitConfigPath(path);
  const fail = (msg: string) => {
    throw new Error(`cc: invalid value for ${path}: ${msg}`);
  };
  const stringPaths = new Set([
    "model",
    "permission.model",
    "webSearch.apiKey",
    "webSearch.provider",
  ]);
  if (parts[0] === "webSearch" && !stringPaths.has(path)) return;
  if (stringPaths.has(path) || parts[0] === "models") {
    if (typeof value !== "string") fail("expected string");
    return;
  }
  if (path === "confirm") {
    if (!["off", "bash", "writes"].includes(value as string))
      fail("expected off, bash, or writes");
    return;
  }
  if (path === "thinking") {
    if (!["off", "think", "think-hard", "ultrathink"].includes(value as string))
      fail("expected off, think, think-hard, or ultrathink");
    return;
  }
  if (path === "permission.mode") {
    if (!["off", "ai"].includes(value as string)) fail("expected off or ai");
    return;
  }
  if (path === "permission.scope") {
    if (!["bash", "writes"].includes(value as string))
      fail("expected bash or writes");
    return;
  }
  if (parts[0] === "providers") {
    if (parts.length === 2) {
      if (!isRecord(value)) fail("expected object");
      const providerValue = value as Record<string, unknown>;
      if ("api" in providerValue)
        validateConfigPathValue(`${path}.api`, providerValue.api);
    } else if (parts[2] === "api") {
      if (
        !["anthropic", "openai-compat", "openai-responses"].includes(
          value as string,
        )
      ) {
        fail("expected anthropic, openai-compat, or openai-responses");
      }
    }
    return;
  }
  if (parts[0] === "mcpServers" || parts[0] === "hooks") {
    if (parts.length === 1 || parts.length === 2) {
      if (!isRecord(value) && !Array.isArray(value))
        fail("expected object or array");
    }
    return;
  }
  if (parts[0] === "permission") return;
  if (path === "ui.nerdFont" || path === "autoUpdate.enabled") {
    if (typeof value !== "boolean") fail("expected boolean");
    return;
  }
  if (parts[0] === "ui" || parts[0] === "autoUpdate") return;
  const nonNegative = new Set(["checkpointEvery"]);
  const positive = new Set([
    "autoMaxTurns",
    "maxConcurrent",
    "maxDepth",
    "compactAtTokens",
  ]);
  if (nonNegative.has(path) || positive.has(path)) {
    if (typeof value !== "number" || !Number.isFinite(value))
      fail("expected finite number");
    const numberValue = value as number;
    if (nonNegative.has(path) && numberValue < 0)
      fail("expected nonnegative number");
    if (positive.has(path) && numberValue <= 0)
      fail("expected positive number");
  }
}

export async function getRawConfigPath(
  path: string,
  configFile: string = configPath(),
): Promise<unknown> {
  return getRawConfigValue(await readRawConfig(configFile), path);
}

export function parseConfigValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

export async function setRawConfigPath(
  path: string,
  value: unknown,
  configFile: string = configPath(),
): Promise<void> {
  validateConfigPathValue(path, value);
  const raw = await readRawConfig(configFile);
  setRawConfigValue(raw, path, value);
  await writeRawConfig(raw, configFile);
}

export async function unsetRawConfigPath(
  path: string,
  configFile: string = configPath(),
): Promise<void> {
  splitConfigPath(path);
  const raw = await readRawConfig(configFile);
  unsetRawConfigValue(raw, path);
  await writeRawConfig(raw, configFile);
}

export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactConfig(v));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (/(apiKey|key|token|secret|password)/i.test(k)) out[k] = "<redacted>";
    else out[k] = redactConfig(v);
  }
  return out;
}

export function summarizeConfig(value: unknown): string {
  return JSON.stringify(redactConfig(value), null, 2);
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

/**
 * Resolve a role to a model id. `reasoning` and `coding` fall back to the base
 * `model`. `permission` falls back to the legacy `permission.model`, then to a
 * cheap default ("haiku"), since the checker runs on every gated call. The
 * `subagent` role is intentionally resolved by subagents.ts directly (its
 * fallback is the parent's model, not the base model), so it is not handled here.
 */
export function modelForRole(config: Config, role: ModelRole): string {
  const explicit = config.models?.[role];
  if (explicit) return explicit;
  if (role === "permission") return config.permission?.model ?? "haiku";
  return config.model;
}
