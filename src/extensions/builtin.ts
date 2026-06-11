// builtin.ts — the registry of built-in extensions.
//
// A BuiltinExtension (extension.ts) is a feature's life OUTSIDE the session:
// provider presets, startup model discovery/gating, and login-style commands.
// The frontends iterate this registry instead of naming features — adding a
// built-in here gives it `cc <command>`/`/<command>` wiring, startup notes, and
// an `/extensions` toggle for free. Session-side features (websearch, skills,
// agents, mcp, hooks) stay registered in assemble.ts; TOGGLEABLE_EXTENSIONS
// below is the union `/extensions` can flip.

import {
  CANARY_PROVIDER,
  describeCanary,
  populateCanaryModels,
} from "../canary.ts";
import type { Config } from "../config.ts";
import type {
  BuiltinCommand,
  BuiltinCommandContext,
  BuiltinExtension,
} from "../extension.ts";
import { extensionEnabled } from "../extension.ts";
import { codexBuiltin } from "./codex.ts";
import { opencodeBuiltin } from "./opencode.ts";

/** The CanaryLLM gateway as a built-in (preset stays in config.ts defaults). */
const canaryBuiltin: BuiltinExtension = {
  name: "canaryllm",
  description: "CanaryLLM gateway models (CANARYLLM_API_KEY)",
  async startup(config) {
    if (!extensionEnabled(config, "canaryllm")) {
      const preset = config.providers[CANARY_PROVIDER];
      if (preset) preset.models = [];
      return undefined;
    }
    return describeCanary(await populateCanaryModels(config));
  },
};

export const BUILTIN_EXTENSIONS: BuiltinExtension[] = [
  canaryBuiltin,
  codexBuiltin,
  opencodeBuiltin,
];

/** Session extensions assemble.ts registers that `/extensions` may toggle.
 * Deliberately excludes the session plumbing every run needs (core tools,
 * ask_user, tasks; permission has its own `permission.mode` switch). */
export const TOGGLEABLE_SESSION_EXTENSIONS = [
  "websearch",
  "skills",
  "agents",
  "mcp",
  "hooks",
] as const;

/** Everything `/extensions` can list/enable/disable, in display order. */
export function toggleableExtensions(): {
  name: string;
  description: string;
}[] {
  return [
    ...BUILTIN_EXTENSIONS.map((e) => ({
      name: e.name,
      description: e.description,
    })),
    { name: "websearch", description: "the web_search tool" },
    { name: "skills", description: "progressive-disclosure skills" },
    { name: "agents", description: "sub-agents + custom agents (spawn_agent)" },
    { name: "mcp", description: "MCP servers from config" },
    { name: "hooks", description: "lifecycle shell hooks" },
  ];
}

/** All login-style commands contributed by built-ins, in registry order. */
export function builtinCommands(): BuiltinCommand[] {
  return BUILTIN_EXTENSIONS.flatMap((e) => e.commands ?? []);
}

/** Find a built-in command by its word (e.g. "login-codex"). */
export function findBuiltinCommand(name: string): BuiltinCommand | undefined {
  return builtinCommands().find((c) => c.name === name);
}

/**
 * Run every built-in extension's startup discovery/gating against `config`,
 * collecting the one-line notes. "fast" favors caches (TUI first paint);
 * "live" blocks on the network (headless runs, config reloads).
 */
export async function startupBuiltins(
  config: Config,
  mode: "fast" | "live",
): Promise<string[]> {
  const notes: string[] = [];
  for (const ext of BUILTIN_EXTENSIONS) {
    if (!ext.startup) continue;
    try {
      const note = await ext.startup(config, mode);
      if (note) notes.push(note);
    } catch (err) {
      notes.push(
        `note: ${ext.name} startup failed — ${(err as Error).message}`,
      );
    }
  }
  // Surface toggled-off extensions so a launch makes the state visible
  // (otherwise "nothing happened" and "disabled" look identical).
  const off = toggleableExtensions()
    .map((e) => e.name)
    .filter((name) => config.extensions[name] === false);
  if (off.length > 0) {
    notes.push(`note: extensions disabled: ${off.join(", ")} (/extensions)`);
  }
  return notes;
}

/** Run a built-in command by name. Returns false when no such command exists. */
export async function runBuiltinCommand(
  name: string,
  ctx: BuiltinCommandContext,
  args: string[] = [],
): Promise<boolean> {
  const cmd = findBuiltinCommand(name);
  if (!cmd) return false;
  await cmd.run(ctx, args);
  return true;
}
