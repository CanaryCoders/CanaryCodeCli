// tui/Card.tsx — a soft filled block for one transcript unit (user / assistant /
// tool / error).
//
// Each conversational unit renders as a borderless block: a muted background fill
// with the title as a bold accent label on its first line. No border — the fill
// alone defines the block (the OpenCode / badlogic-pi look), and stacked blocks
// are separated by a one-row gap rather than a border line. The fill is scoped to
// the block; the CLI's own root background is never painted, so a transparent
// terminal stays transparent in the gaps between blocks. Content is inset by one
// column of horizontal padding. `tint` strips both fill and accent under
// NO_COLOR, leaving the glyphs + spacing.

import type { ReactElement, ReactNode } from "react";
import { Box, Text } from "./primitives.tsx";
import { SPACING, tint } from "./theme.ts";

export function Card({
  color,
  bg,
  title,
  marginTop = 0,
  children,
}: {
  /** Soft accent for the title label (muted truecolor hex). */
  color: string;
  /** Muted background fill painted behind the whole block. */
  bg: string;
  /** Title label on the block's first line (already includes any status mark). */
  title: string;
  /** Blank rows above the card (turn/group spacing from the caller). */
  marginTop?: number;
  children: ReactNode;
}): ReactElement {
  return (
    <Box
      flexDirection="column"
      backgroundColor={tint(bg)}
      paddingX={SPACING.boxPadX}
      paddingY={SPACING.boxPadY}
      marginTop={marginTop}
    >
      <Text color={tint(color)} bold wrap="truncate">
        {title}
      </Text>
      {children}
    </Box>
  );
}
