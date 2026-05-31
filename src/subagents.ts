// subagents.ts — the `spawn_agent` tool: delegate a focused sub-task to a child
// agent that runs its OWN nested agent loop with a fresh context window and
// returns a concise summary to the parent.
//
// Why a sub-agent instead of just continuing the main loop? Isolation and token
// cost. The child sees only its task brief (plus any files the parent names) —
// not the parent's whole history — so a big, self-contained job (write the tests,
// audit a module) doesn't bloat the parent's context. The parent gets back a short
// summary, keeping its window small.
//
// Bounded so it can't fork-bomb: `maxDepth` caps nesting (a sub-agent only gets a
// nested spawn_agent while it is still under the depth cap) and `maxConcurrent`
// caps how many child loops run at once via a shared semaphore.

import { resolveModel, type Config } from "./config.ts";
import { createProvider, type Provider, type Message } from "./provider.ts";
import { runAgent } from "./agent.ts";
import type { Tool } from "./tools.ts";

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
  /** Tools the child inherits. A nested spawn_agent is added on top per depth. */
  inheritedTools: Tool[];
  /** Depth of the agent that holds THIS tool (0 = top level). Children run at depth+1. */
  depth: number;
  /** Shared limiter bounding total concurrent sub-agent runs. */
  limiter: Semaphore;
  /** Abort propagated from the parent run. */
  signal?: AbortSignal;
}

const SUBAGENT_SYSTEM = [
  "You are a sub-agent spawned by another agent to complete one focused task.",
  "Work autonomously: use your tools to investigate and act, taking each next step",
  "yourself without asking for confirmation. You have no interaction with a human.",
  "When the task is done, reply with a concise summary of what you did and what you",
  "found — this summary is your entire return value to the parent agent, so make it",
  "self-contained and to the point.",
].join("\n");

/** Build the toolset a child running at `childDepth` receives: the inherited tools
 * plus a nested spawn_agent only while still under the depth cap. */
function buildChildTools(env: SpawnAgentEnv, childDepth: number): Tool[] {
  const childTools = [...env.inheritedTools];
  if (childDepth < env.config.maxDepth) {
    childTools.push(spawnAgentTool({ ...env, depth: childDepth }));
  }
  return childTools;
}

interface SpawnRequest {
  task: string;
  files?: string[];
  model?: string;
}

/** Run one sub-agent to completion and return its summary text. Never throws —
 * failures come back as a model-readable string so the parent loop continues. */
async function runSubagent(env: SpawnAgentEnv, req: SpawnRequest): Promise<string> {
  if (env.depth >= env.config.maxDepth) {
    return `spawn_agent blocked: maximum sub-agent depth (${env.config.maxDepth}) reached`;
  }
  const childDepth = env.depth + 1;

  // Reuse the parent's provider/model unless the task asks for a different model.
  let provider = env.parentProvider;
  let model = env.parentModel;
  if (req.model && req.model !== env.parentModel) {
    const resolved = resolveModel(env.config, req.model);
    if (!resolved) return `spawn_agent: unknown model "${req.model}"`;
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
    const blocks: string[] = [];
    for (const f of req.files) {
      try {
        blocks.push(`--- ${f} ---\n${await Bun.file(f).text()}`);
      } catch {
        blocks.push(`--- ${f} (could not read) ---`);
      }
    }
    brief += `\n\nRelevant files:\n${blocks.join("\n\n")}`;
  }

  const tools = buildChildTools(env, childDepth);
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: brief }] }];

  await env.limiter.acquire();
  let summary = "";
  try {
    for await (const ev of runAgent({
      provider,
      model,
      system: SUBAGENT_SYSTEM,
      messages,
      tools,
      mode: "normal",
      maxTurns: env.config.autoMaxTurns,
      signal: env.signal,
    })) {
      if (ev.type === "text") summary += ev.text;
    }
  } finally {
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
  return {
    name: "spawn_agent",
    description:
      "Delegate a focused, self-contained sub-task to a child agent that runs with its " +
      "own fresh context and returns a concise summary. Use it to keep your own context " +
      "small for large or parallelizable work (e.g. 'write tests for src/foo.ts', 'audit " +
      "the auth flow'). The child sees only the task brief and any files you name — not " +
      "this conversation — so describe the task completely.",
    readOnly: false,
    schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Complete, self-contained description of the sub-task to perform.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional file paths to embed in the child's brief for context.",
        },
        model: {
          type: "string",
          description: "Optional model id for the child (defaults to the current model).",
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
      return runSubagent(env, { task, files, model });
    },
  };
}
