// markdown.test.ts — single-pass parse: lines + code flags stay aligned.

import { describe, expect, test } from "bun:test";
import {
  codeLineFlags,
  parseMarkdown,
  parseMarkdownBlocks,
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

  test("indented bullets/quotes render as lists, not code", () => {
    const { lines, code } = parseMarkdownWithFlags(
      "    - bullet\n    > quote\n    1. numbered\n    plain code",
    );
    expect(code).toEqual([false, false, false, true]);
    // the bullet really is rendered as a bullet (not dim verbatim)
    expect(lines[0]!.spans[0]!.text).toContain("•");
  });

  test("parses fenced code blocks without rendering fence delimiters", () => {
    const blocks = parseMarkdownBlocks("before\n```ts\nconst x = 1;\n```\nafter");
    expect(blocks).toEqual([
      { kind: "lines", lines: [{ spans: [{ text: "before" }] }] },
      {
        kind: "code",
        language: "ts",
        code: "const x = 1;",
        lines: ["const x = 1;"],
      },
      { kind: "lines", lines: [{ spans: [{ text: "after" }] }] },
    ]);
  });

  test("parses markdown tables with alignment and padded cells", () => {
    const blocks = parseMarkdownBlocks(
      "| Name | Count |\n| :--- | ---: |\n| a | 12 |\n| longer | 3 |",
    );
    expect(blocks.length).toBe(1);
    const table = blocks[0]!;
    expect(table.kind).toBe("table");
    if (table.kind !== "table") return;
    expect(table.align).toEqual(["left", "right"]);
    expect(table.widths).toEqual([6, 5]);
    expect(table.headers[0]!.spans[0]!.text).toBe("Name  ");
    expect(table.headers[1]!.spans[0]!.text).toBe("Count");
    expect(table.rows[0]![0]!.spans[0]!.text).toBe("a     ");
    expect(table.rows[0]![1]!.spans[0]!.text).toBe("   12");
  });
});
