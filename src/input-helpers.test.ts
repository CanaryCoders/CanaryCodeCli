// input-helpers.test.ts — pure prompt editing behavior.

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  charWidth,
  chipIdBeforeCursor,
  drainInputQuiet,
  EMPTY_PASTES,
  isRawEscapeInput,
  pasteChipLabel,
  pastePreviewLines,
  pasteSentinel,
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

describe("paste preview", () => {
  test("pasteChipLabel: 1-based id and line count, non-breaking spaces", () => {
    expect(pasteChipLabel(0, "a\nb\nc")).toBe("[Pasted text #1 +3 lines]");
    expect(pasteChipLabel(4, "single line")).toBe("[Pasted text #5 +1 lines]");
  });

  test("pasteChipLabel: separators are non-breaking spaces", () => {
    // The label must not contain ASCII spaces (they'd let Ink wrap it).
    const label = pasteChipLabel(0, "a\nb\nc");
    expect(label).not.toContain(" ");
    expect(label).toContain(" ");
    expect(label).toBe(`[Pasted text #1 +3 lines]`);
  });

  test("pastePreviewLines: returns all lines when under the cap", () => {
    expect(pastePreviewLines("a\nb\nc", 12)).toEqual({
      lines: ["a", "b", "c"],
      more: 0,
    });
    // Exactly at the cap is not trimmed.
    expect(pastePreviewLines("a\nb\nc", 3)).toEqual({
      lines: ["a", "b", "c"],
      more: 0,
    });
  });

  test("pastePreviewLines: caps long text and reports the elided count", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const { lines, more } = pastePreviewLines(text, 12);
    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe("line 0");
    expect(lines[11]).toBe("line 11");
    expect(more).toBe(8);
  });

  test("pastePreviewLines: max <= 0 elides everything", () => {
    expect(pastePreviewLines("a\nb", 0)).toEqual({ lines: [], more: 2 });
  });
});

describe("chipIdBeforeCursor", () => {
  test("returns the id when the cursor rests just after a sentinel", () => {
    const text = `hi ${pasteSentinel(2)}`;
    // Cursor at end → char before is the chip.
    expect(chipIdBeforeCursor(text, text.length)).toBe(2);
  });

  test("returns null at offset 0 (no char before the cursor)", () => {
    expect(chipIdBeforeCursor(pasteSentinel(0), 0)).toBeNull();
  });

  test("returns null when the char before is ordinary text", () => {
    expect(chipIdBeforeCursor("abc", 2)).toBeNull();
  });

  test("returns null for an offset past the end of the buffer", () => {
    const text = pasteSentinel(0);
    expect(chipIdBeforeCursor(text, text.length + 1)).toBeNull();
  });

  test("with multiple chips, returns the one immediately before the cursor", () => {
    const text = `${pasteSentinel(0)}x${pasteSentinel(1)}`;
    // Right after chip #0 (offset 1).
    expect(chipIdBeforeCursor(text, 1)).toBe(0);
    // After the ordinary 'x' (offset 2) → null.
    expect(chipIdBeforeCursor(text, 2)).toBeNull();
    // Right after chip #1 (offset 3).
    expect(chipIdBeforeCursor(text, 3)).toBe(1);
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
