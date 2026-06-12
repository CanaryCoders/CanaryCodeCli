// tui/tool-expansion.ts — per-tool expansion state for the transcript.
//
// Ctrl+R toggles `verbose` (expand ALL tools); clicking one tool card toggles
// just that tool. A tool renders expanded when verbose is on, the user expanded
// it individually, or it errored (errors always show their detail).
import type { Item } from "./Message.tsx";

/** Return a new set with `id` toggled (added if absent, removed if present). */
export function toggleToolExpanded(
  expanded: ReadonlySet<number>,
  id: number,
): Set<number> {
  const next = new Set(expanded);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Whether a transcript item should render expanded. Non-tool items are
 *  unaffected (they ignore `expanded`); a tool expands on verbose, individual
 *  expansion, or error. */
export function isItemExpanded(
  item: Item,
  verbose: boolean,
  expandedToolIds: ReadonlySet<number>,
): boolean {
  if (verbose) return true;
  if (item.kind === "tool") {
    return expandedToolIds.has(item.id) || Boolean(item.isError);
  }
  return false;
}
