// tui/primitives.tsx — tiny renderer-staging layer for display-only components.
//
// The production App is still Ink during the OpenTUI migration, so the default
// Box/Text exports intentionally render Ink components. Leaf components can move
// off direct Ink imports now, while OpenTUI-ready twins are available for the
// future root switch without changing their public props again.

import { createTextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { Box as InkBox, Text as InkText } from "ink";
import type { ReactElement, ReactNode } from "react";
import { createElement } from "react";
import { tint } from "./theme.ts";

export type BoxProps = React.ComponentProps<typeof InkBox>;
export type TextProps = React.ComponentProps<typeof InkText>;

export function Box(props: BoxProps): ReactElement {
  return <OpenTuiBox {...props} />;
}

export function Text(props: TextProps): ReactElement {
  return <OpenTuiText {...props} />;
}

export function useTerminalColumns(fallback = 80): number {
  const dimensions = useTerminalDimensions();
  return dimensions.width ?? fallback;
}

function mapBorderStyle(
  style: BoxProps["borderStyle"],
): string | boolean | undefined {
  if (style === undefined) return undefined;
  if (style === "round") return "rounded";
  return typeof style === "string" ? style : "single";
}

/** OpenTUI-backed twin for future root-switch work. */
export function OpenTuiBox({
  children,
  borderStyle,
  borderColor,
  borderDimColor: _borderDimColor,
  ...props
}: BoxProps): ReactElement {
  return createElement(
    "box",
    {
      ...props,
      border: borderStyle ? true : undefined,
      borderStyle: mapBorderStyle(borderStyle),
      borderColor,
    },
    children,
  );
}

function mapWrapMode(wrap: TextProps["wrap"]): "none" | "char" | "word" {
  if (wrap === "wrap") return "word";
  if (wrap === "truncate") return "none";
  return "none";
}

/** OpenTUI-backed twin for future root-switch work. */
export function OpenTuiText({
  children,
  color,
  backgroundColor,
  dimColor,
  bold,
  italic,
  underline,
  strikethrough,
  inverse,
  wrap,
  ...props
}: TextProps): ReactElement {
  return createElement(
    "text",
    {
      ...props,
      fg: dimColor ? tint("gray") : color,
      bg: backgroundColor,
      attributes: createTextAttributes({
        bold,
        italic,
        underline,
        strikethrough,
        inverse,
        dim: dimColor && tint("gray") === undefined,
      }),
      truncate: wrap === "truncate",
      wrapMode: mapWrapMode(wrap),
    },
    children as ReactNode,
  );
}
