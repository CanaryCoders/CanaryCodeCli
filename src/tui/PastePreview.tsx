// tui/PastePreview.tsx — the read-only popover for a clicked paste chip.
//
// A paste chip collapses a large paste into one `[Pasted …]` marker in the prompt
// (see Input.tsx / input-helpers.ts). Clicking the chip opens this popover ABOVE
// the input frame — like the `/` autocomplete list — showing the stored text
// (height-capped, width-clamped) so the user can confirm what they pasted without
// expanding it back into the buffer. It is purely additive: it never touches the
// edit buffer. `[copy]` writes the full stored text to the clipboard; `[close]`
// (or Esc) dismisses; `y` copies. While it is open the editor's input is paused
// (Input.tsx gates its key/paste hooks on the preview being closed), so these keys
// reach the popover's own scoped handler instead of typing into the prompt.

import { useState } from "react";
import { writeTextToClipboard } from "./copy-targets.ts";
import { ActionChip } from "./Interactive.tsx";
import { isRawEscapeInput, pastePreviewLines } from "./input-helpers.ts";
import { useTuiInput } from "./keyboard.ts";
import { Box, Text } from "./primitives.tsx";
import { SPACING, tint } from "./theme.ts";

/** Most body rows shown before the `…(+K more lines)` marker kicks in. */
const MAX_BODY_LINES = 12;

// Match the prompt frame's left inset (1-col border + boxPadX) so the popover
// lines up under the prompt content rather than floating flush-left.
const FRAME_INSET = 1 + SPACING.boxPadX;

interface PastePreviewProps {
  /** The paste id being previewed (0-based; shown 1-based in the header). */
  chipId: number;
  /** The stored, original pasted text for `chipId`. */
  text: string;
  /** Terminal width, used to clamp the box so a long line never wraps off-edge. */
  columns: number;
  onClose: () => void;
}

/** The bordered read-only preview popover, with `[copy]`/`[close]` chips and
 *  Esc/y keyboard equivalents. Mounted only while a chip is being previewed. */
export function PastePreview({
  chipId,
  text,
  columns,
  onClose,
}: PastePreviewProps): React.ReactElement {
  const [status, setStatus] = useState<string | null>(null);
  const totalLines = text.split("\n").length;
  const { lines, more } = pastePreviewLines(text, MAX_BODY_LINES);

  // Clamp the box to the terminal so a wide pasted line can't push the border
  // past the right edge. Leave room for the frame inset and the border columns.
  const maxBoxWidth = Math.max(20, columns - FRAME_INSET - 2);

  const copy = (): void => {
    void writeTextToClipboard(text).then((result) => {
      setStatus(
        result.ok
          ? "copied to clipboard"
          : `clipboard unavailable — wrote ${result.path}`,
      );
    });
  };

  // Scoped key handling — active only while this popover is mounted. Esc (or a raw
  // Esc burst) closes; `y` copies. The App's global Esc handler checks the
  // preview-open ref and bows out without escalating, so Esc only closes here.
  useTuiInput((input, key) => {
    if (key.escape || isRawEscapeInput(input)) {
      onClose();
      return;
    }
    if (input === "y") copy();
  });

  return (
    <Box flexDirection="column" paddingLeft={FRAME_INSET} marginBottom={0}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={tint("#89a8d8")}
        backgroundColor={tint("#1f2733")}
        paddingX={SPACING.boxPadX}
        width={maxBoxWidth}
        title={`Pasted text #${chipId + 1} (${totalLines} lines)`}
        titleColor={tint("#89a8d8")}
      >
        {lines.map((line, i) => (
          <Text key={`l${i}:${line}`} wrap="truncate">
            {line.length === 0 ? " " : line}
          </Text>
        ))}
        {more > 0 ? <Text dimColor>{`…(+${more} more lines)`}</Text> : null}
        <Box flexDirection="row" marginTop={1}>
          <ActionChip label="[copy]" onAction={copy} />
          <Text> </Text>
          <ActionChip label="[close]" onAction={onClose} />
          <Text dimColor>{"   y copy · esc close"}</Text>
        </Box>
        {status ? <Text dimColor>{status}</Text> : null}
      </Box>
    </Box>
  );
}
