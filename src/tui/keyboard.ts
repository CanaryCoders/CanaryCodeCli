// tui/keyboard.ts — renderer-neutral keyboard event shape and current Ink adapter.
//
// Components should depend on `useTuiInput` and `TuiKey` rather than importing
// Ink's `useInput` directly. During the staged OpenTUI port this hook delegates to
// Ink; the OpenTUI normalizer below documents the future event mapping so the root
// switch can replace only this boundary.

import type { KeyEvent as OpenTuiKeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { InputKey } from "./input-helpers.ts";

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
