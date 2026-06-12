/** @jsxImportSource @opentui/react */
// tui/Interactive.tsx — tiny mouse interaction helpers for OpenTUI surfaces.
//
// These helpers deliberately do not own keyboard focus or shortcut handling. They
// only translate visible mouse clicks into callbacks that callers route to the
// same actions their keyboard handlers already perform.

import { useRef, useState } from "react";
import { Box, Text, type BoxProps } from "./primitives.tsx";
import { tint } from "./theme.ts";

export interface ActionChipProps {
  label: string;
  onAction: () => void;
  disabled?: boolean;
  color?: string;
  hoverColor?: string;
  activeColor?: string;
}

/** Inline clickable chip such as "[Yes y]". Keyboard remains caller-owned. */
export function ActionChip({
  label,
  onAction,
  disabled = false,
  color = "cyan",
  hoverColor = "white",
  activeColor = "yellow",
}: ActionChipProps): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const pressedRef = useRef(false);
  const interactive = !disabled;
  const fg = disabled
    ? undefined
    : pressed
      ? activeColor
      : hovered
        ? hoverColor
        : color;
  const setPressedState = (next: boolean): void => {
    pressedRef.current = next;
    setPressed(next);
  };

  return (
    <Text
      color={tint(fg)}
      dimColor={disabled}
      bold={interactive && (hovered || pressed)}
      inverse={interactive && pressed}
      cursor={interactive ? "pointer" : "default"}
      onMouseOver={() => {
        if (interactive) setHovered(true);
      }}
      onMouseOut={() => {
        setHovered(false);
        setPressedState(false);
      }}
      onMouseDown={(event) => {
        if (!interactive || event.button !== 0) return;
        setPressedState(true);
        event.stopPropagation();
      }}
      onMouseUp={(event) => {
        if (!interactive || event.button !== 0) return;
        const wasPressed = pressedRef.current;
        setPressedState(false);
        event.stopPropagation();
        if (wasPressed) onAction();
      }}
    >
      {label}
    </Text>
  ) as React.ReactElement;
}

export interface ChoiceRowProps {
  children: React.ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onHover?: () => void;
  onAction?: () => void;
  accentColor?: string;
}

/** Basic selectable row for later picker/autocomplete phases. */
export function ChoiceRow({
  children,
  selected = false,
  disabled = false,
  onHover,
  onAction,
  accentColor = "cyan",
}: ChoiceRowProps): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const pressedRef = useRef(false);
  const interactive = !disabled;
  const setPressedState = (next: boolean): void => {
    pressedRef.current = next;
    setPressed(next);
  };
  const boxProps: Pick<
    BoxProps,
    | "cursor"
    | "backgroundColor"
    | "onMouseOver"
    | "onMouseOut"
    | "onMouseDown"
    | "onMouseUp"
  > = {
    cursor: interactive ? "pointer" : "default",
    backgroundColor: tint(pressed ? "gray" : hovered ? "#2a2e42" : undefined),
    onMouseOver: () => {
      if (!interactive) return;
      setHovered(true);
      onHover?.();
    },
    onMouseOut: () => {
      setHovered(false);
      setPressedState(false);
    },
    onMouseDown: (event) => {
      if (!interactive || event.button !== 0) return;
      setPressedState(true);
      event.stopPropagation();
    },
    onMouseUp: (event) => {
      if (!interactive || event.button !== 0) return;
      const wasPressed = pressedRef.current;
      setPressedState(false);
      event.stopPropagation();
      if (wasPressed) onAction?.();
    },
  };

  return (
    <Box {...boxProps}>
      <Text color={selected ? tint(accentColor) : undefined} dimColor={disabled}>
        {children}
      </Text>
    </Box>
  ) as React.ReactElement;
}
