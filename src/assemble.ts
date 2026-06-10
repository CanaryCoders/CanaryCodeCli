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
  agentsPromptSection,
  describeAgents,
  discoverAgents,
} from "./agents.ts";
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
import { type AskUserFn, askUserExtension } from "./extensions/askuser.ts";
import { webSearchExtension } from "./extensions/websearch.ts";
import { runPostToolHooks, runPreToolHooks } from "./hooks.ts";
import {
  closeMcp,
  connectMcpServers,
  describeMcp,
  type McpConnection,
} from "./mcp.ts";
import {
  describeSkills,
  discoverSkills,
  readSkillTool,
  skillsPromptSection,
} from "./skills.ts";
import { Semaphore, spawnAgentTool } from "./subagents.ts";
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
  "## Tasks and delegation",
  'When a request spans multiple distinct issues (e.g. "X is broken; also Y bothers me; also fix Z") OR is a large, multi-step feature, you MUST:',
  "1. Call update_tasks FIRST to lay the work out as a task list (one task per distinct issue or major step), then keep it current — mark a task in_progress before you start it and completed the moment it is finished.",
  "2. Work each task by delegating it to a sub-agent via spawn_agent with a complete, self-contained brief. This keeps your own context small, which matters most on large features where earlier context is lost to compaction.",
  "3. When a custom agent (see the CUSTOM AGENTS section, if present) fits a task, dispatch to it by name via spawn_agent's `agent` argument instead of a generic sub-agent.",
  "4. Decide per task whether the sub-agents can run in parallel (independent tasks — issue several spawn_agent calls in one turn) or must run sequentially (tasks that touch the same files or depend on each other's output).",
  "For a single, small, self-contained request, skip all of this and just do the work inline — do not create a task list or spawn sub-agents for trivial work.",
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
}

export async function assembleSession(
  opts: AssembleOptions,
): Promise<AssembledSession> {
  const { mode } = opts;
  // The MCP extension records its live connection here so dispose() closes exactly
  // what it opened (the connection isn't known until tools() runs).
  let mcpConn: McpConnection | undefined;

  const extensions: Extension[] = opts.noTools
    ? []
    : [
        { name: "core", tools: () => allTools },
        webSearchExtension(),
        {
          name: "skills",
          async tools(ctx) {
            const skills = await discoverSkills();
            const note = describeSkills(skills);
            if (note) ctx.note(note);
            return [readSkillTool(skills)];
          },
          // Re-discovered so the section reflects exactly what was offered; skills
          // are cheap file reads and discovery is deterministic.
          systemPrompt: async () => skillsPromptSection(await discoverSkills()),
        },
        askUserExtension(opts.askUser),
        {
          name: "mcp",
          async tools(ctx) {
            const configured = Object.keys(ctx.config.mcpServers).length;
            // No servers configured ⇒ don't connect at all (matches headless).
            if (configured === 0) return [];
            const conn = await connectMcpServers(ctx.config.mcpServers);
            const note = describeMcp(conn, configured);
            if (note) ctx.note(note);
            mcpConn = conn;
            return conn.tools;
          },
          dispose: async () => {
            if (mcpConn) await closeMcp(mcpConn);
          },
        },
        {
          name: "agents",
          async tools(ctx) {
            // Sub-agents disabled ⇒ no spawn_agent tool (matches headless).
            if (ctx.config.maxDepth <= 0) return [];
            const agents = await discoverAgents();
            const note = describeAgents(agents);
            if (note) ctx.note(note);
            const limiter = new Semaphore(ctx.config.maxConcurrent);
            return [
              spawnAgentTool({
                config: ctx.config,
                parentProvider: ctx.provider,
                parentModel: ctx.model,
                // Children inherit the base tools — never spawn_agent itself or
                // update_tasks (the orchestrator's own list). Resolved lazily so
                // it reflects the fully-composed set.
                inheritedTools: () =>
                  ctx
                    .getTools()
                    .filter(
                      (t) =>
                        t.name !== "spawn_agent" && t.name !== "update_tasks",
                    ),
                depth: 0,
                limiter,
                signal: ctx.signal,
                agents,
                gate: ctx.gate,
              }),
            ];
          },
          systemPrompt: async () => agentsPromptSection(await discoverAgents()),
        },
        {
          name: "hooks",
          async preToolUse(call, ctx) {
            if (!ctx.config.hooks.PreToolUse?.length) return { allow: true };
            return runPreToolHooks(ctx.config.hooks, call, {
              sessionId: ctx.sessionId,
              cwd: process.cwd(),
            });
          },
          async postToolUse(call, result, ctx) {
            if (!ctx.config.hooks.PostToolUse?.length) return;
            await runPostToolHooks(ctx.config.hooks, call, result, {
              sessionId: ctx.sessionId,
              cwd: process.cwd(),
            });
          },
        },
        {
          // MUST be last: update_tasks always sits at the end of the tool set.
          name: "tasks",
          tools: (ctx) => [updateTasksTool(opts.onTasks, ctx.config)],
        },
      ];

  const composed = await composeExtensions(extensions, opts);
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

  return { ...composed, tools, system };
}
