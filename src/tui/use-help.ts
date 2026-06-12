// tui/use-help.ts — the open/closed state for the keyboard & mouse help overlay.
//
// The footer's `?` chip (and pressing `?` on an empty prompt) opens a modal
// reference overlay listing every keyboard shortcut beside its mouse equivalent.
// That overlay renders ABOVE the input frame (sharing PromptArea's bottom chrome,
// like the paste preview) while its own scoped key handler owns `?`/Esc to close.
// This hook is the small shared piece: it owns whether the overlay is open and
// mirrors that into a ref so the App's global key handler can tell the overlay is
// open (close on Esc, swallow stray keys) without a stale render closure.

import { useRef, useState } from "react";

export interface HelpState {
  /** Whether the help overlay is currently shown. */
  open: boolean;
  /** Open the overlay (deactivates the editor — see App/PromptArea gating). */
  openHelp: () => void;
  /** Close the overlay (re-activates the editor). */
  closeHelp: () => void;
  /** Live mirror of `open` for reads outside render (App's global key gate). */
  openRef: React.MutableRefObject<boolean>;
}

export function useHelp(): HelpState {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;

  const openHelp = (): void => {
    openRef.current = true;
    setOpen(true);
  };
  const closeHelp = (): void => {
    openRef.current = false;
    setOpen(false);
  };

  return { open, openHelp, closeHelp, openRef };
}
