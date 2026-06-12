// tui/Input.tsx — a tiny multi-line text input for the TUI prompt box.
//
// Off-the-shelf single-line text inputs submit on every Enter, so they can't hold
// a multi-line message. This is a focused, dependency-free replacement: plain
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

import { useRef, useState } from "react";
import {
  chipIdBeforeCursor,
  cursorLineCol,
  EMPTY_PASTES,
  type InputResult,
  pasteChipLabel,
  pasteId,
  reduceInput,
  stripEscapes,
  wrapDisplayLine,
} from "./input-helpers.ts";
import { useTuiInput, useTuiPaste } from "./keyboard.ts";
import { Box, Text } from "./primitives.tsx";
import { INTERACTIVE, tint } from "./theme.ts";

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
  /** When false, the prompt is inert — keystrokes/pastes don't edit the buffer.
   * Set while the App is in keyboard nav mode (keys drive the transcript instead). */
  inputActive?: boolean;
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
  /** Click handler for a paste chip — opens the host's read-only preview popover
   *  for that paste id. Omit to make chips non-interactive (plain dim labels). */
  onChipClick?: (id: number) => void;
  /** True while the paste-preview popover is open. The editor pauses (its key/paste
   *  hooks go inert) so the popover's own keys don't type into the buffer; the
   *  buffer/cursor are left untouched until the preview closes. */
  previewActive?: boolean;
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
  inputActive = true,
  capture = false,
  cursorNonce = 0,
  onHistoryPrev,
  onHistoryNext,
  registerPaste,
  pastes = EMPTY_PASTES,
  onChipClick,
  previewActive = false,
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

  // The live value/cursor are mirrored in refs so each event applies against the
  // newest edit even when several land in one tick (the `value` prop only catches
  // up on the next render). `applyResult` updates the refs synchronously, so
  // back-to-back keystrokes and pastes chain correctly.
  const valueRef = useRef(value);
  valueRef.current = value;
  const cursorRef = useRef(effectiveCursor);
  cursorRef.current = effectiveCursor;

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

  // Key events apply immediately — one keystroke is one edit. (Ink used to
  // deliver a paste as a flurry of keystrokes, so the input buffered printable
  // input on a deferred flush to rebuild a paste as a single chip. OpenTUI
  // delivers a bracketed paste as one atomic event instead — see useTuiPaste
  // below — so that coalescing is no longer needed.)
  useTuiInput(
    (input, key) => {
      // Raw Esc bursts can arrive with key.escape missing when the key is
      // spammed. They are handled by App's global cancel listener; never render
      // them as input.
      const cleanInput = stripEscapes(input);
      if (input && !cleanInput) return;
      // Ctrl+P opens the preview for the chip the cursor rests just after — a
      // keyboard path to what a mouse click on the chip already does. Only when
      // autocomplete is closed (`!capture`), so it never fights the popover's own
      // Ctrl+P = move-selection; and only when the char before the cursor is a
      // sentinel, so otherwise Ctrl+P stays the editor's no-op. Consumes the key.
      if (key.ctrl && cleanInput === "p" && !capture && onChipClick) {
        const chipId = chipIdBeforeCursor(valueRef.current, cursorRef.current);
        if (chipId !== null) {
          onChipClick(chipId);
          return;
        }
      }
      applyResult(
        reduceInput(
          { value: valueRef.current, cursor: cursorRef.current },
          cleanInput,
          key,
          { capture, registerPaste },
        ),
      );
    },
    // Inert in nav mode (`inputActive` false), or while the paste-preview popover
    // is open (`previewActive`): keystrokes drive the transcript / the popover, not
    // the prompt buffer.
    { isActive: isActive && inputActive && !previewActive },
  );

  // A terminal paste arrives as a single bracketed-paste event, so it goes
  // straight through `reduceInput` as one insert with an empty key — which
  // collapses a large paste into a single `[Pasted …]` chip. The chip threshold
  // lives in reduceInput, so chip semantics match the old coalescing path.
  useTuiPaste(
    (text) => {
      applyResult(
        reduceInput(
          { value: valueRef.current, cursor: cursorRef.current },
          text,
          {},
          { capture, registerPaste },
        ),
      );
    },
    { isActive: isActive && inputActive && !previewActive },
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

  // When the cursor rests on/just after a paste chip and the editor is live, offer
  // a subtle one-line hint for the keyboard open (mirrors the mouse click). Gated
  // the same way as the Ctrl+P handler so the hint never lies about being usable.
  const showChipHint =
    isActive &&
    inputActive &&
    !previewActive &&
    !capture &&
    onChipClick !== undefined &&
    chipIdBeforeCursor(value, effectiveCursor) !== null;

  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        // A blank row still needs a space so Ink gives it height (otherwise a
        // Shift+Enter newline renders zero-height and appears to do nothing). The
        // key combines the row ordinal with its text so identical blank rows stay
        // distinct without a bare index key.
        <Text key={`${i}:${row.text}`}>
          {row.cursorCol !== null ? (
            <CursorLine
              text={row.text}
              col={row.cursorCol}
              pastes={pastes}
              onChipClick={onChipClick}
            />
          ) : (
            <BlankableLine
              text={row.text}
              pastes={pastes}
              onChipClick={onChipClick}
            />
          )}
        </Text>
      ))}
      {showChipHint && <Text dimColor>{"ctrl+p preview"}</Text>}
    </Box>
  );
}

