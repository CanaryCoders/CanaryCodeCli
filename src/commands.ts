// commands.ts — slash-command parsing and dispatch.
//
// A pure module whose `makeCommandSet(extensionCommands)` factory builds the
// config-aware command set: the static base commands plus the commands of
// currently-enabled extensions. Hosts (TUI, CLI) rebuild it whenever the
// extension set may change — it is cheap (a map over ~25 specs). Parsing stays
// side-effect-free, so both frontends share one dispatcher without coupling to
// each other's state.
//
// A line that does not start with "/" is not a command — it is a normal prompt,
// returned as a `message` action so the host has a single thing to switch on.

import type { AgentMode } from "./agent.ts";
import { CONFIG_PATHS } from "./config.ts";
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
  | { kind: "compact" }
  | { kind: "resume"; id?: string }
  | { kind: "cost" }
  | { kind: "copy-last" }
  /** Enter keyboard transcript copy/navigation mode (nav mode). */
  | { kind: "copy-open" }
  | { kind: "init" }
  /** A command contributed by an extension (built-in or user-loaded). */
  | { kind: "extension-command"; name: string; args: string[] }
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

/**
 * How a command typed *while the agent is busy* should be handled:
 * - "live"  — apply immediately (state/config change or read-only note). /model &
 *             /think take effect on the in-flight turn's next step; /mode on the
 *             next turn. (See the mid-turn-queue spec §3/§4.)
 * - "queue" — push onto the FIFO and inject at the next tool-result boundary.
 * - "defer" — unsafe to run mid-turn (would corrupt in-flight conversation/lifecycle
 *             state); show a "after the current turn" note and run nothing.
 */
export function classifyBusyAction(
  action: CommandAction,
): "live" | "queue" | "defer" {
  switch (action.kind) {
    case "set-model":
    case "set-think":
    case "set-mode":
    case "list-models":
    case "cost":
    case "copy-last":
    case "help":
      return "live";
    case "message":
    case "init":
      return "queue";
    case "clear":
    case "compact":
    case "resume":
    case "copy-open":
    case "extension-command":
    case "extensions":
    case "update":
    case "config":
    case "exit":
    case "error":
      return "defer";
  }
}

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

/** The static commands that open the `/help` listing. */
const BASE_COMMANDS: CommandSpec[] = [
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
  { name: "compact", description: "summarize older context now" },
  {
    name: "resume",
    usage: "[id]",
    description: "list saved sessions, or resume <id>",
  },
  { name: "cost", description: "show token usage and cost so far" },
  {
    name: "copy-last",
    description: "copy the last assistant message to the clipboard",
  },
  {
    name: "copy",
    description: "enter transcript copy/navigation mode",
  },
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
];

/** The static commands that close the `/help` listing. */
const TAIL_COMMANDS: CommandSpec[] = [
  { name: "update", description: "update cc to the latest release" },
  { name: "help", aliases: ["?"], description: "show this command list" },
  { name: "exit", aliases: ["quit", "q"], description: "exit cc" },
];

/** Command words owned by the base command set (names and aliases). An
 * extension command with one of these names is ignored — built-ins win. */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set(
  [...BASE_COMMANDS, ...TAIL_COMMANDS].flatMap((c) => [
    c.name,
    ...(c.aliases ?? []),
  ]),
);

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

