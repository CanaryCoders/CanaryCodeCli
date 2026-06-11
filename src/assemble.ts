// src/assemble.ts — one place where a session's capabilities are decided.
//
// Both frontends (headless CLI and TUI) call this with their own callbacks;
// nothing else may construct the tool set or compose the system prompt. Each
// feature is an Extension; deleting a line here removes the feature whole.

import type { AgentMode } from "./agent.ts";
import { systemForMode } from "./agent.ts";
import {
  composeSystemPrompt,
  describeContext,
  loadProjectContext,
} from "./context.ts";
import type {
  ComposedExtensions,
  ExtensionHost,
  SessionExtension,
} from "./extension.ts";
import { composeExtensions } from "./extension.ts";
import {
  type AskAnswer,
  type AskQuestion,
  type AskUserFn,
  askUserExtension,
} from "./extensions/askuser.ts";
import {
  buildPermissionGate,
  composeGates,
  type FrontendGate,
} from "./extensions/permission.ts";
import { sessionExtensions } from "./extensions/registry.ts";
import {
  type Task,
  type TaskStatus,
  type TaskUpdateFn,
  tasksExtension,
} from "./extensions/tasks.ts";
import type { Tool } from "./tools.ts";
import { tools as allTools } from "./tools.ts";

export type {
  ExtensionCommand,
  ExtensionCommandContext,
} from "./extension.ts";
export { extensionEnabled } from "./extension.ts";
// The built-in extension registry, re-exported so frontends drive provider
// startup discovery, login-style commands, and `/extensions` toggles through
// the assembly boundary instead of importing feature modules directly.
export {
  availableCommands,
  findCommand,
  findCommandAnywhere,
  foldPresets,
  listExtensions,
  runCommand,
  setUserExtensions,
  startupExtensions,
} from "./extensions/registry.ts";
// Frontend-facing feature types re-exported through the assembly boundary, so a
// frontend (TUI component / headless formatter) never has to reach into a feature
// module just to name a type. These are the only feature surfaces the frontends
// touch; everything else flows through assembleSession's callbacks.
export type { AskAnswer, AskQuestion, FrontendGate, Task, TaskStatus };

/**
 * The base system prompt, shared by both frontends. Each mode (plan/auto)
 * appends its own rules via {@link systemForMode}; project memory + the feature
 * sections fold in around it during assembly.
 */
export const SYSTEM_PROMPT = [
  "You are cc, a concise terminal coding agent.",
  "You operate in the user's current working directory and can read, search, and modify files and run shell commands via your tools.",
  "Be direct. Use tools to inspect the project before answering; prefer evidence over assumptions.",
  "",
  "## Working approach",
  "Think before you act. Before making any change, briefly inspect the relevant code and decide on an approach, then state the plan in one or two sentences before you start editing. Do NOT announce a change, make it, and then reverse course mid-task — that erodes trust. Settle on the approach first, then execute it. If you are genuinely unsure between real alternatives, investigate or ask before writing, rather than guessing and rewriting.",
  "Never modify a file you have not read. Always read a file with read_file (or otherwise see its current contents) before you write_file or edit_file it, so your changes fit the existing code and don't clobber anything. Editing blind is not acceptable.",
  "",
  "ALWAYS end your turn with a recap once you have finished working (i.e. your final reply that makes no further tool calls). Never stop after a tool call without a closing message. The recap is mandatory — even for small tasks or when nothing changed. Format it exactly as:",
  "",
  "## Recap",
  "- <what you did, one bullet per change or finding>",
  "",
  "Keep it short: list files touched and the key changes, plus anything the user should know (follow-ups, caveats, how to verify). If the task produced no changes, say so explicitly.",
].join("\n");

