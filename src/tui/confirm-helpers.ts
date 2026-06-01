// tui/confirm-helpers.ts — non-component helpers for Confirm.tsx.
//
// Split out of Confirm.tsx so that module exports only React components, keeping
// the fast-refresh boundary intact (react-doctor/only-export-components). The
// previewable shape lives here too, with Confirm.tsx re-exporting it for callers.

import { computeDiff, type Diff } from "../diff.ts";
import { summarizeToolInput } from "./message-helpers.ts";

/** A previewable description of a pending mutating call. */
export type ConfirmPreview =
  | { kind: "bash"; command: string }
  | { kind: "diff"; path: string; diff: Diff }
  | { kind: "generic"; name: string; summary: string };

export type ConfirmChoice = "yes" | "no" | "always";

/** Map a pressed key to a confirm choice (case-insensitive). */
export function confirmChoiceForKey(input: string): ConfirmChoice | null {
  switch (input.toLowerCase()) {
    case "y":
      return "yes";
    case "n":
      return "no";
    case "a":
      return "always";
    default:
      return null;
  }
}

/**
 * Build the preview for a pending call. For `write_file`/`edit_file` it reads the
 * target file and computes the diff the write *would* produce — without writing
 * anything — so the user reviews the change before it happens. `bash` shows the
 * full command; anything else falls back to a one-line summary.
 */
export async function buildConfirmPreview(call: {
  name: string;
  input: unknown;
}): Promise<ConfirmPreview> {
  const input = (call.input ?? {}) as Record<string, unknown>;

  if (call.name === "bash") {
    return { kind: "bash", command: String(input.command ?? "") };
  }

  if (
    call.name === "write_file" &&
    typeof input.path === "string" &&
    input.path
  ) {
    const file = Bun.file(input.path);
    const old = (await file.exists()) ? await file.text() : "";
    const content = typeof input.content === "string" ? input.content : "";
    return { kind: "diff", path: input.path, diff: computeDiff(old, content) };
  }

  if (
    call.name === "edit_file" &&
    typeof input.path === "string" &&
    input.path
  ) {
    const file = Bun.file(input.path);
    if (await file.exists()) {
      const text = await file.text();
      const oldStr = typeof input.old === "string" ? input.old : "";
      const newStr = typeof input.new === "string" ? input.new : "";
      // Mirror the tool's own splice (indexOf/split, never String.replace — its
      // `$` substitutions would corrupt the preview).
      if (oldStr && text.includes(oldStr)) {
        const updated = input.replace_all
          ? text.split(oldStr).join(newStr)
          : (() => {
              const at = text.indexOf(oldStr);
              return (
                text.slice(0, at) + newStr + text.slice(at + oldStr.length)
              );
            })();
        return {
          kind: "diff",
          path: input.path,
          diff: computeDiff(text, updated),
        };
      }
    }
  }

  return {
    kind: "generic",
    name: call.name,
    summary: summarizeToolInput(call.name, call.input),
  };
}
