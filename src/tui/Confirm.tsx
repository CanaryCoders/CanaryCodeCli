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
import type { ConfirmPreview } from "./confirm-helpers.ts";
import { useIcon } from "./Icon.tsx";
import { DiffView } from "./Message.tsx";
import { SPACING, tint } from "./theme.ts";

// Re-export the preview/choice types and helpers' shapes for callers that still
// reach for them via this module. The value helpers live in confirm-helpers.ts
// (see only-export-components); these type re-exports are erased at build time.
export type { ConfirmChoice, ConfirmPreview } from "./confirm-helpers.ts";

/** Render the pending-call confirmation box. */
export function ConfirmView({
  preview,
  reason,
  columns = 80,
}: {
  preview: ConfirmPreview;
  /** When set, the AI safety check flagged this call — shown above the prompt. */
  reason?: string | null;
  /** Terminal width — the diff preview pads its +/− bands to fit inside the box. */
  columns?: number;
}): React.ReactElement {
  const warningIcon = useIcon("warning");
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
      {reason ? (
        <Box>
          {/* width=2 leaves room for two-cell Nerd Font glyphs so the icon can't
              eat the following space; flexShrink=0 keeps the fixed cell from
              going fractional beside flexible text (see Message.tsx RuleRow). */}
          <Box width={2} flexShrink={0}>
            <Text color={tint("yellow")}>{warningIcon}</Text>
          </Box>
          <Box marginLeft={1}>
            <Text color={tint("yellow")}>
              {`flagged by safety check: ${reason}`}
            </Text>
          </Box>
        </Box>
      ) : null}
      {preview.kind === "bash" ? (
        <Text>{`$ ${preview.command}`}</Text>
      ) : preview.kind === "diff" ? (
        <Box flexDirection="column">
          <Text dimColor>{preview.path}</Text>
          {/* Rows after the box border+padding (4) and the 2-cell rule. */}
          <DiffView
            diff={preview.diff}
            expanded
            width={Math.max(1, columns - 6)}
          />
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
