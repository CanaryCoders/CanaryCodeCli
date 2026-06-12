// tui/Complete.tsx — the `/` fuzzy autocomplete popover, rendered above the prompt.
//
// When the prompt input starts with "/", App computes ranked `Completion`s
// (commands, or a command's parameter values) via commands.ts and hands them
// here. This component is a pure renderer: a compact vertical list with the
// selected row highlighted and an arrow marker, windowed so a long list never
// floods the terminal. All key handling (move / accept / dismiss) lives in App —
// this only draws the current state.

import type { Completion } from "../commands.ts";
import { useIcon } from "./Icon.tsx";
import { ChoiceRow } from "./Interactive.tsx";
import { Box, Text } from "./primitives.tsx";
import { SPACING, tint } from "./theme.ts";

/** Most rows to show at once; the window scrolls to keep `selected` visible. */
const MAX_ROWS = 8;

// The popover renders directly above the framed input box, which insets its
// content by a 1-col border plus `boxPadX` of padding. Matching that inset here
// anchors the popover's marker column under the input's prompt glyph so the two
// read as one attached unit rather than the list floating flush-left.
const FRAME_INSET = 1 + SPACING.boxPadX;

/** Compute the [start, end) slice of items to render around `selected`. */
function windowRange(
  count: number,
  selected: number,
  max = MAX_ROWS,
): [number, number] {
  if (count <= max) return [0, count];
  let start = selected - Math.floor(max / 2);
  if (start < 0) start = 0;
  if (start + max > count) start = count - max;
  return [start, start + max];
}

interface CompleteProps {
  items: Completion[];
  selected: number;
  onSelect?: (index: number) => void;
  onAccept?: (index: number) => void;
}

export function Complete({
  items,
  selected,
  onSelect,
  onAccept,
}: CompleteProps): React.ReactElement | null {
  const promptIcon = useIcon("prompt");
  if (items.length === 0) return null;
  const [start, end] = windowRange(items.length, selected);
  const visible = items.slice(start, end);

  const accent = tint("cyan");
  return (
    <Box flexDirection="column" marginBottom={0} paddingLeft={FRAME_INSET}>
      {visible.map((c, i) => {
        const idx = start + i;
        const isSel = idx === selected;
        return (
          <ChoiceRow
            key={`${idx}:${c.label}`}
            selected={isSel}
            onHover={() => onSelect?.(idx)}
            onAction={() => onAccept?.(idx)}
          >
            <Box width={1} marginRight={1}>
              <Text color={isSel ? accent : undefined}>
                {isSel ? promptIcon : " "}
              </Text>
            </Box>
            <Text color={isSel ? accent : undefined} bold={isSel}>
              {c.label}
            </Text>
            {c.description ? (
              <Text dimColor>{`  ${c.description}`}</Text>
            ) : null}
          </ChoiceRow>
        );
      })}
      {items.length > visible.length ? (
        <Text dimColor>{`  …(${items.length - visible.length} more)`}</Text>
      ) : null}
    </Box>
  );
}
