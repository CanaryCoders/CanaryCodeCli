// commands.ts — slash-command parsing and dispatch.
//
// Slash commands are how the interactive TUI (Phase 4) drives the session at
// runtime: switch model/mode, set thinking, clear or resume, show cost, etc.
// This module is deliberately pure — it parses an input line into a structured
// `CommandAction` that the host executes against its own state. Keeping the
// side effects out of here means it is fully testable now, before the TUI
// exists, and both the TUI and a future REPL can share one dispatcher.
//
// A line that does not start with "/" is not a command — it is a normal prompt,
// returned as a `message` action so the host has a single thing to switch on.

import type { AgentMode } from "./agent.ts";
import { CONFIG_PATHS } from "./config.ts";
import { builtinCommands, toggleableExtensions } from "./extensions/builtin.ts";
import { fuzzyRank, fuzzyScore } from "./fuzzy.ts";
import { parseLevel, type ThinkingLevel } from "./thinking.ts";

/** A command broken into its name (without the leading slash) and trailing argument. */
export interface ParsedCommand {
  name: string;
  /** Everything after the command word, trimmed. Empty string when absent. */
  arg: string;
}

/**
 * The structured outcome of an input line. The host (TUI/REPL) switches on
 * `kind` and applies the effect against its own session state — this module
 * never mutates anything itself.
 */
export type CommandAction =
  | { kind: "message"; text: string }
  | { kind: "help"; text: string }
  | { kind: "set-mode"; mode: AgentMode }
  | { kind: "set-think"; level: ThinkingLevel }
  | { kind: "set-model"; model: string }
  | { kind: "list-models" }
  | { kind: "clear" }
  | { kind: "resume"; id?: string }
  | { kind: "cost" }
  | { kind: "init" }
  /** A command contributed by a built-in extension (login-codex, login-opencode, …). */
  | { kind: "builtin-command"; name: string; args: string[] }
  | { kind: "extensions"; op: "list" | "enable" | "disable"; name?: string }
  | { kind: "update" }
  | {
      kind: "config";
      op: "summary" | "get" | "set" | "unset" | "reload";
      path?: string;
      value?: string;
    }
  | { kind: "exit" }
  | { kind: "error"; message: string };

/** Static description of a command, used for dispatch and for `/help`. */
export interface CommandSpec {
  /** Canonical name (without the slash). */
  name: string;
  /** Accepted aliases (without the slash). */
  aliases?: string[];
  /** Argument hint shown in help, e.g. "[id]". Empty when the command takes none. */
  usage?: string;
  /** One-line description for `/help`. */
  description: string;
}

/** The full command set. Order here is the order shown by `/help`. */
export const COMMANDS: CommandSpec[] = [
  {
    name: "model",
    usage: "[id]",
    description: "list models, or switch to <id>",
  },
  {
    name: "think",
    usage: "[level]",
    description: "set thinking: off | think | think-hard | ultrathink",
  },
  { name: "plan", description: "switch to read-only plan mode" },
  { name: "auto", description: "switch to autonomous auto mode" },
  { name: "normal", description: "return to normal mode" },
  { name: "clear", description: "clear the conversation and start fresh" },
  {
    name: "resume",
    usage: "[id]",
    description: "list saved sessions, or resume <id>",
  },
  { name: "cost", description: "show token usage and cost so far" },
  {
    name: "config",
    usage: "[get|set|unset|reload]",
    description: "show or edit config (get/set/unset <path>, reload [mcp])",
  },
  {
    name: "init",
    description: "generate a starter CC.md project-context file",
  },
  {
    name: "extensions",
    usage: "[enable|disable <name>]",
    description: "toggle extensions (bare: interactive checkbox picker)",
  },
  // Login-style commands contributed by built-in extensions (extensions/builtin.ts).
  ...builtinCommands().map((c) => ({
    name: c.name,
    usage: c.usage,
    description: c.description,
  })),
  { name: "update", description: "update cc to the latest release" },
  { name: "help", aliases: ["?"], description: "show this command list" },
  { name: "exit", aliases: ["quit", "q"], description: "exit cc" },
];

/** Lookup table from a name or alias to its spec. */
const BY_NAME = new Map<string, CommandSpec>();
for (const spec of COMMANDS) {
  BY_NAME.set(spec.name, spec);
  for (const alias of spec.aliases ?? []) BY_NAME.set(alias, spec);
}

