// tui/use-paste-chips.ts — the host side of the input's paste-chip mechanism.
//
// A large paste is stored here by id and embedded in the input buffer as a single
// sentinel char (see Input.tsx). The buffer carries sentinels; callers expand them
// to the real text only when a prompt is sent. State lives in refs (the map never
// drives render directly — it is passed to MultilineInput for chip rendering), so
// this hook never triggers a re-render.

import { useRef } from "react";
import { pasteSentinel } from "./input-helpers.ts";

export interface PasteChips {
  /** id → original pasted text, passed to MultilineInput to render chips. */
  pasteMap: Map<number, string>;
  /** Register a paste and return the sentinel char to embed (null if exhausted). */
  registerPaste: (text: string) => string | null;
}

export function usePasteChips(): PasteChips {
  // useRef has no lazy-init form, so `useRef(new Map())` would allocate a throwaway
  // Map on every render. Init it once behind a null guard instead.
  const mapRef = useRef<Map<number, string> | null>(null);
  if (mapRef.current === null) mapRef.current = new Map();
  const pasteMap = mapRef.current;
  const nextIdRef = useRef(0);

  const registerPaste = (text: string): string | null => {
    const id = nextIdRef.current++;
    if (id > 0xff) return null; // exhausted the sentinel range — paste verbatim
    pasteMap.set(id, text);
    return pasteSentinel(id);
  };

  return { pasteMap, registerPaste };
}
