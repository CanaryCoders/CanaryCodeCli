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
// All the editing logic lives in the pure `input-helpers.ts` module (the
// `reduceInput` reducer, paste-chip encoding, line/wrap math) so it can be unit
// tested without a render; this component is a thin shell that mirrors the cursor
// in state and renders the value with a fake inverse-block cursor (no chalk dep).

import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import {
  cursorLineCol,
  EMPTY_PASTES,
  type InputResult,
  pasteChipLabel,
  pasteId,
  reduceInput,
  wrapDisplayLine,
} from "./input-helpers.ts";

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
  // react-doctor flags this twice, both false positives: (1) no-derived-useState —
  // `value.length` only *seeds* the cursor; it then moves independently as the user
  // edits, and the nonce-guard below re-seeds it on out-of-band value swaps, so it
  // is genuine local state, not derived. (2) rerender-state-only-in-handlers — the
  // cursor IS read in render (via `effectiveCursor` below, which positions the
  // inverse-block cursor), so it must trigger re-renders; a ref would freeze the
  // visible caret in place.
  // eslint-disable-next-line react-doctor/no-derived-useState, react-doctor/rerender-state-only-in-handlers -- see above
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

  // Paste coalescing: a terminal delivers a large paste as several back-to-back
  // stdin chunks, so Ink fires `useInput` once per chunk — each chunk would
  // otherwise become its *own* `[Pasted …]` chip. We buffer consecutive printable
  // input that arrives within the same event-loop turn and process it as one
  // string on a deferred flush, so a single paste collapses into a single chip.
  // The live `value`/`cursor` are mirrored in refs because the flush runs after
  // React's state has moved on from the closure that scheduled it.
  const valueRef = useRef(value);
  valueRef.current = value;
  const cursorRef = useRef(effectiveCursor);
  cursorRef.current = effectiveCursor;
  const pasteBufRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyResult = (result: InputResult): void => {
    if (result.type === "submit") {
      onSubmit(result.value);
    } else if (result.type === "update") {
      cursorRef.current = result.cursor;
      setCursor(result.cursor);
      if (result.value !== valueRef.current) {
        valueRef.current = result.value;
        onChange(result.value);
      }
    } else if (result.type === "history-prev") {
      onHistoryPrev?.();
    } else if (result.type === "history-next") {
      onHistoryNext?.();
    }
  };

  // Drain the buffered paste/typed-text burst as a single insert, so a chunked
  // paste is registered once (one chip) rather than per-chunk.
  const flushPaste = (): void => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const text = pasteBufRef.current;
    pasteBufRef.current = "";
    if (!text) return;
    applyResult(
      reduceInput(
        { value: valueRef.current, cursor: cursorRef.current },
        text,
        {},
        { capture, registerPaste },
      ),
    );
  };

  useInput(
    (input, key) => {
      // Printable input with no key chord is either a keystroke or one chunk of a
      // paste — buffer it and flush the whole burst together on the next tick.
      const printable =
        input &&
        !key.ctrl &&
        !key.return &&
        !key.backspace &&
        !key.delete &&
        !key.leftArrow &&
        !key.rightArrow &&
        !key.upArrow &&
        !key.downArrow &&
        !key.escape &&
        !key.tab;
      if (printable) {
        // Buffer and flush on the next tick. All the chunks of one paste (whether
        // the terminal sends it as a few big blocks or many single chars) arrive
        // within the *same* event-loop turn, so they accumulate into one buffer
        // and are inserted as a single chip; an ordinary keystroke is a lone chunk
        // flushed a sub-millisecond tick later, which is imperceptible.
        pasteBufRef.current += input;
        if (!flushTimerRef.current) {
          flushTimerRef.current = setTimeout(flushPaste, 0);
        }
        return;
      }
      // Any control/navigation key first commits the buffered burst (preserving
      // order), then applies its own effect against the now-current value.
      flushPaste();
      applyResult(
        reduceInput(
          { value: valueRef.current, cursor: cursorRef.current },
          input,
          key,
          { capture, registerPaste },
        ),
      );
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
        // Shift+Enter newline renders zero-height and appears to do nothing). The
        // key combines the row ordinal with its text so identical blank rows stay
        // distinct without a bare index key.
        <Text key={`${i}:${row.text}`}>
          {row.cursorCol !== null ? (
            <CursorLine text={row.text} col={row.cursorCol} pastes={pastes} />
          ) : (
            <BlankableLine text={row.text} pastes={pastes} />
          )}
        </Text>
      ))}
    </Box>
  );
}

