// tui/Complete.tsx — the `/` fuzzy autocomplete popover, rendered above the prompt.
//
// When the prompt input starts with "/", App computes ranked `Completion`s
// (commands, or a command's parameter values) via commands.ts and hands them
// here. This component is a pure renderer: a compact vertical list with the
// selected row highlighted and an arrow marker, windowed so a long list never
// floods the terminal. All key handling (move / accept / dismiss) lives in App —
// this only draws the current state.

import { Box, Text } from "ink";
import type { Completion } from "../commands.ts";

/** Most rows to show at once; the window scrolls to keep `selected` visible. */
const MAX_ROWS = 8;

/** Compute the [start, end) slice of items to render around `selected`. */
export function windowRange(count: number, selected: number, max = MAX_ROWS): [number, number] {
  if (count <= max) return [0, count];
  let start = selected - Math.floor(max / 2);
  if (start < 0) start = 0;
  if (start + max > count) start = count - max;
  return [start, start + max];
}

interface CompleteProps {
  items: Completion[];
  selected: number;
}

export function Complete({ items, selected }: CompleteProps): React.ReactElement | null {
  if (items.length === 0) return null;
  const [start, end] = windowRange(items.length, selected);
  const visible = items.slice(start, end);

  return (
    <Box flexDirection="column" marginBottom={0}>
      {visible.map((c, i) => {
        const idx = start + i;
        const isSel = idx === selected;
        return (
          <Box key={idx}>
            <Text color={isSel ? "cyan" : undefined}>{isSel ? "› " : "  "}</Text>
            <Text color={isSel ? "cyan" : undefined} bold={isSel}>
              {c.label}
            </Text>
            {c.description ? <Text dimColor>{`  ${c.description}`}</Text> : null}
          </Box>
        );
      })}
      {items.length > visible.length ? (
        <Text dimColor>{`  …(${items.length - visible.length} more)`}</Text>
      ) : null}
    </Box>
  );
}