/** Parse the `/config [get|set|unset|reload]` argument. */
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
function helpText(specs: CommandSpec[]): string {
  const left = specs.map((c) => `/${c.name}${c.usage ? ` ${c.usage}` : ""}`);
  const width = Math.max(...left.map((l) => l.length));
  const lines = specs.map(
    (c, i) => `  ${left[i].padEnd(width)}  ${c.description}`,
  );
  return ["Commands:", ...lines].join("\n");
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

/** A selectable model and where it comes from (provider display name). */
export interface ModelOption {
  id: string;
  /** Source label shown beside the id: "CanaryLLM", "Codex", "OpenCode", … */
  source?: string;
}

/** Known parameter values the host can supply for parameter completion. */
export interface CompletionContext {
  /** Configured models (for `/model` and model-valued `/config` paths). */
  models?: ModelOption[];
  /** Recent sessions, newest first (for `/resume`). */
  sessions?: { id: string; title: string | null }[];
  /** Optional config paths supplied by the host; defaults to built-in common paths. */
  configPaths?: string[];
  /** Known extensions (for `/extensions enable|disable` completion). */
  extensions?: { name: string; description: string }[];
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
  if (
    path === "model" ||
    path.startsWith("models.") ||
    path === "permission.model"
  ) {
    return (ctx.models ?? []).map((m) => ({
      value: `${prefix}${m.id}`,
      label: m.id,
      description: m.source,
    }));
  }
  const values = CONFIG_ENUM_VALUES[path] ?? [];
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
      // The description names the model's source (CanaryLLM, Codex, OpenCode, …)
      // so identically-named models from different providers stay tellable apart.
      return (ctx.models ?? []).map((m) => ({
        value: `/model ${m.id}`,
        label: m.id,
        description: m.source,
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
        return (ctx.extensions ?? []).map((e) => ({
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

/** A built command set: the dispatcher and completer over one spec list. */
export interface CommandSet {
  /** Full spec list in /help order. */
  specs: CommandSpec[];
  /** Parse + dispatch an input line (the old dispatchCommand). */
  dispatch(input: string): CommandAction;
  /** Autocomplete suggestions (the old completions). */
  completions(input: string, ctx: CompletionContext): Completion[];
}

/**
 * Build the command set for the CURRENT config: the static base commands plus
 * the commands of currently-enabled extensions. Hosts rebuild this whenever
 * the extension set may have changed (cheap — a map over ~25 specs), so a
 * disabled extension's commands are unknown everywhere at once.
 */
export function makeCommandSet(
  extensionCommands: {
    name: string;
    usage?: string;
    description: string;
  }[] = [],
): CommandSet {
  const safeExtensions = extensionCommands.filter(
    (c) => !RESERVED_COMMAND_NAMES.has(c.name),
  );
  const specs: CommandSpec[] = [
    ...BASE_COMMANDS,
    ...safeExtensions.map((c) => ({
      name: c.name,
      usage: c.usage,
      description: c.description,
    })),
    ...TAIL_COMMANDS,
  ];
  const byName = new Map<string, CommandSpec>();
  for (const spec of specs) {
    byName.set(spec.name, spec);
    for (const alias of spec.aliases ?? []) byName.set(alias, spec);
  }
  const extensionNames = new Set(safeExtensions.map((c) => c.name));

  /**
   * Parse and dispatch an input line into a `CommandAction`. Non-command lines
   * become a `message` action. Unknown commands and bad arguments become an
   * `error` action with a human-readable message — the host decides how to show it.
   */
  function dispatch(input: string): CommandAction {
    const parsed = parseCommand(input);
    if (!parsed) return { kind: "message", text: input };

    const spec = byName.get(parsed.name);
    if (!spec) {
      return {
        kind: "error",
        message: `unknown command: /${parsed.name} (try /help)`,
      };
    }

    // Extension commands dispatch generically — the host looks the handler up
    // in the registry, so new extensions never grow this switch.
    if (extensionNames.has(spec.name)) {
      return {
        kind: "extension-command",
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
      case "compact":
        return { kind: "compact" };
      case "resume":
        return parsed.arg
          ? { kind: "resume", id: parsed.arg }
          : { kind: "resume" };
      case "cost":
        return { kind: "cost" };
      case "copy-last":
        return { kind: "copy-last" };
      case "copy":
        return { kind: "copy-open" };
      case "config":
        return parseConfigAction(parsed.arg);
      case "init":
        return { kind: "init" };
      case "extensions":
        return parseExtensionsAction(parsed.arg);
      case "update":
        return { kind: "update" };
      case "help":
        return { kind: "help", text: helpText(specs) };
      case "exit":
        return { kind: "exit" };
      default:
        // Unreachable while the specs and this switch stay in sync.
        return { kind: "error", message: `unhandled command: /${spec.name}` };
    }
  }

  /**
   * Compute autocomplete suggestions for a raw input line. Returns [] when the
   * line is not a `/`-command in progress. The first token (no space yet) ranks
   * commands; after a command word + space, ranks that command's parameters.
   */
  function complete(input: string, ctx: CompletionContext): Completion[] {
    if (!input.startsWith("/")) return [];
    const rest = input.slice(1);
    const space = rest.search(/\s/);

    // First token still being typed → complete the command name.
    if (space === -1) {
      const q = rest;
      // Single pass: score each command and keep only the matches (avoids a
      // separate map()+filter() over the registry).
      const scored: Array<{ c: CommandSpec; best: number }> = [];
      for (const c of specs) {
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
    const spec = byName.get(name);
    if (!spec) return [];
    const rawArg = rest.slice(space + 1);
    const values = paramValues(spec.name, ctx, rawArg);
    const query =
      spec.name === "config" || spec.name === "extensions"
        ? (rawArg.trimStart().split(/\s+/).at(-1) ?? "")
        : argQuery;
    return fuzzyRank(query, values, (v) => v.label).map((r) => r.item);
  }

  return { specs, dispatch, completions: complete };
}
