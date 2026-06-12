// keyboard.test.ts — renderer-neutral keyboard normalization.

import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { normalizeOpenTuiKey } from "./keyboard.ts";

function event(partial: Partial<KeyEvent>): KeyEvent {
  return {
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: "",
    raw: "",
    eventType: "press",
    source: "raw",
    number: false,
    ...partial,
  } as KeyEvent;
}

describe("normalizeOpenTuiKey", () => {
  test("maps ctrl letter chords to Ink-compatible input letters", () => {
    expect(
      normalizeOpenTuiKey(event({ name: "c", ctrl: true, raw: "\x03" })),
    ).toMatchObject({ input: "c", key: { ctrl: true } });
    expect(
      normalizeOpenTuiKey(event({ name: "r", ctrl: true, raw: "\x12" })),
    ).toMatchObject({ input: "r", key: { ctrl: true } });
    expect(
      normalizeOpenTuiKey(event({ name: "v", ctrl: true, raw: "\x16" })),
    ).toMatchObject({ input: "v", key: { ctrl: true } });
  });

  test("maps navigation and submit keys without leaking raw sequences", () => {
    expect(
      normalizeOpenTuiKey(event({ name: "up", raw: "\x1b[A" })),
    ).toMatchObject({ input: "", key: { upArrow: true } });
    expect(
      normalizeOpenTuiKey(event({ name: "enter", raw: "\r" })),
    ).toMatchObject({ input: "", key: { return: true } });
    expect(
      normalizeOpenTuiKey(event({ name: "tab", shift: true, raw: "\x1b[Z" })),
    ).toMatchObject({ input: "", key: { tab: true, shift: true } });
  });

  test("keeps printable text and ignores unknown control sequences", () => {
    expect(normalizeOpenTuiKey(event({ name: "a", raw: "a" }))).toMatchObject({
      input: "a",
    });
    expect(
      normalizeOpenTuiKey(event({ name: "space", raw: " " })),
    ).toMatchObject({
      input: " ",
    });
    expect(
      normalizeOpenTuiKey(event({ name: "home", raw: "\x1b[H" })),
    ).toMatchObject({ input: "" });
  });

  test("flags home/end without leaking their raw sequences", () => {
    expect(
      normalizeOpenTuiKey(event({ name: "home", raw: "\x1b[H" })),
    ).toMatchObject({ input: "", key: { home: true, end: false } });
    expect(
      normalizeOpenTuiKey(event({ name: "end", raw: "\x1b[F" })),
    ).toMatchObject({ input: "", key: { end: true, home: false } });
  });
});
