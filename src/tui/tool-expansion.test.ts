// tool-expansion.test.ts — pure tests for per-tool expansion state. The toggle
// reducer and the expand predicate are renderer-independent so they can be
// exercised without Ink's React 18 renderer.

import { expect, test } from "bun:test";
import type { Item } from "./Message.tsx";
import { isItemExpanded, toggleToolExpanded } from "./tool-expansion.ts";

const tool = (id: number, isError = false): Item => ({
  id,
  kind: "tool",
  toolId: `t${id}`,
  name: "bash",
  input: {},
  pending: false,
  isError,
});

const assistant = (id: number): Item => ({ id, kind: "assistant", text: "hi" });

test("toggleToolExpanded adds an absent id and removes a present one", () => {
  const empty = new Set<number>();
  const added = toggleToolExpanded(empty, 1);
  expect([...added]).toEqual([1]);

  const removed = toggleToolExpanded(added, 1);
  expect([...removed]).toEqual([]);
});

test("toggleToolExpanded does not mutate the input set", () => {
  const input = new Set<number>([1]);
  const next = toggleToolExpanded(input, 2);
  expect([...input]).toEqual([1]);
  expect(next).not.toBe(input);
  expect([...next].sort()).toEqual([1, 2]);
});

test("isItemExpanded: verbose forces every tool open", () => {
  expect(isItemExpanded(tool(1), true, new Set())).toBe(true);
});

test("isItemExpanded: an individually-expanded tool is open", () => {
  expect(isItemExpanded(tool(1), false, new Set([1]))).toBe(true);
});

test("isItemExpanded: an errored tool is open even when collapsed and absent", () => {
  expect(isItemExpanded(tool(1, true), false, new Set())).toBe(true);
});

test("isItemExpanded: a plain collapsed tool stays closed", () => {
  expect(isItemExpanded(tool(1), false, new Set())).toBe(false);
});

test("isItemExpanded: non-tool items are never expanded by the set", () => {
  expect(isItemExpanded(assistant(2), false, new Set([2]))).toBe(false);
});
