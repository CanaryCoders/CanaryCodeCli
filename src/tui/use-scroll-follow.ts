// tui/use-scroll-follow.ts — track whether the transcript scrollbox is pinned to
// the newest content, and provide the "jump to latest" action.
//
// OpenTUI's ScrollBoxRenderable does NOT emit a scroll event (the only scroll
// event in core is the editor's split-view sync, unrelated here). So "am I at the
// bottom?" can only be answered by reading the renderable's live geometry —
// `scrollTop`, `scrollHeight`, and `viewport.height`. We poll on a modest interval
// and only flip React state when the answer actually changes, so an idle scrollback
// never triggers a re-render. "At bottom" tolerates a 1-row epsilon because the
// scrollbar clamps/rounds the position to whole rows.

import type { ScrollBoxRenderable } from "@opentui/core";
import { useCallback, useEffect, useRef, useState } from "react";

/** Poll cadence for the bottom check — fast enough to feel live, slow enough to
 *  stay off the render hot path. */
const POLL_MS = 120;
/** Row slack so a position rounded/clamped one row short still reads as "bottom". */
const EPSILON = 1;

export interface ScrollFollow {
  /** Ref to attach to the `<ScrollBox>` element. */
  ref: React.RefObject<ScrollBoxRenderable | null>;
  /** False once the user scrolls up away from the newest content. */
  atBottom: boolean;
  /** Scroll to the newest content and re-engage sticky-follow. */
  jumpToLatest: () => void;
  /** Scroll to the oldest content (top). */
  jumpToOldest: () => void;
}

/** Is the scrollbox pinned to (or within an epsilon of) its bottom edge? Content
 *  that fits the viewport counts as "at bottom" — there is nothing to jump to. */
function computeAtBottom(box: ScrollBoxRenderable): boolean {
  const maxScrollTop = box.scrollHeight - box.viewport.height;
  if (maxScrollTop <= EPSILON) return true;
  return box.scrollTop >= maxScrollTop - EPSILON;
}

/**
 * Track the transcript scrollbox's bottom-pinned state by polling its geometry,
 * and expose the jump actions the banner + End/Home keys drive.
 */
export function useScrollFollow(): ScrollFollow {
  const ref = useRef<ScrollBoxRenderable | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const id = setInterval(() => {
      const box = ref.current;
      // No renderable yet (first frames) → leave the optimistic default in place.
      if (!box) return;
      const next = computeAtBottom(box);
      // Only re-render on an actual transition, so a still scrollback is free.
      setAtBottom((prev) => (prev === next ? prev : next));
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const jumpToLatest = useCallback(() => {
    const box = ref.current;
    if (!box) return;
    // Passing the full scrollHeight as the target y clamps to the bottom edge;
    // setting scrollTop there re-engages sticky-bottom inside the renderable
    // (its updateStickyState flips _stickyScrollBottom on and clears manual
    // scroll), so newly-appended content sticks again without us touching the
    // private sticky flags.
    box.scrollTo({ x: box.scrollLeft, y: box.scrollHeight });
    // Optimistic: avoid a one-poll flicker of the banner before the next tick.
    setAtBottom(true);
  }, []);

  const jumpToOldest = useCallback(() => {
    const box = ref.current;
    if (!box) return;
    box.scrollTo({ x: box.scrollLeft, y: 0 });
    setAtBottom(false);
  }, []);

  return { ref, atBottom, jumpToLatest, jumpToOldest };
}
