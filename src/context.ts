// context.ts — discover and load flat-file project memory.
//
// On startup we walk from the cwd up to the repo root looking for a project
// context file and prepend its contents to the system prompt. Three filenames
// are recognized, in priority order: CC.md > AGENTS.md > CLAUDE.md. The first
// one found (nearest directory first, then filename priority within a directory)
// wins; any other context files that exist are noted but not loaded. This keeps
// project instructions out of config and lets a repo carry its own memory.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
export async function findContextFiles(
  startDir: string = process.cwd(),
): Promise<ContextFile[]> {
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
export async function loadProjectContext(
  startDir: string = process.cwd(),
): Promise<ProjectContext> {
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

/**
 * A starter CC.md template for `/init`. `name` labels the project (detected from
 * package.json or the directory name). Kept deliberately small — a scaffold the
 * user fills in, not a generated essay.
 */
export function starterContext(name: string): string {
  return `# ${name}

Project context for \`cc\`. This file is prepended to the system prompt so the
agent knows how to work in this repo. Keep it short and high-signal.

## Overview

<!-- One or two sentences: what this project is and does. -->

## Stack

<!-- Languages, frameworks, runtimes, and key libraries. -->

## Commands

<!-- How to build, test, run, and lint. e.g.
- build: \`...\`
- test:  \`...\`
- lint:  \`...\`
-->

## Conventions

<!-- Code style, patterns, and any rules the agent must follow. -->
`;
}

/**
 * Detect a project name for the starter template: the `name` field of a
 * package.json in `dir`, else the directory's basename.
 */
async function detectProjectName(dir: string): Promise<string> {
  try {
    const pkg = await Bun.file(join(dir, "package.json")).json();
    if (pkg && typeof pkg.name === "string" && pkg.name.trim())
      return pkg.name.trim();
  } catch {
    // no package.json or unparseable — fall through to the directory name
  }
  return resolve(dir).split("/").pop() || "project";
}

/** Result of an `/init` attempt. */
export interface InitResult {
  /** Absolute path to the CC.md (whether or not it was created). */
  path: string;
  /** True if a new file was written; false if one already existed (left intact). */
  created: boolean;
  /** The starter content written (only when `created`). */
  content?: string;
}

/**
 * Generate a starter CC.md in `dir` (default cwd) for `/init`. Refuses to
 * overwrite an existing CC.md — returns `created:false` so the caller can warn
 * instead of clobbering project memory.
 */
export async function initProjectContext(
  dir: string = process.cwd(),
): Promise<InitResult> {
  const path = join(dir, "CC.md");
  if (existsSync(path)) return { path, created: false };
  const content = starterContext(await detectProjectName(dir));
  await Bun.write(path, content);
  return { path, created: true, content };
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
