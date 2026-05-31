// context.ts — discover and load flat-file project memory.
//
// On startup we walk from the cwd up to the repo root looking for a project
// context file and prepend its contents to the system prompt. Three filenames
// are recognized, in priority order: CC.md > AGENTS.md > CLAUDE.md. The first
// one found (nearest directory first, then filename priority within a directory)
// wins; any other context files that exist are noted but not loaded. This keeps
// project instructions out of config and lets a repo carry its own memory.

import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

/** Recognized context filenames, highest priority first. */
export const CONTEXT_FILENAMES = ["CC.md", "AGENTS.md", "CLAUDE.md"] as const;

export interface ContextFile {
  /** Absolute path to the file. */
  path: string;
  /** The bare filename (one of CONTEXT_FILENAMES). */
  name: string;
}

export interface ProjectContext {
  /** Trimmed contents of the winning file, or undefined if none was loaded. */
  content?: string;
  /** The file whose contents were loaded. */
  primary?: ContextFile;
  /** Context files that exist but were not loaded (priority/proximity losers). */
  others: ContextFile[];
}

/**
 * Build the chain of directories to search: `startDir` first, then each parent
 * up to (and including) the repo root — the first directory containing a `.git`.
 * If no repo root is found we stop at the home directory or the filesystem root,
 * whichever comes first, so we never scan unrelated ancestors.
 */
function dirChain(startDir: string): string[] {
  const dirs: string[] = [];
  const home = resolve(homedir());
  let dir = resolve(startDir);
  while (true) {
    dirs.push(dir);
    // A repo root (`.git` may be a directory or a worktree gitfile) ends the walk.
    if (existsSync(join(dir, ".git"))) break;
    if (dir === home) break;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return dirs;
}

/**
 * Find every recognized context file at or above `startDir`, ordered by search
 * priority: nearest directory first, and within a directory CC.md > AGENTS.md >
 * CLAUDE.md. The first element (if any) is the one that should be loaded.
 */
export async function findContextFiles(startDir: string = process.cwd()): Promise<ContextFile[]> {
  const found: ContextFile[] = [];
  for (const dir of dirChain(startDir)) {
    for (const name of CONTEXT_FILENAMES) {
      const path = join(dir, name);
      if (await Bun.file(path).exists()) found.push({ path, name });
    }
  }
  return found;
}

/**
 * Resolve the project context: the first non-empty recognized file at or above
 * `startDir` becomes `primary`; remaining found files are recorded in `others`.
 * Empty or unreadable files are skipped so they can't shadow a real one.
 */
export async function loadProjectContext(startDir: string = process.cwd()): Promise<ProjectContext> {
  const found = await findContextFiles(startDir);
  let primary: ContextFile | undefined;
  let content: string | undefined;
  for (const f of found) {
    let text: string;
    try {
      text = (await Bun.file(f.path).text()).trim();
    } catch {
      continue; // unreadable — treat as absent
    }
    if (text) {
      primary = f;
      content = text;
      break;
    }
  }
  const others = found.filter((f) => f !== primary);
  return { content, primary, others };
}

/** Prepend loaded project context to the base system prompt (no-op if none). */
export function composeSystemPrompt(base: string, ctx: ProjectContext): string {
  if (!ctx.content || !ctx.primary) return base;
  return `${base}\n\n── PROJECT CONTEXT (${ctx.primary.name}) ──\n${ctx.content}`;
}

/** A one-line note for stderr describing what context was loaded (undefined if none). */
export function describeContext(ctx: ProjectContext): string | undefined {
  if (!ctx.primary) return undefined;
  let note = `📄 context: ${ctx.primary.name}`;
  if (ctx.others.length > 0) {
    const names = [...new Set(ctx.others.map((o) => o.name))].join(", ");
    note += ` (also present, not loaded: ${names})`;
  }
  return note;
}
