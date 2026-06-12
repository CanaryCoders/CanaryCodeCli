// tui/use-paste-preview.ts — the open/closed state for the paste-chip preview.
//
// A paste chip in the prompt (`[Pasted text #N +M lines]`) is clickable: clicking
// it opens a read-only popover showing the stored text. That popover renders ABOVE
// the input frame (so it shares `PromptArea`'s layout with the autocomplete list),
// while the chip click handlers and the editor's input gate live in `Input.tsx`.
// This hook is the small shared piece between them: it owns which chip id is being
// previewed (or null when closed) and mirrors that into a ref so the App's global
// Esc handler can tell the preview is open and skip its escalation.

import { useRef, useState } from "react";

export interface PastePreview {
  /** The paste id currently previewed, or null when the popover is closed. */
  chipId: number | null;
  /** Open the popover for `id` (pauses the editor — see Input.tsx). */
  open: (id: number) => void;
  /** Close the popover (re-activates the editor). */
  close: () => void;
  /** Live mirror of `chipId !== null` for reads outside render (App's Esc gate). */
  openRef: React.MutableRefObject<boolean>;
}

export function usePastePreview(): PastePreview {
  const [chipId, setChipId] = useState<number | null>(null);
  const openRef = useRef(false);
  openRef.current = chipId !== null;

  const open = (id: number): void => {
    openRef.current = true;
    setChipId(id);
  };
  const close = (): void => {
    openRef.current = false;
    setChipId(null);
  };

  return { chipId, open, close, openRef };
}
