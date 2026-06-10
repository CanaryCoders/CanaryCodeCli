// Tests for the transcript renderer's display-width helpers (wrapWords/padRow/
// visibleWidth) and a render-level regression guard for the <Static> width bug:
// Ink's <Static> box is position:absolute with NO width, so Yoga sizes it to its
// content instead of the terminal — text then wraps a couple of columns too wide
// and the terminal hard-wraps the overflow to column 0 (no gutter indent). The
// App must pass an explicit width to <Static>; these tests render the same tree
// shape and assert no physical line exceeds the terminal width.

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Box, render, Static } from "ink";
import { type Item, ItemView } from "./tui/Message.tsx";
import {
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

// ── render regression: transcript must never exceed the terminal width ─────────

function createFakeStdout(columns: number) {
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows: 30,
    isTTY: true,
    frames: [] as string[],
    write(s: string): boolean {
      stdout.frames.push(s);
      return true;
    },
  });
  return stdout as typeof stdout & NodeJS.WriteStream;
}

/** Render `items` the way App.tsx renders the scrollback (Static + explicit
 * width) and return the physical output lines with ANSI stripped. */
async function renderScrollback(
  items: Item[],
  columns: number,
): Promise<string[]> {
  const stdout = createFakeStdout(columns);
  const tree = (
    <Box flexDirection="column">
      <Static items={items} style={{ width: columns }}>
        {(item, index) => (
          <ItemView
            key={item.id}
            item={item}
            prevKind={index > 0 ? items[index - 1]!.kind : undefined}
            columns={columns}
          />
        )}
      </Static>
    </Box>
  );
  const inst = render(tree, { stdout, patchConsole: false });
  await new Promise((r) => setTimeout(r, 50));
  inst.unmount();
  const plain = stdout.frames
    .join("")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  return plain.split("\n");
}

const PARA =
  "I need to respond, but the user's input “asd” seems meaningless. Should I inspect it? If there's no clear task, maybe I should ask what they truly need. The developer has advised using tools to inspect before answering.";

describe("scrollback render width", () => {
  test("a long thinking block never exceeds the terminal width", async () => {
    const lines = await renderScrollback(
      [{ id: 1, kind: "thinking", text: `Clarifying user input\n${PARA}` }],
      60,
    );
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
    // Wrapped continuation rows keep the 3-column gutter indent.
    const wrapped = lines.filter((l) => l.includes("developer has advised"));
    expect(wrapped.length).toBe(1);
    expect(wrapped[0]!.startsWith("   ")).toBe(true);
  });

  test("a long user line wraps within the terminal width", async () => {
    const lines = await renderScrollback(
      [{ id: 1, kind: "user", text: PARA }],
      60,
    );
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
    // Word wrap: the wrap before "developer" keeps "The" intact.
    expect(lines.some((l) => l.includes("Th") && !l.includes("The"))).toBe(
      false,
    );
  });

  // Regression: Ink boxes default to flexShrink=1, so the fixed 2-cell gutter
  // box used to shrink fractionally (2 → ~1.96) whenever the text's max-content
  // width over-constrained the row. Yoga's pixel-grid rounding then handed the
  // text node one MORE column than the space it had, and the wrapped paragraph
  // spilled single letters to column 0. These widths all reproduced the spill
  // before the gutter cells were pinned with flexShrink=0.
  const PARA2 =
    "I see the user is just greeting me, so I shouldn't need any tools for that. The developer mentions using tools for coding tasks, but that doesn't apply here. I'm thinking it's important to recap my response, even if it's just a greeting. I'll keep it concise while ensuring I fulfill the recap requirement at the end. It seems necessary, so let's make sure to adhere to that guideline!";
  for (const cols of [153, 158, 161, 172]) {
    test(`no fractional-shrink spill at ${cols} columns`, async () => {
      const lines = await renderScrollback(
        [
          { id: 1, kind: "thinking", text: `A heading line\n${PARA2}` },
          {
            id: 2,
            kind: "assistant",
            text: `Prose first.\n\`\`\`\nconst x = ${'"y"'.repeat(60)};\n\`\`\`\n`,
          },
        ],
        cols,
      );
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
      }
    });
  }
});
