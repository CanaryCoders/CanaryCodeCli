// tui/Input.tsx — a tiny multi-line text input for the TUI prompt box.
//
// `ink-text-input` is single-line and submits on every Enter, so it can't hold a
// multi-line message. This is a focused, dependency-free replacement: plain
// **Enter** submits, **Shift+Enter** (or a literal linefeed — what some terminals
// send for Shift+Enter, and what pasted text carries) inserts a newline instead.
// Left/Right/Up/Down move the cursor (Up/Down across lines), Backspace/Delete
// remove the char before it. Pasted text is inserted verbatim, newlines and all.
//
// Large pastes collapse to a single `[Pasted text #N +M lines]` chip so a wall of
// pasted text never floods the prompt box. The chip is one sentinel character in
// the editing model (a private-use codepoint that maps to the paste's real text),
// so the cursor steps over it and Backspace deletes it as a single unit; the host
// only ever sees the *expanded* text on change/submit.
//
// The editing logic lives in the pure `reduceInput` reducer so it can be unit
// tested without a render; the component is a thin shell that mirrors the cursor
// in state and renders the value with a fake inverse-block cursor (no chalk dep).

import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";

// ── pasted-text chips ───────────────────────────────────────────────────────────
//
// A large paste is replaced in the edit buffer by a single sentinel codepoint from
// the Unicode Private Use Area, keyed by id (`PASTE_BASE + id`). The id→text map
// lives in the component; `expandPastes` swaps sentinels back to real text before
// the value leaves the component, and the renderer swaps them to a `[Pasted …]`
// chip for display. Because each chip is one codepoint, all cursor/Backspace logic
// in `reduceInput` treats it atomically for free.

/** First Private Use Area codepoint used as a paste sentinel (U+E000…U+E0FF). */
const PASTE_BASE = 0xe000;
/** A paste collapses into a chip when it has >3 newlines or is very long. */
const PASTE_MIN_LINES = 4;
const PASTE_MIN_CHARS = 400;

/** The sentinel character for paste `id` (0-based). */
export function pasteSentinel(id: number): string {
  return String.fromCodePoint(PASTE_BASE + id);
}

/** Is `ch` a paste sentinel? Returns its id, or -1. */
function pasteId(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined || cp < PASTE_BASE || cp > PASTE_BASE + 0xff) return -1;
  return cp - PASTE_BASE;
}

/** Should this pasted text collapse into a chip rather than insert verbatim? */
export function shouldCollapsePaste(text: string): boolean {
  let nl = 0;
  for (const c of text) if (c === "\n") nl++;
  return nl + 1 >= PASTE_MIN_LINES || text.length >= PASTE_MIN_CHARS;
}

/** Replace every paste sentinel in `value` with its real text from `map`. */
export function expandPastes(value: string, map: Map<number, string>): string {
  let out = "";
  for (const ch of value) {
    const id = pasteId(ch);
    out += id >= 0 ? (map.get(id) ?? "") : ch;
  }
  return out;
}

/** The `[Pasted text #N +M lines]` chip label for a paste's real text. Spaces are
 *  non-breaking (U+00A0) so Ink never wraps the label across a line/border. */
export function pasteChipLabel(id: number, text: string): string {
  const lines = text.split("\n").length;
  return `[Pasted\u00a0text\u00a0#${id + 1}\u00a0+${lines}\u00a0lines]`;
}

// ── pure editing reducer ──────────────────────────────────────────────────────

export interface InputState {
  value: string;
  cursor: number;
}

export type InputResult =
  | { type: "update"; value: string; cursor: number }
  | { type: "submit"; value: string }
  // Up on the first line / Down on the last line: the host walks prompt history
  // instead of moving the cursor (single-line input always navigates history).
  | { type: "history-prev" }
  | { type: "history-next" }
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
function cursorLineCol(
  value: string,
  cursor: number,
): { line: number; col: number } {
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
  for (let i = 0; i < line && i < lines.length; i++)
    off += lines[i]!.length + 1;
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
  /** Register a large paste and return the sentinel char to insert in its place.
   *  When absent (or it returns null) the paste is inserted verbatim. */
  registerPaste?: (text: string) => string | null;
}

