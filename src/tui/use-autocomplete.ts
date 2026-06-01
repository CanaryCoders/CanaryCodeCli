// tui/use-autocomplete.ts — the `/` slash-command autocomplete popover.
//
// The suggestion list is recomputed each render from the current input; the key
// handler drives it (move/accept/dismiss) through mirrored refs because Ink's key
// handler reads them outside render. Typing reopens the popover (any input change
// clears `dismissed` and resets the selection to the top). The popover stays live
// while the agent is busy so a command can be composed/queued mid-turn.

import { useRef, useState } from "react";
import {
  type Completion,
  type CompletionContext,
  completions,
} from "../commands.ts";
import type { Config } from "../config.ts";
import type { SessionStore } from "../session.ts";

/** Gather the data the `/` autocomplete draws parameter values from. */
function buildCompletionContext(
  config: Config,
  store: SessionStore,
): CompletionContext {
  const models: string[] = [];
  for (const pc of Object.values(config.providers)) {
    for (const m of pc.models ?? []) models.push(m.id);
  }
  const sessions = store
    .listSessions(20)
    .map((s) => ({ id: s.id, title: s.title }));
  return { models, sessions };
}

export interface Autocomplete {
  /** The current suggestion rows (empty when the popover is closed). */
  suggestions: Completion[];
  /** Whether the popover is open (has suggestions to show). */
  completeOpen: boolean;
  /** The clamped highlighted index. */
  sel: number;
  /** Live mirror of `completeOpen` for the key handler. */
  completeOpenRef: React.MutableRefObject<boolean>;
  /** onChange for the input: updates the buffer and reopens the popover. */
  handleInputChange: (value: string) => void;
  /** Move the selection (wraps both ends). */
  moveSel: (delta: number) => void;
  /** Hide the popover until the input changes. */
  dismissComplete: () => void;
  /** Accept the highlighted suggestion into the input. */
  acceptCompletion: () => void;
}

export function useAutocomplete(opts: {
  input: string;
  /** True while a plan awaits review — the popover is suppressed then. */
  planActive: boolean;
  setInput: (value: string) => void;
  bumpCursor: () => void;
  /** Called when the input is edited (so prompt-history browsing resets). */
  onEdit: () => void;
  config: Config;
  store: SessionStore;
}): Autocomplete {
  const { input, planActive, setInput, bumpCursor, onEdit, config, store } =
    opts;

  const [selected, setSelected] = useState(0);
  const [completeDismissed, setCompleteDismissed] = useState(false);
  const completeOpenRef = useRef(false);
  const completionsRef = useRef<Completion[]>([]);
  const selRef = useRef(0);
  const completeDismissedRef = useRef(false);

  function handleInputChange(value: string): void {
    setInput(value);
    setSelected(0);
    // Typing leaves history browsing — the next Up re-stashes this edited draft.
    onEdit();
    if (completeDismissedRef.current) {
      completeDismissedRef.current = false;
      setCompleteDismissed(false);
    }
  }
  function moveSel(delta: number): void {
    const n = completionsRef.current.length;
    if (n === 0) return;
    setSelected((s) => (((s + delta) % n) + n) % n); // wrap both ends
  }
  function dismissComplete(): void {
    completeDismissedRef.current = true;
    setCompleteDismissed(true);
  }
  function acceptCompletion(): void {
    const choice = completionsRef.current[selRef.current];
    if (!choice) return;
    setInput(choice.value);
    bumpCursor();
    setSelected(0);
    // A trailing space means "now complete a parameter" → keep the popover open;
    // otherwise the command/value is complete → close it (Enter then submits).
    const keepOpen = choice.value.endsWith(" ");
    completeDismissedRef.current = !keepOpen;
    setCompleteDismissed(!keepOpen);
  }

  // ── recompute suggestions each render from the input ──
  // Only while the prompt is an in-progress slash command and the popover isn't
  // dismissed/blocked by a plan. The refs are mirrored for the key handler.
  const completeActive =
    !planActive && input.startsWith("/") && !completeDismissed;
  const suggestions = completeActive
    ? completions(input, buildCompletionContext(config, store))
    : [];
  const completeOpen = suggestions.length > 0;
  const sel = completeOpen
    ? Math.min(Math.max(selected, 0), suggestions.length - 1)
    : 0;
  completeOpenRef.current = completeOpen;
  completionsRef.current = suggestions;
  selRef.current = sel;

  return {
    suggestions,
    completeOpen,
    sel,
    completeOpenRef,
    handleInputChange,
    moveSel,
    dismissComplete,
    acceptCompletion,
  };
}
