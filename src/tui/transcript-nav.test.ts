// transcript-nav.test.ts — the pure focus model for keyboard transcript navigation.
//
// These cover the vim-style movement contract (clamp at the ends, enter from the
// appropriate end), the first/last selectors, and the "answer group" boundary used
// by the whole-group yank. Pure — no render is exercised.

import { describe, expect, test } from "bun:test";
import type { Item } from "./Message.tsx";
import {
  firstFocusId,
  focusableIds,
  focusGroup,
  isFocusable,
  lastFocusId,
  moveFocus,
} from "./transcript-nav.ts";

// A representative transcript: banner chrome, then two answer groups separated by
// a user line, with a trailing standalone note.
const banner: Item = {
  id: 1,
  kind: "banner",
  appName: "canarycode",
  version: "0.0.1",
  cwd: "/tmp",
  model: "m",
  provider: "p",
};
const user1: Item = { id: 2, kind: "user", text: "do a thing" };
const assistant1: Item = { id: 3, kind: "assistant", text: "on it" };
const thinking1: Item = { id: 4, kind: "thinking", text: "hmm" };
const tool1: Item = {
  id: 5,
  kind: "tool",
  toolId: "t1",
  name: "bash",
  input: { command: "ls" },
  result: "a\nb",
  pending: false,
};
const user2: Item = { id: 6, kind: "user", text: "another" };
const assistant2: Item = { id: 7, kind: "assistant", text: "done" };
const note1: Item = { id: 8, kind: "note", text: "fyi" };

const transcript: Item[] = [
  banner,
  user1,
  assistant1,
  thinking1,
  tool1,
  user2,
  assistant2,
  note1,
];

describe("isFocusable / focusableIds", () => {
  test("the banner is not focusable; everything else is", () => {
    expect(isFocusable(banner)).toBe(false);
    expect(isFocusable(user1)).toBe(true);
    expect(focusableIds(transcript)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  test("empty and all-banner transcripts have no focusable ids", () => {
    expect(focusableIds([])).toEqual([]);
    expect(focusableIds([banner])).toEqual([]);
  });
});

describe("moveFocus", () => {
  test("down (+1) steps toward newer items", () => {
    expect(moveFocus(transcript, 2, 1)).toBe(3);
    expect(moveFocus(transcript, 5, 1)).toBe(6);
  });

  test("up (-1) steps toward older items", () => {
    expect(moveFocus(transcript, 6, -1)).toBe(5);
    expect(moveFocus(transcript, 3, -1)).toBe(2);
  });

  test("clamps at the ends (no wrap)", () => {
    // Last focusable id can't move down.
    expect(moveFocus(transcript, 8, 1)).toBe(8);
    // First focusable id can't move up.
    expect(moveFocus(transcript, 2, -1)).toBe(2);
  });

  test("from null, up enters at the last and down enters at the first", () => {
    expect(moveFocus(transcript, null, -1)).toBe(8);
    expect(moveFocus(transcript, null, 1)).toBe(2);
  });

  test("a stale id enters from the appropriate end", () => {
    expect(moveFocus(transcript, 999, -1)).toBe(8);
    expect(moveFocus(transcript, 999, 1)).toBe(2);
  });

  test("an empty/all-banner transcript yields null", () => {
    expect(moveFocus([], 1, 1)).toBeNull();
    expect(moveFocus([banner], null, -1)).toBeNull();
  });
});

describe("firstFocusId / lastFocusId", () => {
  test("skip the banner at the head", () => {
    expect(firstFocusId(transcript)).toBe(2);
    expect(lastFocusId(transcript)).toBe(8);
  });

  test("null when nothing is focusable", () => {
    expect(firstFocusId([banner])).toBeNull();
    expect(lastFocusId([])).toBeNull();
  });
});

describe("focusGroup", () => {
  test("returns the contiguous assistant/thinking/tool run, stopping at a user", () => {
    // The first answer group runs assistant1 → thinking1 → tool1 (bounded by the
    // user lines on either side).
    expect(focusGroup(transcript, 4).map((i) => i.id)).toEqual([3, 4, 5]);
    // Entering from any member yields the same whole group.
    expect(focusGroup(transcript, 3).map((i) => i.id)).toEqual([3, 4, 5]);
    expect(focusGroup(transcript, 5).map((i) => i.id)).toEqual([3, 4, 5]);
  });

  test("a user item's group is just itself", () => {
    expect(focusGroup(transcript, 2).map((i) => i.id)).toEqual([2]);
  });

  test("a note item's group is just itself (it does not absorb the answer)", () => {
    expect(focusGroup(transcript, 8).map((i) => i.id)).toEqual([8]);
  });

  test("an unknown id yields an empty group", () => {
    expect(focusGroup(transcript, 999)).toEqual([]);
  });
});
