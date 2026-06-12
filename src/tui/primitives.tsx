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
import { createContext, createElement, useContext } from "react";

// OpenTUI splits Ink's single <Text> into two host elements: a block-level
// <text> (a TextRenderable) and inline <span> runs (TextNodeRenderable). A
// <text> only accepts string / span / StyledText children — appending another
// <text> to it throws ("TextNodeRenderable only accepts strings, …"). Ink code
// freely nests <Text> inside <Text> for styled runs, so we map that idiom by
// tracking nesting: the outermost Text emits <text> and marks its subtree as
// "inside text"; any Text rendered within emits <span> instead. Box resets the
// flag so block layout always starts a fresh text context.
const InsideText = createContext(false);

export interface BoxProps {
  children?: ReactNode;
  key?: React.Key;
  // Border
  borderStyle?: "single" | "double" | "round";
  borderColor?: string;
  borderDimColor?: boolean;
  // Title embedded in the top (or bottom) border — OpenTUI renders these into
  // the border run itself, so a bordered Box reads as a titled card.
  title?: string;
  titleColor?: string;
  titleAlignment?: "left" | "center" | "right";
  bottomTitle?: string;
  bottomTitleAlignment?: "left" | "center" | "right";
  // Optional fill painted behind the box. Left undefined the box is transparent
  // (the terminal background shows through). Never set on the root layout — only
  // on small framed elements where a subtle fill is wanted.
  backgroundColor?: string;
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
  wrap?: "wrap" | "truncate";
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
  return style;
}

/** Adapter: maps Box props onto OpenTUI's native <box> element. */
export function OpenTuiBox({
  children,
  borderStyle,
  borderColor,
  borderDimColor: _borderDimColor,
  flexDirection,
  ...props
}: BoxProps): ReactElement {
  return createElement(
    "box",
    {
      ...props,
      // Ink's <Box> defaults to flexDirection="row"; OpenTUI/Yoga defaults to
      // "column". The whole TUI was authored against Ink's row default, so we
      // restore it here — otherwise every Box that relied on the implicit
      // default (footer bar, completion rows, …) stacks vertically.
      flexDirection: flexDirection ?? "row",
      border: borderStyle ? true : undefined,
      borderStyle: mapBorderStyle(borderStyle),
      borderColor,
    },
    // A box is block-level layout: its subtree starts outside any text node, so
    // a Text inside it emits a fresh <text>, not a <span>.
    createElement(InsideText.Provider, { value: false }, children),
  );
}

function mapWrapMode(wrap: TextProps["wrap"]): "none" | "char" | "word" {
  if (wrap === "wrap") return "word";
  if (wrap === "truncate") return "none";
  return "none";
}

/** Adapter: maps Text props onto OpenTUI's native <text>/<span> element. */
export function OpenTuiText(props: TextProps): ReactElement {
  return buildTextElement(props, useContext(InsideText));
}

/**
 * Pure builder for a Text primitive's host element, split out so the
 * <text>-vs-<span> decision can be tested without a renderer.
 *
 * `insideText` is true when this Text is nested within another Text. In that
 * case it must emit an inline <span> (a TextNodeRenderable the parent <text>
 * accepts) — emitting a nested <text> throws at render. At the top level it
 * emits a block <text> and flags its subtree inside-text so descendant Text
 * runs become spans. Block-only props (truncate/wrapMode) apply to <text> only.
 */
export function buildTextElement(
  {
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
  }: TextProps,
  insideText: boolean,
): ReactElement {
  // Ink's `dimColor` applied the ANSI dim attribute (SGR 2): it fades whatever
  // colour is set and respects the terminal's theme. The first port mapped it to
  // a flat hard-coded grey foreground, which discarded the real colour and made
  // every dim line one uniform grey. Use the native dim attribute instead so the
  // colour is preserved and faded — terminal-theme-aware, matching Ink.
  const fg = color;
  const attributes = createTextAttributes({
    bold,
    italic,
    underline,
    strikethrough,
    inverse,
    dim: dimColor,
  });

  if (insideText) {
    return createElement(
      "span",
      { ...props, fg, bg: backgroundColor, attributes },
      children as ReactNode,
    );
  }

  return createElement(
    "text",
    {
      ...props,
      fg,
      bg: backgroundColor,
      attributes,
      truncate: wrap === "truncate",
      wrapMode: mapWrapMode(wrap),
    },
    createElement(InsideText.Provider, { value: true }, children as ReactNode),
  );
}
