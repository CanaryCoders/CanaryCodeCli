// agents.ts — delegation: custom agent definitions + the `spawn_agent` tool.
//
// This is one feature in two halves. The first half discovers custom agents:
// file-defined reusable personas that `spawn_agent` can dispatch to. The second
// half is the `spawn_agent` tool itself, which delegates a focused sub-task to a
// child agent running its own nested agent loop. The `agentsExtension()` factory
// at the bottom wires both into the extension kernel.
//
// Custom agents
// -------------
// A custom agent is a single markdown file with YAML frontmatter that names a
// reusable persona for `spawn_agent` to dispatch to. Definitions live in
// `~/.canarycode/agents/<name>.md` (global) and `./.canarycode/agents/<name>.md` (project, which
// overrides a global of the same name) — mirroring the skills layout, but flat
// files since an agent is just a prompt + a little config.
//
//   ---
//   name: test-writer
//   description: Writes thorough unit tests for a given module.
//   model: haiku                       # optional — defaults to the parent's model
//   tools: read_file, grep, write_file # optional — defaults to the full inherited set
//   ---
//   You are a meticulous test engineer. …   ← the body is the child's system prompt
//
// Only each agent's name + description go into the parent's system prompt (so it
// knows what it can delegate to); the body is loaded on demand when `spawn_agent`
// is called with that agent's name.
//
// spawn_agent
// -----------
// Why a sub-agent instead of just continuing the main loop? Isolation and token
// cost. The child sees only its task brief (plus any files the parent names) —
// not the parent's whole history — so a big, self-contained job (write the tests,
// audit a module) doesn't bloat the parent's context. The parent gets back a short
// summary, keeping its window small.
//
// Bounded so it can't fork-bomb: `maxDepth` caps nesting (a sub-agent only gets a
// nested spawn_agent while it is still under the depth cap) and `maxConcurrent`
// caps how many child loops run at once via a shared semaphore.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentOptions, runAgent } from "../agent.ts";
import { type Config, resolveModel } from "../config.ts";
import type { SessionExtension } from "../extension.ts";
import { createProvider, type Message, type Provider } from "../provider.ts";
import type { Tool } from "../tools.ts";
import {
  runPostToolHooks,
  runPreToolHooks,
  runSubagentStopHooks,
} from "./hooks.ts";

export interface AgentDef {
  /** Agent name (frontmatter `name`, falling back to the filename). */
  name: string;
  /** One-line "when to delegate to this" summary (frontmatter `description`). */
  description: string;
  /** Optional model id override (resolved against providers when spawned). */
  model?: string;
  /** Optional tool-name allowlist; undefined = inherit the parent's full set. */
  tools?: string[];
  /** The system prompt for the child agent (the markdown body). */
  system: string;
  /** Where the definition came from. Project defs override global ones by name. */
  source: "global" | "project";
}

/** Default agent directories: global (`~/.canarycode/agents`) then project (`./.canarycode/agents`). */
function agentDirs(
  cwd: string = process.cwd(),
): { dir: string; source: "global" | "project" }[] {
  return [
    { dir: join(homedir(), ".canarycode", "agents"), source: "global" },
    { dir: join(cwd, ".canarycode", "agents"), source: "project" },
  ];
}

interface ParsedAgent {
  name?: string;
  description?: string;
  model?: string;
  tools?: string[];
  body: string;
}

/**
 * Parse an agent file: a leading `---`-delimited YAML frontmatter block (simple
 * `key: value` scalars only) followed by the markdown body. `tools` is read as a
 * comma-separated list. Files with no frontmatter yield `{ body: <whole file> }`.
 */
function parseAgent(text: string): ParsedAgent {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { body: text.trim() };
  const [, front, body] = match;
  const meta: Record<string, string> = {};
  for (const line of front.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[kv[1].toLowerCase()] = value;
  }
  const tools = meta.tools
    ? meta.tools.split(",").flatMap((t) => {
        const name = t.trim();
        return name ? [name] : [];
      })
    : undefined;
  return {
    name: meta.name,
    description: meta.description,
    model: meta.model || undefined,
    tools,
    body: body.trim(),
  };
}

/**
 * Discover every custom agent in the global + project directories. Each `.md`
 * file is one agent; project defs override global defs of the same name. Missing
 * directories are skipped silently (custom agents are optional). A def with no
 * name/description or an empty body is dropped — it can't be announced or run.
 */
