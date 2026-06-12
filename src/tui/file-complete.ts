// tui/file-complete.ts — inline @file completion for the prompt box.
//
// The source of candidates is `git ls-files` plus untracked non-ignored files, so
// the popup follows .gitignore without pulling in node_modules/build outputs.

import type { Completion } from "../commands.ts";
import { fuzzyRank } from "../fuzzy.ts";

const MAX_FILE_COMPLETIONS = 50;
const REFRESH_MS = 2_000;
const ACTIVE_MENTION_RE = /(^|\s)@([^\s@]*)$/;

let cachedAt = 0;
let cachedFiles: string[] = [];

async function refreshFiles(): Promise<string[]> {
  const proc = Bun.spawn({
    cmd: ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return cachedFiles;
  cachedFiles = out.split("\n").filter(Boolean).sort();
  cachedAt = Date.now();
  return cachedFiles;
}

export async function listMentionableFiles(): Promise<string[]> {
  if (Date.now() - cachedAt < REFRESH_MS) return cachedFiles;
  return refreshFiles();
}

function activeMention(input: string): { start: number; query: string } | null {
  const match = input.match(ACTIVE_MENTION_RE);
  if (!match || match.index === undefined) return null;
  const prefix = match[1] ?? "";
  return { start: match.index + prefix.length, query: match[2] ?? "" };
}

export function fileMentionCompletions(
  input: string,
  files: string[],
): Completion[] {
  const active = activeMention(input);
  if (!active) return [];
  const before = input.slice(0, active.start);
  const after = input.slice(active.start + 1 + active.query.length);
  return fuzzyRank(active.query, files, (file) => file)
    .slice(0, MAX_FILE_COMPLETIONS)
    .map((r) => ({
      value: `${before}@${r.item}${after}`,
      label: `@${r.item}`,
    }));
}
