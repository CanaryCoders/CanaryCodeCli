// tui/use-prompt-input.ts — the prompt buffer and its cursor nonce.
//
// `input` is the edit buffer (may carry paste sentinels — see Input.tsx). `setInput`
// keeps a mirror ref in sync so async code and the once-bound key handlers can read
// the live value. `cursorNonce` is bumped whenever the buffer is set out-of-band
// (history recall, completion accept, clear) so MultilineInput snaps its cursor to
// the end of the new value.

import { useRef, useState } from "react";

export interface PromptInput {
  input: string;
  /** Live mirror of `input` for reads outside render. */
  inputRef: React.MutableRefObject<string>;
  setInput: (value: string) => void;
  /** Bumped on every out-of-band set so the cursor snaps to end. */
  cursorNonce: number;
  bumpCursor: () => void;
}

export function usePromptInput(): PromptInput {
  const [input, setInputState] = useState("");
  const inputRef = useRef("");
  const [cursorNonce, setCursorNonce] = useState(0);

  const setInput = (value: string) => {
    inputRef.current = value;
    setInputState(value);
  };
  const bumpCursor = () => setCursorNonce((n) => n + 1);

  return { input, inputRef, setInput, cursorNonce, bumpCursor };
}