export async function discoverAgents(
  dirs: { dir: string; source: "global" | "project" }[] = agentDirs(),
): Promise<AgentDef[]> {
  const byName = new Map<string, AgentDef>();
  for (const { dir, source } of dirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(
      () => null,
    );
    if (!entries) continue;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(dir, entry.name);
      let text: string;
      try {
        text = await Bun.file(path).text();
      } catch {
        continue;
      }
      const parsed = parseAgent(text);
      const name = (parsed.name || entry.name.replace(/\.md$/, "")).trim();
      const description = (parsed.description || "").trim();
      if (!name || !description || !parsed.body) continue;
      byName.set(name, {
        name,
        description,
        model: parsed.model,
        tools: parsed.tools,
        system: parsed.body,
        source,
      });
    }
  }
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * The available custom-agents catalog section (names + descriptions), or
 * undefined when there are no custom agents. Tells the model it can delegate to
 * them via `spawn_agent`'s `agent` parameter. Returned as its own block so the
 * extension kernel can append it as a named system-prompt section.
 */
export function agentsPromptSection(agents: AgentDef[]): string | undefined {
  if (agents.length === 0) return undefined;
  const lines = agents.map((a) => `- ${a.name}: ${a.description}`);
  return [
    "── CUSTOM AGENTS ──",
    "You can delegate a focused sub-task to one of these purpose-built agents by",
    "calling spawn_agent with its name as the `agent` argument. Each runs with its",
    "own persona, and possibly its own model and a restricted tool set.",
    "",
    ...lines,
  ].join("\n");
}

/** A one-line stderr/startup note listing discovered agents (undefined if none). */
export function describeAgents(agents: AgentDef[]): string | undefined {
  if (agents.length === 0) return undefined;
  return `◆ agents: ${agents.map((a) => a.name).join(", ")}`;
}

// ===========================================================================
// spawn_agent — delegate a focused sub-task to a child agent
// ===========================================================================

/**
 * A tiny async counting semaphore bounding concurrent sub-agent runs. The slot is
 * handed directly to the next waiter on release (no decrement/increment churn), so
 * `active` is always an accurate count of in-flight holders.
 *
 * Note: a holder keeps its slot for its whole lifetime, including while it waits on
 * its own children, so `maxConcurrent` must be ≥ `maxDepth` to avoid a chain
 * dead-locking on itself. The default config (3 ≥ 2) satisfies this.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.max <= 0 || this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    // Resumed by release(), which handed us its slot — active already accounts for it.
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

export interface SpawnAgentEnv {
  config: Config;
  /** Provider to reuse when the sub-task does not request a different model. */
  parentProvider: Provider;
  /** Concrete model name the parent is using (inherited by default). */
  parentModel: string;
  /** Tools the child inherits, resolved at spawn time. A nested spawn_agent is
   * added on top per depth. Lazy so it can reflect the fully-composed tool set
   * (the kernel hands the complete set only after assembly finishes). */
  inheritedTools: () => Tool[];
  /** Depth of the agent that holds THIS tool (0 = top level). Children run at depth+1. */
  depth: number;
  /** Shared limiter bounding total concurrent sub-agent runs. */
  limiter: Semaphore;
  /** Abort propagated from the parent run. */
  signal?: AbortSignal;
  /** Approval gate inherited from the parent run (mutating tools only). Omitted ⇒ ungated, matching the parent. */
  gate?: AgentOptions["gate"];
  /** Custom agent definitions the model may dispatch to by name (optional). */
  agents?: AgentDef[];
}

const SUBAGENT_SYSTEM = [
  "You are a sub-agent spawned by another agent to complete one focused task.",
  "Work autonomously: use your tools to investigate and act, taking each next step",
  "yourself without asking for confirmation. You have no interaction with a human.",
  "When the task is done, reply with a concise summary of what you did and what you",
  "found — this summary is your entire return value to the parent agent, so make it",
  "self-contained and to the point.",
].join("\n");

/**
 * Build the toolset a child running at `childDepth` receives: the inherited tools
 * (optionally narrowed to a custom agent's `allow` list) plus a nested spawn_agent
 * only while still under the depth cap (and permitted by the allow list).
 */
