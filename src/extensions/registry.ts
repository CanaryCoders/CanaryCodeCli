// registry.ts — the extension registry: the single config-aware authority on
// which extensions exist, which are enabled, and what each contributes.
//
// Built-ins and user-loaded extensions share one unified Extension shape
// (extension.ts). Everything that varies with the `extensions.<name>` toggle
// flows through here: a disabled extension contributes no commands, no startup
// work, no provider presets, and no session extension — enforced in this
// module, never self-policed by the extension.

import {
  CANARY_PROVIDER,
  canaryProviderConfig,
  describeCanary,
  populateCanaryModels,
} from "../canary.ts";
import type { Config } from "../config.ts";
import type {
  Extension,
  ExtensionCommand,
  ExtensionCommandContext,
  SessionExtension,
} from "../extension.ts";
import { extensionEnabled } from "../extension.ts";
import { agentsExtension } from "./agents.ts";
import { codexExtension } from "./codex.ts";
import { hooksExtension } from "./hooks.ts";
import { mcpExtension } from "./mcp.ts";
import { opencodeExtension } from "./opencode.ts";
import { skillsExtension } from "./skills.ts";
import { webSearchExtension } from "./websearch.ts";

/** The CanaryLLM gateway as an extension. */
const canaryExtension: Extension = {
  name: "canaryllm",
  description: "CanaryLLM gateway models (CANARYLLM_API_KEY)",
  providerPresets: () => ({ [CANARY_PROVIDER]: canaryProviderConfig() }),
  async startup(config) {
    return describeCanary(await populateCanaryModels(config));
  },
};

export const BUILTIN_EXTENSIONS: Extension[] = [
  canaryExtension,
  codexExtension,
  opencodeExtension,
  {
    name: "websearch",
    description: "the web_search tool",
    session: () => webSearchExtension(),
  },
  {
    name: "skills",
    description: "progressive-disclosure skills",
    session: () => skillsExtension(),
  },
  {
    name: "mcp",
    description: "MCP servers from config",
    session: () => mcpExtension(),
  },
  {
    name: "agents",
    description: "sub-agents + custom agents (spawn_agent)",
    session: () => agentsExtension(),
  },
  {
    name: "hooks",
    description: "lifecycle shell hooks",
    session: () => hooksExtension(),
  },
];

let userExtensions: Extension[] = [];

/** Replace the loaded user extensions (the loader calls this at startup/reload). */
export function setUserExtensions(exts: Extension[]): void {
  userExtensions = exts;
}

/** Every known extension, built-in first, in registry order. */
export function allExtensions(): Extension[] {
  return [...BUILTIN_EXTENSIONS, ...userExtensions];
}

/** Whether `ext` is enabled under `config` — the only place this is decided. */
export function isEnabled(config: Config, ext: Extension): boolean {
  return extensionEnabled(config, ext.name, ext.defaultEnabled ?? true);
}

export function enabledExtensions(config: Config): Extension[] {
  return allExtensions().filter((e) => isEnabled(config, e));
}

/** Everything `/extensions` lists, in registry order, with live enabled state. */
export function listExtensions(
  config: Config,
): { name: string; description: string; enabled: boolean }[] {
  return allExtensions().map((e) => ({
    name: e.name,
    description: e.description,
    enabled: isEnabled(config, e),
  }));
}

/** Commands from ENABLED extensions only — a disabled extension's command is
 * an unknown command everywhere (help, autocomplete, dispatch, CLI). */
export function availableCommands(config: Config): ExtensionCommand[] {
  return enabledExtensions(config).flatMap((e) => e.commands ?? []);
}

export function findCommand(
  config: Config,
  name: string,
): ExtensionCommand | undefined {
  return availableCommands(config).find((c) => c.name === name);
}

/** Find a command across ALL extensions, returning its owner — used only to
 * explain "that command belongs to a disabled extension", never to run it. */
export function findCommandAnywhere(
  name: string,
): { command: ExtensionCommand; extension: Extension } | undefined {
  for (const extension of allExtensions()) {
    const command = (extension.commands ?? []).find((c) => c.name === name);
    if (command) return { command, extension };
  }
  return undefined;
}

/** Run an enabled extension's command. Returns false when no such command. */
export async function runCommand(
  config: Config,
  name: string,
  ctx: ExtensionCommandContext,
  args: string[] = [],
): Promise<boolean> {
  const cmd = findCommand(config, name);
  if (!cmd) return false;
  await cmd.run(ctx, args);
  return true;
}

/** Session extensions contributed by enabled extensions, in registry order. */
export function sessionExtensions(config: Config): SessionExtension[] {
  return enabledExtensions(config).flatMap((e) =>
    e.session ? [e.session()] : [],
  );
}

/** Fold the provider presets of enabled extensions into `config`, in place.
 * A provider the user defined themselves wins; a disabled extension's preset
 * simply never exists. */
export function foldPresets(config: Config): void {
  for (const ext of enabledExtensions(config)) {
    for (const [key, preset] of Object.entries(ext.providerPresets?.() ?? {})) {
      config.providers[key] ??= preset;
    }
  }
}

/**
 * Run every ENABLED extension's startup against `config`, collecting the
 * one-line notes. Disabled extensions are skipped here — kernel-enforced.
 * "fast" favors caches (TUI first paint); "live" blocks on the network.
 */
export async function startupExtensions(
  config: Config,
  mode: "fast" | "live",
): Promise<string[]> {
  const notes: string[] = [];
  for (const ext of enabledExtensions(config)) {
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
  const off = allExtensions()
    .filter((e) => !isEnabled(config, e))
    .map((e) => e.name);
  if (off.length > 0) {
    notes.push(`note: extensions disabled: ${off.join(", ")} (/extensions)`);
  }
  return notes;
}