/** Command words owned by built-in extensions (dispatched generically). */
const BUILTIN_COMMAND_NAMES = new Set(builtinCommands().map((c) => c.name));

/** Whether a raw input line is a slash command (vs. an ordinary prompt). */
function isCommand(input: string): boolean {
  const t = input.trim();
  // "/word" or "/word <args>" — the name is letters/word-chars with no slash, so a
  // path like "/usr/bin" (slash before whitespace) is treated as text, not a command.
  return /^\/[a-zA-Z?][\w?-]*(\s|$)/.test(t);
}

/** Split a command line into `{ name, arg }`. Returns null when not a command. */
function parseCommand(input: string): ParsedCommand | null {
  if (!isCommand(input)) return null;
  const t = input.trim().slice(1); // drop the leading "/"
  const space = t.search(/\s/);
  if (space === -1) return { name: t.toLowerCase(), arg: "" };
  return {
    name: t.slice(0, space).toLowerCase(),
    arg: t.slice(space + 1).trim(),
  };
}

/** Parse the `/extensions [enable|disable <name>]` argument. */
function parseExtensionsAction(arg: string): CommandAction {
  if (!arg) return { kind: "extensions", op: "list" };
  const match = arg.match(/^(\S+)(?:\s+(\S+))?\s*$/);
  const op = match?.[1]?.toLowerCase() ?? "";
  const name = match?.[2];
  if ((op === "enable" || op === "disable") && name) {
    return { kind: "extensions", op, name };
  }
  return {
    kind: "error",
    message: "usage: /extensions [enable|disable <name>]",
  };
}

/** Render the `/help` command list as aligned lines. */
function parseConfigAction(arg: string): CommandAction {
  if (!arg) return { kind: "config", op: "summary" };
  const match = arg.match(/^(\S+)(?:\s+(.*))?$/);
  const op = match?.[1]?.toLowerCase() ?? "";
  const rest = match?.[2]?.trim() ?? "";
  switch (op) {
    case "get":
      return rest
        ? { kind: "config", op: "get", path: rest }
        : { kind: "error", message: "usage: /config get <path>" };
    case "set": {
      const setMatch = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
      const path = setMatch?.[1];
      const value = setMatch?.[2];
      if (!path || value === undefined) {
        return { kind: "error", message: "usage: /config set <path> <value>" };
      }
      return { kind: "config", op: "set", path, value };
    }
    case "unset":
      return rest
        ? { kind: "config", op: "unset", path: rest }
        : { kind: "error", message: "usage: /config unset <path>" };
    case "reload":
      if (!rest) return { kind: "config", op: "reload" };
      if (rest === "mcp") return { kind: "config", op: "reload", path: "mcp" };
      return { kind: "error", message: "usage: /config reload [mcp]" };
    default:
      return {
        kind: "error",
        message: `unknown config operation: "${op}" (summary|get|set|unset|reload)`,
      };
  }
}

/** Render the `/help` command list as aligned lines. */
function helpText(): string {
  const left = COMMANDS.map((c) => `/${c.name}${c.usage ? ` ${c.usage}` : ""}`);
  const width = Math.max(...left.map((l) => l.length));
  const lines = COMMANDS.map(
    (c, i) => `  ${left[i].padEnd(width)}  ${c.description}`,
  );
  return ["Commands:", ...lines].join("\n");
}

/**
 * Parse and dispatch an input line into a `CommandAction`. Non-command lines
 * become a `message` action. Unknown commands and bad arguments become an
 * `error` action with a human-readable message — the host decides how to show it.
 */