/** Decide what a keypress does to the input. Pure — no Ink, no React. */
function reduceInput(
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
    return cursor > 0
      ? { type: "update", value, cursor: cursor - 1 }
      : { type: "none" };
  }
  if (key.rightArrow) {
    return cursor < value.length
      ? { type: "update", value, cursor: cursor + 1 }
      : { type: "none" };
  }
  // While the popover captures keys, Up/Down move the selection, not the cursor.
  if ((key.upArrow || key.downArrow) && opts.capture) return { type: "none" };
  if (key.upArrow || key.downArrow) {
    const { line, col } = cursorLineCol(value, cursor);
    const lines = value.split("\n");
    const target = line + (key.upArrow ? -1 : 1);
    // At the top/bottom boundary the cursor can't move further — hand off to the
    // host to browse prompt history (Up on the first line, Down on the last).
    if (target < 0) return { type: "history-prev" };
    if (target >= lines.length) return { type: "history-next" };
    const nextCol = Math.min(col, lines[target]!.length);
    return {
      type: "update",
      value,
      cursor: lineStart(value, target) + nextCol,
    };
  }
  if (key.backspace || key.delete) {
    if (cursor === 0) return { type: "none" };
    return {
      type: "update",
      value: value.slice(0, cursor - 1) + value.slice(cursor),
      cursor: cursor - 1,
    };
  }

  // Ignore control chords (Ctrl/Esc/Tab arrive with empty or control input); a
  // real character (or a multi-char paste) is inserted at the cursor. Normalise
  // any carriage returns in pasted text to plain newlines.
  if (input && !key.ctrl) {
    const text = input.replace(/\r\n?/g, "\n");
    if (!text) return { type: "none" };
    // A large multi-line/long paste collapses into a single sentinel chip, so a
    // wall of pasted text doesn't flood the prompt. Short input inserts verbatim.
    if (opts.registerPaste && shouldCollapsePaste(text)) {
      const sentinel = opts.registerPaste(text);
      if (sentinel) return insert(value, cursor, sentinel);
    }
    return insert(value, cursor, text);
  }
  return { type: "none" };
}

// ── the component ─────────────────────────────────────────────────────────────

interface MultilineInputProps {
  /** The edit buffer — may contain paste sentinels (the chips). The host stores
   *  it verbatim and expands it with `expandPastes` only when it needs the real
   *  text (e.g. on submit). */
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
  /** Up pressed on the first line — recall the previous prompt from history. */
  onHistoryPrev?: () => void;
  /** Down pressed on the last line — walk forward toward the current draft. */
  onHistoryNext?: () => void;
  /** Register a large paste (host owns the id→text map) and return the sentinel
   *  char to embed in the buffer. Omit to insert all pastes verbatim. */
  registerPaste?: (text: string) => string | null;
  /** The host's paste map, for rendering sentinels as `[Pasted …]` chips. */
  pastes?: Map<number, string>;
  /** Visible content width (columns) available to the input. Display lines are
   *  hard-wrapped to this width so Ink never soft-wraps a live row — a soft-wrapped
   *  row is what Ink mis-erases and smears across the box border. */
  width?: number;
}

export function MultilineInput({
  value,
  onChange,
  onSubmit,
  placeholder = "",
  isActive = true,
  capture = false,
  cursorNonce = 0,
  onHistoryPrev,
  onHistoryNext,
  registerPaste,
  pastes = EMPTY_PASTES,
  width = 0,
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
      const result = reduceInput(
        { value, cursor: effectiveCursor },
        input,
        key,
        { capture, registerPaste },
      );
      if (result.type === "submit") {
        onSubmit(result.value);
      } else if (result.type === "update") {
        setCursor(result.cursor);
        if (result.value !== value) onChange(result.value);
      } else if (result.type === "history-prev") {
        onHistoryPrev?.();
      } else if (result.type === "history-next") {
        onHistoryNext?.();
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

  // Hard-wrap each logical line into display rows of at most `width` columns,
  // keeping paste chips atomic. This stops Ink from soft-wrapping a live row,
  // which it mis-erases and smears across the input border on edits.
  const rows: { text: string; cursorCol: number | null }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const wrapped = wrapDisplayLine(lines[i]!, width, pastes);
    const onCursorLine = i === curLine;
    for (let r = 0; r < wrapped.length; r++) {
      const seg = wrapped[r]!;
      let cursorCol: number | null = null;
      if (onCursorLine && curCol >= seg.start && curCol <= seg.end) {
        // The cursor's own row owns it; a cursor exactly at a wrap boundary
        // belongs to the *next* row's start (so it shows before the next char),
        // except on the final row where it sits at end-of-line.
        if (curCol === seg.end && r < wrapped.length - 1) {
          cursorCol = null;
        } else {
          cursorCol = curCol - seg.start;
        }
      }
      rows.push({ text: seg.text, cursorCol });
    }
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        // A blank row still needs a space so Ink gives it height (otherwise a
        // Shift+Enter newline renders zero-height and appears to do nothing).
        <Text key={i}>
          {row.cursorCol !== null
            ? renderCursorLine(row.text, row.cursorCol, pastes)
            : renderLine(row.text, pastes) || " "}
        </Text>
      ))}
    </Box>
  );
}

