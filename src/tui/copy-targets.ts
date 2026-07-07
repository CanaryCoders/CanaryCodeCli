// tui/copy-targets.ts — source-text extraction for transcript copy actions.
//
// Explicit copy actions must copy the original/source text, not wrapped terminal
// rows, visual table padding, code gutters, or language labels. Keep the logic pure
// so tests cover the important portability contract independently of the renderer.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item } from "./Message.tsx";
import { fmtInput } from "./message-helpers.ts";

export type CopyKind =
  | "message"
  | "code"
  | "table-markdown"
  | "table-tsv"
  | "tool-command"
  | "tool-output";

export interface CopyTarget {
  kind: CopyKind;
  label: string;
  text: string;
}

const FENCE = /^\s*(```|~~~)\s*(.*?)\s*$/;

/** Conservative OSC 52 payload cap. Terminals vary, and oversized control
 * sequences can be dropped silently or make redraws sluggish. */
export const OSC52_MAX_TEXT_BYTES = 100_000;

type ClipboardEnv = Record<string, string | undefined>;

interface ClipboardWriter {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export function isSshSession(env: ClipboardEnv = process.env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

export function osc52ClipboardSequence(
  text: string,
  env: ClipboardEnv = process.env,
): string | null {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > OSC52_MAX_TEXT_BYTES) return null;
  const payload = bytes.toString("base64");
  const sequence = `\x1b]52;c;${payload}\x07`;
  // tmux needs the OSC sequence wrapped in a DCS passthrough. The doubled ESC
  // before ]52 is tmux's escape for a literal ESC in the inner sequence.
  return env.TMUX ? `\x1bPtmux;\x1b${sequence}\x1b\\` : sequence;
}

export function writeOsc52Clipboard(
  text: string,
  env: ClipboardEnv = process.env,
  writer: ClipboardWriter = process.stdout,
): boolean {
  if (!writer.isTTY) return false;
  const sequence = osc52ClipboardSequence(text, env);
  if (!sequence) return false;
  writer.write(sequence);
  return true;
}

export function copyTargetForItem(item: Item): CopyTarget | null {
  if (item.kind === "user") {
    return { kind: "message", label: "user message", text: item.text };
  }
  if (item.kind === "assistant" || item.kind === "thinking") {
    return { kind: "message", label: "assistant message", text: item.text };
  }
  if (item.kind === "tool") {
    const output = item.result ?? "";
    return {
      kind: "tool-output",
      label: "tool output",
      text: output || fmtInput(item.input),
    };
  }
  if (item.kind === "note") {
    return { kind: "message", label: "note", text: item.text };
  }
  return null;
}

export function extractCodeBlocks(markdown: string): CopyTarget[] {
  const lines = markdown.split("\n");
  const targets: CopyTarget[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]!);
    if (!open) continue;
    const marker = open[1]!;
    const language = open[2]!.trim().split(/\s+/)[0] || "code";
    const code: string[] = [];
    i++;
    while (i < lines.length) {
      const close = FENCE.exec(lines[i]!);
      if (close && close[1] === marker) break;
      code.push(lines[i]!);
      i++;
    }
    targets.push({ kind: "code", label: language, text: code.join("\n") });
  }
  return targets;
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = body.split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isSeparator(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

export function extractMarkdownTables(markdown: string): CopyTarget[] {
  const lines = markdown.split("\n");
  const targets: CopyTarget[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = splitTableRow(lines[i]!);
    const separator = splitTableRow(lines[i + 1]!);
    if (!header || !separator || !isSeparator(separator)) continue;
    const tableLines = [lines[i]!, lines[i + 1]!];
    const rows = [header];
    i += 2;
    while (i < lines.length) {
      const row = splitTableRow(lines[i]!);
      if (!row) break;
      tableLines.push(lines[i]!);
      rows.push(row);
      i++;
    }
    i--;
    targets.push({
      kind: "table-markdown",
      label: "table",
      text: tableLines.join("\n"),
    });
    targets.push({
      kind: "table-tsv",
      label: "table tsv",
      text: rows.map((row) => row.join("\t")).join("\n"),
    });
  }
  return targets;
}

export function copyTargetsForItem(item: Item): CopyTarget[] {
  const base = copyTargetForItem(item);
  const targets = base ? [base] : [];
  if (item.kind === "assistant" || item.kind === "thinking") {
    targets.push(...extractCodeBlocks(item.text));
    targets.push(...extractMarkdownTables(item.text));
  }
  if (item.kind === "tool") {
    targets.push({
      kind: "tool-command",
      label: "tool command",
      text: fmtInput(item.input),
    });
    if (item.result !== undefined) {
      targets.push({
        kind: "tool-output",
        label: "tool output",
        text: item.result,
      });
    }
  }
  return targets.filter((target) => target.text.length > 0);
}

/**
 * Resolve the CopyTarget a transcript copy chip should write, given the chip's
 * `kind`. Tool cards expose two chips ("command"/"output"); every other item has
 * a single default chip. Returns null when there is nothing to copy.
 */
export function resolveItemCopyTarget(
  item: Item,
  kind: "default" | "command" | "output" = "default",
): CopyTarget | null {
  if (kind === "command" || kind === "output") {
    const wanted = kind === "command" ? "tool-command" : "tool-output";
    return copyTargetsForItem(item).find((t) => t.kind === wanted) ?? null;
  }
  const base = copyTargetForItem(item);
  return base && base.text.length > 0 ? base : null;
}

/**
 * Write a copy target to the clipboard and return a human status note: a success
 * line on a clean copy, or — when no clipboard tool exists — the temp-file path
 * the text was spilled to instead (still informative, not an error).
 */
export async function copyTargetToClipboard(
  target: CopyTarget,
): Promise<string> {
  const result = await writeTextToClipboard(target.text);
  return result.ok
    ? `copied ${target.label} to clipboard`
    : `clipboard unavailable — wrote ${target.label} to ${result.path}`;
}

/**
 * Concatenated source text of a focus group (for the `Y` whole-group yank): each
 * member's primary copy target text, joined by a blank line. Members with no
 * copyable text (e.g. an empty note) are skipped, so the result has no stray gaps.
 */
export function groupCopyText(items: Item[]): string {
  return items
    .map((item) => copyTargetForItem(item)?.text ?? "")
    .filter((text) => text.length > 0)
    .join("\n\n");
}

export function lastAssistantCopyTarget(items: Item[]): CopyTarget | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "assistant") return copyTargetForItem(item);
  }
  return null;
}

export async function writeTextToClipboard(
  text: string,
  platform: NodeJS.Platform = process.platform,
  env: ClipboardEnv = process.env,
  writer: ClipboardWriter = process.stdout,
): Promise<{ ok: true } | { ok: false; path: string }> {
  if (text.length === 0) return { ok: true };

  // Over SSH, native clipboard tools copy on the remote machine. OSC 52 asks the
  // user's local terminal to set its clipboard instead, which is what users expect.
  if (isSshSession(env) && writeOsc52Clipboard(text, env, writer)) {
    return { ok: true };
  }

  const command =
    platform === "darwin"
      ? ["pbcopy"]
      : platform === "win32"
        ? ["clip"]
        : [
            "sh",
            "-c",
            "command -v wl-copy >/dev/null && wl-copy || xclip -selection clipboard",
          ];
  try {
    const proc = Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(text);
    await proc.stdin.end();
    if ((await proc.exited) === 0) return { ok: true };
  } catch {
    // Fall through to OSC 52 / temp-file fallback.
  }

  if (writeOsc52Clipboard(text, env, writer)) return { ok: true };

  const dir = await mkdtemp(join(tmpdir(), "canarycode-copy-"));
  const path = join(dir, "copied.txt");
  await writeFile(path, text, "utf8");
  return { ok: false, path };
}