export interface AssembleOptions extends Omit<ExtensionHost, "gate"> {
  /** The frontend's own approval gate (the TUI confirm box; absent in headless).
   * It flows into composeGates as the frontend side, so it may receive an AI
   * advisory when the AI checker flags a call. The COMPOSED gate handed to
   * runAgent and threaded to spawn_agent children stays a plain `Gate`. */
  gate?: FrontendGate;
  /** Answer ask_user questions (interactive in TUI, autoAnswer in headless). */
  askUser: AskUserFn;
  /** Render the agent's task list (stderr checklist / TUI component). */
  onTasks: TaskUpdateFn;
  noTools?: boolean;
}

export interface AssembledSession extends ComposedExtensions {
  /** Fully composed system prompt: base + project context + sections + mode. */
  system: string;
  /** The composed approval gate (AI permission check + the frontend's gate),
   * to hand to `runAgent`. Undefined when nothing gates this run. */
  gate?: ExtensionHost["gate"];
}

export async function assembleSession(
  opts: AssembleOptions,
): Promise<AssembledSession> {
  // Assembly is mode-independent: the tool set, system prompt, and gate are
  // built once and the per-turn mode (plan filtering, mode suffix, auto's gate
  // skip) is derived later via `sessionForMode`. This lets a frontend (the TUI)
  // switch modes between turns without reassembling — and reconnecting MCP. The
  // AI permission gate is built whenever config asks for it, regardless of mode;
  // `sessionForMode` drops it for an auto-mode turn.
  //
  // Build the AI permission gate and compose it with the frontend's own gate
  // BEFORE composing extensions, so `ctx.gate` (which the agents extension hands
  // to its children) already includes the AI check. The AI gate runs first; a
  // deny short-circuits before the frontend gate (the TUI confirm box) is asked.
  const aiGate =
    opts.config.permission.mode === "ai"
      ? buildPermissionGate({
          config: opts.config,
          signal: opts.signal,
          note: opts.note,
        })
      : undefined;
  const gate = composeGates(aiGate, opts.gate);

  // Feature extensions come from the registry, which yields only the ENABLED
  // ones — `/extensions disable <name>` drops a feature here, whole: no tools,
  // no prompt section, no startup work. The plumbing every run needs (core
  // tools, ask_user, tasks; permission via permission.mode) is not an
  // extension and always assembles.
  const extensions: SessionExtension[] = opts.noTools
    ? []
    : [
        { name: "core", tools: () => allTools },
        ...sessionExtensions(opts.config),
        askUserExtension(opts.askUser),
        // MUST be last: update_tasks always sits at the end of the tool set.
        tasksExtension(opts.onTasks),
      ];

  const composed = await composeExtensions(extensions, { ...opts, gate });

  // Project memory (CC.md > AGENTS.md > CLAUDE.md, nearest dir first) is prepended
  // to the base prompt; the feature sections fold in after. The per-mode rules are
  // appended per turn by `sessionForMode`, NOT here — `system` is the base prompt.
  const projectContext = await loadProjectContext();
  const contextNote = describeContext(projectContext);
  if (contextNote) opts.note(contextNote);
  const base = composeSystemPrompt(SYSTEM_PROMPT, projectContext);
  const system = [base, ...composed.promptSections].join("\n\n");

  return { ...composed, system, gate };
}

/**
 * Derive the per-turn tool set, system prompt, and gate for a mode from an
 * assembled session. Assembly is mode-independent; plan filtering, the mode
 * suffix, and auto's gate skip are cheap per-turn derivations:
 *   • plan  — only read-only tools survive; the AI/human gate still applies.
 *   • auto  — full tool set, no gate (autonomous runs never pause to confirm).
 *   • normal — full tool set, the composed gate.
 */
export function sessionForMode(
  session: AssembledSession,
  mode: AgentMode,
): { tools: Tool[]; system: string; gate?: ExtensionHost["gate"] } {
  const tools =
    mode === "plan" ? session.tools.filter((t) => t.readOnly) : session.tools;
  return {
    tools,
    system: systemForMode(session.system, mode),
    gate: mode === "auto" ? undefined : session.gate,
  };
}
