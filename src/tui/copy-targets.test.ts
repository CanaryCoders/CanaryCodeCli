// copy-targets.test.ts — source-text extraction for transcript copy actions.
//
// These cover the portability contract (copy the original/source text, never the
// renderer's wrapped rows, table padding, code gutters, or language labels) and
// the chip resolver. They are pure — no clipboard spawn is exercised here.

import { describe, expect, test } from "bun:test";
import {
  copyTargetForItem,
  extractCodeBlocks,
  extractMarkdownTables,
  resolveItemCopyTarget,
} from "./copy-targets.ts";
import type { Item } from "./Message.tsx";

const assistant: Item = {
  id: 1,
  kind: "assistant",
  text: "hello world",
};

const tool: Item = {
  id: 2,
  kind: "tool",
  toolId: "t1",
  name: "bash",
  input: { command: "ls -la" },
  result: "file-a\nfile-b",
  pending: false,
};

describe("copyTargetForItem", () => {
  test("a user message copies its original prompt text", () => {
    const user: Item = { id: 10, kind: "user", text: "summarise this repo" };
    const target = copyTargetForItem(user);
    expect(target?.kind).toBe("message");
    expect(target?.text).toBe("summarise this repo");
  });

  test("an assistant message copies its original markdown text", () => {
    const md: Item = {
      id: 11,
      kind: "assistant",
      text: "# Title\n\nSome **bold** prose.",
    };
    const target = copyTargetForItem(md);
    expect(target?.kind).toBe("message");
    expect(target?.text).toBe("# Title\n\nSome **bold** prose.");
  });
});

describe("extractCodeBlocks", () => {
  test("copies code without the fence markers or language label", () => {
    const md = "intro\n\n```ts\nconst x = 1;\nconst y = 2;\n```\n\noutro";
    const [block] = extractCodeBlocks(md);
    expect(block?.kind).toBe("code");
    expect(block?.label).toBe("ts");
    expect(block?.text).toBe("const x = 1;\nconst y = 2;");
    expect(block?.text).not.toContain("```");
  });
});

describe("extractMarkdownTables", () => {
  test("yields raw markdown and tab-joined (unpadded) targets", () => {
    const md = ["| a | bb |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    const targets = extractMarkdownTables(md);
    const markdown = targets.find((t) => t.kind === "table-markdown");
    const tsv = targets.find((t) => t.kind === "table-tsv");
    expect(markdown?.text).toContain("| a | bb |");
    // The TSV target is tab-joined with no visual column padding.
    expect(tsv?.text).toBe("a\tbb\n1\t2");
    expect(tsv?.text).not.toContain("  ");
  });
});

describe("resolveItemCopyTarget", () => {
  test("default kind copies an assistant message's text", () => {
    const target = resolveItemCopyTarget(assistant);
    expect(target?.kind).toBe("message");
    expect(target?.text).toBe("hello world");
  });

  test("command kind copies the formatted tool command (input)", () => {
    const target = resolveItemCopyTarget(tool, "command");
    expect(target?.kind).toBe("tool-command");
    expect(target?.text).toContain("ls -la");
  });

  test("output kind copies the tool's full result", () => {
    const target = resolveItemCopyTarget(tool, "output");
    expect(target?.kind).toBe("tool-output");
    expect(target?.text).toBe("file-a\nfile-b");
  });

  test("returns null when the requested chip has no text", () => {
    const empty: Item = { id: 3, kind: "user", text: "" };
    expect(resolveItemCopyTarget(empty)).toBeNull();
  });

  test("returns null for a command chip on a non-tool item", () => {
    expect(resolveItemCopyTarget(assistant, "command")).toBeNull();
  });
});
