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
  { name: "model", usage: "[id]", description: "list models, or switch to <id>" },
  { name: "think", usage: "[level]", description: "set thinking: off | think | think-hard | ultrathink" },
  { name: "plan", description: "switch to read-only plan mode" },
  { name: "auto", description: "switch to autonomous auto mode" },
  { name: "normal", description: "return to normal mode" },
  { name: "clear", description: "clear the conversation and start fresh" },
  { name: "resume", usage: "[id]", description: "list saved sessions, or resume <id>" },
  { name: "cost", description: "show token usage and cost so far" },
  { name: "init", description: "generate a starter CC.md project-context file" },
  { name: "help", aliases: ["?"], description: "show this command list" },
  { name: "exit", aliases: ["quit", "q"], description: "exit cc" },
];

/** Lookup table from a name or alias to its spec. */
const BY_NAME = new Map<string, CommandSpec>();
for (const spec of COMMANDS) {
  BY_NAME.set(spec.name, spec);
  for (const alias of spec.aliases ?? []) BY_NAME.set(alias, spec);
}

/** Whether a raw input line is a slash command (vs. an ordinary prompt). */
export function isCommand(input: string): boolean {
  const t = input.trim();
  // "/word" or "/word <args>" — the name is letters/word-chars with no slash, so a
  // path like "/usr/bin" (slash before whitespace) is treated as text, not a command.
  return /^\/[a-zA-Z?][\w?-]*(\s|$)/.test(t);
}

/** Split a command line into `{ name, arg }`. Returns null when not a command. */
export function parseCommand(input: string): ParsedCommand | null {
  if (!isCommand(input)) return null;
  const t = input.trim().slice(1); // drop the leading "/"
  const space = t.search(/\s/);
  if (space === -1) return { name: t.toLowerCase(), arg: "" };
  return { name: t.slice(0, space).toLowerCase(), arg: t.slice(space + 1).trim() };
}

/** Render the `/help` command list as aligned lines. */
export function helpText(): string {
  const left = COMMANDS.map((c) => `/${c.name}${c.usage ? ` ${c.usage}` : ""}`);
  const width = Math.max(...left.map((l) => l.length));
  const lines = COMMANDS.map((c, i) => `  ${left[i].padEnd(width)}  ${c.description}`);
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
    return { kind: "error", message: `unknown command: /${parsed.name} (try /help)` };
  }

  switch (spec.name) {
    case "model":
      return parsed.arg ? { kind: "set-model", model: parsed.arg } : { kind: "list-models" };
    case "think": {
      // A bare `/think` means the default on-level; an unrecognized value errors.
      const level = parseLevel(parsed.arg || "think");
      if (level === undefined) {
        return { kind: "error", message: `unknown thinking level: "${parsed.arg}" (off|think|think-hard|ultrathink)` };
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
      return parsed.arg ? { kind: "resume", id: parsed.arg } : { kind: "resume" };
    case "cost":
      return { kind: "cost" };
    case "init":
      return { kind: "init" };
    case "help":
      return { kind: "help", text: helpText() };
    case "exit":
      return { kind: "exit" };
    default:
      // Unreachable while COMMANDS and this switch stay in sync.
      return { kind: "error", message: `unhandled command: /${spec.name}` };
  }
}