/** Render a line's chip-aware content, or a single space when empty so Ink still
 *  gives the row height (a zero-height blank row makes Shift+Enter look broken).
 *  An empty line yields no parts, so guard on the text directly. */
function BlankableLine({
  text,
  pastes,
  onChipClick,
}: {
  text: string;
  pastes: Map<number, string>;
  onChipClick?: (id: number) => void;
}): React.ReactElement {
  if (text.length === 0) return <Text> </Text>;
  return <LineParts text={text} pastes={pastes} onChipClick={onChipClick} />;
}

/** A single paste chip: a dim `[Pasted …]` label that brightens on hover and, when
 *  interactive, opens the read-only preview popover on click. Kept to one inline
 *  `<Text>` run so the cursor/line-wrap math (which treats the sentinel as one
 *  atomic unit) is unchanged — see `wrapDisplayLine`/`splitLineParts`. */
function Chip({
  id,
  pastes,
  onChipClick,
}: {
  id: number;
  pastes: Map<number, string>;
  onChipClick?: (id: number) => void;
}): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const interactive = onChipClick !== undefined;
  const label = pasteChipLabel(id, pastes.get(id) ?? "");
  return (
    <Text
      dimColor={!hovered}
      color={hovered ? tint(INTERACTIVE.hoverFg) : undefined}
      backgroundColor={hovered ? tint(INTERACTIVE.hoverBg) : undefined}
      cursor={interactive ? "pointer" : "default"}
      onMouseOver={() => {
        if (interactive) setHovered(true);
      }}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        if (!interactive || event.button !== 0) return;
        // Open on press (mouse-up can land outside a one-line chip after a drag);
        // stop propagation so the click doesn't reach the surrounding surface.
        event.stopPropagation();
        onChipClick?.(id);
      }}
    >
      {label}
    </Text>
  );
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
  onChipClick,
}: {
  text: string;
  pastes: Map<number, string>;
  onChipClick?: (id: number) => void;
}): React.ReactElement {
  const parts = splitLineParts(text);
  return (
    <>
      {parts.map((part) =>
        "chipId" in part ? (
          <Chip
            key={`p${part.start}`}
            id={part.chipId}
            pastes={pastes}
            onChipClick={onChipClick}
          />
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
  onChipClick,
}: {
  text: string;
  col: number;
  pastes: Map<number, string>;
  onChipClick?: (id: number) => void;
}): React.ReactElement {
  const chars = [...text];
  const before = chars.slice(0, col).join("");
  const at = chars[col];
  const after = chars.slice(col + 1).join("");
  // The cursor sits on a paste chip: highlight the whole chip label (the inverse
  // caret owns it, so it stays a plain run rather than a clickable Chip).
  if (at !== undefined && pasteId(at) >= 0) {
    return (
      <>
        <LineParts text={before} pastes={pastes} onChipClick={onChipClick} />
        <Text inverse>
          {pasteChipLabel(pasteId(at), pastes.get(pasteId(at)) ?? "")}
        </Text>
        <LineParts text={after} pastes={pastes} onChipClick={onChipClick} />
      </>
    );
  }
  if (at === undefined) {
    return (
      <>
        <LineParts text={before} pastes={pastes} onChipClick={onChipClick} />
        <Text inverse> </Text>
      </>
    );
  }
  return (
    <>
      <LineParts text={before} pastes={pastes} onChipClick={onChipClick} />
      <Text inverse>{at}</Text>
      <LineParts text={after} pastes={pastes} onChipClick={onChipClick} />
    </>
  );
}
