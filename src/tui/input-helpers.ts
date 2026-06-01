// tui/input-helpers.ts — the pure editing model behind the multi-line prompt.
//
// All of the prompt input's logic that doesn't touch React/Ink lives here: the
// pasted-text chip encoding, the cursor/line math, and the `reduceInput` keypress
// reducer. Keeping it apart from Input.tsx means that module exports only
// components (clean fast-refresh boundaries) and that this logic can be unit
// tested without a renderer.

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
export function pasteId(ch: string): number {
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
  escape?: boolean;
  tab?: boolean;
}

/** Map an absolute cursor offset to its {line, col} within the value. */
export function cursorLineCol(
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

export const ESC = "\x1b";

export function stripEscapes(input: string): string {
  return input.split(ESC).join("");
}

/** True when `input` is nothing but raw Esc bytes. A rapid Esc repeat reaches Ink
 *  as a single chunk of several `\x1b`; Ink only flags `key.escape` for one or two
 *  of them (see parse-keypress), so the host must also recognise a bare-escape
 *  chunk to treat it as Esc rather than letting it leak into the prompt as `^[`. */
export function isRawEscapeInput(input: string): boolean {
  return input.length > 0 && stripEscapes(input) === "";
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

  // Ignore control chords (Ctrl/Esc/Tab usually arrive with empty/control input).
  // Some terminals report raw Esc as printable "\x1b" when keys are spammed; strip
  // it so it never renders as a literal ^[ in the prompt. Normalise carriage
  // returns in pasted text to plain newlines.
  if (input && !key.ctrl) {
    const text = stripEscapes(input).replace(/\r\n?/g, "\n");
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

// ── display wrapping ──────────────────────────────────────────────────────────

/** A display row carved out of one logical line by `wrapDisplayLine`: its text
 *  plus the [start, end) range of cursor columns (logical line offsets) it owns. */
export interface DisplayRow {
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

export const EMPTY_PASTES: Map<number, string> = new Map();
