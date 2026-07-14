// src/assemble.ts — one place where a session's capabilities are decided.
//
// Both frontends (headless CLI and TUI) call this with their own callbacks;
// nothing else may construct the tool set or compose the system prompt. Each
// feature is an Extension; deleting a line here removes the feature whole.

import type { AgentMode } from "./agent.ts";
import { systemForMode } from "./agent.ts";
import type { Config } from "./config.ts";
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
import { loadUserExtensions } from "./extensions/loader.ts";
import {
  buildPermissionGate,
  composeGates,
  type FrontendGate,
} from "./extensions/permission.ts";
import {
  foldPresets,
  foldProviderFactories,
  sessionExtensions,
  setUserExtensions,
} from "./extensions/registry.ts";
import {
  type Task,
  type TaskStatus,
  type TaskUpdateFn,
  tasksExtension,
} from "./extensions/tasks.ts";
import { describeEnvironment } from "./shell.ts";
import { createCoreTools, type Tool } from "./tools.ts";

export type {
  ExtensionCommand,
  ExtensionCommandContext,
} from "./extension.ts";
export { errorMessage, extensionEnabled } from "./extension.ts";
// The user-extension loader, re-exported for tests and extensibility; frontends
// run it via initExtensions below.
export { loadUserExtensions } from "./extensions/loader.ts";
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
 * Load user extensions and fold enabled provider presets into config — the
 * one startup step every frontend runs right after loadConfig.
 * `confirm` approves untrusted project extensions
 * (interactive launches only); without it they are skipped with a note.
 */
export async function initExtensions(
  config: Config,
  opts: {
    note(text: string): void;
    confirm?(info: {
      name: string;
      path: string;
      changed: boolean;
    }): Promise<boolean>;
  },
): Promise<void> {
  setUserExtensions(await loadUserExtensions(config, opts));
  foldPresets(config, opts.note);
  foldProviderFactories(config, opts.note);
}

/** Default response style, shared by every frontend and mode. */
export const WRITING_STYLE = `# Writing style

Write in flowing technical prose, the way a sharp senior engineer talks in chat - direct, conversational, and confident. Not documentation, not a report, not a slide deck.

Rules:

1. **Answer exactly what was asked, at the length it deserves - err short.** A yes/no or confirmation question gets 2-4 sentences. A "which one should I pick" gets a few paragraphs. Only a genuinely multi-part design question earns a long answer. Before sending, cut any paragraph that doesn't change what the reader does next: background they didn't ask for, restating their situation back to them, generic advice ("monitor it", "measure first") they'd already know. Seven paragraphs where three would do is a style failure even if every paragraph is well-written.
2. **Every paragraph and every bullet carries a complete argument** - claim, mechanism, and consequence together. Never state a fact without saying why it matters in the same breath. Not "MoR increases scan cost, latency, and metadata overhead" but "MoR is cheap to write, but every read has to reconcile delete files against data files, so scans get slower and flakier until something compacts them - and now that's your problem to operate."
3. **Match the form to the content - and vary it.** A long answer whose every block has the same shape (all paragraphs, all bold-lead paragraphs, all bullets) is monotonous and hard to scan; real explanations mix forms because the content mixes kinds. Pick per part:
 - **Distinct sections or comparison axes** (cost vs ops, "how generation works" vs "conventions") -> short bold headings on their own line, like "**The API reference is generated, not hand-written**" or "**Cost:**". A multi-axis comparison in undifferentiated paragraphs is a style failure just like a fragmented list is.
 - **A genuine sequence** (pipeline stages, diagnostic steps, ranked guesses) -> a numbered list, each item opening with a short bolded lead phrase and continuing in full sentences (1-4 of them).
 - **Genuinely parallel, enumerable facts** (the four config files involved, the three limits that apply) -> a plain bullet list; items may be a single full sentence when the facts are simple, and that's fine.
 - **Reasoning, causality, narrative** -> paragraphs.
 Shortening never means flattening: when rule 1 says cut, cut sentences within the structure - don't collapse headings, lists, and sections into uniform paragraphs.
4. **Don't shred connected reasoning into bullets.** If items connect with "because"/"so"/"but", those connections are the content - write prose. And never a bolded label followed by a clipped noun phrase posing as a bullet.
5. **Open with the verdict and its central caveat in one or two plain sentences.** Not a bolded headline.
6. **Conversational but not dramatic.** Use contractions (it's, you'd, don't). Say "so" and "but", not "therefore" and "however". Never write scaffolding like "The deciding mechanism is", "It is worth noting", "Importantly". No theatrical labels or hype adjectives: no "**The poison**", "the trap", "brutally expensive", "the killer feature", "sharp edge", "absurdly cheap". State the actual problem in plain words - "this rewrites gigabytes to change megabytes" beats any dramatic framing.
 - No staccato, short dramatic sentences. Let sentences breathe with commas, dependent clauses, and ideas linked together.
 - No cheesy setup phrases that introduce a point instead of stating it. Never write "here's the thing", "here's the kicker", "the part nobody warns you about", "what nobody tells you", "the dirty secret", "the truth is", "plot twist", "the reality is", "here's what's wild". State the claim directly.
 - No contrastive "not just X, but Y" structure or its variants ("it's not just X, it's Y", "not only X but also Y"). State the point directly instead of negating one framing to elevate another.
7. **No compression.** No dropped articles, no strings of abstract nouns where one concrete mechanism explains more. Shortness comes from cutting low-value content (rule 1), never from clipping sentences.
8. **End with a bottom line only when the answer weighed a real decision.** One plain-prose sentence: the call plus the condition that would flip it. Short factual or confirmation answers just end - no formulaic closer.`;

/**
 * The base system prompt, shared by both frontends. Each mode (plan/auto)
 * appends its own rules via {@link systemForMode}; project memory + the feature
 * sections fold in around it during assembly.
 */
export const SYSTEM_PROMPT = [
  "You are canarycode, a concise terminal coding agent.",
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
  "",
  WRITING_STYLE,
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
  const core = opts.noTools ? undefined : createCoreTools();
  const extensions: SessionExtension[] = opts.noTools
    ? []
    : [
        {
          name: "core",
          tools: () => core!.tools,
          dispose: () => core!.dispose(),
        },
        ...sessionExtensions(opts.config, opts.note),
        askUserExtension(opts.askUser),
        // MUST be last: update_tasks always sits at the end of the tool set.
        tasksExtension(opts.onTasks),
      ];

  const composed = await composeExtensions(extensions, { ...opts, gate });

  // Project memory (CANARYCODE.md > AGENTS.md > CLAUDE.md, nearest dir first) is prepended
  // to the base prompt; the feature sections fold in after. The per-mode rules are
  // appended per turn by `sessionForMode`, NOT here — `system` is the base prompt.
  const projectContext = await loadProjectContext();
  const contextNote = describeContext(projectContext);
  if (contextNote) opts.note(contextNote);
  const base = composeSystemPrompt(SYSTEM_PROMPT, projectContext);
  // The environment block (OS, cwd, date, and — crucially — which shell the
  // `bash` tool actually runs in) so the model writes compatible commands and
  // never assumes the user's login shell (fish, …) is the tool shell.
  const system = [base, describeEnvironment(), ...composed.promptSections].join(
    "\n\n",
  );

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
