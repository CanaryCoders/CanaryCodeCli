// tui/primitives.tsx — the renderer primitive layer over OpenTUI.
//
// `Box`/`Text` are the only layout/text primitives the rest of the TUI imports.
// They accept a small, Ink-flavoured prop surface (flex layout, margins/padding,
// border + text styling) and forward it onto OpenTUI's native `box`/`text`
// elements via the `OpenTuiBox`/`OpenTuiText` adapters below. Keeping the public
// props here means leaf components never touch OpenTUI element names directly.

import { createTextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactElement, ReactNode } from "react";
import { createElement } from "react";
import { tint } from "./theme.ts";

export interface BoxProps {
  children?: ReactNode;
  key?: React.Key;
  // Border
  borderStyle?: "single" | "double" | "round" | "bold" | "classic";
  borderColor?: string;
  borderDimColor?: boolean;
  // Flexbox layout
  flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
  flexGrow?: number;
  flexShrink?: number;
  justifyContent?:
    | "flex-start"
    | "flex-end"
    | "center"
    | "space-between"
    | "space-around";
  alignItems?: "flex-start" | "flex-end" | "center" | "stretch";
  alignSelf?: "flex-start" | "flex-end" | "center" | "auto";
  // Sizing
  width?: number | string;
  height?: number | string;
  minWidth?: number;
  minHeight?: number;
  // Spacing
  margin?: number;
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  paddingTop?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  paddingRight?: number;
}

export interface TextProps {
  children?: ReactNode;
  key?: React.Key;
  color?: string;
  backgroundColor?: string;
  dimColor?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  wrap?: "wrap" | "truncate" | "end";
}

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
