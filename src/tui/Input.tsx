// tui/Input.tsx — a tiny multi-line text input for the TUI prompt box.
//
// `ink-text-input` is single-line and submits on every Enter, so it can't hold a
// multi-line message. This is a focused, dependency-free replacement: plain
// **Enter** submits, **Shift+Enter** (or a literal linefeed — what some terminals
// send for Shift+Enter, and what pasted text carries) inserts a newline instead.
// Left/Right/Up/Down move the cursor (Up/Down across lines), Backspace/Delete
// remove the char before it. Pasted text is inserted verbatim, newlines and all.
//
// The editing logic lives in the pure `reduceInput` reducer so it can be unit
// tested without a render; the component is a thin shell that mirrors the cursor
// in state and renders the value with a fake inverse-block cursor (no chalk dep).

import { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

// ── pure editing reducer ──────────────────────────────────────────────────────

export interface InputState {
  value: string;
  cursor: number;
}

export type InputResult =
  | { type: "update"; value: string; cursor: number }
  | { type: "submit"; value: string }
  | { type: "none" };

/** The `key` shape Ink's `useInput` passes — only the fields we read. */
export interface InputKey {
  return?: boolean;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

/** Map an absolute cursor offset to its {line, col} within the value. */
export function cursorLineCol(value: string, cursor: number): { line: number; col: number } {
  const lines = value.split("\n");
  let rem = cursor;
  for (let i = 0; i < lines.length; i++) {
    if (rem <= lines[i]!.length) return { line: i, col: rem };
    rem -= lines[i]!.length + 1; // +1 for the consumed "\n"
  }
  const last = lines.length - 1;
  return { line: last, col: lines[last]!.length };
}

/** Offset of the start of `line` within `value` (line 0 → 0). */
function lineStart(value: string, line: number): number {
  const lines = value.split("\n");
  let off = 0;
  for (let i = 0; i < line && i < lines.length; i++) off += lines[i]!.length + 1;
  return off;
}

function insert(value: string, cursor: number, text: string): InputResult {
  const next = value.slice(0, cursor) + text + value.slice(cursor);
  return { type: "update", value: next, cursor: cursor + text.length };
}

/** Options that let the host suppress keys it handles itself (e.g. an open popover). */
export interface ReduceOptions {
  /** When true, the autocomplete popover owns Enter and Up/Down — the input
   *  ignores them (Shift+Enter still inserts a newline, editing keys still work). */
  capture?: boolean;
}

/** Decide what a keypress does to the input. Pure — no Ink, no React. */
export function reduceInput(
  state: InputState,
  input: string,
  key: InputKey,
  opts: ReduceOptions = {},
): InputResult {
  const value = state.value;
  const cursor = Math.min(Math.max(state.cursor, 0), value.length);

  // Plain Enter submits; Shift+Enter (or meta+return) inserts a newline instead.
  // While the popover captures keys, plain Enter is theirs (accept) — ignore it.
  if (key.return) {
    if (key.shift || key.meta) return insert(value, cursor, "\n");
    if (opts.capture) return { type: "none" };
    return { type: "submit", value };
  }

  if (key.leftArrow) {
    return cursor > 0 ? { type: "update", value, cursor: cursor - 1 } : { type: "none" };
  }
  if (key.rightArrow) {
    return cursor < value.length ? { type: "update", value, cursor: cursor + 1 } : { type: "none" };
  }
  // While the popover captures keys, Up/Down move the selection, not the cursor.
  if ((key.upArrow || key.downArrow) && opts.capture) return { type: "none" };
  if (key.upArrow || key.downArrow) {
    const { line, col } = cursorLineCol(value, cursor);
    const lines = value.split("\n");
    const target = line + (key.upArrow ? -1 : 1);
    if (target < 0 || target >= lines.length) return { type: "none" };
    const nextCol = Math.min(col, lines[target]!.length);
    return { type: "update", value, cursor: lineStart(value, target) + nextCol };
  }
  if (key.backspace || key.delete) {
    if (cursor === 0) return { type: "none" };
    return { type: "update", value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
  }

  // Ignore control chords (Ctrl/Esc/Tab arrive with empty or control input); a
  // real character (or a multi-char paste) is inserted at the cursor. Normalise
  // any carriage returns in pasted text to plain newlines.
  if (input && !key.ctrl) {
    const text = input.replace(/\r\n?/g, "\n");
    if (text) return insert(value, cursor, text);
  }
  return { type: "none" };
}

// ── the component ─────────────────────────────────────────────────────────────

interface MultilineInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  isActive?: boolean;
  /** When true, the autocomplete popover owns Enter/Up/Down (see reduceInput). */
  capture?: boolean;
  /** A counter the host bumps when it sets `value` externally (e.g. accepting a
   *  completion); a change jumps the cursor to the end of the new value. */
  cursorNonce?: number;
}

export function MultilineInput({
  value,
  onChange,
  onSubmit,
  placeholder = "",
  isActive = true,
  capture = false,
  cursorNonce = 0,
}: MultilineInputProps): React.ReactElement {
  const [cursor, setCursor] = useState(value.length);
  // When the host replaces `value` out-of-band (completion accept), snap the
  // cursor to the end. Adjusting state during render is React's sanctioned way
  // to derive from a changed prop without an effect.
  const lastNonceRef = useRef(cursorNonce);
  if (cursorNonce !== lastNonceRef.current) {
    lastNonceRef.current = cursorNonce;
    setCursor(value.length);
  }
  const effectiveCursor = Math.min(cursor, value.length);

  useInput(
    (input, key) => {
      const result = reduceInput({ value, cursor: effectiveCursor }, input, key, { capture });
      if (result.type === "submit") {
        onSubmit(result.value);
      } else if (result.type === "update") {
        setCursor(result.cursor);
        if (result.value !== value) onChange(result.value);
      }
    },
    { isActive },
  );

  if (value.length === 0) {
    // Empty: show the placeholder with the cursor block over its first char.
    if (!placeholder) return <Text inverse> </Text>;
    return (
      <Text>
        <Text inverse>{placeholder[0]}</Text>
        <Text dimColor>{placeholder.slice(1)}</Text>
      </Text>
    );
  }

  const lines = value.split("\n");
  const { line: curLine, col: curCol } = cursorLineCol(value, effectiveCursor);

  return (
    <Box flexDirection="column">
      {lines.map((text, i) => (
        <Text key={i}>{i === curLine ? renderCursorLine(text, curCol) : text}</Text>
      ))}
    </Box>
  );
}

/** Render one line with an inverse block at `col` (a trailing space if at EOL). */
function renderCursorLine(text: string, col: number): React.ReactNode {
  if (col >= text.length) {
    return (
      <>
        {text}
        <Text inverse> </Text>
      </>
    );
  }
  return (
    <>
      {text.slice(0, col)}
      <Text inverse>{text[col]}</Text>
      {text.slice(col + 1)}
    </>
  );
}
