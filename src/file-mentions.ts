// file-mentions.ts — @file references in prompts.
//
// The TUI uses this to offer inline @ completions, and both frontends use it to
// eagerly read mentioned files into the user turn before the agent can respond.
// Paths are intentionally project-relative: @README.md, @docs/plan.md, etc.

import { relative, resolve, sep } from "node:path";

export interface MentionedFile {
  /** Project-relative path as typed after @. */
  path: string;
  /** UTF-8 file contents. */
  text: string;
}

const TRAILING_PUNCTUATION = /[),.;:!?]+$/;
const MENTION_RE = /(^|\s)@([^\s]+)/g;

function cleanMention(raw: string): string {
  return raw.replace(TRAILING_PUNCTUATION, "");
}

/** True when `path` stays inside `cwd` and is a project-relative file path. */
function isSafeRelativePath(path: string, cwd = process.cwd()): boolean {
  if (!path || path.startsWith("/") || path.startsWith("~")) return false;
  const abs = resolve(cwd, path);
  const rel = relative(cwd, abs);
  return rel !== "" && !rel.startsWith("..") && !rel.split(sep).includes("..");
}

/** Extract unique @file mentions from free-form prompt text, in mention order. */
export function extractFileMentions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const path = cleanMention(m[2] ?? "");
    if (!isSafeRelativePath(path) || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/** Read all @mentioned files. Missing/binary/unreadable files are reported. */
export async function readMentionedFiles(
  text: string,
): Promise<{ files: MentionedFile[]; errors: string[] }> {
  const files: MentionedFile[] = [];
  const errors: string[] = [];
  for (const path of extractFileMentions(text)) {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) {
        errors.push(`${path}: no such file`);
        continue;
      }
      files.push({ path, text: await file.text() });
    } catch (err) {
      errors.push(`${path}: ${(err as Error).message}`);
    }
  }
  return { files, errors };
}

/** Append the contents of mentioned files to the model-facing prompt text. */
export function appendMentionedFilesToPrompt(
  prompt: string,
  files: MentionedFile[],
): string {
  if (files.length === 0) return prompt;
  const blocks = files.map(
    (f) => `--- ${f.path} ---\n${f.text}\n--- end ${f.path} ---`,
  );
  return `${prompt}\n\nThe user mentioned the following files with @. Read and use them before doing anything else:\n\n${blocks.join("\n\n")}`;
}