/** A display row carved out of one logical line by `wrapDisplayLine`: its text
 *  plus the [start, end) range of cursor columns (logical line offsets) it owns. */
interface DisplayRow {
  text: string;
  start: number;
  end: number;
}

/** Split a logical line into display rows no wider than `width` visible columns,
 *  treating each paste sentinel as an atomic unit of its chip-label width. With
 *  `width <= 0` (unknown) the whole line is one row — Ink's own wrap then applies. */
export function wrapDisplayLine(
  line: string,
  width: number,
  pastes: Map<number, string>,
): DisplayRow[] {
  const chars = [...line];
  if (width <= 0 || chars.length === 0) {
    return [{ text: line, start: 0, end: chars.length }];
  }
  const rows: DisplayRow[] = [];
  let buf = "";
  let bufCols = 0;
  let start = 0;
  let col = 0; // logical column (index into chars)
  for (const ch of chars) {
    const id = pasteId(ch);
    const w = id >= 0 ? pasteChipLabel(id, pastes.get(id) ?? "").length : 1;
    if (bufCols + w > width && bufCols > 0) {
      rows.push({ text: buf, start, end: col });
      buf = "";
      bufCols = 0;
      start = col;
    }
    buf += ch;
    bufCols += w;
    col++;
  }
  rows.push({ text: buf, start, end: col });
  return rows;
}

const EMPTY_PASTES: Map<number, string> = new Map();

/** Render a line, swapping paste sentinels for their `[Pasted …]` chip label. A
 *  chip is dim so it reads as a placeholder, not literal typed text. */
function renderLine(
  text: string,
  pastes: Map<number, string>,
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let buf = "";
  let k = 0;
  for (const ch of text) {
    const id = pasteId(ch);
    if (id >= 0) {
      if (buf) {
        parts.push(buf);
        buf = "";
      }
      parts.push(
        <Text key={`p${k++}`} dimColor>
          {pasteChipLabel(id, pastes.get(id) ?? "")}
        </Text>,
      );
    } else {
      buf += ch;
    }
  }
  if (buf) parts.push(buf);
  return parts.length > 0 ? parts : "";
}

/** Render one line with an inverse block at `col` (a trailing space if at EOL),
 *  splitting around the cursor and swapping paste sentinels for their chips. */
function renderCursorLine(
  text: string,
  col: number,
  pastes: Map<number, string>,
): React.ReactNode {
  const chars = [...text];
  const before = chars.slice(0, col).join("");
  const at = chars[col];
  const after = chars.slice(col + 1).join("");
  // The cursor sits on a paste chip: highlight the whole chip label.
  if (at !== undefined && pasteId(at) >= 0) {
    return (
      <>
        {renderLine(before, pastes)}
        <Text inverse>
          {pasteChipLabel(pasteId(at), pastes.get(pasteId(at)) ?? "")}
        </Text>
        {renderLine(after, pastes)}
      </>
    );
  }
  if (at === undefined) {
    return (
      <>
        {renderLine(before, pastes)}
        <Text inverse> </Text>
      </>
    );
  }
  return (
    <>
      {renderLine(before, pastes)}
      <Text inverse>{at}</Text>
      {renderLine(after, pastes)}
    </>
  );
}
