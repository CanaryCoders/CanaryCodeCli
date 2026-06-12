// input-helpers.test.ts — pure prompt editing behavior.

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  charWidth,
  drainInputQuiet,
  EMPTY_PASTES,
  isRawEscapeInput,
  reduceInput,
  wrapDisplayLine,
} from "./tui/input-helpers.ts";

describe("reduceInput", () => {
  test("backspace deletes before the cursor and delete deletes at the cursor", () => {
    expect(
      reduceInput({ value: "abcd", cursor: 2 }, "", { backspace: true }),
    ).toEqual({ type: "update", value: "acd", cursor: 1 });
    expect(
      reduceInput({ value: "abcd", cursor: 2 }, "", { delete: true }),
    ).toEqual({ type: "update", value: "abd", cursor: 2 });
    expect(
      reduceInput({ value: "abcd", cursor: 4 }, "", { delete: true }),
    ).toEqual({ type: "none" });
  });

  test("ignores raw escape bytes instead of inserting visible ^[ text", () => {
    expect(reduceInput({ value: "", cursor: 0 }, "\x1b", {})).toEqual({
      type: "none",
    });
    expect(reduceInput({ value: "hi", cursor: 2 }, "\x1b\x1b", {})).toEqual({
      type: "none",
    });
  });

  test("strips raw escape bytes from mixed text chunks", () => {
    expect(reduceInput({ value: "", cursor: 0 }, "a\x1bb", {})).toEqual({
      type: "update",
      value: "ab",
      cursor: 2,
    });
  });
});

describe("isRawEscapeInput", () => {
  test("recognises bare-escape chunks Ink delivers without key.escape", () => {
    expect(isRawEscapeInput("\x1b")).toBe(true);
    expect(isRawEscapeInput("\x1b\x1b")).toBe(true);
    expect(isRawEscapeInput("\x1b\x1b\x1b")).toBe(true);
  });

  test("ignores empty and mixed input", () => {
    expect(isRawEscapeInput("")).toBe(false);
    expect(isRawEscapeInput("a")).toBe(false);
    expect(isRawEscapeInput("a\x1bb")).toBe(false);
  });
});

describe("display width", () => {
  test("charWidth: wide and narrow codepoints", () => {
    expect(charWidth("a")).toBe(1);
    expect(charWidth("漢")).toBe(2); // CJK ideograph
    expect(charWidth("ｱ")).toBe(1); // halfwidth katakana
    expect(charWidth("Ａ")).toBe(2); // fullwidth Latin
    expect(charWidth("😀")).toBe(2); // emoji
    expect(charWidth("한")).toBe(2); // hangul syllable
  });

  test("wrapDisplayLine: wide chars fill columns at 2 each", () => {
    // 4 ideographs = 8 columns; width 4 → two rows of 2 chars each
    const rows = wrapDisplayLine("漢字漢字", 4, EMPTY_PASTES);
    expect(rows.map((r) => r.text)).toEqual(["漢字", "漢字"]);
    expect(rows[0]).toMatchObject({ start: 0, end: 2 });
    expect(rows[1]).toMatchObject({ start: 2, end: 4 });
  });
});

describe("drainInputQuiet", () => {
  test("resolves once the stream has been quiet for quietMs", async () => {
    const stdin = new EventEmitter();
    const start = Date.now();
    await drainInputQuiet(stdin, 20, 200);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(elapsed).toBeLessThan(150);
    // The listener must be removed — no leak into the parent shell's stdin.
    expect(stdin.listenerCount("data")).toBe(0);
  });

  test("a steady key-spam stream is cut off at maxMs", async () => {
    const stdin = new EventEmitter();
    const spam = setInterval(() => stdin.emit("data", Buffer.from("\x1b")), 5);
    const start = Date.now();
    await drainInputQuiet(stdin, 50, 120);
    clearInterval(spam);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(300);
    expect(stdin.listenerCount("data")).toBe(0);
  });
});