export function dispatchCommand(input: string): CommandAction {
  const parsed = parseCommand(input);
  if (!parsed) return { kind: "message", text: input };

  const spec = BY_NAME.get(parsed.name);
  if (!spec) {
    return {
      kind: "error",
      message: `unknown command: /${parsed.name} (try /help)`,
    };
  }

  // Built-in extension commands dispatch generically — the host looks the
  // handler up in the registry, so new built-ins never grow this switch.
  if (BUILTIN_COMMAND_NAMES.has(spec.name)) {
    return {
      kind: "builtin-command",
      name: spec.name,
      args: parsed.arg ? parsed.arg.split(/\s+/) : [],
    };
  }

  switch (spec.name) {
    case "model":
      return parsed.arg
        ? { kind: "set-model", model: parsed.arg }
        : { kind: "list-models" };
    case "think": {
      // A bare `/think` means the default on-level; an unrecognized value errors.
      const level = parseLevel(parsed.arg || "think");
      if (level === undefined) {
        return {
          kind: "error",
          message: `unknown thinking level: "${parsed.arg}" (off|think|think-hard|ultrathink)`,
        };
      }
      return { kind: "set-think", level };
    }
    case "plan":
      return { kind: "set-mode", mode: "plan" };
    case "auto":
      return { kind: "set-mode", mode: "auto" };
    case "normal":
      return { kind: "set-mode", mode: "normal" };
    case "clear":
      return { kind: "clear" };
    case "resume":
      return parsed.arg
        ? { kind: "resume", id: parsed.arg }
        : { kind: "resume" };
    case "cost":
      return { kind: "cost" };
    case "config":
      return parseConfigAction(parsed.arg);
    case "init":
      return { kind: "init" };
    case "extensions":
      return parseExtensionsAction(parsed.arg);
    case "update":
      return { kind: "update" };
    case "help":
      return { kind: "help", text: helpText() };
    case "exit":
      return { kind: "exit" };
    default:
      // Unreachable while COMMANDS and this switch stay in sync.
      return { kind: "error", message: `unhandled command: /${spec.name}` };
  }
}

// ── slash autocomplete ─────────────────────────────────────────────────────────
//
// The TUI shows an fzf-style popover while the input starts with "/". This layer
// is pure and data-driven: given the raw input and a context of known parameter
// values, it returns ranked `Completion`s. The first token fuzzy-matches the
// command registry (name + aliases + description); once a command word and a
// space are present, we switch to that command's parameter source (model ids,
// thinking levels, recent sessions). Keeping it here — beside the registry it
// draws on — means both the matcher and the dispatcher share one source of truth.

/** A single autocomplete suggestion. */
export interface Completion {
  /** The full input line to replace the prompt with when accepted. A trailing
   *  space signals "now complete a parameter" (keeps the popover open). */
  value: string;
  /** Primary display text (the command form, or the parameter value). */
  label: string;
  /** Dim secondary hint (the command description, or a session title). */
  description?: string;
}

/** Known parameter values the host can supply for parameter completion. */
export interface CompletionContext {
  /** Configured model ids (for `/model` and model-valued `/config` paths). */
  models?: string[];
  /** Recent sessions, newest first (for `/resume`). */
  sessions?: { id: string; title: string | null }[];
  /** Optional config paths supplied by the host; defaults to built-in common paths. */
  configPaths?: string[];
}

/** The thinking levels `/think` accepts, in increasing order. */
const THINK_LEVELS: ThinkingLevel[] = [
  "off",
  "think",
  "think-hard",
  "ultrathink",
];

const CONFIG_SUBCOMMANDS = ["get", "set", "unset", "reload"] as const;

const CONFIG_ENUM_VALUES: Record<string, string[]> = {
  confirm: ["off", "bash", "writes"],
  thinking: [...THINK_LEVELS],
  "permission.mode": ["off", "ai"],
  "permission.scope": ["bash", "writes"],
  "ui.nerdFont": ["true", "false"],
  "autoUpdate.enabled": ["true", "false"],
  "webSearch.provider": ["duckduckgo", "brave", "tavily"],
};

function configPathCompletions(
  prefix: string,
  ctx: CompletionContext,
): Completion[] {
  return (ctx.configPaths ?? [...CONFIG_PATHS]).map((path) => ({
    value: `${prefix}${path}`,
    label: path,
  }));
}

function configValueCompletions(
  prefix: string,
  path: string,
  ctx: CompletionContext,
): Completion[] {
  const values =
    path === "model" ||
    path.startsWith("models.") ||
    path === "permission.model"
      ? (ctx.models ?? [])
      : (CONFIG_ENUM_VALUES[path] ?? []);
  return values.map((value) => ({ value: `${prefix}${value}`, label: value }));
}

