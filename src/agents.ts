// agents.ts — custom subagent definitions (file-defined agents).
//
// A custom agent is a single markdown file with YAML frontmatter that names a
// reusable persona for `spawn_agent` to dispatch to. Definitions live in
// `~/.cc/agents/<name>.md` (global) and `./.cc/agents/<name>.md` (project, which
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

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** Default agent directories: global (`~/.cc/agents`) then project (`./.cc/agents`). */
function agentDirs(
  cwd: string = process.cwd(),
): { dir: string; source: "global" | "project" }[] {
  return [
    { dir: join(homedir(), ".cc", "agents"), source: "global" },
    { dir: join(cwd, ".cc", "agents"), source: "project" },
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
 * Append the available custom-agents catalog (names + descriptions) to the base
 * system prompt, telling the model it can delegate to them via `spawn_agent`'s
 * `agent` parameter. No-op when there are no custom agents.
 */
export function composeAgentsPrompt(base: string, agents: AgentDef[]): string {
  if (agents.length === 0) return base;
  const lines = agents.map((a) => `- ${a.name}: ${a.description}`);
  return [
    base,
    "",
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
  return `🧑‍🚀 agents: ${agents.map((a) => a.name).join(", ")}`;
}
