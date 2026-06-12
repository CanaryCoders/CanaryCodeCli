// Tests for the transcript renderer's renderer-independent display-width helpers.
// Ink-rendered <Static> regression tests were intentionally replaced during the
// OpenTUI port because Ink's React 18 reconciler is incompatible with React 19.

import { describe, expect, test } from "bun:test";
import type { Message } from "./provider.ts";
import {
  itemsFromMessages,
  padRow,
  truncateWidth,
  visibleWidth,
  wrapWords,
} from "./tui/message-helpers.ts";

// ── visibleWidth ────────────────────────────────────────────────────────────────

describe("visibleWidth", () => {
  test("ascii counts 1 per char", () => {
    expect(visibleWidth("hello")).toBe(5);
    expect(visibleWidth("")).toBe(0);
  });

  test("CJK and emoji count 2 per char", () => {
    expect(visibleWidth("日本")).toBe(4);
    expect(visibleWidth("a日b")).toBe(4);
    expect(visibleWidth("🎉")).toBe(2);
  });
});

// ── padRow ──────────────────────────────────────────────────────────────────────

describe("padRow", () => {
  test("pads short rows to the width", () => {
    expect(padRow("ab", 5)).toBe("ab   ");
    expect(padRow("", 3)).toBe("   ");
  });

  test("leaves full/overlong rows alone", () => {
    expect(padRow("abcde", 5)).toBe("abcde");
    expect(padRow("abcdef", 5)).toBe("abcdef");
  });

  test("pads by visible width for wide chars", () => {
    expect(padRow("日", 4)).toBe("日  ");
  });
});

// ── truncateWidth ───────────────────────────────────────────────────────────────

describe("truncateWidth", () => {
  test("leaves short strings alone", () => {
    expect(truncateWidth("abc", 5)).toBe("abc");
  });

  test("truncates by visible width with an ellipsis", () => {
    expect(truncateWidth("abcdef", 5)).toBe("abcd…");
  });

  test("counts wide chars as two columns", () => {
    // 4 CJK chars = 8 columns; at max 5 only two fit before the ellipsis.
    expect(truncateWidth("日本語字", 5)).toBe("日本…");
    expect(visibleWidth(truncateWidth("日本語字", 5))).toBeLessThanOrEqual(5);
  });
});

// ── wrapWords ──────────────────────────────────────────────────────────────────

describe("wrapWords", () => {
  test("short line is one row", () => {
    expect(wrapWords("hello world", 20)).toEqual(["hello world"]);
  });

  test("empty line is one empty row", () => {
    expect(wrapWords("", 10)).toEqual([""]);
  });

  test("wraps at word boundaries, never mid-word when the word fits", () => {
    expect(wrapWords("what they truly need. The developer has", 24)).toEqual([
      "what they truly need.",
      "The developer has",
    ]);
  });

  test("every row fits the width", () => {
    const rows = wrapWords(
      "I need to respond, but the user's input seems meaningless.",
      13,
    );
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(13);
    expect(rows.join(" ").replace(/\s+/g, " ")).toBe(
      "I need to respond, but the user's input seems meaningless.",
    );
  });

  test("hard-breaks a word longer than the width", () => {
    expect(wrapWords("ab supercalifragilistic cd", 8)).toEqual([
      "ab",
      "supercal",
      "ifragili",
      "stic cd",
    ]);
  });

  test("breaks wide chars by visible width", () => {
    const rows = wrapWords("日本語のテキスト", 4);
    expect(rows).toEqual(["日本", "語の", "テキ", "スト"]);
  });
});

// ── transcript-width helpers ───────────────────────────────────────────────────

const PARA =
  "I need to respond, but the user's input “asd” seems meaningless. Should I inspect it? If there's no clear task, maybe I should ask what they truly need. The developer has advised using tools to inspect before answering.";

function wrapWithGutter(
  text: string,
  columns: number,
  gutter = "   ",
): string[] {
  return wrapWords(text, columns - visibleWidth(gutter)).map(
    (line) => `${gutter}${line}`,
  );
}

describe("transcript wrapping widths", () => {
  test("a long thinking block fits when wrapped behind a gutter", () => {
    const lines = wrapWithGutter(PARA, 60);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
    const wrapped = lines.filter((l) => l.includes("developer has advised"));
    expect(wrapped.length).toBe(1);
    expect(wrapped[0]!.startsWith("   ")).toBe(true);
  });

  test("a long user line wraps within the terminal width", () => {
    const lines = wrapWithGutter(PARA, 60);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
    // Word wrap: the wrap before "developer" keeps "The" intact.
    expect(lines.some((l) => l.includes("Th") && !l.includes("The"))).toBe(
      false,
    );
  });

  // Regression coverage for widths that previously reproduced gutter spill under
  // Ink. The renderer is gone from this test; the invariant remains that wrapped
  // transcript rows are budgeted against the terminal width after gutter space.
  const PARA2 =
    "I see the user is just greeting me, so I shouldn't need any tools for that. The developer mentions using tools for coding tasks, but that doesn't apply here. I'm thinking it's important to recap my response, even if it's just a greeting. I'll keep it concise while ensuring I fulfill the recap requirement at the end. It seems necessary, so let's make sure to adhere to that guideline!";
  for (const cols of [153, 158, 161, 172]) {
    test(`no gutter spill at ${cols} columns`, () => {
      const lines = wrapWithGutter(PARA2, cols);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
      }
    });
  }
});

// ── itemsFromMessages (session resume) ─────────────────────────────────────────

describe("itemsFromMessages", () => {
  test("converts a user/assistant/tool transcript into scrollback items", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "list the files" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should run ls" },
          { type: "text", text: "Listing now." },
          {
            type: "tool_use",
            id: "t1",
            name: "bash",
            input: { command: "ls" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "a.ts\nb.ts" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Two files." }] },
    ];
    const items = itemsFromMessages(messages);
    expect(items.map((i) => i.kind)).toEqual([
      "user",
      "thinking",
      "assistant",
      "tool",
      "assistant",
    ]);
    const tool = items[3]!;
    if (tool.kind !== "tool") throw new Error("expected tool item");
    expect(tool.name).toBe("bash");
    expect(tool.result).toBe("a.ts\nb.ts");
    expect(tool.pending).toBe(false);
    expect(tool.isError).toBeUndefined();
  });

  test("an unmatched tool_use renders finished without a result", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t9", name: "grep", input: { pattern: "x" } },
        ],
      },
    ];
    const [tool] = itemsFromMessages(messages);
    if (tool?.kind !== "tool") throw new Error("expected tool item");
    expect(tool.pending).toBe(false);
    expect(tool.result).toBeUndefined();
  });

  test("error results and images: errors carried, images skipped", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mediaType: "image/png", data: "aaaa" },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "bash",
            input: { command: "nope" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: "command not found",
            is_error: true,
          },
        ],
      },
    ];
    const items = itemsFromMessages(messages);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool"]);
    const tool = items[1]!;
    if (tool.kind !== "tool") throw new Error("expected tool item");
    expect(tool.isError).toBe(true);
  });
});
