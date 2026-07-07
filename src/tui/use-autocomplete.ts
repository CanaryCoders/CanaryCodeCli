// tui/use-autocomplete.ts — the `/` slash-command autocomplete popover.
//
// The suggestion list is recomputed each render from the current input; the key
// handler drives it (move/accept/dismiss) through mirrored refs because Ink's key
// handler reads them outside render. Typing reopens the popover (any input change
// clears `dismissed` and resets the selection to the top). The popover stays live
// while the agent is busy so a command can be composed/queued mid-turn.

import { useEffect, useRef, useState } from "react";
import { availableCommands, listExtensions } from "../assemble.ts";
import {
  type Completion,
  type CompletionContext,
  type ModelOption,
  makeCommandSet,
} from "../commands.ts";
import { type Config, providerDisplayName } from "../config.ts";
import type { SessionStore } from "../session.ts";
import {
  fileMentionCompletions,
  listMentionableFiles,
} from "./file-complete.ts";

/** Gather the data the `/` autocomplete draws parameter values from. */
function buildCompletionContext(
  config: Config,
  store: SessionStore,
): CompletionContext {
  // Detect ids that appear under more than one provider (e.g. `opus` from both
  // the `anthropic` API-billing preset and the `claude` Claude Code preset). Those
  // must be qualified as `provider:id` so /model selects the intended billing path
  // — an unqualified id resolves to whichever provider is listed first.
  const idCounts = new Map<string, number>();
  for (const pc of Object.values(config.providers))
    for (const m of pc.models ?? [])
      idCounts.set(m.id, (idCounts.get(m.id) ?? 0) + 1);
  const models: ModelOption[] = [];
  for (const [key, pc] of Object.entries(config.providers)) {
    for (const m of pc.models ?? []) {
      const ambiguous = (idCounts.get(m.id) ?? 0) > 1;
      models.push({
        id: ambiguous ? `${key}:${m.id}` : m.id,
        source: providerDisplayName(key),
      });
    }
  }
  const sessions = store
    .listSessions(20)
    .map((s) => ({ id: s.id, title: s.title }));
  return {
    models,
    sessions,
    extensions: listExtensions(config).map((e) => ({
      name: e.name,
      description: e.description,
    })),
  };
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
  /** Select a suggestion row directly (mouse hover). */
  selectCompletion: (index: number) => void;
  /** Accept the highlighted suggestion into the input. */
  acceptCompletion: (index?: number) => void;
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
  const [files, setFiles] = useState<string[]>([]);
  const completeOpenRef = useRef(false);
  const completionsRef = useRef<Completion[]>([]);
  const selRef = useRef(0);
  const completeDismissedRef = useRef(false);

  function refreshMentionableFiles(): void {
    listMentionableFiles()
      .then((next) => setFiles(next))
      .catch(() => {});
  }

  useEffect(() => {
    let cancelled = false;
    listMentionableFiles()
      .then((next) => {
        if (!cancelled) setFiles(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function handleInputChange(value: string): void {
    refreshMentionableFiles();
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
  function selectCompletion(index: number): void {
    const n = completionsRef.current.length;
    if (index < 0 || index >= n) return;
    selRef.current = index;
    setSelected(index);
  }
  function acceptCompletion(index = selRef.current): void {
    const choice = completionsRef.current[index];
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
  // Slash commands complete at the start of the prompt; @file mentions complete
  // inline for the active whitespace-delimited mention token.
  const completeActive = !planActive && !completeDismissed;
  const suggestions = completeActive
    ? input.startsWith("/")
      ? makeCommandSet(availableCommands(config)).completions(
          input,
          buildCompletionContext(config, store),
        )
      : fileMentionCompletions(input, files)
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
    selectCompletion,
    acceptCompletion,
  };
}
