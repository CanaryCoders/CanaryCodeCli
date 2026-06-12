// AskUser.test.ts — renderer-independent tests for the ask_user wizard's state
// reducer. The OpenTUI migration keeps the row-selection behavior pure (cursor
// moves, picks toggles, the per-question reset) so these assertions never touch a
// React renderer. Mirrors Extensions.test.tsx for the `/extensions` picker.

import { expect, test } from "bun:test";
import { reducer, type State } from "./AskUser.tsx";

/** A bare wizard state at the given cursor, with empty picks and no draft. */
function stateAt(cursor: number, picks: number[] = []): State {
  return {
    qIndex: 0,
    cursor,
    picks: new Set(picks),
    writing: false,
    draft: "",
  };
}

test("moveCursor wraps both ends", () => {
  const rowCount = 4;
  // From the top row, ↑ wraps to the last row.
  expect(
    reducer(stateAt(0), { type: "moveCursor", rowCount, delta: -1 }).cursor,
  ).toBe(3);
  // From the last row, ↓ wraps back to the top.
  expect(
    reducer(stateAt(3), { type: "moveCursor", rowCount, delta: 1 }).cursor,
  ).toBe(0);
});

test("setCursor accepts in-range and ignores out-of-range", () => {
  const rowCount = 3;
  // In range: the cursor moves there.
  expect(
    reducer(stateAt(0), { type: "setCursor", index: 2, rowCount }).cursor,
  ).toBe(2);
  // Below zero: ignored, state unchanged.
  const negative = reducer(stateAt(1), {
    type: "setCursor",
    index: -1,
    rowCount,
  });
  expect(negative.cursor).toBe(1);
  // At/above rowCount: ignored, state unchanged.
  const past = reducer(stateAt(1), { type: "setCursor", index: 3, rowCount });
  expect(past.cursor).toBe(1);
});

test("togglePick adds then removes, without mutating the prior Set", () => {
  const before = stateAt(0);
  const added = reducer(before, { type: "togglePick", index: 1 });
  expect([...added.picks]).toEqual([1]);
  // The previous picks Set is untouched (the reducer copies before mutating).
  expect(before.picks.size).toBe(0);

  // Toggling the same index again removes it — an idempotent flip.
  const removed = reducer(added, { type: "togglePick", index: 1 });
  expect([...removed.picks]).toEqual([]);
  // The intermediate state's Set is likewise not mutated by the second toggle.
  expect([...added.picks]).toEqual([1]);
});

test("nextQuestion resets picks/writing/draft and sets the cursor", () => {
  const dirty: State = {
    qIndex: 0,
    cursor: 2,
    picks: new Set([0, 1]),
    writing: true,
    draft: "half-typed answer",
  };
  const next = reducer(dirty, { type: "nextQuestion", cursor: 1 });
  expect(next.qIndex).toBe(1);
  expect(next.cursor).toBe(1);
  expect([...next.picks]).toEqual([]);
  expect(next.writing).toBe(false);
  expect(next.draft).toBe("");
});
