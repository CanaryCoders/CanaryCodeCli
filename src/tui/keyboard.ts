// tui/keyboard.ts — renderer-neutral keyboard event shape and current Ink adapter.
//
// Components should depend on `useTuiInput` and `TuiKey` rather than importing
// Ink's `useInput` directly. During the staged OpenTUI port this hook delegates to
// Ink; the OpenTUI normalizer below documents the future event mapping so the root
// switch can replace only this boundary.

import type { KeyEvent as OpenTuiKeyEvent } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import type { InputKey } from "./input-helpers.ts";

// OpenTUI's PasteEvent carries the paste as raw UTF-8 bytes; core decodes it with
// a shared TextDecoder (its exported decoder isn't in the public type surface, so
// we mirror it here rather than import an untyped symbol).
const pasteDecoder = new TextDecoder();

export type TuiKey = InputKey;

export type TuiInputHandler = (input: string, key: TuiKey) => void;

export interface TuiInputOptions {
  isActive?: boolean;
}

function printableOpenTuiInput(event: OpenTuiKeyEvent, key: TuiKey): string {
  const name = event.name;
  const raw = event.raw ?? event.sequence ?? "";

  // Existing handlers expect Ctrl+C/R/V as their printable letter, matching Ink.
  if ((key.ctrl || key.meta) && name.length === 1) return name;

  if (
    key.ctrl ||
    key.meta ||
    key.return ||
    key.backspace ||
    key.delete ||
    key.escape ||
    key.tab ||
    key.leftArrow ||
    key.rightArrow ||
    key.upArrow ||
    key.downArrow
  ) {
    return "";
  }

  // Do not leak raw escape/control sequences from named keys (home, pageup, F1,
  // etc.) into the prompt. Plain printable keys are single-character names; space
  // is commonly named while carrying a literal raw space.
  if (name === "space") return " ";
  if (name.length === 1 && raw && raw >= " ") return raw;
  return "";
}

/** Production adapter: OpenTUI useKeyboard → renderer-neutral key shape. */
export function useTuiInput(
  handler: TuiInputHandler,
  options?: TuiInputOptions,
): void {
  useKeyboard((event) => {
    if (options?.isActive === false) return;
    const { input, key } = normalizeOpenTuiKey(event);
    handler(input, key);
  });
}

/**
 * Production adapter: OpenTUI bracketed-paste event → decoded text.
 *
 * OpenTUI parses a bracketed paste as a single `paste` event carrying the raw
 * bytes, separate from key events — so the host receives the whole paste at once
 * and no longer has to coalesce per-keystroke chunks to reconstruct it (which is
 * what Ink forced, since it delivered a paste as a flurry of `useInput` calls).
 */
export function useTuiPaste(
  handler: (text: string) => void,
  options?: TuiInputOptions,
): void {
  usePaste((event) => {
    if (options?.isActive === false) return;
    handler(pasteDecoder.decode(event.bytes));
  });
}

/** OpenTUI KeyEvent → renderer-neutral key shape + input. */
export function normalizeOpenTuiKey(event: OpenTuiKeyEvent): {
  input: string;
  key: TuiKey;
} {
  const name = event.name;
  const key: TuiKey = {
    return: name === "return" || name === "enter",
    shift: event.shift,
    meta: event.meta || event.option,
    ctrl: event.ctrl,
    leftArrow: name === "left",
    rightArrow: name === "right",
    upArrow: name === "up",
    downArrow: name === "down",
    backspace: name === "backspace",
    delete: name === "delete",
    escape: name === "escape",
    tab: name === "tab",
  };

  return { input: printableOpenTuiInput(event, key), key };
}