function buildChildTools(
  env: SpawnAgentEnv,
  childDepth: number,
  allow?: string[],
): Tool[] {
  const allowed = allow ? new Set(allow) : null;
  const inherited = env.inheritedTools();
  const childTools = allowed
    ? inherited.filter((t) => allowed.has(t.name))
    : [...inherited];
  if (
    childDepth < env.config.maxDepth &&
    (!allowed || allowed.has("spawn_agent"))
  ) {
    // The env spread deliberately carries `gate` (and `signal`) down so every
    // nested spawn_agent level stays under the parent's approval gate.
    childTools.push(spawnAgentTool({ ...env, depth: childDepth }));
  }
  return childTools;
}

interface SpawnRequest {
  task: string;
  files?: string[];
  model?: string;
  /** Name of a custom agent definition to dispatch to (optional). */
  agent?: string;
}

/** Sub-agent model precedence: explicit request model → custom agent's declared
 * model → the configured `subagent` role default → (undefined ⇒ inherit parent). */
export function pickSubagentModel(
  reqModel: string | undefined,
  defModel: string | undefined,
  config: Config,
): string | undefined {
  return reqModel ?? defModel ?? config.models?.subagent;
}

/** Run one sub-agent to completion and return its summary text. Never throws —
 * failures come back as a model-readable string so the parent loop continues. */
async function runSubagent(
  env: SpawnAgentEnv,
  req: SpawnRequest,
): Promise<string> {
  if (env.depth >= env.config.maxDepth) {
    return `spawn_agent blocked: maximum sub-agent depth (${env.config.maxDepth}) reached`;
  }
  const childDepth = env.depth + 1;

  // Resolve a named custom agent, if one was requested. It supplies the child's
  // persona (system prompt), and may override the model and restrict the tools.
  let def: AgentDef | undefined;
  if (req.agent) {
    def = env.agents?.find((a) => a.name === req.agent);
    if (!def) {
      const available = env.agents?.length
        ? env.agents.map((a) => a.name).join(", ")
        : "(none)";
      return `spawn_agent: unknown agent "${req.agent}"; available: ${available}`;
    }
  }

  // Model precedence: an explicit `model` arg wins, else the custom agent's
  // declared model, else the configured subagent role, else the parent's model.
  const wantModel = pickSubagentModel(req.model, def?.model, env.config);
  let provider = env.parentProvider;
  let model = env.parentModel;
  if (wantModel && wantModel !== env.parentModel) {
    const resolved = resolveModel(env.config, wantModel);
    if (!resolved) return `spawn_agent: unknown model "${wantModel}"`;
    try {
      provider = createProvider(resolved.providerConfig);
      model = resolved.model.name ?? resolved.model.id;
    } catch (err) {
      return `spawn_agent: ${(err as Error).message}`;
    }
  }

  // Compose the brief. Named files are embedded so the child has them without a
  // round-trip (and even when they sit outside what it would think to read).
  let brief = req.task;
  if (req.files && req.files.length > 0) {
    // The file reads are independent — race them, preserving the requested order
    // in the assembled brief via the Promise.all result index.
    const blocks = await Promise.all(
      req.files.map(async (f) => {
        try {
          return `--- ${f} ---\n${await Bun.file(f).text()}`;
        } catch {
          return `--- ${f} (could not read) ---`;
        }
      }),
    );
    brief += `\n\nRelevant files:\n${blocks.join("\n\n")}`;
  }

  const tools = buildChildTools(env, childDepth, def?.tools);
  // A custom agent's body becomes the persona; the generic contract (work
  // autonomously, return a self-contained summary) is appended so the return value
  // still flows back to the parent correctly.
  const system = def ? `${def.system}\n\n${SUBAGENT_SYSTEM}` : SUBAGENT_SYSTEM;
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: brief }] },
  ];

  await env.limiter.acquire();
  let summary = "";
  let reason = "stop";
  const hookContext = { cwd: process.cwd() };
  const preToolUse = env.config.hooks.PreToolUse?.length
    ? (call: { name: string; input: unknown }) =>
        runPreToolHooks(env.config.hooks, call, hookContext)
    : undefined;
  const postToolUse = env.config.hooks.PostToolUse?.length
    ? (
        call: { name: string; input: unknown },
        result: { content: string; isError: boolean },
      ) => runPostToolHooks(env.config.hooks, call, result, hookContext)
    : undefined;
  try {
    for await (const ev of runAgent({
      provider,
      model,
      system,
      messages,
      tools,
      mode: "normal",
      maxTurns: env.config.autoMaxTurns,
      signal: env.signal,
      gate: env.gate,
      preToolUse,
      postToolUse,
    })) {
      if (ev.type === "text") summary += ev.text;
      if (ev.type === "done") reason = ev.reason;
    }
  } finally {
    if (env.config.hooks.SubagentStop?.length) {
      await runSubagentStopHooks(env.config.hooks, { ...hookContext, reason });
    }
    env.limiter.release();
  }
  return summary.trim() || "(sub-agent finished without a summary)";
}

