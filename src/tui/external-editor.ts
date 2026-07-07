// tui/external-editor.ts — open the prompt buffer in $EDITOR and read it back.
//
// The TUI renderer is suspended while the editor owns the terminal, so terminal
// editors (nvim/vim) open in the same pane and hand control straight back on quit.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CliRenderer } from "@opentui/core";

function editorCommand(): string {
  return process.env.VISUAL || process.env.EDITOR || "vi";
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function editorDisplayName(): string {
  return basename(editorCommand().split(/\s+/)[0] ?? "editor");
}

export interface EditPromptInEditorOptions {
  initialText: string;
  renderer: CliRenderer | null;
}

/**
 * Open $VISUAL/$EDITOR with a temp file seeded from the current prompt. Resolves
 * to the saved file contents, or null if the editor exits unsuccessfully.
 */
export async function editPromptInEditor({
  initialText,
  renderer,
}: EditPromptInEditorOptions): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "canarycode-prompt-"));
  const file = join(dir, "prompt.md");
  await writeFile(file, initialText, "utf8");

  renderer?.suspend();
  try {
    const command = `${editorCommand()} ${quoteShellArg(file)}`;
    const proc = Bun.spawn([process.env.SHELL ?? "/bin/sh", "-lc", command], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    const code = await proc.exited;
    if (code !== 0) return null;
    return await readFile(file, "utf8");
  } finally {
    renderer?.resume();
    await rm(dir, { recursive: true, force: true });
  }
}
