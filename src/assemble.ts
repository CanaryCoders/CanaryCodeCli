// src/assemble.ts — one place where a session's capabilities are decided.
//
// Both frontends (headless CLI and TUI) call this with their own callbacks;
// nothing else may construct the tool set or compose the system prompt. Each
// feature is an Extension; deleting a line here removes the feature whole.
//
// The inline Extension objects below are transplanted verbatim from what
// runHeadless used to do by hand. Later tasks formalize them into src/extensions/
// files; for now they live here so the wiring lives in exactly one place.

import { systemForMode } from "./agent.ts";
import {
  composeSystemPrompt,
  describeContext,
  loadProjectContext,
} from "./context.ts";
import type {
  ComposedExtensions,
  Extension,
  ExtensionHost,
} from "./extension.ts";
import { composeExtensions } from "./extension.ts";
import { agentsExtension } from "./extensions/agents.ts";
import { type AskUserFn, askUserExtension } from "./extensions/askuser.ts";
import { hooksExtension } from "./extensions/hooks.ts";
import { mcpExtension } from "./extensions/mcp.ts";
import { buildPermissionGate, composeGates } from "./extensions/permission.ts";
import { skillsExtension } from "./extensions/skills.ts";
import { webSearchExtension } from "./extensions/websearch.ts";
import { updateTasksTool } from "./tasks.ts";
import { tools as allTools } from "./tools.ts";

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
  "## Tasks",
  'When a request spans multiple distinct issues (e.g. "X is broken; also Y bothers me; also fix Z") OR is a large, multi-step feature, call update_tasks FIRST to lay the work out as a task list (one task per distinct issue or major step), then keep it current — mark a task in_progress before you start it and completed the moment it is finished.',
  "For a single, small, self-contained request, skip this and just do the work inline — do not create a task list for trivial work.",
  "",
  "ALWAYS end your turn with a recap once you have finished working (i.e. your final reply that makes no further tool calls). Never stop after a tool call without a closing message. The recap is mandatory — even for small tasks or when nothing changed. Format it exactly as:",
  "",
  "## Recap",
  "- <what you did, one bullet per change or finding>",
  "",
  "Keep it short: list files touched and the key changes, plus anything the user should know (follow-ups, caveats, how to verify). If the task produced no changes, say so explicitly.",
].join("\n");

export interface AssembleOptions extends Omit<ExtensionHost, "gate"> {
  gate?: ExtensionHost["gate"];
  /** Answer ask_user questions (interactive in TUI, autoAnswer in headless). */
  askUser: AskUserFn;
  /** Render the agent's task list (stderr checklist / TUI component). */
  onTasks: Parameters<typeof updateTasksTool>[0];
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
  const { mode } = opts;

  // Build the AI permission gate and compose it with the frontend's own gate
  // BEFORE composing extensions, so `ctx.gate` (which the agents extension hands
  // to its children) already includes the AI check. The AI gate runs first; a
  // deny short-circuits before the frontend gate (the TUI confirm box) is asked.
  const aiGate =
    mode !== "auto" && opts.config.permission.mode === "ai"
      ? buildPermissionGate({
          config: opts.config,
          signal: opts.signal,
          note: opts.note,
        })
      : undefined;
  const gate = composeGates(aiGate, opts.gate);

  const extensions: Extension[] = opts.noTools
    ? []
    : [
        { name: "core", tools: () => allTools },
        webSearchExtension(),
        skillsExtension(),
        askUserExtension(opts.askUser),
        mcpExtension(),
        agentsExtension(),
        hooksExtension(),
        {
          // MUST be last: update_tasks always sits at the end of the tool set.
          name: "tasks",
          tools: (ctx) => [updateTasksTool(opts.onTasks, ctx.config)],
        },
      ];

  const composed = await composeExtensions(extensions, { ...opts, gate });
  let tools = composed.tools;
  if (mode === "plan") tools = tools.filter((t) => t.readOnly);

  // Project memory (CC.md > AGENTS.md > CLAUDE.md, nearest dir first) is prepended
  // to the base prompt; the feature sections and per-mode rules fold in after.
  const projectContext = await loadProjectContext();
  const contextNote = describeContext(projectContext);
  if (contextNote) opts.note(contextNote);
  const base = composeSystemPrompt(SYSTEM_PROMPT, projectContext);
  const system = systemForMode(
    [base, ...composed.promptSections].join("\n\n"),
    mode,
  );

  return { ...composed, tools, system, gate };
}
