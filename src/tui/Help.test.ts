// tui/Help.test.ts — the help overlay's reference rows are pure data, so they can
// be asserted without rendering. Guards that the cheat-sheet stays non-empty and
// every row carries an action plus both a keyboard and a mouse column (a `"—"`
// dash is the explicit "no equivalent" marker — never an empty string).

import { describe, expect, it } from "bun:test";
import { HELP_ROWS } from "./Help.tsx";

describe("HELP_ROWS", () => {
  it("is non-empty", () => {
    expect(HELP_ROWS.length).toBeGreaterThan(0);
  });

  it("every row has an action and both columns filled", () => {
    for (const row of HELP_ROWS) {
      expect(row.action.length).toBeGreaterThan(0);
      expect(row.keyboard.length).toBeGreaterThan(0);
      expect(row.mouse.length).toBeGreaterThan(0);
    }
  });

  it("covers the new mouse affordances", () => {
    const mice = HELP_ROWS.map((r) => r.mouse).join(" | ");
    expect(mice).toContain("click mode pill");
    expect(mice).toContain("click verbose chip");
    expect(mice).toContain("click footer ?");
  });
});
