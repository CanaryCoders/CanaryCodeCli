// markdown.test.ts — single-pass parse: lines + code flags stay aligned.

import { describe, expect, test } from "bun:test";
import {
  codeLineFlags,
  parseMarkdown,
  parseMarkdownWithFlags,
} from "./markdown.ts";

describe("parseMarkdownWithFlags", () => {
  test("lines and flags align and match the split functions", () => {
    const src = "# h\n```\ncode\n```\n    indented\nplain";
    const { lines, code } = parseMarkdownWithFlags(src);
    expect(lines).toEqual(parseMarkdown(src));
    expect(code).toEqual(codeLineFlags(src));
    expect(code).toEqual([false, true, true, true, true, false]);
    expect(lines.length).toBe(code.length);
  });

  test("unterminated fence flags everything after the opener as code", () => {
    const src = "before\n```\nstill code\nmore";
    const { lines, code } = parseMarkdownWithFlags(src);
    expect(code).toEqual([false, true, true, true]);
    expect(lines.length).toBe(code.length);
    expect(code).toEqual(codeLineFlags(src));
  });

  test("empty string yields one line and one flag", () => {
    const { lines, code } = parseMarkdownWithFlags("");
    expect(lines.length).toBe(1);
    expect(code).toEqual([false]);
  });
});