/** Render a line's chip-aware content, or a single space when empty so Ink still
 *  gives the row height (a zero-height blank row makes Shift+Enter look broken).
 *  An empty line yields no parts, so guard on the text directly. */
function BlankableLine({
  text,
  pastes,
}: {
  text: string;
  pastes: Map<number, string>;
}): React.ReactElement {
  if (text.length === 0) return <Text> </Text>;
  return <LineParts text={text} pastes={pastes} />;
}

/** One piece of a line: a plain-text run or a paste-chip marker. Pure data (no
 *  JSX) so the split can be computed without rendering. `start` is the part's
 *  offset within the line — a stable React key that is not the array index. */
type LinePart =
  | { text: string; start: number }
  | { chipId: number; start: number };

/** Split a line into plain-text runs and paste-chip markers. */
function splitLineParts(text: string): LinePart[] {
  const parts: LinePart[] = [];
  let buf = "";
  let bufStart = 0;
  let pos = 0;
  const flush = () => {
    if (buf) {
      parts.push({ text: buf, start: bufStart });
      buf = "";
    }
  };
  for (const ch of text) {
    const id = pasteId(ch);
    if (id >= 0) {
      flush();
      parts.push({ chipId: id, start: pos });
    } else {
      if (!buf) bufStart = pos;
      buf += ch;
    }
    pos += ch.length;
  }
  flush();
  return parts;
}

/** A line's chip-aware content: plain runs interleaved with dim `[Pasted …]`
 *  chips. Used for both blank-but-present rows and the no-cursor segments of a
 *  cursor row. */
function LineParts({
  text,
  pastes,
}: {
  text: string;
  pastes: Map<number, string>;
}): React.ReactElement {
  const parts = splitLineParts(text);
  return (
    <>
      {parts.map((part) =>
        "chipId" in part ? (
          <Text key={`p${part.start}`} dimColor>
            {pasteChipLabel(part.chipId, pastes.get(part.chipId) ?? "")}
          </Text>
        ) : (
          <Text key={`t${part.start}`}>{part.text}</Text>
        ),
      )}
    </>
  );
}

/** Render one line with an inverse block at `col` (a trailing space if at EOL),
 *  splitting around the cursor and swapping paste sentinels for their chips. */
function CursorLine({
  text,
  col,
  pastes,
}: {
  text: string;
  col: number;
  pastes: Map<number, string>;
}): React.ReactElement {
  const chars = [...text];
  const before = chars.slice(0, col).join("");
  const at = chars[col];
  const after = chars.slice(col + 1).join("");
  // The cursor sits on a paste chip: highlight the whole chip label.
  if (at !== undefined && pasteId(at) >= 0) {
    return (
      <>
        <LineParts text={before} pastes={pastes} />
        <Text inverse>
          {pasteChipLabel(pasteId(at), pastes.get(pasteId(at)) ?? "")}
        </Text>
        <LineParts text={after} pastes={pastes} />
      </>
    );
  }
  if (at === undefined) {
    return (
      <>
        <LineParts text={before} pastes={pastes} />
        <Text inverse> </Text>
      </>
    );
  }
  return (
    <>
      <LineParts text={before} pastes={pastes} />
      <Text inverse>{at}</Text>
      <LineParts text={after} pastes={pastes} />
    </>
  );
}
