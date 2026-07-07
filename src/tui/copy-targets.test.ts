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
  groupCopyText,
  isSshSession,
  OSC52_MAX_TEXT_BYTES,
  osc52ClipboardSequence,
  resolveItemCopyTarget,
  writeOsc52Clipboard,
  writeTextToClipboard,
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

describe("groupCopyText", () => {
  test("joins each member's source text with a blank line", () => {
    const thinking: Item = { id: 20, kind: "thinking", text: "let me think" };
    expect(groupCopyText([assistant, thinking, tool])).toBe(
      "hello world\n\nlet me think\n\nfile-a\nfile-b",
    );
  });

  test("skips members with no copyable text and leaves no stray gaps", () => {
    const empty: Item = { id: 21, kind: "note", text: "" };
    expect(groupCopyText([assistant, empty, tool])).toBe(
      "hello world\n\nfile-a\nfile-b",
    );
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

describe("OSC 52 clipboard", () => {
  test("detects SSH sessions from standard environment variables", () => {
    expect(isSshSession({ SSH_CONNECTION: "1 2 3 4" })).toBe(true);
    expect(isSshSession({ SSH_CLIENT: "1 2 3" })).toBe(true);
    expect(isSshSession({ SSH_TTY: "/dev/pts/1" })).toBe(true);
    expect(isSshSession({})).toBe(false);
  });

  test("builds a base64 OSC 52 clipboard sequence", () => {
    expect(osc52ClipboardSequence("hello", {})).toBe("\x1b]52;c;aGVsbG8=\x07");
  });

  test("wraps OSC 52 for tmux passthrough", () => {
    expect(osc52ClipboardSequence("hello", { TMUX: "/tmp/tmux" })).toBe(
      "\x1bPtmux;\x1b\x1b]52;c;aGVsbG8=\x07\x1b\\",
    );
  });

  test("rejects oversized OSC 52 payloads", () => {
    expect(
      osc52ClipboardSequence("x".repeat(OSC52_MAX_TEXT_BYTES + 1), {}),
    ).toBe(null);
  });

  test("writes OSC 52 only to a TTY", () => {
    const chunks: string[] = [];
    const writer = {
      isTTY: true,
      write: (chunk: string) => chunks.push(chunk),
    };
    expect(writeOsc52Clipboard("hi", {}, writer)).toBe(true);
    expect(chunks).toEqual(["\x1b]52;c;aGk=\x07"]);
    expect(
      writeOsc52Clipboard("hi", {}, { isTTY: false, write: () => {} }),
    ).toBe(false);
  });

  test("prefers OSC 52 over remote native clipboard tools in SSH", async () => {
    const chunks: string[] = [];
    const writer = {
      isTTY: true,
      write: (chunk: string) => chunks.push(chunk),
    };
    const result = await writeTextToClipboard(
      "remote copy",
      "darwin",
      { SSH_CONNECTION: "1 2 3 4" },
      writer,
    );
    expect(result).toEqual({ ok: true });
    expect(chunks).toEqual(["\x1b]52;c;cmVtb3RlIGNvcHk=\x07"]);
  });
});
