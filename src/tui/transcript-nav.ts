// tui/transcript-nav.ts — the pure focus model for keyboard transcript navigation.
//
// The TUI's "nav mode" (App.tsx) lets the keyboard walk the committed scrollback
// without a mouse: move focus item-to-item, expand/collapse a focused tool, and
// yank any block. The movement/selection logic is kept here as plain functions over
// the `Item[]` transcript so it can be unit-tested without a render. The launch
// banner is never focusable (it's a one-time chrome chip, not a conversational
// unit); everything else is.

import type { Item } from "./Message.tsx";

/** Items the keyboard can focus: everything except the launch banner. */
export function isFocusable(item: Item): boolean {
  return item.kind !== "banner";
}

/** Ids of all focusable items, in transcript order. */
export function focusableIds(items: Item[]): number[] {
  return items.filter(isFocusable).map((item) => item.id);
}

/**
 * Move focus one step. `dir -1` = up (toward older), `+1` = down (toward newer).
 * Clamps at the ends (vim-style, no wrap): from the last item, down is a no-op;
 * from the first, up is a no-op. When `currentId` is null or no longer present
 * (the transcript changed under the focus), this is an *entry* move — it returns
 * the last focusable id for `dir < 0` and the first for `dir > 0`.
 */
export function moveFocus(
  items: Item[],
  currentId: number | null,
  dir: -1 | 1,
): number | null {
  const ids = focusableIds(items);
  if (ids.length === 0) return null;
  const idx = currentId === null ? -1 : ids.indexOf(currentId);
  // No current focus (null) or a stale id (removed): enter at the appropriate end.
  if (idx === -1) return dir < 0 ? ids[ids.length - 1]! : ids[0]!;
  const next = idx + dir;
  // Clamp at the ends — vim-style, no wrap.
  if (next < 0 || next >= ids.length) return currentId;
  return ids[next]!;
}

/** First focusable id (vim `g`), or null when there are none. */
export function firstFocusId(items: Item[]): number | null {
  const ids = focusableIds(items);
  return ids.length > 0 ? ids[0]! : null;
}

/** Last focusable id (vim `G`), or null when there are none. */
export function lastFocusId(items: Item[]): number | null {
  const ids = focusableIds(items);
  return ids.length > 0 ? ids[ids.length - 1]! : null;
}

/** Kinds that form the body of an "answer group" — the model's prose plus the
 * actions it took. A user line or banner bounds the run; a note stands alone. */
const GROUP_BODY_KINDS = new Set<Item["kind"]>([
  "assistant",
  "thinking",
  "tool",
]);

/**
 * The contiguous "answer group" a focused item belongs to: the run of consecutive
 * assistant/thinking/tool items bounded by user/banner items (used by `Y`, which
 * yanks the whole group). For a `user` or `note` item the group is just that item.
 * Returns the members in transcript order, or an empty array when the id is unknown.
 */
export function focusGroup(items: Item[], id: number): Item[] {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return [];
  const item = items[index]!;
  // A user/note item is its own group — it does not absorb the answer around it.
  if (!GROUP_BODY_KINDS.has(item.kind)) return [item];
  // Walk out from the focused item across the contiguous answer-body run.
  let start = index;
  while (start - 1 >= 0 && GROUP_BODY_KINDS.has(items[start - 1]!.kind))
    start--;
  let end = index;
  while (end + 1 < items.length && GROUP_BODY_KINDS.has(items[end + 1]!.kind))
    end++;
  return items.slice(start, end + 1);
}
