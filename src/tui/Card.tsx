// tui/Card.tsx — a slim titled box for one transcript unit (user / assistant /
// tool / error).
//
// Each conversational unit renders as its own rounded box with a title embedded
// in the top border (OpenTUI draws `title` into the border run itself, so no
// manual overlay). Colour comes from the border + title only — an ANSI name the
// terminal theme remaps (Catppuccin on Ghostty, …) — and the box never paints a
// background, so a transparent terminal shows straight through. Content is inset
// by one column of horizontal padding and no vertical padding, so a one-line
// message is three rows tall (top border, content, bottom border): boxed, but
// deliberately not bloated.

import type { ReactElement, ReactNode } from "react";
import { Box } from "./primitives.tsx";
import { SPACING, tint } from "./theme.ts";

export function Card({
  color,
  title,
  marginTop = 0,
  children,
}: {
  /** Border + title colour (ANSI name, remapped by the terminal theme). */
  color: string;
  /** Title rendered into the top border (already includes any status mark). */
  title: string;
  /** Blank rows above the card (turn/group spacing from the caller). */
  marginTop?: number;
  children: ReactNode;
}): ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tint(color)}
      title={` ${title} `}
      titleColor={tint(color)}
      titleAlignment="left"
      paddingX={SPACING.boxPadX}
      marginTop={marginTop}
    >
      {children}
    </Box>
  );
}
