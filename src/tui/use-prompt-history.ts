// tui/use-prompt-history.ts — shell-style prompt history for the TUI input.
//
// Up walks back through submitted prompts (stashing the live draft on the first
// press); Down walks forward, the last step restoring the stashed draft. Editing
// the input resets browsing so the next Up re-stashes. All browse state lives in
// refs — none of it drives render — so this is a behaviour-only hook with no
// re-renders of its own.

import { useRef } from "react";

export interface PromptHistory {
  /** Up at the first line: recall the previous submitted prompt. */
  historyPrev: () => void;
  /** Down at the last line: walk forward toward the live draft. */
  historyNext: () => void;
  /** Record a submitted line (de-dup consecutive) and exit browsing. */
  recordHistory: (line: string) => void;
  /** Leave browsing (called when the input is edited) so the next Up re-stashes. */
  resetBrowsing: () => void;
}

export function usePromptHistory(opts: {
  /** Read the live input buffer (so the first Up can stash the current draft). */
  getInput: () => string;
  setInput: (value: string) => void;
  /** Bump the input's cursor nonce so it snaps to end after an out-of-band set. */
  bumpCursor: () => void;
}): PromptHistory {
  const listRef = useRef<string[]>([]);
  const idxRef = useRef<number | null>(null);
  const draftRef = useRef("");

  function historyPrev(): void {
    const list = listRef.current;
    if (list.length === 0) return;
    if (idxRef.current === null) {
      draftRef.current = opts.getInput();
      idxRef.current = list.length - 1;
    } else {
      idxRef.current = Math.max(0, idxRef.current - 1);
    }
    opts.setInput(list[idxRef.current]!);
    opts.bumpCursor();
  }

  function historyNext(): void {
    if (idxRef.current === null) return; // already on the live draft
    const list = listRef.current;
    const next = idxRef.current + 1;
    if (next >= list.length) {
      idxRef.current = null;
      opts.setInput(draftRef.current);
    } else {
      idxRef.current = next;
      opts.setInput(list[next]!);
    }
    opts.bumpCursor();
  }

  function recordHistory(line: string): void {
    const list = listRef.current;
    if (list[list.length - 1] !== line) list.push(line);
    idxRef.current = null;
  }

  /** Typing leaves history browsing — the next Up re-stashes the edited draft. */
  function resetBrowsing(): void {
    idxRef.current = null;
  }

  return { historyPrev, historyNext, recordHistory, resetBrowsing };
}