/**
 * The `spawn_agent` tool, bound to a depth/limiter environment. Mutating
 * (`readOnly: false`) so plan mode's read-only filter drops it. Callers add it to
 * the top-level tool set only when `maxDepth > 0`; nesting is handled internally.
 */
export function spawnAgentTool(env: SpawnAgentEnv): Tool {
  // List any custom agents so the description points the model at them by name.
  const agentList = env.agents?.length
    ? ` Custom agents you can dispatch to via \`agent\`: ${env.agents
        .map((a) => a.name)
        .join(", ")}.`
    : "";
  return {
    name: "spawn_agent",
    description:
      "Delegate a focused, self-contained sub-task to a child agent that runs with its " +
      "own fresh context and returns a concise summary. Use it to keep your own context " +
      "small for large or parallelizable work (e.g. 'write tests for src/foo.ts', 'audit " +
      "the auth flow'). The child sees only the task brief and any files you name — not " +
      `this conversation — so describe the task completely.${agentList}`,
    readOnly: false,
    schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Complete, self-contained description of the sub-task to perform.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional file paths to embed in the child's brief for context.",
        },
        model: {
          type: "string",
          description:
            "Optional model id for the child (defaults to the current model).",
        },
        agent: {
          type: "string",
          description:
            "Optional name of a custom agent definition to dispatch to (its persona, " +
            "model, and tool restrictions apply). Omit for a generic sub-agent.",
        },
      },
      required: ["task"],
    },
    async run(input) {
      const task = input.task;
      if (typeof task !== "string" || task.length === 0) {
        throw new Error('missing required string argument "task"');
      }
      const files = Array.isArray(input.files)
        ? input.files.filter((f): f is string => typeof f === "string")
        : undefined;
      const model = typeof input.model === "string" ? input.model : undefined;
      const agent = typeof input.agent === "string" ? input.agent : undefined;
      return runSubagent(env, { task, files, model, agent });
    },
  };
}

// ===========================================================================
// Extension factory
// ===========================================================================

const DELEGATION_PROMPT_SECTION = [
  "## Delegation",
  "Prefer delegating distinct, self-contained tasks to sub-agents via",
  "spawn_agent with a complete brief — this keeps your own context small on",
  "large features. Dispatch to a custom agent by name (spawn_agent's `agent`",
  "argument) when one fits. Issue several spawn_agent calls in one turn when",
  "tasks are independent; run them sequentially when they touch the same",
  "files or depend on each other.",
].join("\n");

export function agentsExtension(
  dirs?: Parameters<typeof discoverAgents>[0],
): SessionExtension {
  let agents: AgentDef[] = [];
  let enabled = false;
  return {
    name: "agents",
    async tools(ctx) {
      if (ctx.config.maxDepth <= 0) return [];
      enabled = true;
      agents = await discoverAgents(dirs);
      const note = describeAgents(agents);
      if (note) ctx.note(note);
      const limiter = new Semaphore(ctx.config.maxConcurrent);
      return [
        spawnAgentTool({
          config: ctx.config,
          parentProvider: ctx.provider,
          parentModel: ctx.model,
          // Children inherit the base tools — never spawn_agent itself or
          // update_tasks (the orchestrator's own list). Resolved lazily so it
          // reflects the fully-composed set.
          inheritedTools: () =>
            ctx
              .getTools()
              .filter(
                (t) => t.name !== "spawn_agent" && t.name !== "update_tasks",
              ),
          depth: 0,
          limiter,
          signal: ctx.signal,
          agents,
          gate: ctx.gate,
        }),
      ];
    },
    systemPrompt: () => {
      if (!enabled) return undefined;
      const custom = agentsPromptSection(agents);
      return custom
        ? `${DELEGATION_PROMPT_SECTION}\n\n${custom}`
        : DELEGATION_PROMPT_SECTION;
    },
  };
}