function configParamValues(arg: string, ctx: CompletionContext): Completion[] {
  const trimmed = arg.trimStart();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const endsWithSpace = /\s$/.test(arg);
  if (tokens.length === 0) {
    return CONFIG_SUBCOMMANDS.map((op) => ({
      value: `/config ${op} `,
      label: op,
    }));
  }
  const op = tokens[0]?.toLowerCase();
  if (!CONFIG_SUBCOMMANDS.includes(op as (typeof CONFIG_SUBCOMMANDS)[number]))
    return [];
  if (op === "reload") return [{ value: "/config reload mcp", label: "mcp" }];
  if (op === "get" || op === "unset")
    return configPathCompletions(`/config ${op} `, ctx);
  if (op === "set") {
    if (tokens.length <= 1 && !endsWithSpace)
      return configPathCompletions("/config set ", ctx);
    if (tokens.length === 1 && endsWithSpace)
      return configPathCompletions("/config set ", ctx);
    const path = tokens[1] ?? "";
    return configValueCompletions(`/config set ${path} `, path, ctx);
  }
  return [];
}

/** Parameter-value candidates for a (canonical) command name, pre-fuzzy-filter. */
function paramValues(
  name: string,
  ctx: CompletionContext,
  arg = "",
): Completion[] {
  switch (name) {
    case "model":
      return (ctx.models ?? []).map((id) => ({
        value: `/model ${id}`,
        label: id,
      }));
    case "think":
      return THINK_LEVELS.map((l) => ({ value: `/think ${l}`, label: l }));
    case "resume":
      return (ctx.sessions ?? []).map((s) => ({
        value: `/resume ${s.id}`,
        label: s.id.slice(0, 8),
        description: s.title ?? undefined,
      }));
    case "config":
      return configParamValues(arg, ctx);
    case "extensions": {
      const tokens = arg.trimStart().split(/\s+/).filter(Boolean);
      // Bare `/extensions` is the interactive picker — suggest nothing so a
      // plain Enter submits it instead of accepting an op completion.
      if (tokens.length === 0) return [];
      const op = tokens[0]?.toLowerCase();
      const opComplete = tokens.length >= 2 || /\s$/.test(arg);
      if ((op === "enable" || op === "disable") && opComplete) {
        return toggleableExtensions().map((e) => ({
          value: `/extensions ${op} ${e.name}`,
          label: e.name,
          description: e.description,
        }));
      }
      return ["enable", "disable"].map((o) => ({
        value: `/extensions ${o} `,
        label: o,
      }));
    }
    default:
      return [];
  }
}

/**
 * Compute autocomplete suggestions for a raw input line. Returns [] when the
 * line is not a `/`-command in progress. The first token (no space yet) ranks
 * commands; after a command word + space, ranks that command's parameters.
 */
export function completions(
  input: string,
  ctx: CompletionContext,
): Completion[] {
  if (!input.startsWith("/")) return [];
  const rest = input.slice(1);
  const space = rest.search(/\s/);

  // First token still being typed → complete the command name.
  if (space === -1) {
    const q = rest;
    // Single pass: score each command and keep only the matches (avoids a
    // separate map()+filter() over the registry).
    const scored: Array<{ c: CommandSpec; best: number }> = [];
    for (const c of COMMANDS) {
      // Score against the name, any alias, and the description; keep the best.
      const keys = [c.name, ...(c.aliases ?? []), c.description];
      let best = -Infinity;
      for (const k of keys) {
        const m = fuzzyScore(q, k);
        if (m && m.score > best) best = m.score;
      }
      if (best > -Infinity) scored.push({ c, best });
    }
    scored.sort((a, b) => b.best - a.best);
    return scored.map(({ c }) => ({
      value: `/${c.name}${c.usage ? " " : ""}`,
      label: `/${c.name}${c.usage ? ` ${c.usage}` : ""}`,
      description: c.description,
    }));
  }

  // Command word complete → complete its parameter values.
  const name = rest.slice(0, space).toLowerCase();
  const argQuery = rest.slice(space + 1).trimStart();
  const spec = BY_NAME.get(name);
  if (!spec) return [];
  const rawArg = rest.slice(space + 1);
  const values = paramValues(spec.name, ctx, rawArg);
  const query =
    spec.name === "config" || spec.name === "extensions"
      ? (rawArg.trimStart().split(/\s+/).at(-1) ?? "")
      : argQuery;
  return fuzzyRank(query, values, (v) => v.label).map((r) => r.item);
}
