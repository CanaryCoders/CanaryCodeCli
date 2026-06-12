// session-picker.test.ts — the pure helpers behind the `cc --resume` picker.

import { describe, expect, test } from "bun:test";
import type { SessionRow } from "./session.ts";
import {
  formatAge,
  pickerActionForInput,
  renderPickerLines,
} from "./session-picker.ts";

describe("pickerActionForInput", () => {
  test("maps arrows, vi keys, enter, and cancel keys", () => {
    expect(pickerActionForInput("\x1b[A")).toBe("up");
    expect(pickerActionForInput("\x1bOA")).toBe("up");
    expect(pickerActionForInput("k")).toBe("up");
    expect(pickerActionForInput("\x1b[B")).toBe("down");
    expect(pickerActionForInput("j")).toBe("down");
    expect(pickerActionForInput("\r")).toBe("accept");
    expect(pickerActionForInput("\x1b")).toBe("cancel");
    expect(pickerActionForInput("q")).toBe("cancel");
    expect(pickerActionForInput("\x03")).toBe("cancel");
    expect(pickerActionForInput("x")).toBe("none");
    // A CSI sequence that isn't an arrow must not cancel (it contains \x1b).
    expect(pickerActionForInput("\x1b[C")).toBe("none");
  });
});

describe("formatAge", () => {
  const now = 1_750_000_000_000;
  test("buckets seconds/minutes/hours/days", () => {
    expect(formatAge(now - 10_000, now)).toBe("just now");
    expect(formatAge(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatAge(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatAge(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});

function row(over: Partial<SessionRow>): SessionRow {
  return {
    id: "abcdef1234567890",
    createdAt: 0,
    updatedAt: 0,
    model: "claude-opus-4-8",
    cwd: "/tmp",
    title: "fix the parser",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    thinking: null,
    mode: null,
    ...over,
  };
}

describe("renderPickerLines", () => {
  const now = 1_750_000_000_000;
  test("marks the selected row and shows id/age/model/title", () => {
    const rows = [
      row({ id: "aaaaaaaa1111", updatedAt: now - 60_000 }),
      row({ id: "bbbbbbbb2222", title: null, updatedAt: now - 3_600_000 }),
    ];
    const lines = renderPickerLines(rows, 1, 100, false, now);
    expect(lines).toHaveLength(4); // header + 2 rows + hint
    expect(lines[1]).toStartWith("  aaaaaaaa");
    expect(lines[1]).toContain("1m ago");
    expect(lines[1]).toContain("fix the parser");
    expect(lines[2]).toStartWith("❯ bbbbbbbb");
    expect(lines[2]).toContain("(untitled)");
  });

  test("clips long titles so a row never wraps", () => {
    const rows = [row({ title: "x".repeat(300) })];
    const lines = renderPickerLines(rows, 0, 60, false, now);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
    expect(lines[1]).toContain("…");
  });
});
