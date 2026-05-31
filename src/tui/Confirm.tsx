// tui/Confirm.tsx — the confirm-before-running box (the optional bash/write gate).
//
// When `confirm` is configured (off | bash | writes) and a gated, mutating tool
// is about to run, App pauses the agent loop and renders this box: the full shell
// command for `bash`, or a unified diff of the pending write/edit so the user can
// see exactly what would change before approving. `[y]es` runs it, `[n]o` declines
// it (the model gets a "user declined" result and adapts), `[a]lways` runs it and
// disables the gate for the rest of the session. Auto mode and `--yolo` never
// reach here — they bypass the gate by design.

import { Box, Text } from "ink";
import { computeDiff, type Diff } from "../diff.ts";
import { DiffView, summarizeToolInput } from "./Message.tsx";
import { SPACING, tint } from "./theme.ts";

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

/** Render the pending-call confirmation box. */
export function ConfirmView({
  preview,
}: {
  preview: ConfirmPreview;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tint("yellow")}
      paddingX={SPACING.boxPadX}
      marginTop={SPACING.inputGap}
    >
      <Text color={tint("yellow")} bold>
        Run this?
      </Text>
      {preview.kind === "bash" ? (
        <Text>{`$ ${preview.command}`}</Text>
      ) : preview.kind === "diff" ? (
        <Box flexDirection="column">
          <Text dimColor>{preview.path}</Text>
          <DiffView diff={preview.diff} expanded />
        </Box>
      ) : (
        <Text>
          {preview.summary
            ? `${preview.name}: ${preview.summary}`
            : preview.name}
        </Text>
      )}
      <Text dimColor>{"[y]es · [n]o · [a]lways (this session)"}</Text>
    </Box>
  );
}
