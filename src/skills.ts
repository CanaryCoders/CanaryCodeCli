// skills.ts — progressive-disclosure capabilities (the `pi` approach).
//
// A skill is a folder containing a `SKILL.md` file with YAML frontmatter
// (`name`, `description`) and a body of instructions/resources. Skills live in
// `~/.cc/skills/<skill>/SKILL.md` (global) and `./.cc/skills/<skill>/SKILL.md`
// (project). On startup we discover them and inject ONLY each skill's name and
// description into the system prompt — cheap. The full body is loaded on demand
// when the model decides a skill is relevant, via the read-only `read_skill`
// tool. This keeps the prompt small while making many capabilities available.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool } from "./tools.ts";

export interface Skill {
  /** Skill name (frontmatter `name`, falling back to the folder name). */
  name: string;
  /** One-line "when to use" summary (frontmatter `description`). */
  description: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Where the skill came from. Project skills override global ones by name. */
  source: "global" | "project";
}

/** Parsed frontmatter + the remaining body of a SKILL.md file. */
export interface ParsedSkill {
  name?: string;
  description?: string;
  body: string;
}

/** Default skill directories: global (`~/.cc/skills`) then project (`./.cc/skills`). */
export function skillDirs(
  cwd: string = process.cwd(),
): { dir: string; source: "global" | "project" }[] {
  return [
    { dir: join(homedir(), ".cc", "skills"), source: "global" },
    { dir: join(cwd, ".cc", "skills"), source: "project" },
  ];
}

/**
 * Parse a SKILL.md file: a leading `---`-delimited YAML frontmatter block (only
 * simple `key: value` scalars are read) followed by the markdown body. Files
 * with no frontmatter yield `{ body: <whole file> }`.
 */
export function parseSkill(text: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { body: text.trim() };
  const [, front, body] = match;
  const meta: Record<string, string> = {};
  for (const line of front.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    // Strip matching surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[kv[1].toLowerCase()] = value;
  }
  return { name: meta.name, description: meta.description, body: body.trim() };
}

/**
 * Discover every skill at or below the given directories. Each immediate
 * subdirectory holding a `SKILL.md` is a skill. Project skills override global
 * skills that share a name. Missing/unreadable directories are skipped silently
 * (skills are optional). Skills with an empty name/description are dropped.
 */
export async function discoverSkills(
  dirs: { dir: string; source: "global" | "project" }[] = skillDirs(),
): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  for (const { dir, source } of dirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(
      () => null,
    );
    if (!entries) continue; // directory absent — no skills from here
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name, "SKILL.md");
      let text: string;
      try {
        text = await Bun.file(path).text();
      } catch {
        continue; // no SKILL.md in this folder
      }
      const parsed = parseSkill(text);
      const name = (parsed.name || entry.name).trim();
      const description = (parsed.description || "").trim();
      if (!name || !description) continue; // a skill must announce itself
      // Later sources (project) win on name collision.
      byName.set(name, { name, description, path, source });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Append the available-skills catalog (names + descriptions only) to the base
 * system prompt. No-op when there are no skills. The model is told to call
 * `read_skill` to load a skill's full instructions before using it.
 */
export function composeSkillsPrompt(base: string, skills: Skill[]): string {
  if (skills.length === 0) return base;
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    base,
    "",
    "── SKILLS ──",
    "The following skills are available. Each is a set of instructions you can load on demand.",
    "When a skill is relevant to the task, call read_skill with its name to load its full instructions BEFORE acting.",
    "",
    ...lines,
  ].join("\n");
}

/** A one-line stderr note describing which skills were discovered (undefined if none). */
export function describeSkills(skills: Skill[]): string | undefined {
  if (skills.length === 0) return undefined;
  return `🧩 skills: ${skills.map((s) => s.name).join(", ")}`;
}

/**
 * Build the read-only `read_skill` tool over a discovered skill set. It returns
 * the full SKILL.md body for a named skill so the model can follow its
 * instructions. Read-only, so it is allowed in plan mode.
 */
export function readSkillTool(skills: Skill[]): Tool {
  const index = new Map(skills.map((s) => [s.name, s]));
  return {
    name: "read_skill",
    description:
      "Load the full instructions for one of the available skills (listed in the SKILLS section of the system prompt). Pass the skill's `name`. Returns the skill's complete guidance; follow it for the current task.",
    readOnly: true,
    schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The skill name to load (exact match).",
        },
      },
      required: ["name"],
    },
    async run(input) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) throw new Error('missing required string argument "name"');
      const skill = index.get(name);
      if (!skill) {
        const available =
          skills.length > 0 ? skills.map((s) => s.name).join(", ") : "(none)";
        throw new Error(`no such skill "${name}"; available: ${available}`);
      }
      const text = await Bun.file(skill.path).text();
      return parseSkill(text).body || text.trim();
    },
  };
}
