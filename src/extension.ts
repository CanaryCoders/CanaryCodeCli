// src/extension.ts — the extension kernel.
//
// An Extension is one feature's complete footprint: the tools it contributes,
// the prompt section it injects (named and visible — nothing enters the system
// prompt anonymously), and its pre/post tool hooks. `composeExtensions` folds N
// extensions into the exact callback shape `runAgent` already accepts, so the
// core loop stays a pure engine that knows nothing about features.

import type { AgentOptions } from "./agent.ts";
import type { Config, ProviderConfig } from "./config.ts";
import type { Provider } from "./provider.ts";
import type { Tool } from "./tools.ts";

// ── Built-in extensions ──────────────────────────────────────────────────────
//
// A session Extension (below) covers what a feature contributes to one agent
// session: tools, a prompt section, tool hooks. Some features also have a life
// OUTSIDE the session — a provider preset baked into the default config, model
// discovery/gating at startup, and login-style commands (CLI subcommands + TUI
// slash commands). A BuiltinExtension describes that outer lifecycle; the
// registry in extensions/builtin.ts lists them so the frontends iterate instead
// of hardcoding each feature.

/** What a built-in extension command receives from its host (CLI or TUI). */
export interface BuiltinCommandContext {
  config: Config;
  /** Status/result line for the human (console.log in CLI, note() in TUI). */
  note(text: string): void;
  /** Read one line of user input (CLI manual flows only; absent in the TUI). */
  readLine?: () => Promise<string>;
}

/** A login-style command surfaced as `cc <name>` and `/<name>`. */
export interface BuiltinCommand {
  /** Command word, e.g. "login-codex". */
  name: string;
  /** Argument hint shown in help, e.g. "[--manual]". */
  usage?: string;
  /** One-line description for help/autocomplete. */
  description: string;
  /** Run the command. Throw to report failure (the host formats the error). */
  run(ctx: BuiltinCommandContext, args: string[]): Promise<void>;
}

export interface BuiltinExtension {
  name: string;
  /** One-line description shown by `/extensions`. */
  description: string;
  /** Provider presets folded into the default config (inert until signed in). */
  providerPresets?(): Record<string, ProviderConfig>;
  /**
   * Startup discovery/gating, mutating `config` in place — populate provider
   * models when authenticated, empty them when not (or when disabled). "fast"
   * favors caches + background refresh (the TUI's first paint); "live" blocks
   * on the network (headless, reloads). Returns an optional one-line note.
   */
  startup?(config: Config, mode: "fast" | "live"): Promise<string | undefined>;
  /** Login-style commands this extension contributes. */
  commands?: BuiltinCommand[];
}

/**
 * Whether an extension is enabled: the `extensions.<name>` config toggle, else
 * the given default. Applies to built-ins and to toggleable session extensions.
 */
export function extensionEnabled(
  config: Config,
  name: string,
  defaultEnabled = true,
): boolean {
  return config.extensions[name] ?? defaultEnabled;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface Verdict {
  allow: boolean;
  reason?: string;
}

/** Everything a frontend supplies to extensions at assembly time. */
export interface ExtensionHost {
  config: Config;
  provider: Provider;
  model: string;
  sessionId: string;
  signal: AbortSignal;
  /** Status note for the human (stderr in headless, status line in TUI). */
  note(text: string): void;
  /** Human approval gate (TUI confirm box); undefined in headless/auto. */
  gate?: AgentOptions["gate"];
}

/** Host plus the kernel-provided view of the composed tool set. */
export interface ExtensionContext extends ExtensionHost {
  /** The full composed tool set. Stable reference; complete once
   * `composeExtensions` resolves — only call it lazily (inside `run`/hooks). */
  getTools(): Tool[];
}

export interface Extension {
  name: string;
  /** Tools this extension contributes. Called once at assembly. */
  tools?(ctx: ExtensionContext): Promise<Tool[]> | Tool[];
  /** Optional system-prompt section, appended after the base prompt. Keep it
   * to a few lines — every active extension pays its own token cost. Called
   * after all `tools()` so it can reflect what was discovered. */
  systemPrompt?(
    ctx: ExtensionContext,
  ): Promise<string | undefined> | string | undefined;
  /** Veto hook before every tool call. First deny across extensions wins. */
  preToolUse?(call: ToolCall, ctx: ExtensionContext): Promise<Verdict>;
  /** Observational hook after every tool call. Errors are swallowed. */
  postToolUse?(
    call: ToolCall,
    result: { content: string; isError: boolean },
    ctx: ExtensionContext,
  ): Promise<void>;
  /** Cleanup: close connections, kill children. Errors are swallowed. */
  dispose?(): Promise<void>;
}

export interface ComposedExtensions {
  tools: Tool[];
  /** Prompt sections to append after the base system prompt, in order. */
  promptSections: string[];
  preToolUse: NonNullable<AgentOptions["preToolUse"]>;
  postToolUse: NonNullable<AgentOptions["postToolUse"]>;
  dispose(): Promise<void>;
}

export async function composeExtensions(
  extensions: Extension[],
  host: ExtensionHost,
): Promise<ComposedExtensions> {
  const tools: Tool[] = [];
  const ctx: ExtensionContext = { ...host, getTools: () => tools };

  // Sequential by design: tool order is part of the contract (extensions may
  // capture `getTools()` lazily and expect earlier extensions to be present),
  // and discovery functions print notes in a deterministic order.
  for (const ext of extensions) {
    if (ext.tools) tools.push(...(await ext.tools(ctx)));
  }
  const promptSections: string[] = [];
  for (const ext of extensions) {
    const section = ext.systemPrompt ? await ext.systemPrompt(ctx) : undefined;
    if (section) promptSections.push(section);
  }

  const pres = extensions.filter((e) => e.preToolUse);
  const posts = extensions.filter((e) => e.postToolUse);

  return {
    tools,
    promptSections,
    preToolUse: async (call) => {
      for (const ext of pres) {
        const verdict = await ext.preToolUse!(call, ctx);
        if (!verdict.allow) return verdict;
      }
      return { allow: true };
    },
    postToolUse: async (call, result) => {
      for (const ext of posts) {
        try {
          await ext.postToolUse!(call, result, ctx);
        } catch {
          // observational hooks never affect the loop
        }
      }
    },
    dispose: async () => {
      for (const ext of extensions) {
        try {
          await ext.dispose?.();
        } catch {
          // best-effort cleanup
        }
      }
    },
  };
}
