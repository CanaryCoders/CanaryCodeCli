// input-helpers.test.ts — pure prompt editing behavior.

import { describe, expect, test } from "bun:test";
import { isRawEscapeInput, reduceInput } from "./tui/input-helpers.ts";

describe("reduceInput", () => {
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
